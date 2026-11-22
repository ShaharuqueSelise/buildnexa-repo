// RFIs (PRD RFI-01..RFI-06), built from the demo app's RFIs page (mock/src/mock/pages/RfisPage.tsx):
// the list with KPIs and filters, the New RFI form, and the RFI with its ball in court, status
// steps, response thread, official answer and history. Every action goes through the rfis
// Function, which decides who may do what; the buttons shown here follow its `can` answer.
// Not real yet (later parts of the RFI work): attachments and the phone layout, bell and email
// notifications, reminders, CSV export; and from later releases: board view, bulk reassign, PDF
// with letterhead, linked sheets, change events, related RFIs, reply by email.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlarmClock, ArrowLeft, Check, CheckCircle2, Download, FilePlus2, Loader2, Lock, MessageSquare, Paperclip, Pencil, Plus,
  RotateCcw, Send, Star, UserRoundCog, XCircle
} from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FUNCTIONS, FunctionRefused } from "../../lib/blocks/functions";
import { projectCan } from "../../lib/permissions";
import { addWorkingDays, todayIso, workingDaysBetween } from "../../lib/workdays";
import {
  Avatar, Badge, Button, Checkbox, Dialog, Empty, Field, Kpi, KeyValue, Note, PageTitle, Panel, PersonChip, ReleaseTag, SearchInput,
  Segmented, Select, Tabs, Timeline, Toasts, colorFor, cx, fmt, useToasts
} from "../../shared/m/ui";
import type { Tone, ToastTone } from "../../shared/m/ui";
import { personName, useProjects } from "../projects/projectsApi";
import type { ProjectRow, TeamRow } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { useRfi, useRfiAction, useRfiList } from "./rfisApi";
import type { Impact, RfiInput, RfiRow, RfiStatus } from "./rfisApi";
import "./RfisPage.css";

type Nav = { onNavigate: (path: string) => void; params?: string[] };
type T = (key: TranslationKey) => string;

const STATUSES: RfiStatus[] = ["draft", "open", "answered", "closed", "void"];
const STATUS_TONE: Record<RfiStatus, Tone> = { draft: "amber", open: "blue", answered: "purple", closed: "green", void: "gray" };
const DISCIPLINES = ["Architectural", "Structural", "Mechanical", "Electrical", "Plumbing", "Fire protection", "Civil", "Landscape"];
const IMPACT_TONE: Record<Impact, Tone> = { yes: "red", tbd: "amber", no: "gray" };
const LIVE: RfiStatus[] = ["draft", "open", "answered"];

const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const isOverdue = (r: RfiRow, today: string) => r.status === "open" && Boolean(r.dueDate) && String(r.dueDate) < today;
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// ---------- shared context for the list and the detail ----------
type Ctx = {
  t: T;
  project: ProjectRow;
  team: TeamRow[];
  myUserId: string;
  myRole?: string;
  today: string;
  nameOf: (userId?: string, fallback?: string) => string;
  companyOf: (userId?: string) => string;
  toast: (text: string, tone?: ToastTone) => void;
  onNavigate: (path: string) => void;
};

function StatusPill({ status, t }: { status: RfiStatus; t: T }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{t(`rfi.status.${status}` as TranslationKey)}</Badge>;
}

function DueLabel({ due, done, today, t }: { due?: string; done?: boolean; today: string; t: T }) {
  if (!due) return <span className="m-muted">—</span>;
  if (done) return <span className="m-muted">{fmtShortDate(due)}</span>;
  if (due < today) return <span className="m-due m-due-over">{fmtShortDate(due)} · {fmt(t("rfi.daysOverdue"), { count: workingDaysBetween(due, today) })}</span>;
  const left = workingDaysBetween(today, due);
  if (left <= 2) return <span className="m-due m-due-soon">{fmtShortDate(due)} · {left === 0 ? t("rfi.dueToday") : fmt(t("rfi.daysLeft"), { count: left })}</span>;
  return <span className="m-due">{fmtShortDate(due)}</span>;
}

function errorText(error: unknown, t: T) {
  return error instanceof FunctionRefused ? error.message : t("common.error");
}

export function RfisPage({ onNavigate, params = [] }: Nav) {
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
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("rfi.title")} />
        <Panel><Empty icon={<MessageSquare size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }
  if (!FUNCTIONS.rfis) {
    return (
      <div>
        <PageTitle title={t("rfi.title")} />
        <Note tone="warn">{t("rfi.notDeployed")}</Note>
      </div>
    );
  }

  const nameOf = (userId?: string, fallback?: string) => {
    const member = ws.people.find((m) => m.userId === userId);
    if (member) return personName(member);
    return team.find((r) => r.userId === userId)?.displayName || fallback || "";
  };
  const companyOf = (userId?: string) => team.find((r) => r.userId === userId)?.companyName ?? "";
  const ctx: Ctx = { t, project, team, myUserId, myRole, today, nameOf, companyOf, toast, onNavigate };
  const id = params[0];

  return (
    <div>
      {id ? <RfiDetailView ctx={ctx} rfiId={id} /> : <RfiListView ctx={ctx} />}
      <Toasts items={toasts} />
    </div>
  );
}

// ---------- list ----------
type StatusFilter = "all" | RfiStatus;
type SortKey = "number" | "due" | "status";

