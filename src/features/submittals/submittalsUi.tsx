// What the Submittals register and the submittal page share: the context, the status pill, the due
// label, and the New / Edit submittal form (SUB-01), built from the demo app's NewSubmittalDialog
// (mock/src/mock/pages/SubmittalsPage.tsx).
import { useState } from "react";
import { FileStack, Loader2, Pencil, Send } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FunctionRefused } from "../../lib/blocks/functions";
import { ROLE_LABEL } from "../../lib/roles";
import { workingDaysBetween } from "../../lib/workdays";
import { Badge, Button, Dialog, Field, Note, Select, cx, fmt } from "../../shared/m/ui";
import type { Tone, ToastTone } from "../../shared/m/ui";
import type { ProjectRow, TeamRow } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { SUBMITTAL_TYPES, submitByOf, useSubmittalAction, viewOf } from "./submittalsApi";
import type { SubmittalInput, SubmittalList, SubmittalRow, SubmittalType, SubmittalView } from "./submittalsApi";

export type T = (key: TranslationKey) => string;
export type Ctx = {
  t: T;
  project: ProjectRow;
  team: TeamRow[];
  myUserId: string;
  myRole?: string;
  today: string;
  toast: (text: string, tone?: ToastTone) => void;
  onNavigate: (path: string) => void;
};

export const VIEWS: SubmittalView[] = ["draft", "notSubmitted", "withGc", "withReviewer", "resubmit", "approved", "approvedAsNoted", "rejected", "void"];
const VIEW_TONE: Record<SubmittalView, Tone> = {
  draft: "gray", notSubmitted: "gray", withGc: "amber", withReviewer: "blue", resubmit: "red",
  approved: "green", approvedAsNoted: "teal", reviseResubmit: "red", rejected: "red", void: "gray"
};
export const DECISION_TONE: Record<string, Tone> = { approved: "green", approvedAsNoted: "teal", reviseResubmit: "red", rejected: "red" };

// Common MasterFormat sections, offered while typing (any section can be typed).
const SPEC_SUGGESTIONS: [string, string][] = [
  ["03 30 00", "Cast-in-place concrete"], ["05 12 00", "Structural steel framing"], ["07 50 00", "Membrane roofing"],
  ["07 84 00", "Firestopping"], ["08 11 13", "Hollow metal doors and frames"], ["08 44 13", "Glazed curtain walls"],
  ["09 21 16", "Gypsum board assemblies"], ["09 51 13", "Acoustical panel ceilings"], ["09 65 19", "Resilient tile flooring"],
  ["14 21 00", "Traction elevators"], ["21 13 13", "Wet-pipe sprinkler systems"], ["22 42 00", "Plumbing fixtures"],
  ["23 31 13", "Metal ducts"], ["23 64 26", "Rotary-screw water chillers"], ["26 24 16", "Panelboards"],
  ["26 51 00", "Interior lighting"], ["28 31 11", "Fire alarm control panels"]
];
const MAX_LEAD_DAYS = 730;
const MAX_REVIEW_DAYS = 60;

export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const errorText = (error: unknown, t: T) => (error instanceof FunctionRefused ? error.message : t("common.error"));
export const isOpenStep = (s: Pick<SubmittalRow, "status">) => s.status === "awaitingSubmission" || s.status === "inGcReview" || s.status === "inDesignReview";
export const roleName = (t: T, role: string) => (role in ROLE_LABEL ? t(ROLE_LABEL[role as keyof typeof ROLE_LABEL].label) : role);
export const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function ViewPill({ s, t }: { s: Pick<SubmittalRow, "status" | "decision" | "revision">; t: T }) {
  const v = viewOf(s);
  return <Badge tone={VIEW_TONE[v]}>{t(`sub.view.${v}` as TranslationKey)}</Badge>;
}

