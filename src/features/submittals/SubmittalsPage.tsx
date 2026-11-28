// Submittals (PRD SUB-01..SUB-04), built from the demo app's Submittals page
// (mock/src/mock/pages/SubmittalsPage.tsx): the register (KPIs, filters, the table, CSV), the New
// submittal form (submittalsUi.tsx) and the submittal itself (SubmittalDetail.tsx). Every read and
// write goes through the submittals Function, which decides who sees and does what; the buttons here
// follow its answers. Not real yet, from later releases: import from a spec index, packages and
// transmittal PDFs (R2), parallel reviewers (R3).
import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileStack, Layers, Plus } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { todayIso } from "../../lib/workdays";
import {
  Button, Checkbox, Empty, Kpi, Note, PageTitle, Panel, PersonChip, ReleaseTag, SearchInput, Select, Toasts, cx, downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtShortDate } from "../projects/ProjectsPage";
import { SkTable, SkeletonPage } from "../../shared/m/Skeleton";
import { SUBMITTAL_OPEN, useSubmittalList, viewOf } from "./submittalsApi";
import { SubDue, SubmittalFormDialog, VIEWS, ViewPill, errorText, isOpenStep } from "./submittalsUi";
import type { Ctx } from "./submittalsUi";
import { SubmittalDetailView } from "./SubmittalDetail";
import "./SubmittalsPage.css";

type Nav = { onNavigate: (path: string) => void; params?: string[] };

export function SubmittalsPage({ onNavigate, params = [] }: Nav) {
  const { t } = useT();
  const { query, ws, project, myUserId, myRole } = useProjects();
  const { items: toasts, toast } = useToasts();
  const today = todayIso();
  const team = useMemo(
    () => (ws && project ? ws.team.filter((r) => r.projectId === project.ItemId && r.status === "active") : []),
    [ws, project]
  );

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <SkeletonPage kind="table" label={t("common.loading")} />;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("sub.title")} />
        <Panel><Empty icon={<FileStack size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }

  const ctx: Ctx = { t, project, team, myUserId, myRole, today, toast, onNavigate };
  const id = params[0];
  return (
    <div>
      {id ? <SubmittalDetailView ctx={ctx} submittalId={id} /> : <Register ctx={ctx} />}
      <Toasts items={toasts} />
    </div>
  );
}