function RfiListView({ ctx }: { ctx: Ctx }) {
  const { t, project, myUserId, today, nameOf, onNavigate } = ctx;
  const list = useRfiList(project.ItemId);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const [ball, setBall] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [ballOnMe, setBallOnMe] = useState(false);
  const [createdByMe, setCreatedByMe] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "number", dir: -1 });
  const [showNew, setShowNew] = useState(false);

  const rfis = useMemo(() => list.data?.rfis ?? [], [list.data]);
  const showCost = list.data?.seesCost ?? false;

  const kpi = useMemo(() => {
    const open = rfis.filter((r) => r.status === "open");
    const turnaround = rfis.filter((r) => r.openedDate && r.answeredDate).map((r) => workingDaysBetween(String(r.openedDate), String(r.answeredDate)));
    return {
      open: open.length,
      overdue: open.filter((r) => isOverdue(r, today)).length,
      answered: rfis.filter((r) => r.status === "answered").length,
      median: median(turnaround),
      mine: rfis.filter((r) => r.ballInCourtUserId === myUserId && LIVE.includes(r.status)).length
    };
  }, [rfis, today, myUserId]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rfis.length };
    STATUSES.forEach((s) => { c[s] = rfis.filter((r) => r.status === s).length; });
    return c;
  }, [rfis]);

  const ballPeople = useMemo(
    () => [...new Set(rfis.map((r) => r.ballInCourtUserId).filter((u): u is string => Boolean(u)))].map((u) => ({ value: u, label: nameOf(u, rfis.find((r) => r.ballInCourtUserId === u)?.ballInCourtName) })),
    [rfis, nameOf]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const order = (r: RfiRow) => (sort.key === "number" ? String(r.seq ?? 0).padStart(6, "0") + r.createdAt : sort.key === "due" ? r.dueDate ?? "9999" : String(STATUSES.indexOf(r.status)));
    return rfis
      .filter((r) =>
        (status === "all" || r.status === status) &&
        (!ball || r.ballInCourtUserId === ball) &&
        (!discipline || r.discipline === discipline) &&
        (!overdueOnly || isOverdue(r, today)) &&
        (!ballOnMe || (r.ballInCourtUserId === myUserId && LIVE.includes(r.status))) &&
        (!createdByMe || r.createdByUserId === myUserId) &&
        (!needle || `${r.number} ${r.subject} ${r.question ?? ""} ${r.location ?? ""}`.toLowerCase().includes(needle))
      )
      .sort((a, b) => order(a).localeCompare(order(b)) * sort.dir);
  }, [rfis, status, ball, discipline, overdueOnly, ballOnMe, createdByMe, q, today, myUserId, sort]);

  const toggleSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");
  const filtersOn = status !== "all" || ball || discipline || overdueOnly || ballOnMe || createdByMe || q;
  const clear = () => { setStatus("all"); setBall(""); setDiscipline(""); setOverdueOnly(false); setBallOnMe(false); setCreatedByMe(false); setQ(""); };
  const canCreate = list.data?.canCreate ?? false;
  const createWhy = list.data && !canCreate ? t("rfi.createWhy") : undefined;

  return (
    <>
      <PageTitle
        title={t("rfi.title")}
        subtitle={t("rfi.subtitle")}
        actions={
          <>
            <Button variant="secondary" icon={<Download size={15} />} disabled title={t("rfi.later.csv")}>{t("coadmin.exportCsv")}</Button>
            <Button icon={<Plus size={15} />} onClick={() => setShowNew(true)} disabled={!canCreate} title={createWhy}>{t("rfi.new")}</Button>
          </>
        }
      />

      {list.error ? <div style={{ marginBottom: 12 }}><Note tone="danger">{errorText(list.error, t)}</Note></div> : null}

      <div className="m-kpis">
        <Kpi label={t("rfi.kpi.open")} value={kpi.open} hint={t("rfi.kpi.openHint")} tone="blue" onClick={() => { clear(); setStatus("open"); }} />
        <Kpi
          label={t("rfi.kpi.overdue")}
          value={kpi.overdue}
          hint={kpi.open ? fmt(t("rfi.kpi.overdueHint"), { pct: Math.round((kpi.overdue / kpi.open) * 100) }) : t("rfi.kpi.noneOpen")}
          tone={kpi.overdue ? "red" : "green"}
          onClick={() => { clear(); setStatus("open"); setOverdueOnly(true); }}
        />
        <Kpi label={t("rfi.kpi.answered")} value={kpi.answered} hint={t("rfi.kpi.answeredHint")} tone="amber" onClick={() => { clear(); setStatus("answered"); }} />
        <Kpi
          label={t("rfi.kpi.turnaround")}
          value={kpi.median === undefined ? "—" : fmt(t("rfi.kpi.days"), { count: kpi.median.toFixed(1) })}
          hint={t("rfi.kpi.turnaroundHint")}
          tone={kpi.median !== undefined && kpi.median > 5 ? "red" : "green"}
        />
        <Kpi label={t("rfi.kpi.mine")} value={kpi.mine} hint={t("rfi.kpi.mineHint")} tone={kpi.mine ? "amber" : undefined} onClick={() => { clear(); setBallOnMe(true); }} />
      </div>

      <div className="m-toolbar">
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          options={(["all", ...STATUSES] as StatusFilter[]).map((s) => ({
            key: s,
            label: <>{s === "all" ? t("rfi.all") : t(`rfi.status.${s}` as TranslationKey)} <span className="m-muted m-small">{counts[s] ?? 0}</span></>
          }))}
        />
      </div>
      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("rfi.search")} />
        <Select value={ball} onChange={setBall} placeholder={t("rfi.anyBall")} options={ballPeople} />
        <Select value={discipline} onChange={setDiscipline} placeholder={t("rfi.allDisciplines")} options={DISCIPLINES} />
        <Checkbox checked={overdueOnly} onChange={setOverdueOnly} label={t("rfi.overdueOnly")} />
        <Checkbox checked={ballOnMe} onChange={setBallOnMe} label={t("rfi.ballOnMe")} />
        <Checkbox checked={createdByMe} onChange={setCreatedByMe} label={t("rfi.createdByMe")} />
        {filtersOn ? <Button variant="ghost" small onClick={clear}>{t("rfi.clearFilters")}</Button> : null}
      </div>

      {list.isLoading ? (
        <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>
      ) : filtered.length === 0 ? (
        <Panel>
          <Empty icon={<MessageSquare size={28} />} title={rfis.length ? t("rfi.noMatch") : t("rfi.none")}>
            {rfis.length ? t("rfi.noMatchText") : canCreate ? t("rfi.noneText") : t("rfi.noneReadOnly")}
          </Empty>
        </Panel>
      ) : (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th><button className="m-link" onClick={() => toggleSort("number")}>{t("rfi.col.number")}{sortMark("number")}</button></th>
                <th>{t("rfi.col.subject")}</th>
                <th><button className="m-link" onClick={() => toggleSort("status")}>{t("rfi.col.status")}{sortMark("status")}</button></th>
                <th>{t("rfi.ballInCourt")}</th>
                <th className="m-hide-mobile">{t("rfi.discipline")}</th>
                <th><button className="m-link" onClick={() => toggleSort("due")}>{t("rfi.col.due")}{sortMark("due")}</button></th>
                <th className="m-hide-mobile">{t("rfi.col.createdBy")}</th>
                {showCost ? <th className="m-hide-mobile">{t("rfi.col.impact")}</th> : null}
                <th className="m-num m-hide-mobile">{t("rfi.col.replies")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.ItemId} className="m-clickable" onClick={() => onNavigate(`/rfis/${r.ItemId}`)}>
                  <td className="m-mono m-strong">{r.number || <span className="m-muted">{t("rfi.status.draft")}</span>}</td>
                  <td>
                    <div className="m-rfis-subject">
                      {r.priority === "high" ? <Badge tone="red">{t("rfi.priority.high")}</Badge> : null} {r.subject}
                      {r.location ? <small>{r.location}</small> : null}
                    </div>
                  </td>
                  <td><StatusPill status={r.status} t={t} /></td>
                  <td>{r.ballInCourtUserId && LIVE.includes(r.status) ? <PersonChip name={nameOf(r.ballInCourtUserId, r.ballInCourtName)} /> : <span className="m-muted">—</span>}</td>
                  <td className="m-hide-mobile">{r.discipline || "—"}</td>
                  <td><DueLabel due={r.dueDate} done={r.status !== "open" && r.status !== "draft"} today={today} t={t} /></td>
                  <td className="m-hide-mobile">{nameOf(r.createdByUserId, r.createdByName)}</td>
                  {showCost ? (
                    <td className="m-hide-mobile">
                      <span className="m-row">
                        <Badge tone={IMPACT_TONE[r.costImpact ?? "tbd"]} title={t("rfi.costImpact")}>€ {t(`rfi.impact.${r.costImpact ?? "tbd"}` as TranslationKey)}</Badge>
                        <Badge tone={IMPACT_TONE[r.scheduleImpact ?? "tbd"]} title={t("rfi.scheduleImpact")}>⏱ {t(`rfi.impact.${r.scheduleImpact ?? "tbd"}` as TranslationKey)}</Badge>
                      </span>
                    </td>
                  ) : null}
                  <td className="m-num m-hide-mobile">{r.responseCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-muted m-small" style={{ marginTop: 10 }}>{fmt(t("rfi.footer"), { shown: filtered.length, total: rfis.length })}</p>

      {showNew ? (
        <RfiFormDialog
          ctx={ctx}
          seesCost={showCost}
          seesInternal={list.data?.seesInternal ?? false}
          onClose={() => setShowNew(false)}
          onDone={(rfiId) => { setShowNew(false); onNavigate(`/rfis/${rfiId}`); }}
        />
      ) : null}
    </>
  );
}

// ---------- new RFI and edit ----------
function RfiFormDialog({ ctx, seesCost, seesInternal, initial, onClose, onDone }: {
  ctx: Ctx; seesCost: boolean; seesInternal: boolean; initial?: RfiRow; onClose: () => void; onDone: (rfiId: string) => void;
}) {
  const { t, project, team, myUserId, today, toast } = ctx;
  const action = useRfiAction(project.ItemId);
  const [requestId] = useState(newRequestId);
  const answerers = team.filter((r) => r.role !== "owner-viewer");
  const firstDesigner = answerers.find((r) => r.role === "design-reviewer")?.userId;
  const [v, setV] = useState<RfiInput>(() => ({
    subject: initial?.subject ?? "",
    question: initial?.question ?? "",
    suggestedAnswer: initial?.suggestedAnswer ?? "",
    priority: initial?.priority ?? "normal",
    discipline: initial?.discipline ?? "",
    location: initial?.location ?? "",
    dueDate: initial?.dueDate ?? addWorkingDays(today, 7),
    assigneeUserIds: initial?.assigneeUserIds ?? (firstDesigner ? [firstDesigner] : []),
    distributionUserIds: initial?.distributionUserIds ?? team.filter((r) => r.role === "project-manager" && r.userId !== myUserId).map((r) => r.userId),
    costImpact: initial?.costImpact ?? "tbd",
    scheduleImpact: initial?.scheduleImpact ?? "tbd",
    costImpactAmount: initial?.costImpactAmount ?? "",
    scheduleImpactDays: initial?.scheduleImpactDays ?? "",
    internalNote: initial?.internalNote ?? ""
  }));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof RfiInput>(k: K, value: RfiInput[K]) => setV((prev) => ({ ...prev, [k]: value }));
  const toggle = (k: "assigneeUserIds" | "distributionUserIds", id: string) =>
    set(k, v[k].includes(id) ? v[k].filter((x) => x !== id) : [...v[k], id]);

  const editing = Boolean(initial);
  const mustBeComplete = editing && initial?.status !== "draft";
  const missing = [
    v.subject.trim().length < 3 && t("rfi.form.subject"),
    !v.question.trim() && t("rfi.form.question"),
    v.assigneeUserIds.length === 0 && t("rfi.form.assignees"),
    !v.dueDate && t("rfi.form.due")
  ].filter((x): x is string => Boolean(x));

  // Cost and internal fields go only to roles that may set them; the Function refuses them otherwise.
  const payload = (): RfiInput => {
    const { costImpact, scheduleImpact, costImpactAmount, scheduleImpactDays, internalNote, ...rest } = v;
    return {
      ...rest,
      subject: v.subject.trim(),
      ...(seesCost ? { costImpact, scheduleImpact, costImpactAmount, scheduleImpactDays } : {}),
      ...(seesInternal ? { internalNote } : {})
    };
  };

  async function save(submit: boolean) {
    setTried(true);
    if ((submit || mustBeComplete) && missing.length) { toast(fmt(t("rfi.form.missing"), { fields: missing.join(", ") }), "warn"); return; }
    if (v.subject.trim().length < 3) { toast(t("rfi.form.needSubject"), "warn"); return; }
    try {
      const detail = initial
        ? await action.mutateAsync({ action: "edit", rfiId: initial.ItemId, changes: payload() })
        : await action.mutateAsync({ action: "create", clientRequestId: requestId, submit, ...payload() });
      toast(initial ? t("rfi.toast.edited") : submit ? fmt(t("rfi.toast.submitted"), { number: detail.rfi.number, name: detail.rfi.ballInCourtName || "" }) : t("rfi.toast.draft"));
      onDone(detail.rfi.ItemId);
    } catch (error) {
      toast(errorText(error, t), "warn");
    }
  }

  const required = (bad: boolean) => (tried && bad ? <span style={{ color: "hsl(var(--m-red-fg))" }}>{t("rfi.form.required")}</span> : undefined);
  const busy = action.isPending;

  return (
    <Dialog
      title={<span className="m-row">{initial ? <Pencil size={18} /> : <FilePlus2 size={18} />}{initial ? fmt(t("rfi.form.editTitle"), { number: initial.number || t("rfi.status.draft") }) : t("rfi.new")}</span>}
      onClose={onClose}
      size="lg"
      footer={
        <>
          {!initial ? <span className="m-muted m-small" style={{ marginRight: "auto" }}>{t("rfi.form.numberHint")}</span> : null}
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          {initial ? (
            <Button onClick={() => save(false)} disabled={busy} icon={busy ? <Loader2 className="spin" size={15} /> : undefined}>{t("common.save")}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => save(false)} disabled={busy}>{t("rfi.form.saveDraft")}</Button>
              <Button icon={busy ? <Loader2 className="spin" size={15} /> : <Send size={15} />} onClick={() => save(true)} disabled={busy}>{t("rfi.form.submit")}</Button>
            </>
          )}
        </>
      }
    >
      <div className="m-form">
        <Field label={`${t("rfi.form.subject")} *`} wide hint={required(v.subject.trim().length < 3)}>
          <input className="m-input" value={v.subject} maxLength={200} onChange={(e) => set("subject", e.target.value)} placeholder={t("rfi.form.subjectPh")} autoFocus />
        </Field>
        <Field label={`${t("rfi.form.question")} *`} wide hint={required(!v.question.trim())}>
          <textarea className="m-input" value={v.question} onChange={(e) => set("question", e.target.value)} placeholder={t("rfi.form.questionPh")} />
        </Field>
        <Field label={t("rfi.form.suggested")} wide>
          <textarea className="m-input" value={v.suggestedAnswer} onChange={(e) => set("suggestedAnswer", e.target.value)} placeholder={t("rfi.form.suggestedPh")} style={{ minHeight: 60 }} />
        </Field>
        <Field label={t("rfi.discipline")}><Select value={v.discipline} onChange={(x) => set("discipline", x)} placeholder={t("rfi.form.choose")} options={DISCIPLINES} /></Field>
        <Field label={t("rfi.location")}><input className="m-input" value={v.location} maxLength={120} onChange={(e) => set("location", e.target.value)} placeholder={t("rfi.form.locationPh")} /></Field>
        <Field label={`${t("rfi.form.due")} *`} hint={fmt(t("rfi.form.dueHint"), { date: fmtShortDate(addWorkingDays(today, 7)) })}>
          <input className="m-input" type="date" value={v.dueDate} min={today} onChange={(e) => set("dueDate", e.target.value)} />
        </Field>
        <Field label={t("rfi.priority")}>
          <Select value={v.priority} onChange={(x) => set("priority", x as RfiInput["priority"])} options={(["low", "normal", "high"] as const).map((p) => ({ value: p, label: t(`rfi.priority.${p}` as TranslationKey) }))} />
        </Field>
        <Field label={`${t("rfi.form.assignees")} *`} wide hint={required(v.assigneeUserIds.length === 0) ?? t("rfi.form.assigneesHint")}>
          <div className="m-rfis-pick">
            {answerers.map((p) => (
              <Checkbox key={p.userId} checked={v.assigneeUserIds.includes(p.userId)} onChange={() => toggle("assigneeUserIds", p.userId)}
                label={<span>{ctx.nameOf(p.userId, p.displayName)} <span className="m-muted m-small">· {p.companyName}</span></span>} />
            ))}
          </div>
        </Field>
        <Field label={t("rfi.form.distribution")} wide hint={t("rfi.form.distributionHint")}>
          <div className="m-rfis-pick">
            {team.filter((p) => !v.assigneeUserIds.includes(p.userId)).map((p) => (
              <Checkbox key={p.userId} checked={v.distributionUserIds.includes(p.userId)} onChange={() => toggle("distributionUserIds", p.userId)}
                label={<span>{ctx.nameOf(p.userId, p.displayName)} <span className="m-muted m-small">· {p.companyName}</span></span>} />
            ))}
          </div>
        </Field>
        {seesCost ? (
          <>
            <Field label={t("rfi.costImpact")}><Select value={v.costImpact ?? "tbd"} onChange={(x) => set("costImpact", x as Impact)} options={impactOptions(t)} /></Field>
            <Field label={t("rfi.scheduleImpact")}><Select value={v.scheduleImpact ?? "tbd"} onChange={(x) => set("scheduleImpact", x as Impact)} options={impactOptions(t)} /></Field>
            {v.costImpact === "yes" ? (
              <Field label={t("rfi.form.amount")}><input className="m-input" type="number" min={0} step="0.01" value={v.costImpactAmount ?? ""} onChange={(e) => set("costImpactAmount", e.target.value === "" ? "" : Number(e.target.value))} /></Field>
            ) : null}
            {v.scheduleImpact === "yes" ? (
              <Field label={t("rfi.form.days")}><input className="m-input" type="number" min={0} step={1} value={v.scheduleImpactDays ?? ""} onChange={(e) => set("scheduleImpactDays", e.target.value === "" ? "" : Number(e.target.value))} /></Field>
            ) : null}
          </>
        ) : (
          <Field label={t("rfi.form.impactTitle")} wide><span className="m-muted m-small">{t("rfi.form.impactHidden")}</span></Field>
        )}
        {seesInternal ? (
          <Field label={t("rfi.internalNote")} wide hint={t("rfi.internalNoteHint")}>
            <textarea className="m-input" value={v.internalNote ?? ""} onChange={(e) => set("internalNote", e.target.value)} style={{ minHeight: 60 }} />
          </Field>
        ) : null}
        <Field label={t("rfi.form.attachments")} wide hint={t("rfi.later.files")}>
          <div><Button variant="secondary" small icon={<Paperclip size={14} />} disabled title={t("rfi.later.files")}>{t("rfi.form.addFiles")}</Button></div>
        </Field>
      </div>
    </Dialog>
  );
}