/** The current step's due date: red once passed, amber in the last two working days. */
export function SubDue({ s, today, t }: { s: Pick<SubmittalRow, "status" | "dueDate">; today: string; t: T }) {
  if (!isOpenStep(s) || !s.dueDate) return <span className="m-muted">—</span>;
  if (s.dueDate < today) return <span className="m-due m-due-over">{fmtShortDate(s.dueDate)} · {fmt(t("rfi.daysOverdue"), { count: workingDaysBetween(s.dueDate, today) })}</span>;
  const left = workingDaysBetween(today, s.dueDate);
  if (left <= 2) return <span className="m-due m-due-soon">{fmtShortDate(s.dueDate)} · {left === 0 ? t("rfi.dueToday") : fmt(t("rfi.daysLeft"), { count: left })}</span>;
  return <span className="m-due">{fmtShortDate(s.dueDate)}</span>;
}

// ---------- New and Edit submittal ----------
type Form = Omit<SubmittalInput, "leadTimeDays" | "gcReviewDays" | "designReviewDays"> & { leadTimeDays: string; gcReviewDays: string; designReviewDays: string };

/**
 * New submittal (no `initial`), or Edit for the PM and the document controller while it is open.
 * The subcontractor can only change before the first submission; a new design reviewer (or contact)
 * gets the ball, and the Function tells them.
 */