// ---------- register ----------
function Register({ ctx }: { ctx: Ctx }) {
  const { t, project, myUserId, today, onNavigate } = ctx;
  const list = useSubmittalList(project.ItemId);
  const [view, setView] = useState("");
  const [spec, setSpec] = useState("");
  const [company, setCompany] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [ball, setBall] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(() => new URLSearchParams(window.location.search).get("overdue") === "1");
  const [myQueue, setMyQueue] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);

  const rows = useMemo(() => list.data?.submittals ?? [], [list.data]);
  const seesAll = list.data?.can.seesAllCompanies ?? true;
  const canCreate = list.data?.can.create ?? false;
  const month = today.slice(0, 7);

  const kpi = useMemo(() => ({
    withGc: rows.filter((s) => s.status === "inGcReview").length,
    withReviewer: rows.filter((s) => s.status === "inDesignReview").length,
    overdue: rows.filter((s) => s.overdue).length,
    resubmit: rows.filter((s) => viewOf(s) === "resubmit").length,
    approvedMonth: rows.filter((s) => s.status === "closed" && (s.decision === "approved" || s.decision === "approvedAsNoted") && String(s.decidedAt ?? "").startsWith(month)).length,
    late: rows.filter((s) => s.submitLate).length,
    mine: rows.filter((s) => s.ballInCourtUserId === myUserId && SUBMITTAL_OPEN.includes(s.status)).length
  }), [rows, month, myUserId]);

  // Until the list arrives the tiles show a dash, not a misleading 0.
  const shown = (n: number) => (list.data ? n : "—");

  const uniq = <K extends string>(pairs: [K, string][]) => [...new Map(pairs.filter(([k]) => Boolean(k))).entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const specs = useMemo(() => uniq(rows.map((s) => [s.specSection, `${s.specSection}${s.specSectionTitle ? ` ${s.specSectionTitle}` : ""}`])), [rows]);
  const companies = useMemo(() => uniq(rows.map((s) => [s.responsibleCompanyId, s.responsibleCompanyName ?? ""])), [rows]);
  const reviewers = useMemo(() => uniq(rows.map((s) => [s.designReviewerUserId ?? "", s.designReviewerName ?? ""])), [rows]);
  const balls = useMemo(() => uniq(rows.filter((s) => SUBMITTAL_OPEN.includes(s.status)).map((s) => [s.ballInCourtUserId ?? "", s.ballInCourtName ?? ""])), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((s) =>
        (!view || viewOf(s) === view) &&
        (!spec || s.specSection === spec) &&
        (!company || s.responsibleCompanyId === company) &&
        (!reviewer || s.designReviewerUserId === reviewer) &&
        (!ball || (s.ballInCourtUserId === ball && SUBMITTAL_OPEN.includes(s.status))) &&
        (!overdueOnly || s.overdue) &&
        (!lateOnly || s.submitLate) &&
        (!myQueue || (s.ballInCourtUserId === myUserId && SUBMITTAL_OPEN.includes(s.status))) &&
        (!needle || `${s.number} ${s.title} ${s.specSection} ${s.specSectionTitle ?? ""} ${s.responsibleCompanyName ?? ""}`.toLowerCase().includes(needle))
      )
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  }, [rows, view, spec, company, reviewer, ball, overdueOnly, lateOnly, myQueue, q, myUserId]);

  const filtersOn = view || spec || company || reviewer || ball || overdueOnly || lateOnly || myQueue || q;
  const clear = () => { setView(""); setSpec(""); setCompany(""); setReviewer(""); setBall(""); setOverdueOnly(false); setLateOnly(false); setMyQueue(false); setQ(""); };
  const only = (fn: () => void) => { clear(); fn(); };
  const manageWhy = list.data && !canCreate ? (list.data.archived ? t("sub.archived") : t("sub.createWhy")) : undefined;

  const exportCsv = () => {
    const headers = ["Number", "Revision", "Title", "Spec section", "Section title", "Type", "Subcontractor", "Status", "Ball in court", "Design reviewer", "Required on site", "Lead time (days)", "GC check (working days)", "Design review (working days)", "Submit by", "Submit by passed", "Due", "Overdue", "Submitted", "Decided"];
    const data = filtered.map((s) => ({
      number: s.number,
      revision: s.revision,
      title: s.title,
      spec: s.specSection,
      specTitle: s.specSectionTitle ?? "",
      type: t(`sub.type.${s.type}` as TranslationKey),
      company: s.responsibleCompanyName ?? "",
      status: t(`sub.view.${viewOf(s)}` as TranslationKey),
      ball: SUBMITTAL_OPEN.includes(s.status) ? s.ballInCourtName ?? "" : "",
      reviewer: s.designReviewerName ?? "",
      onSite: s.requiredOnSiteDate,
      lead: s.leadTimeDays,
      gc: s.gcReviewDays,
      design: s.designReviewDays,
      submitBy: s.submitByDate,
      late: s.submitLate ? "yes" : "",
      due: isOpenStep(s) ? s.dueDate ?? "" : "",
      overdue: s.overdue ? "yes" : "",
      submitted: String(s.submittedAt ?? "").slice(0, 10),
      decided: String(s.decidedAt ?? "").slice(0, 10)
    }));
    downloadCsv(`${project.number || "project"}-submittals-${today}.csv`, data, headers);
    ctx.toast(fmt(t("sub.csvDone"), { count: data.length }));
  };

  return (
    <>
      <PageTitle
        title={t("sub.title")}
        subtitle={list.data && !seesAll ? fmt(t("sub.subtitleOwn"), { company: rows[0]?.responsibleCompanyName || t("sub.yourCompany") }) : t("sub.subtitle")}
        actions={
          <>
            <Button variant="secondary" icon={<Download size={15} />} onClick={exportCsv} disabled={filtered.length === 0} title={filtered.length ? undefined : t("sub.csvEmpty")}>{t("coadmin.exportCsv")}</Button>
            <Button variant="secondary" icon={<FileSpreadsheet size={15} />} disabled title={t("sub.importLater")}>{t("sub.import")} <ReleaseTag release="R2" /></Button>
            <Button icon={<Plus size={15} />} onClick={() => setShowNew(true)} disabled={!canCreate} title={manageWhy}>{t("sub.new")}</Button>
          </>
        }
      />

      {list.error ? <div style={{ marginBottom: 12 }}><Note tone="danger">{errorText(list.error, t)}</Note></div> : null}

      <div className="m-kpis">
        <Kpi label={t("sub.kpi.withGc")} value={shown(kpi.withGc)} hint={t("sub.kpi.withGcHint")} tone="amber" onClick={() => only(() => setView("withGc"))} />
        <Kpi label={t("sub.kpi.withReviewer")} value={shown(kpi.withReviewer)} hint={t("sub.kpi.withReviewerHint")} tone="blue" onClick={() => only(() => setView("withReviewer"))} />
        <Kpi label={t("sub.kpi.overdue")} value={shown(kpi.overdue)} hint={t("sub.kpi.overdueHint")} tone={kpi.overdue ? "red" : "green"} onClick={() => only(() => setOverdueOnly(true))} />
        <Kpi label={t("sub.kpi.resubmit")} value={shown(kpi.resubmit)} hint={t("sub.kpi.resubmitHint")} tone={kpi.resubmit ? "red" : undefined} onClick={() => only(() => setView("resubmit"))} />
        <Kpi label={t("sub.kpi.approvedMonth")} value={shown(kpi.approvedMonth)} hint={t("sub.kpi.approvedMonthHint")} tone="green" />
        <Kpi label={t("sub.kpi.late")} value={shown(kpi.late)} hint={t("sub.kpi.lateHint")} tone={kpi.late ? "red" : undefined} onClick={() => only(() => setLateOnly(true))} />
      </div>

      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("sub.search")} />
        <Select value={view} onChange={setView} placeholder={t("sub.allStatuses")} options={VIEWS.filter((v) => v !== "draft" || canCreate).map((v) => ({ value: v, label: t(`sub.view.${v}` as TranslationKey) }))} />
        <Select value={spec} onChange={setSpec} placeholder={t("sub.allSpecs")} options={specs} />
        {seesAll ? <Select value={company} onChange={setCompany} placeholder={t("sub.allCompanies")} options={companies} /> : null}
        <Select value={reviewer} onChange={setReviewer} placeholder={t("sub.anyReviewer")} options={reviewers} />
        <Select value={ball} onChange={setBall} placeholder={t("rfi.anyBall")} options={balls} />
        <Checkbox checked={overdueOnly} onChange={setOverdueOnly} label={t("rfi.overdueOnly")} />
        <Checkbox checked={lateOnly} onChange={setLateOnly} label={t("sub.lateOnly")} />
        <Checkbox checked={myQueue} onChange={setMyQueue} label={fmt(t("sub.myQueue"), { count: kpi.mine })} />
        {filtersOn ? <Button variant="ghost" small onClick={clear}>{t("rfi.clearFilters")}</Button> : null}
      </div>

      {list.isLoading ? (
        <SkTable label={t("common.loading")} />
      ) : filtered.length === 0 ? (
        <Panel>
          <Empty icon={<FileStack size={28} />} title={rows.length ? t("sub.noMatch") : t("sub.none")}>
            {rows.length ? t("sub.noMatchText") : canCreate ? t("sub.noneText") : seesAll ? t("sub.noneReadOnly") : t("sub.noneSub")}
          </Empty>
        </Panel>
      ) : (
        <div className="m-table-wrap m-subs-table">
          <table className="m-table">
            <thead>
              <tr>
                <th>{t("sub.col.number")}</th>
                <th>{t("sub.col.title")}</th>
                <th className="m-hide-mobile">{t("sub.col.spec")}</th>
                <th className="m-hide-mobile">{t("sub.col.type")}</th>
                {seesAll ? <th className="m-hide-mobile">{t("sub.col.company")}</th> : null}
                <th>{t("sub.col.status")}</th>
                <th>{t("rfi.ballInCourt")}</th>
                <th className="m-hide-mobile">{t("sub.col.onSite")}</th>
                <th className="m-num m-hide-mobile">{t("sub.col.lead")}</th>
                <th className="m-hide-mobile" title={t("sub.formulaShort")}>{t("sub.col.submitBy")}</th>
                <th>{t("sub.col.due")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.ItemId} className="m-clickable" onClick={() => onNavigate(`/submittals/${s.ItemId}`)}>
                  <td className="m-mono m-strong m-subs-c-num">{s.number}<span className="m-subs-rev-sm">R{s.revision}</span></td>
                  <td className="m-subs-c-title"><div className="m-subs-title">{s.title}<small className="m-subs-only-mobile">{s.specSection}{seesAll && s.responsibleCompanyName ? ` · ${s.responsibleCompanyName}` : ""}</small></div></td>
                  <td className="m-hide-mobile m-small"><span className="m-mono">{s.specSection}</span>{s.specSectionTitle ? <div className="m-muted">{s.specSectionTitle}</div> : null}</td>
                  <td className="m-hide-mobile">{t(`sub.type.${s.type}` as TranslationKey)}</td>
                  {seesAll ? <td className="m-hide-mobile">{s.responsibleCompanyName}</td> : null}
                  <td className="m-subs-c-status"><ViewPill s={s} t={t} /></td>
                  <td className="m-subs-c-ball">{SUBMITTAL_OPEN.includes(s.status) && s.ballInCourtName ? <PersonChip name={s.ballInCourtName} /> : <span className="m-muted">—</span>}</td>
                  <td className="m-hide-mobile" style={{ whiteSpace: "nowrap" }}>{fmtShortDate(s.requiredOnSiteDate)}</td>
                  <td className="m-num m-hide-mobile">{fmt(t("sub.days"), { count: s.leadTimeDays })}</td>
                  <td className={cx("m-hide-mobile", s.submitLate && "m-subs-late")} style={{ whiteSpace: "nowrap" }}>{fmtShortDate(s.submitByDate)}{s.submitLate ? ` · ${t("sub.passed")}` : ""}</td>
                  <td className="m-subs-c-due"><SubDue s={s} today={today} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-muted m-small" style={{ marginTop: 10 }}>{fmt(t("sub.footer"), { shown: filtered.length, total: rows.length })}</p>
      <p className="m-muted m-small m-row" style={{ marginTop: 4 }}><Layers size={13} /> {t("sub.packagesLater")} <ReleaseTag release="R2" /></p>

      {showNew && list.data ? (
        <SubmittalFormDialog ctx={ctx} list={list.data} onClose={() => setShowNew(false)} onDone={(id) => { setShowNew(false); onNavigate(`/submittals/${id}`); }} />
      ) : null}
    </>
  );
}