const impactOptions = (t: T) => (["no", "tbd", "yes"] as const).map((x) => ({ value: x, label: t(`rfi.impact.${x}` as TranslationKey) }));

// ---------- detail ----------
type DialogKind = "" | "edit" | "reassign" | "void" | "askAgain" | "reopen";

const HISTORY_TONE: Record<string, Tone> = {
  submitted: "blue", draftCreated: "gray", edited: "gray", ballChanged: "amber", responded: "gray", officialAnswer: "green",
  answeredOfficially: "green", askedAgain: "amber", closed: "green", reopened: "purple", voided: "red"
};
const HISTORY_KEYS = new Set(Object.keys(HISTORY_TONE));

function RfiDetailView({ ctx, rfiId }: { ctx: Ctx; rfiId: string }) {
  const { t, project, team, myUserId, myRole, today, nameOf, companyOf, toast, onNavigate } = ctx;
  const detail = useRfi(project.ItemId, rfiId);
  const action = useRfiAction(project.ItemId);
  const [tab, setTab] = useState<"responses" | "history">("responses");
  const [reply, setReply] = useState("");
  const [asOfficial, setAsOfficial] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>("");
  const seesCost = projectCan(myRole, "rfi.see_cost");
  const seesInternal = projectCan(myRole, "rfi.see_internal");

  const back = <Button variant="ghost" small icon={<ArrowLeft size={14} />} onClick={() => onNavigate("/rfis")}>{t("rfi.back")}</Button>;
  if (detail.isLoading) return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  if (!detail.data) {
    return (
      <Panel>
        <Empty icon={<Lock size={28} />} title={t("rfi.cantOpen")}>
          {detail.error ? errorText(detail.error, t) : null} {back}
        </Empty>
      </Panel>
    );
  }

  const { rfi, can, responses, history } = detail.data;
  const overdue = isOverdue(rfi, today);
  const ballName = nameOf(rfi.ballInCourtUserId, rfi.ballInCourtName);
  const busy = action.isPending;

  async function run(body: Parameters<typeof action.mutateAsync>[0], ok?: string) {
    try {
      await action.mutateAsync(body);
      if (ok) toast(ok);
      return true;
    } catch (error) {
      toast(errorText(error, t), "warn");
      return false;
    }
  }

  async function postReply() {
    const text = reply.trim();
    if (!text) return;
    const done = await run({ action: "respond", rfiId: rfi.ItemId, body: text, asOfficial: asOfficial || undefined }, asOfficial ? t("rfi.toast.officialPosted") : t("rfi.toast.responded"));
    if (done) { setReply(""); setAsOfficial(false); }
  }

  const stepIndex = rfi.status === "void" ? -1 : ["draft", "open", "answered", "closed"].indexOf(rfi.status);
  const respondWhy =
    rfi.status === "draft" ? t("rfi.why.draft")
      : rfi.status === "closed" ? t("rfi.why.closed")
        : rfi.status === "void" ? t("rfi.why.void")
          : myRole === "owner-viewer" ? t("rfi.why.owner")
            : t("rfi.why.notAssigned");
  const anyAction = can.submit || can.edit || can.reassign || can.askAgain || can.close || can.reopen || can.void;
  const official = responses.find((r) => r.ItemId === rfi.officialResponseId);
  const people = (ids?: string[]) => (ids ?? []).map((u) => ({ id: u, name: nameOf(u), company: companyOf(u) }));

  return (
    <>
      <div className="m-rfis-head">
        <div>
          <div className="m-rfis-back">{back}</div>
          <div className="m-rfis-head-meta">
            <span className="m-mono m-strong">{rfi.number || t("rfi.status.draft")}</span>
            <StatusPill status={rfi.status} t={t} />
            {overdue ? <Badge tone="red">{t("rfi.overdue")}</Badge> : null}
            {rfi.priority === "high" ? <Badge tone="red">{t("rfi.priority.high")}</Badge> : null}
            {rfi.discipline ? <Badge tone="teal">{rfi.discipline}</Badge> : null}
          </div>
          <h1>{rfi.subject}</h1>
          <span className="m-muted m-small">
            {fmt(t("rfi.raisedBy"), { name: nameOf(rfi.createdByUserId, rfi.createdByName), company: companyOf(rfi.createdByUserId) || "—", date: fmtDate(rfi.createdAt) })}
            {rfi.location ? ` · ${rfi.location}` : ""}
          </span>
        </div>
        {rfi.ballInCourtUserId && LIVE.includes(rfi.status) ? (
          <div className={cx("m-rfis-ball", overdue && "m-rfis-ball-over")}>
            <Avatar name={ballName || "?"} color={colorFor(ballName || "?")} size={42} />
            <div>
              <span className="m-rfis-ball-label">{t("rfi.ballInCourt")}</span>
              <strong>{ballName}{rfi.ballInCourtUserId === myUserId ? ` (${t("rfi.you")})` : ""}</strong>
              <span className="m-small m-muted">{companyOf(rfi.ballInCourtUserId)} · {t(`rfi.ballRole.${rfi.ballInCourtRole ?? "assignee"}` as TranslationKey)}</span>
              <div className="m-small" style={{ marginTop: 4 }}>{t("rfi.col.due")} <DueLabel due={rfi.dueDate} done={rfi.status !== "open" && rfi.status !== "draft"} today={today} t={t} /></div>
            </div>
          </div>
        ) : null}
      </div>

      <ol className="m-rfis-stepper" aria-label={t("rfi.col.status")}>
        {(["draft", "open", "answered", "closed"] as RfiStatus[]).map((s, i) => (
          <li key={s} className={cx("m-rfis-step", stepIndex > i && "m-rfis-step-done", stepIndex === i && (s === "closed" ? "m-rfis-step-done" : "m-rfis-step-current"))}>
            <span className="m-rfis-step-dot">{stepIndex > i || (stepIndex === i && s === "closed") ? <Check size={12} /> : i + 1}</span>{t(`rfi.status.${s}` as TranslationKey)}
          </li>
        ))}
        {rfi.status === "void" ? <li className="m-rfis-step m-rfis-step-void"><span className="m-rfis-step-dot"><XCircle size={12} /></span>{t("rfi.status.void")}</li> : null}
      </ol>

      {anyAction ? (
        <div className="m-toolbar">
          {can.submit ? <Button icon={<Send size={15} />} disabled={busy} onClick={() => run({ action: "submit", rfiId: rfi.ItemId }, t("rfi.toast.submittedDraft"))}>{t("rfi.action.submit")}</Button> : null}
          {can.edit ? <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => setDialog("edit")}>{t("rfi.action.edit")}</Button> : null}
          {can.reassign ? <Button variant="secondary" icon={<UserRoundCog size={15} />} onClick={() => setDialog("reassign")}>{t("rfi.action.reassign")}</Button> : null}
          {can.askAgain ? <Button variant="secondary" icon={<RotateCcw size={15} />} onClick={() => setDialog("askAgain")}>{t("rfi.action.askAgain")}</Button> : null}
          {can.close ? <Button variant="success" icon={<CheckCircle2 size={15} />} disabled={busy} onClick={() => run({ action: "close", rfiId: rfi.ItemId }, t("rfi.toast.closed"))}>{t("rfi.action.close")}</Button> : null}
          {can.reopen ? <Button variant="secondary" icon={<RotateCcw size={15} />} onClick={() => setDialog("reopen")}>{t("rfi.action.reopen")}</Button> : null}
          {can.void ? <Button variant="danger" icon={<XCircle size={15} />} onClick={() => setDialog("void")}>{t("rfi.action.void")}</Button> : null}
        </div>
      ) : can.respond ? null : (
        <div style={{ marginBottom: 12 }}><Note>{rfi.status === "closed" || rfi.status === "void" ? t("rfi.readOnlyFinal") : t("rfi.readOnly")}</Note></div>
      )}
      {rfi.status === "void" && rfi.voidReason ? <div style={{ marginBottom: 12 }}><Note tone="warn">{fmt(t("rfi.voidedBecause"), { reason: rfi.voidReason })}</Note></div> : null}

      <div className="m-grid m-grid-main" style={{ marginTop: 12 }}>
        <div className="m-stack-v" style={{ gap: 16, alignContent: "start" }}>
          <Panel title={t("rfi.form.question")}>
            <p className="m-rfis-question">{rfi.question || <span className="m-muted">{t("rfi.noQuestion")}</span>}</p>
            {rfi.suggestedAnswer ? <p className="m-rfis-suggested"><b>{t("rfi.form.suggested")}:</b> {rfi.suggestedAnswer}</p> : null}
          </Panel>

          {rfi.officialAnswerText ? (
            <Panel title={<span className="m-row"><Star size={16} />{t("rfi.officialAnswer")}</span>}>
              <div className="m-msg m-msg-official">
                {official ? (
                  <div className="m-rfis-msg-head">
                    <PersonChip name={nameOf(official.authorUserId, official.authorName)} sub={companyOf(official.authorUserId)} />
                    <span className="m-muted m-small">{fmtDateTime(official.postedAt)}</span>
                  </div>
                ) : null}
                <p className="m-rfis-msg-text">{rfi.officialAnswerText}</p>
              </div>
            </Panel>
          ) : null}

          <Panel>
            <Tabs<"responses" | "history">
              tabs={[{ key: "responses", label: t("rfi.responses"), count: responses.length }, { key: "history", label: t("rfi.history"), count: history.length }]}
              value={tab}
              onChange={setTab}
            />
            {tab === "responses" ? (
              <>
                {responses.length === 0 ? (
                  <Empty icon={<MessageSquare size={24} />} title={t("rfi.noResponses")}>
                    {rfi.status === "draft" ? t("rfi.why.draft") : ballName ? fmt(t("rfi.waitingFor"), { name: ballName }) : null}
                  </Empty>
                ) : null}
                <div className="m-thread">
                  {responses.map((r) => {
                    const mayMark = !r.isOfficial && (can.markOfficial || (can.markOfficialOwn && r.authorUserId === myUserId));
                    return (
                      <div key={r.ItemId} className={cx("m-msg", r.isOfficial && "m-msg-official")}>
                        <div className="m-rfis-msg-head">
                          <PersonChip name={nameOf(r.authorUserId, r.authorName)} sub={companyOf(r.authorUserId)} />
                          <span className="m-row">
                            {r.isOfficial ? <Badge tone="green"><Star size={11} /> {t("rfi.official")}</Badge> : null}
                            <span className="m-muted m-small">{fmtDateTime(r.postedAt)}</span>
                          </span>
                        </div>
                        <p className="m-rfis-msg-text">{r.body}</p>
                        {mayMark ? (
                          <div className="m-row" style={{ marginTop: 8 }}>
                            <Button small variant="secondary" icon={<Star size={13} />} disabled={busy}
                              onClick={() => run({ action: "markOfficial", rfiId: rfi.ItemId, responseId: r.ItemId }, t("rfi.toast.markedOfficial"))}>
                              {t("rfi.action.markOfficial")}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {can.respond ? (
                  <div className="m-rfis-composer">
                    <textarea className="m-input" value={reply} onChange={(e) => setReply(e.target.value)}
                      placeholder={rfi.ballInCourtUserId === myUserId && rfi.ballInCourtRole === "assignee" ? t("rfi.replyAnswerPh") : t("rfi.replyPh")} />
                    <div className="m-row m-row-wrap">
                      {can.markOfficial || can.markOfficialOwn ? <Checkbox checked={asOfficial} onChange={setAsOfficial} label={t("rfi.postAsOfficial")} /> : null}
                      <Button variant="secondary" small icon={<Paperclip size={14} />} disabled title={t("rfi.later.files")}>{t("rfi.attach")}</Button>
                      <span style={{ flex: 1 }} />
                      <Button icon={busy ? <Loader2 className="spin" size={14} /> : <Send size={14} />} onClick={postReply} disabled={!reply.trim() || busy}>{t("rfi.post")}</Button>
                    </div>
                  </div>
                ) : <div style={{ marginTop: 12 }}><Note>{respondWhy}</Note></div>}
              </>
            ) : history.length === 0 ? (
              <Empty title={t("rfi.noHistory")} />
            ) : (
              <Timeline
                items={history.map((h) => ({
                  who: h.actorName,
                  when: fmtDateTime(h.at),
                  title: HISTORY_KEYS.has(h.action) ? t(`rfi.event.${h.action}` as TranslationKey) : h.action,
                  body: <>{h.summary}{h.reason ? <div><i>“{h.reason}”</i></div> : null}</>,
                  tone: HISTORY_TONE[h.action] ?? "gray"
                }))}
              />
            )}
          </Panel>
        </div>

        <div className="m-stack-v" style={{ gap: 16, alignContent: "start" }}>
          <Panel title={t("rfi.details")}>
            <KeyValue items={[
              [t("rfi.col.status"), <StatusPill key="s" status={rfi.status} t={t} />],
              [t("rfi.priority"), t(`rfi.priority.${rfi.priority ?? "normal"}` as TranslationKey)],
              [t("rfi.col.due"), <DueLabel key="d" due={rfi.dueDate} done={rfi.status !== "open" && rfi.status !== "draft"} today={today} t={t} />],
              [t("rfi.discipline"), rfi.discipline || "—"],
              [t("rfi.location"), rfi.location || "—"],
              [t("rfi.created"), fmtDate(rfi.createdAt)],
              [t("rfi.submitted"), rfi.openedDate ? fmtDate(rfi.openedDate) : "—"],
              [t("rfi.answered"), rfi.answeredDate ? fmtDate(rfi.answeredDate) : "—"],
              [t("rfi.closed"), rfi.closedDate ? fmtDate(rfi.closedDate) : "—"],
              ...(seesCost ? [
                [t("rfi.costImpact"), <ImpactValue key="c" impact={rfi.costImpact} extra={rfi.costImpactAmount != null ? `€ ${rfi.costImpactAmount.toLocaleString("en-GB")}` : ""} t={t} />],
                [t("rfi.scheduleImpact"), <ImpactValue key="t" impact={rfi.scheduleImpact} extra={rfi.scheduleImpactDays != null ? fmt(t("rfi.kpi.days"), { count: rfi.scheduleImpactDays }) : ""} t={t} />]
              ] as [ReactNode, ReactNode][] : [])
            ]} />
            {!seesCost ? <p className="m-muted m-small" style={{ marginBottom: 0 }}>{t("rfi.costHidden")}</p> : null}
          </Panel>

          {seesInternal && rfi.internalNote ? (
            <Panel title={<span className="m-row"><Lock size={15} />{t("rfi.internalNote")}</span>}>
              <p className="m-rfis-msg-text" style={{ margin: 0 }}>{rfi.internalNote}</p>
              <p className="m-muted m-small" style={{ marginBottom: 0 }}>{t("rfi.internalNoteHint")}</p>
            </Panel>
          ) : null}

          <Panel title={t("rfi.people")}>
            <div className="m-stack-v">
              <div><div className="m-field-label">{t("rfi.manager")}</div><div style={{ marginTop: 6 }}><PersonChip name={nameOf(rfi.managerUserId)} sub={companyOf(rfi.managerUserId)} /></div></div>
              <div>
                <div className="m-field-label">{t("rfi.form.assignees")}</div>
                <div className="m-stack-v" style={{ gap: 6, marginTop: 6 }}>
                  {people(rfi.assigneeUserIds).map((p) => <PersonChip key={p.id} name={p.name || "?"} sub={p.company} />)}
                  {!rfi.assigneeUserIds?.length ? <span className="m-muted m-small">—</span> : null}
                </div>
              </div>
              <div>
                <div className="m-field-label">{fmt(t("rfi.distributionCount"), { count: rfi.distributionUserIds?.length ?? 0 })}</div>
                <div className="m-row m-row-wrap" style={{ marginTop: 6 }}>
                  {people(rfi.distributionUserIds).map((p) => <Avatar key={p.id} name={p.name || "?"} color={colorFor(p.name || "?")} title={`${p.name} · ${p.company}`} />)}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title={<span className="m-row"><AlarmClock size={16} />{t("rfi.comingNext")}</span>}>
            <ul className="m-small m-muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              <li>{t("rfi.later.notify")}</li>
              <li>{t("rfi.later.files")}</li>
              <li>{t("rfi.later.reminders")}</li>
              <li>{t("rfi.later.pdf")} <ReleaseTag release="R2" /></li>
              <li>{t("rfi.later.links")} <ReleaseTag release="R2" /></li>
            </ul>
          </Panel>
        </div>
      </div>

      {dialog === "edit" ? (
        <RfiFormDialog ctx={ctx} seesCost={seesCost} seesInternal={seesInternal} initial={rfi} onClose={() => setDialog("")} onDone={() => setDialog("")} />
      ) : null}
      {dialog === "reassign" ? (
        <ReassignDialog
          t={t}
          title={fmt(t("rfi.reassignTitle"), { number: rfi.number || t("rfi.status.draft") })}
          options={team.filter((r) => r.role !== "owner-viewer" && r.userId !== rfi.ballInCourtUserId).map((r) => ({ value: r.userId, label: `${nameOf(r.userId, r.displayName)} · ${r.companyName ?? ""}` }))}
          busy={busy}
          onClose={() => setDialog("")}
          onSave={async (toUserId, note) => { if (await run({ action: "reassign", rfiId: rfi.ItemId, toUserId, note }, fmt(t("rfi.toast.reassigned"), { name: nameOf(toUserId) }))) setDialog(""); }}
        />
      ) : null}
      {dialog === "void" || dialog === "askAgain" || dialog === "reopen" ? (
        <ReasonDialog
          t={t}
          kind={dialog}
          number={rfi.number || t("rfi.status.draft")}
          busy={busy}
          onClose={() => setDialog("")}
          onSave={async (reason) => {
            const ok = dialog === "void" ? t("rfi.toast.voided") : dialog === "askAgain" ? t("rfi.toast.askedAgain") : t("rfi.toast.reopened");
            if (await run({ action: dialog, rfiId: rfi.ItemId, reason }, ok)) setDialog("");
          }}
        />
      ) : null}
    </>
  );
}

function ImpactValue({ impact, extra, t }: { impact?: Impact; extra?: string; t: T }) {
  const v = impact ?? "tbd";
  return <span className="m-row"><Badge tone={IMPACT_TONE[v]}>{t(`rfi.impact.${v}` as TranslationKey)}</Badge>{v === "yes" && extra ? <span>{extra}</span> : null}</span>;
}

function ReassignDialog({ t, title, options, busy, onClose, onSave }: {
  t: T; title: string; options: { value: string; label: string }[]; busy: boolean; onClose: () => void; onSave: (to: string, note: string) => void;
}) {
  const [to, setTo] = useState(options[0]?.value ?? "");
  const [note, setNote] = useState("");
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button icon={<UserRoundCog size={15} />} onClick={() => onSave(to, note.trim())} disabled={!to || busy}>{t("rfi.action.reassign")}</Button></>}
    >
      <div className="m-stack-v">
        <Field label={t("rfi.newBall")}><Select value={to} onChange={setTo} options={options} /></Field>
        <Field label={t("rfi.noteOptional")}><textarea className="m-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("rfi.notePh")} /></Field>
        <Note>{t("rfi.later.notify")}</Note>
      </div>
    </Dialog>
  );
}

function ReasonDialog({ t, kind, number, busy, onClose, onSave }: {
  t: T; kind: "void" | "askAgain" | "reopen"; number: string; busy: boolean; onClose: () => void; onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const title = fmt(t(`rfi.${kind}Title` as TranslationKey), { number });
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant={kind === "void" ? "danger" : "primary"} onClick={() => onSave(reason.trim())} disabled={!reason.trim() || busy}>{t(`rfi.action.${kind}` as TranslationKey)}</Button>
        </>
      }
    >
      <div className="m-stack-v">
        <Note tone={kind === "void" ? "warn" : "info"}>{t(`rfi.${kind}Text` as TranslationKey)}</Note>
        <Field label={`${t("rfi.reason")} *`}><textarea className="m-input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </div>
    </Dialog>
  );
}