export function SubmittalFormDialog({ ctx, list, initial, onClose, onDone }: {
  ctx: Ctx; list: SubmittalList; initial?: SubmittalRow; onClose: () => void; onDone: (id: string) => void;
}) {
  const { t, project, today, toast } = ctx;
  const action = useSubmittalAction(project.ItemId);
  const [requestId] = useState(newRequestId);
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(true);
  const [v, setV] = useState<Form>(() => ({
    title: initial?.title ?? "",
    specSection: initial?.specSection ?? "",
    specSectionTitle: initial?.specSectionTitle ?? "",
    type: initial?.type ?? "shopDrawing",
    responsibleCompanyId: initial?.responsibleCompanyId ?? (list.companies.length === 1 ? list.companies[0]!.companyId : ""),
    responsibleUserId: initial?.responsibleUserId ?? "",
    designReviewerUserId: initial?.designReviewerUserId ?? (list.reviewers.length === 1 ? list.reviewers[0]!.userId : ""),
    gcReviewerUserId: initial?.gcReviewerUserId ?? "",
    requiredOnSiteDate: initial?.requiredOnSiteDate ?? "",
    leadTimeDays: String(initial?.leadTimeDays ?? 28),
    gcReviewDays: String(initial?.gcReviewDays ?? list.defaults.gcReviewDays),
    designReviewDays: String(initial?.designReviewDays ?? list.defaults.designReviewDays),
    description: initial?.description ?? "",
    internalNotes: initial?.internalNotes ?? ""
  }));
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setV((prev) => ({ ...prev, [k]: value }));

  const editing = Boolean(initial);
  const companyLocked = editing && initial!.status !== "draft" && initial!.status !== "awaitingSubmission";
  const company = list.companies.find((c) => c.companyId === v.responsibleCompanyId);
  const n = (x: string) => (x.trim() === "" ? NaN : Number(x));
  const lead = n(v.leadTimeDays);
  const gc = n(v.gcReviewDays);
  const design = n(v.designReviewDays);
  const daysOk = (x: number, min: number, max: number) => Number.isInteger(x) && x >= min && x <= max;
  const by = daysOk(lead, 0, MAX_LEAD_DAYS) && daysOk(gc, 1, MAX_REVIEW_DAYS) && daysOk(design, 1, MAX_REVIEW_DAYS) ? submitByOf(v.requiredOnSiteDate, lead, gc, design) : "";
  const late = Boolean(by) && by < today;

  const problems: [keyof Form, string][] = [
    ["specSection", !v.specSection.trim() ? t("sub.form.needSpec") : ""],
    ["title", v.title.trim().length < 3 ? t("sub.form.needTitle") : ""],
    ["responsibleCompanyId", !v.responsibleCompanyId ? t("sub.form.needCompany") : ""],
    ["designReviewerUserId", !v.designReviewerUserId ? t("sub.form.needReviewer") : ""],
    ["requiredOnSiteDate", !v.requiredOnSiteDate ? t("sub.form.needOnSite") : ""],
    ["leadTimeDays", !daysOk(lead, 0, MAX_LEAD_DAYS) ? fmt(t("sub.form.badDays"), { min: 0, max: MAX_LEAD_DAYS }) : ""],
    ["gcReviewDays", !daysOk(gc, 1, MAX_REVIEW_DAYS) ? fmt(t("sub.form.badDays"), { min: 1, max: MAX_REVIEW_DAYS }) : ""],
    ["designReviewDays", !daysOk(design, 1, MAX_REVIEW_DAYS) ? fmt(t("sub.form.badDays"), { min: 1, max: MAX_REVIEW_DAYS }) : ""]
  ];
  const hint = (k: keyof Form, normal?: string) => {
    const p = tried ? problems.find(([key]) => key === k)?.[1] : "";
    return p ? <span style={{ color: "hsl(var(--m-red-fg))" }}>{p}</span> : normal;
  };

  // Typing a known section fills its title (when it is still empty).
  const onSpec = (code: string) => {
    const known = SPEC_SUGGESTIONS.find(([c]) => c === code.trim());
    setV((prev) => ({ ...prev, specSection: code, specSectionTitle: known && !prev.specSectionTitle.trim() ? known[1] : prev.specSectionTitle }));
  };

  const input = (): SubmittalInput => ({
    title: v.title.trim(),
    specSection: v.specSection.trim(),
    specSectionTitle: v.specSectionTitle.trim(),
    type: v.type,
    responsibleCompanyId: v.responsibleCompanyId,
    responsibleUserId: v.responsibleUserId ?? "",
    designReviewerUserId: v.designReviewerUserId,
    gcReviewerUserId: v.gcReviewerUserId ?? "",
    requiredOnSiteDate: v.requiredOnSiteDate,
    leadTimeDays: lead,
    gcReviewDays: gc,
    designReviewDays: design,
    description: v.description?.trim() ?? "",
    ...(list.can.seeInternal ? { internalNotes: v.internalNotes?.trim() ?? "" } : {})
  });

  async function save(send: boolean) {
    setTried(true);
    setSending(send);
    const missing = problems.filter(([, p]) => p);
    if (missing.length) { toast(missing[0]![1], "warn"); return; }
    try {
      if (initial) {
        // Only what changed: the Function writes one history line naming it.
        const next = input();
        const changes = Object.fromEntries(
          (Object.keys(next) as (keyof SubmittalInput)[])
            .filter((k) => String(next[k] ?? "") !== String(initial[k as keyof SubmittalRow] ?? ""))
            .filter((k) => !(k === "gcReviewerUserId" && !next.gcReviewerUserId))
            .map((k) => [k, next[k]])
        ) as Partial<SubmittalInput>;
        if (!Object.keys(changes).length) { onClose(); return; }
        const d = await action.mutateAsync({ action: "edit", submittalId: initial.ItemId, version: initial.version, changes });
        toast(fmt(t("sub.toast.edited"), { number: d.submittal.number }));
        onDone(d.submittal.ItemId);
        return;
      }
      const d = await action.mutateAsync({ action: "create", clientRequestId: requestId, send, ...input(), ...(v.responsibleUserId ? {} : { responsibleUserId: undefined }), ...(v.gcReviewerUserId ? {} : { gcReviewerUserId: undefined }) });
      const s = d.submittal;
      toast(send ? fmt(t("sub.toast.sent"), { number: s.number, company: s.responsibleCompanyName ?? "" }) : fmt(t("sub.toast.draft"), { number: s.number }));
      onDone(s.ItemId);
    } catch (error) {
      toast(errorText(error, t), "warn");
    }
  }

  const busy = action.isPending;
  const noCompanies = list.companies.length === 0;
  const noReviewers = list.reviewers.length === 0;

  return (
    <Dialog
      title={<span className="m-row">{editing ? <Pencil size={18} /> : <FileStack size={18} />}{editing ? fmt(t("sub.editTitle"), { number: initial!.number }) : t("sub.new")}</span>}
      onClose={onClose}
      size="lg"
      footer={
        editing ? (
          <>
            <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
            <Button icon={busy ? <Loader2 className="spin" size={15} /> : undefined} onClick={() => save(false)} disabled={busy}>{t("common.save")}</Button>
          </>
        ) : (
          <>
            <span className="m-muted m-small" style={{ marginRight: "auto" }}>{t("sub.form.numberHint")}</span>
            <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="secondary" icon={busy && !sending ? <Loader2 className="spin" size={15} /> : undefined} onClick={() => save(false)} disabled={busy} title={t("sub.form.draftHint")}>{t("rfi.form.saveDraft")}</Button>
            <Button icon={busy && sending ? <Loader2 className="spin" size={15} /> : <Send size={15} />} onClick={() => save(true)} disabled={busy || noCompanies || noReviewers}>{t("sub.form.send")}</Button>
          </>
        )
      }
    >
      {!editing && (noCompanies || noReviewers) ? (
        <div style={{ marginBottom: 12 }}>
          <Note tone="warn">{noCompanies ? t("sub.form.noCompanies") : ""} {noReviewers ? t("sub.form.noReviewers") : ""}</Note>
        </div>
      ) : null}
      {editing && initial!.status !== "draft" ? <div style={{ marginBottom: 12 }}><Note>{t("sub.form.editNote")}</Note></div> : null}
      <div className="m-form">
        <Field label={`${t("sub.form.spec")} *`} hint={hint("specSection", t("sub.form.specHint"))}>
          <input className="m-input m-mono" list="sub-spec-list" value={v.specSection} maxLength={40} onChange={(e) => onSpec(e.target.value)} placeholder="08 11 13" autoFocus={!editing} />
          <datalist id="sub-spec-list">
            {SPEC_SUGGESTIONS.map(([code, title]) => <option key={code} value={code}>{title}</option>)}
          </datalist>
        </Field>
        <Field label={t("sub.form.specTitle")}>
          <input className="m-input" value={v.specSectionTitle} maxLength={120} onChange={(e) => set("specSectionTitle", e.target.value)} placeholder={t("sub.form.specTitlePh")} />
        </Field>
        <Field label={`${t("sub.form.title")} *`} wide hint={hint("title")}>
          <input className="m-input" value={v.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder={t("sub.form.titlePh")} />
        </Field>
        <Field label={t("sub.form.type")}>
          <Select value={v.type} onChange={(x) => set("type", x as SubmittalType)} options={SUBMITTAL_TYPES.map((x) => ({ value: x, label: t(`sub.type.${x}` as TranslationKey) }))} />
        </Field>
        <Field label={`${t("sub.form.company")} *`} hint={hint("responsibleCompanyId", companyLocked ? t("sub.form.companyLocked") : undefined)}>
          <Select
            value={v.responsibleCompanyId}
            onChange={(x) => setV((prev) => ({ ...prev, responsibleCompanyId: x, responsibleUserId: "" }))}
            placeholder={t("rfi.form.choose")}
            disabled={companyLocked}
            options={[
              ...list.companies.map((c) => ({ value: c.companyId, label: c.trade ? `${c.companyName} · ${c.trade}` : c.companyName })),
              ...(initial && !list.companies.some((c) => c.companyId === initial.responsibleCompanyId) ? [{ value: initial.responsibleCompanyId, label: initial.responsibleCompanyName ?? "" }] : [])
            ]}
          />
        </Field>
        <Field label={t("sub.form.contact")} hint={t("sub.form.contactHint")}>
          <Select
            value={v.responsibleUserId ?? ""}
            onChange={(x) => set("responsibleUserId", x)}
            placeholder={company ? fmt(t("sub.form.contactAuto"), { name: company.people[0]?.displayName ?? "" }) : t("sub.form.contactFirst")}
            disabled={!company}
            options={(company?.people ?? []).map((p) => ({ value: p.userId, label: p.displayName }))}
          />
        </Field>
        <Field label={`${t("sub.form.reviewer")} *`} hint={hint("designReviewerUserId", editing && initial!.status === "inDesignReview" ? t("sub.form.reviewerMoves") : undefined)}>
          <Select value={v.designReviewerUserId} onChange={(x) => set("designReviewerUserId", x)} placeholder={t("rfi.form.choose")} options={list.reviewers.map((p) => ({ value: p.userId, label: `${p.displayName} · ${p.companyName}` }))} />
        </Field>
        <Field label={t("sub.form.gcReviewer")} hint={t("sub.form.gcReviewerHint")}>
          <Select value={v.gcReviewerUserId ?? ""} onChange={(x) => set("gcReviewerUserId", x)} placeholder={t("sub.form.gcAuto")} options={list.gcReviewers.map((p) => ({ value: p.userId, label: `${p.displayName} · ${roleName(t, p.role)}` }))} />
        </Field>
        <Field label={`${t("sub.form.onSite")} *`} hint={hint("requiredOnSiteDate")}>
          <input className="m-input" type="date" value={v.requiredOnSiteDate} onChange={(e) => set("requiredOnSiteDate", e.target.value)} />
        </Field>
        <Field label={t("sub.form.lead")} hint={hint("leadTimeDays", t("sub.form.leadHint"))}>
          <input className="m-input" type="number" min={0} max={MAX_LEAD_DAYS} step={1} value={v.leadTimeDays} onChange={(e) => set("leadTimeDays", e.target.value)} />
        </Field>
        <Field label={t("sub.form.gcDays")} hint={hint("gcReviewDays", fmt(t("sub.form.defaultDays"), { count: list.defaults.gcReviewDays }))}>
          <input className="m-input" type="number" min={1} max={MAX_REVIEW_DAYS} step={1} value={v.gcReviewDays} onChange={(e) => set("gcReviewDays", e.target.value)} />
        </Field>
        <Field label={t("sub.form.designDays")} hint={hint("designReviewDays", fmt(t("sub.form.defaultDays"), { count: list.defaults.designReviewDays }))}>
          <input className="m-input" type="number" min={1} max={MAX_REVIEW_DAYS} step={1} value={v.designReviewDays} onChange={(e) => set("designReviewDays", e.target.value)} />
        </Field>
        <div className="m-field-wide">
          <div className="m-subs-formula">
            {by ? (
              <>
                {fmtDate(v.requiredOnSiteDate)} − <b>{fmt(t("sub.days"), { count: lead })}</b> {t("sub.form.leadWord")} − <b>{fmt(t("sub.workingDays"), { count: gc + design })}</b> {t("sub.form.reviewWord")} = {t("sub.form.submitBy")} <b className={cx(late && "m-subs-late")}>{fmtDate(by)}</b>
                {late ? <Badge tone="red">{t("sub.form.alreadyPassed")}</Badge> : <Badge tone="green">{fmt(t("sub.form.workingDaysLeft"), { count: workingDaysBetween(today, by) })}</Badge>}
              </>
            ) : (
              <span className="m-muted">{t("sub.form.formulaEmpty")}</span>
            )}
          </div>
        </div>
        <Field label={t("sub.form.description")} wide>
          <textarea className="m-input" value={v.description ?? ""} maxLength={4000} onChange={(e) => set("description", e.target.value)} placeholder={t("sub.form.descriptionPh")} style={{ minHeight: 60 }} />
        </Field>
        {list.can.seeInternal ? (
          <Field label={t("sub.form.internal")} wide hint={t("sub.form.internalHint")}>
            <textarea className="m-input" value={v.internalNotes ?? ""} maxLength={2000} onChange={(e) => set("internalNotes", e.target.value)} style={{ minHeight: 50 }} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}
