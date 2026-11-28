// One submittal (PRD SUB-02, SUB-03), built from the demo app's SubmittalDetail
// (mock/src/mock/pages/SubmittalsPage.tsx): the review chain with the ball in court, "Your action"
// (submit the package, the GC check, the design decision), the files of this and earlier
// revisions, comments and history, dates and people. The buttons follow the submittals Function's
// `can` answer; the Function checks everything again.
// Not real yet: reminders before the due date (next step of the module), transmittal PDF (R2),
// parallel reviewers (R3).
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlarmClock, ArrowLeft, Ban, Building2, CheckCircle2, ClipboardCheck, FileStack, Gavel, HardHat, Loader2, Lock, MessageSquare, Pencil,
  Plus, Printer, RotateCcw, Send, Undo2, Users
} from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { projectCan } from "../../lib/permissions";
import { addWorkingDays } from "../../lib/workdays";
import { Badge, Button, Checkbox, Dialog, Empty, Field, KeyValue, Note, Panel, PersonChip, ReleaseTag, Segmented, Timeline, cx, fmt } from "../../shared/m/ui";
import type { Tone } from "../../shared/m/ui";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { SkeletonPage } from "../../shared/m/Skeleton";
import { AttachmentList, AttachmentPicker } from "../files/Attachments";
import type { PickedFile } from "../files/Attachments";
import type { NewAttachment } from "../files/files";
import { SUBMITTAL_DECISIONS, submittalUploadLinks, useSubmittal, useSubmittalAction, useSubmittalList } from "./submittalsApi";
import type { SubmittalDecision, SubmittalDetail, SubmittalRow, SubmittalStep } from "./submittalsApi";
import { DECISION_TONE, SubDue, SubmittalFormDialog, ViewPill, errorText, fmtDateTime, isOpenStep, roleName } from "./submittalsUi";
import type { Ctx, T } from "./submittalsUi";

type DialogKind = "" | "edit" | "void" | "newRevision" | "distribute";

const HISTORY_TONE: Record<string, Tone> = {
  created: "gray", edited: "gray", sent: "blue", submitted: "amber", forwarded: "blue", returned: "red", decided: "green",
  newRevision: "purple", voided: "red", distributed: "teal"
};
const HISTORY_KEYS = new Set(Object.keys(HISTORY_TONE));
const decisionLabel = (t: T, d?: string) => (d ? t(`sub.view.${d}` as TranslationKey) : "");

export function SubmittalDetailView({ ctx, submittalId }: { ctx: Ctx; submittalId: string }) {
  const { t, project, onNavigate } = ctx;
  const detail = useSubmittal(project.ItemId, submittalId);
  const back = <Button variant="ghost" small icon={<ArrowLeft size={14} />} onClick={() => onNavigate("/submittals")}>{t("sub.back")}</Button>;

  if (detail.isLoading) return <><div className="m-subs-back">{back}</div><SkeletonPage kind="detail" label={t("common.loading")} kpis={false} /></>;
  if (detail.error || !detail.data) {
    return (
      <>
        <div className="m-subs-back">{back}</div>
        <Panel>
          <Empty icon={<FileStack size={28} />} title={t("sub.notFound")}>{detail.error ? errorText(detail.error, t) : t("common.error")}</Empty>
        </Panel>
      </>
    );
  }
  return <Loaded key={detail.data.submittal.ItemId} ctx={ctx} data={detail.data} back={back} />;
}

function Loaded({ ctx, data, back }: { ctx: Ctx; data: SubmittalDetail; back: ReactNode }) {
  const { t, project, team, myUserId, today, toast } = ctx;
  const { submittal: s, can, steps, comments, history, files: links } = data;
  const action = useSubmittalAction(project.ItemId);
  // The pickers of the Edit form (only the PM and the document controller get them).
  const list = useSubmittalList(can.edit ? project.ItemId : undefined);
  const [dialog, setDialog] = useState<DialogKind>("");
  const [busyKind, setBusyKind] = useState("");
  const uploadLinks = useMemo(() => submittalUploadLinks(project.ItemId, s.ItemId), [project.ItemId, s.ItemId]);

  // Your action: the package, the GC comment, the decision.
  const [pkg, setPkg] = useState<PickedFile[]>(() => s.files);
  const [pkgUploading, setPkgUploading] = useState(false);
  const [submitNote, setSubmitNote] = useState("");
  const [gcNote, setGcNote] = useState("");
  const [decision, setDecision] = useState<SubmittalDecision>("approved");
  const [markups, setMarkups] = useState<PickedFile[]>([]);
  const [markupUploading, setMarkupUploading] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  // Comments.
  const [comment, setComment] = useState("");
  const [commentFiles, setCommentFiles] = useState<PickedFile[]>([]);
  const [commentUploading, setCommentUploading] = useState(false);

  const busy = action.isPending;
  const rev = s.revision;
  const mine = s.ballInCourtUserId === myUserId;

  async function run(kind: string, body: Parameters<typeof action.mutateAsync>[0], done: (d: SubmittalDetail) => string) {
    setBusyKind(kind);
    try {
      const d = await action.mutateAsync(body);
      toast(done(d));
      return d;
    } catch (error) {
      toast(errorText(error, t), "warn");
      return undefined;
    } finally {
      setBusyKind("");
    }
  }
  const spin = (kind: string, icon: ReactNode) => (busy && busyKind === kind ? <Loader2 className="spin" size={15} /> : icon);

  const send = () => run("send", { action: "send", submittalId: s.ItemId, version: s.version }, (d) => fmt(t("sub.toast.draftSent"), { number: d.submittal.number, company: d.submittal.responsibleCompanyName ?? "" }));

  async function submit() {
    if (pkgUploading) { toast(t("files.wait"), "warn"); return; }
    if (!pkg.length) { toast(t("sub.act.needFiles"), "warn"); return; }
    const attachments = pkg.map((a) => (s.files.some((x) => x.fileId === a.fileId) ? { fileId: a.fileId } : (a as NewAttachment)));
    const d = await run("submit", { action: "submit", submittalId: s.ItemId, version: s.version, attachments, comment: submitNote.trim() || undefined },
      (x) => fmt(t("sub.toast.submitted"), { number: x.submittal.number, name: x.submittal.ballInCourtName ?? "" }));
    if (d) setSubmitNote("");
  }

  async function forward() {
    const d = await run("forward", { action: "forward", submittalId: s.ItemId, version: s.version, comment: gcNote.trim() || undefined },
      (x) => fmt(t("sub.toast.forwarded"), { name: x.submittal.designReviewerName ?? "" }));
    if (d) setGcNote("");
  }

  async function returnToSub() {
    if (gcNote.trim().length < 3) { toast(t("sub.act.needMissing"), "warn"); return; }
    const d = await run("return", { action: "returnToSub", submittalId: s.ItemId, version: s.version, comment: gcNote.trim() },
      () => fmt(t("sub.toast.returned"), { company: s.responsibleCompanyName ?? "" }));
    if (d) { setGcNote(""); setPkg(d.submittal.files); }
  }

  const needMarkup = decision !== "approved";
  const needWhy = decision === "reviseResubmit" || decision === "rejected";
  async function decide() {
    if (markupUploading) { toast(t("files.wait"), "warn"); return; }
    if (needMarkup && !markups.length) { toast(t("sub.act.needMarkup"), "warn"); return; }
    if (needWhy && decisionNote.trim().length < 3) { toast(t("sub.act.needWhy"), "warn"); return; }
    const d = await run("decide", {
      action: "decide", submittalId: s.ItemId, version: s.version, decision, comment: decisionNote.trim() || undefined,
      attachments: markups.length ? (markups as NewAttachment[]) : undefined
    }, (x) => (decision === "reviseResubmit"
      ? fmt(t("sub.toast.resubmit"), { rev: x.submittal.revision, name: x.submittal.ballInCourtName ?? "" })
      : fmt(t("sub.toast.decided"), { decision: decisionLabel(t, decision) })));
    if (d) { setMarkups([]); setDecisionNote(""); setDecision("approved"); setPkg(d.submittal.files); }
  }

  async function postComment() {
    if (commentUploading) { toast(t("files.wait"), "warn"); return; }
    if (!comment.trim()) return;
    const d = await run("comment", { action: "comment", submittalId: s.ItemId, body: comment.trim(), attachments: commentFiles.length ? (commentFiles as NewAttachment[]) : undefined }, () => t("sub.toast.commented"));
    if (d) { setComment(""); setCommentFiles([]); }
  }

  // ---------- the review chain ----------
  const current = s.status === "awaitingSubmission" ? 0 : s.status === "inGcReview" ? 1 : s.status === "inDesignReview" ? 2 : s.status === "closed" ? 3 : -1;
  const bad = s.status === "closed" && s.decision === "rejected";
  const lastDecisionStep = [...steps].reverse().find((x) => x.stepType === "designReview");
  // Once this revision is in, name who submitted it; before that, whoever is asked to.
  const lastSubmit = [...steps].reverse().find((x) => x.stepType === "submit" && x.revision === s.revision);
  const pastSub = s.status === "inGcReview" || s.status === "inDesignReview" || s.status === "closed";
  const subPerson = s.status === "awaitingSubmission" && s.ballInCourtRole === "sub" ? s.ballInCourtName : (pastSub && lastSubmit?.actorName) || s.responsibleName;
  // The same for the GC check and the review: whoever did it on this revision (the PM can act for
  // either), else whoever is assigned.
  const gcDone = [...steps].reverse().find((x) => x.stepType === "gcReview" && x.outcome === "forwarded" && x.revision === s.revision);
  const designDone = [...steps].reverse().find((x) => x.stepType === "designReview" && x.revision === s.revision);
  const nodes: { key: string; title: string; icon: ReactNode; sub: ReactNode; ball: boolean }[] = [
    { key: "sub", title: t("sub.chain.sub"), icon: <HardHat size={20} />, sub: <>{subPerson || t("sub.chain.anyone")}<br />{s.responsibleCompanyName}</>, ball: s.ballInCourtRole === "sub" },
    { key: "gc", title: t("sub.chain.gc"), icon: <ClipboardCheck size={20} />, sub: <>{gcDone?.actorName || s.gcReviewerName}<br />{t("sub.chain.completeness")}</>, ball: s.ballInCourtRole === "gc" },
    { key: "design", title: t("sub.chain.design"), icon: <Building2 size={20} />, sub: <>{designDone?.actorName || s.designReviewerName}<br />{fmt(t("sub.chain.days"), { count: s.designReviewDays })}</>, ball: s.ballInCourtRole === "reviewer" },
    {
      key: "decision", title: t("sub.chain.decision"), icon: <Gavel size={20} />, ball: false,
      sub: s.status === "closed" ? <ViewPill s={s} t={t} /> : lastDecisionStep ? fmt(t("sub.chain.lastDecision"), { rev: lastDecisionStep.revision, decision: decisionLabel(t, lastDecisionStep.outcome) }) : t("sub.chain.pending")
    }
  ];

  // ---------- files: this revision, the last decision, earlier ones ----------
  const earlier = steps.filter((x) => x.attachments.length && !(x.stepType === "submit" && x.revision === rev) && x !== lastDecisionStep);

  // ---------- your action ----------
  const late = s.submitLate;
  const lastReturn = [...steps].reverse().find((x) => x.revision === rev && x.outcome === "returnedIncomplete");
  const lastForward = [...steps].reverse().find((x) => x.revision === rev && x.outcome === "forwarded");
  // The note the previous person left for the next one (the sub's note to the GC, the GC's to the reviewer).
  const noteOf = (step?: SubmittalStep) => step?.comment ? <p className="m-subs-quote"><b>{step.actorName}</b>: {step.comment}</p> : null;
  const awaitingWhy = rev > 0 && s.decisionComment ? (
    <Note tone="warn">
      {fmt(t("sub.act.resubmitNote"), { rev, decision: decisionLabel(t, s.decision ?? "") })} {s.decisionComment ? <i>“{s.decisionComment}”</i> : null}
    </Note>
  ) : null;

  const actionPanel = (() => {
    if (s.status === "void") return <Note>{fmt(t("sub.act.void"), { reason: s.voidReason ?? "" })}</Note>;
    if (can.send) {
      return (
        <div className="m-stack-v">
          <span className="m-small">{fmt(t("sub.act.draft"), { company: s.responsibleCompanyName ?? "" })}</span>
          <div><Button icon={spin("send", <Send size={15} />)} onClick={send} disabled={busy}>{t("sub.sendNow")}</Button></div>
        </div>
      );
    }
    if (can.submit) {
      return (
        <div className="m-stack-v">
          {lastReturn && !awaitingWhy ? <Note tone="warn">{fmt(t("sub.act.returnedNote"), { name: lastReturn.actorName })} <i>“{lastReturn.comment}”</i></Note> : null}
          {awaitingWhy}
          {late ? <Note tone="danger">{fmt(t("sub.act.lateNote"), { date: fmtDate(s.submitByDate) })}</Note> : null}
          {can.onBehalf ? <Note>{fmt(t("sub.act.onBehalfNote"), { company: s.responsibleCompanyName ?? "" })}</Note> : null}
          <Field label={fmt(t("sub.act.packageLabel"), { rev })} hint={t("sub.act.packageHint")}>
            <AttachmentPicker value={pkg} onChange={setPkg} requestLinks={uploadLinks} onBusyChange={setPkgUploading} toast={toast} />
          </Field>
          <Field label={t("sub.act.noteLabel")}>
            <textarea className="m-input" value={submitNote} maxLength={2000} onChange={(e) => setSubmitNote(e.target.value)} placeholder={t("sub.act.notePh")} style={{ minHeight: 50 }} />
          </Field>
          <div>
            <Button icon={spin("submit", <Send size={15} />)} onClick={submit} disabled={busy || pkgUploading || !pkg.length} title={!pkg.length ? t("sub.act.needFiles") : pkgUploading ? t("files.wait") : undefined}>
              {can.onBehalf ? fmt(t("sub.act.submitOnBehalf"), { company: s.responsibleCompanyName ?? "" }) : t("sub.act.submit")}
            </Button>
          </div>
        </div>
      );
    }
    if (can.forward || can.returnToSub) {
      return (
        <div className="m-stack-v">
          <span className="m-small">{fmt(t("sub.act.gcIntro"), { name: s.designReviewerName ?? "", company: s.responsibleCompanyName ?? "" })}</span>
          {noteOf(lastSubmit)}
          <AttachmentList items={s.files} links={links} />
          <textarea className="m-input" value={gcNote} maxLength={2000} onChange={(e) => setGcNote(e.target.value)} placeholder={t("sub.act.gcNotePh")} style={{ minHeight: 60 }} />
          <div className="m-row m-row-wrap">
            <Button icon={spin("forward", <Send size={15} />)} onClick={forward} disabled={busy}>{fmt(t("sub.act.forward"), { name: s.designReviewerName ?? "" })}</Button>
            <Button variant="secondary" icon={spin("return", <Undo2 size={15} />)} onClick={returnToSub} disabled={busy || gcNote.trim().length < 3} title={gcNote.trim().length < 3 ? t("sub.act.needMissing") : undefined}>{t("sub.act.return")}</Button>
          </div>
        </div>
      );
    }
    if (can.decide) {
      return (
        <div className="m-stack-v">
          {s.designReviewerUserId !== myUserId ? <Note>{fmt(t("sub.act.forDesign"), { name: s.designReviewerName ?? "" })}</Note> : null}
          {noteOf(lastSubmit)}
          {noteOf(lastForward)}
          <AttachmentList items={s.files} links={links} />
          <Field label={t("sub.act.decision")}>
            <Segmented<SubmittalDecision> value={decision} onChange={setDecision} options={SUBMITTAL_DECISIONS.map((d) => ({ key: d, label: decisionLabel(t, d) }))} />
          </Field>
          <Field label={`${t("sub.act.markup")}${needMarkup ? " *" : ` (${t("sub.act.optional")})`}`} hint={t("sub.act.markupHint")}>
            <AttachmentPicker value={markups} onChange={setMarkups} requestLinks={uploadLinks} onBusyChange={setMarkupUploading} toast={toast} compact />
          </Field>
          <Field label={`${t("sub.act.comments")}${needWhy ? " *" : ""}`}>
            <textarea className="m-input" value={decisionNote} maxLength={2000} onChange={(e) => setDecisionNote(e.target.value)} placeholder={t("sub.act.commentsPh")} style={{ minHeight: 60 }} />
          </Field>
          {decision === "reviseResubmit" ? <Note tone="warn">{fmt(t("sub.act.resubmitWarn"), { rev: rev + 1, number: s.number, company: s.responsibleCompanyName ?? "" })}</Note> : null}
          {decision === "rejected" ? <Note tone="danger">{t("sub.act.rejectWarn")}</Note> : null}
          <div>
            <Button icon={spin("decide", <Gavel size={15} />)} onClick={decide} disabled={busy || markupUploading || (needMarkup && !markups.length) || (needWhy && decisionNote.trim().length < 3)}
              title={needMarkup && !markups.length ? t("sub.act.needMarkup") : needWhy && decisionNote.trim().length < 3 ? t("sub.act.needWhy") : undefined}>
              {t("sub.act.returnDecision")}
            </Button>
          </div>
        </div>
      );
    }
    if (can.newRevision) {
      return (
        <div className="m-stack-v">
          <Note tone="danger">{t("sub.act.rejectedNote")} {s.decisionComment ? <i>“{s.decisionComment}”</i> : null}</Note>
          <div><Button icon={<RotateCcw size={15} />} onClick={() => setDialog("newRevision")}>{fmt(t("sub.act.openRevision"), { rev: rev + 1 })}</Button></div>
        </div>
      );
    }
    // Nothing for this person to do: say who has it and why.
    const who = isOpenStep(s) ? s.ballInCourtName || t("sub.chain.anyone") : "";
    const why = s.status === "draft" ? t("sub.why.draft")
      : s.status === "closed" ? fmt(t("sub.why.closed"), { decision: decisionLabel(t, s.decision ?? "") })
        : ctx.myRole === "owner-viewer" || ctx.myRole === "superintendent" ? t("sub.why.viewOnly")
          : ctx.myRole === "design-reviewer" && s.status === "inDesignReview" ? fmt(t("sub.why.notYourReview"), { name: s.designReviewerName ?? "" })
            : "";
    return <Note>{who ? fmt(t("sub.why.waiting"), { name: who }) : null} {why}</Note>;
  })();
  const yourTurn = can.send || can.submit || can.forward || can.decide || can.newRevision;

  // ---------- people for Distribute: everyone on the team who may open this submittal ----------
  const canOpen = (role: string, companyId?: string) =>
    projectCan(role, "submittal.view") || (projectCan(role, "submittal.view_own") && companyId === s.responsibleCompanyId);
  const distributable = team.filter((m) => m.userId !== myUserId && canOpen(m.role, m.companyId));

  return (
    <>
      <div className="m-subs-back">{back}</div>
      <div className="m-subs-head">
        <div>
          <div className="m-subs-meta">
            <span className="m-mono m-strong">{s.number}</span>
            <span className="m-subs-rev">{fmt(t("sub.rev"), { rev })}</span>
            <ViewPill s={s} t={t} />
            {s.overdue ? <Badge tone="red">{t("sub.kpi.overdue")}</Badge> : null}
            {s.submitLate ? <Badge tone="red">{t("sub.kpi.late")}</Badge> : null}
            <Badge tone="teal">{t(`sub.type.${s.type}` as TranslationKey)}</Badge>
          </div>
          <h1>{s.title}</h1>
          <span className="m-muted m-small"><span className="m-mono">{s.specSection}</span>{s.specSectionTitle ? ` ${s.specSectionTitle}` : ""} · {s.responsibleCompanyName}</span>
        </div>
        <div className="m-row m-row-wrap">
          {can.distribute ? <Button variant="secondary" icon={<Users size={15} />} onClick={() => setDialog("distribute")}>{t("sub.distribute")}</Button> : null}
          {can.edit ? <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => setDialog("edit")} disabled={!list.data}>{t("sub.edit")}</Button> : null}
          {can.edit || can.distribute ? <Button variant="secondary" icon={<Printer size={15} />} disabled title={t("sub.transmittalLater")}>{t("sub.transmittal")} <ReleaseTag release="R2" /></Button> : null}
          {can.void ? <Button variant="danger" icon={<Ban size={15} />} onClick={() => setDialog("void")}>{t("sub.void")}</Button> : null}
        </div>
      </div>

      <Panel title={t("sub.chain.title")}>
        {s.status === "draft" ? <div style={{ marginBottom: 12 }}><Note>{t("sub.chain.draft")}</Note></div> : null}
        <div className="m-subs-chain">
          {nodes.map((node, i) => {
            const done = i < current || (i === 3 && current === 3 && !bad);
            return (
              <div key={node.key} className={cx("m-subs-node", done && "m-subs-node-done", i === current && i < 3 && "m-subs-node-current", i === 3 && bad && "m-subs-node-bad")}>
                <span className="m-subs-node-icon">{done ? <CheckCircle2 size={20} /> : node.icon}</span>
                <span className="m-subs-node-title">{node.title}</span>
                <span className="m-subs-node-sub">{node.sub}</span>
                {node.ball && isOpenStep(s) ? <span className="m-subs-ball">{t("rfi.ballInCourt")}{mine ? ` · ${t("sub.you")}` : ""}</span> : null}
              </div>
            );
          })}
        </div>
        {isOpenStep(s) && s.ballInCourtName ? <div className="m-small">{t("sub.chain.current")} <b>{s.ballInCourtName}</b> · {t("sub.chain.due")} <SubDue s={s} today={today} t={t} /></div> : null}
      </Panel>

      <div className="m-grid m-grid-main m-subs-detail" style={{ marginTop: 16 }}>
        <div className="m-stack-v" style={{ gap: 16, alignContent: "start" }}>
          <Panel title={t("sub.act.title")} className={cx(yourTurn && "m-subs-action")}>{actionPanel}</Panel>

          <Panel title={fmt(t("sub.files.title"), { rev })}>
            {s.files.length ? <AttachmentList items={s.files} links={links} /> : <span className="m-muted m-small">{t("sub.files.none")}</span>}
            {s.decision && (s.decisionFiles.length || s.decisionComment) ? (
              <>
                <hr className="m-sep" />
                <div className="m-field-label m-row" style={{ marginBottom: 6 }}>
                  {fmt(t("sub.files.lastDecision"), { rev: lastDecisionStep?.revision ?? rev })} <Badge tone={DECISION_TONE[s.decision] ?? "gray"}>{decisionLabel(t, s.decision)}</Badge>
                  <span className="m-muted">· {s.decidedByName} · {fmtDate(s.decidedAt)}</span>
                </div>
                {s.decisionComment ? <p className="m-subs-quote">{s.decisionComment}</p> : null}
                <AttachmentList items={s.decisionFiles} links={links} />
              </>
            ) : null}
            {earlier.length ? (
              <>
                <hr className="m-sep" />
                <div className="m-field-label" style={{ marginBottom: 6 }}>{t("sub.files.earlier")}</div>
                <div className="m-stack-v" style={{ gap: 10 }}>
                  {earlier.map((x) => (
                    <div key={x.ItemId}>
                      <div className="m-small m-muted" style={{ marginBottom: 4 }}>
                        {fmt(t("sub.rev"), { rev: x.revision })} · {t(`sub.step.${x.outcome}` as TranslationKey)} · {x.actorName} · {fmtDate(x.completedAt)}
                      </div>
                      <AttachmentList items={x.attachments} links={links} />
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </Panel>

          <Panel title={<span className="m-row"><MessageSquare size={16} />{fmt(t("sub.comments"), { count: comments.length })}</span>}>
            {comments.length ? (
              <div className="m-thread">
                {comments.map((c) => (
                  <div key={c.ItemId} className="m-msg">
                    <div className="m-row" style={{ justifyContent: "space-between" }}><PersonChip name={c.authorName} /><span className="m-muted m-small">{fmtDateTime(c.postedAt)}</span></div>
                    <p className="m-subs-msg-text">{c.body}</p>
                    <AttachmentList items={c.attachments} links={links} />
                  </div>
                ))}
              </div>
            ) : null}
            {can.comment ? (
              <div className="m-subs-composer" style={{ marginTop: comments.length ? 12 : 0 }}>
                <textarea className="m-input" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder={t("sub.commentPh")} style={{ minHeight: 60 }} />
                <AttachmentPicker value={commentFiles} onChange={setCommentFiles} requestLinks={uploadLinks} onBusyChange={setCommentUploading} toast={toast} compact />
                <div className="m-row m-row-wrap">
                  <span style={{ flex: 1 }} />
                  <Button small icon={spin("comment", <Send size={13} />)} onClick={postComment} disabled={busy || commentUploading || !comment.trim()}>{t("sub.commentPost")}</Button>
                </div>
              </div>
            ) : <div style={{ marginTop: comments.length ? 12 : 0 }}><Note>{s.status === "void" ? t("sub.commentVoid") : t("sub.commentViewOnly")}</Note></div>}
          </Panel>

          <Panel title={t("sub.history")}>
            {history.length === 0 ? <span className="m-muted m-small">{t("sub.historyNone")}</span> : (
              <Timeline
                items={history.map((h) => ({
                  who: h.actorName,
                  when: fmtDateTime(h.at),
                  title: HISTORY_KEYS.has(h.action) ? t(`sub.event.${h.action}` as TranslationKey) : h.action,
                  body: h.summary || h.reason ? <>{h.summary}{h.reason ? <div><i>“{h.reason}”</i></div> : null}</> : undefined,
                  tone: h.action === "decided" ? DECISION_TONE[s.decision ?? ""] ?? "green" : HISTORY_TONE[h.action] ?? "gray"
                }))}
              />
            )}
          </Panel>
        </div>

        <div className="m-stack-v" style={{ gap: 16, alignContent: "start" }}>
          <Panel title={t("sub.dates")}>
            <KeyValue items={[
              [t("sub.form.onSite"), fmtDate(s.requiredOnSiteDate)],
              [t("sub.form.lead"), fmt(t("sub.days"), { count: s.leadTimeDays })],
              [t("sub.reviewTime"), fmt(t("sub.reviewTimeValue"), { gc: s.gcReviewDays, design: s.designReviewDays })],
              [t("sub.form.submitBy"), <span key="b" className={cx(s.submitLate && "m-subs-late")}>{fmtDate(s.submitByDate)}{s.submitLate ? ` · ${t("sub.passed")}` : ""}</span>],
              [t("sub.sent"), s.sentAt ? fmtDate(s.sentAt) : "—"],
              [t("sub.submitted"), s.submittedAt ? fmtDate(s.submittedAt) : "—"],
              [t("sub.decided"), s.decidedAt ? fmtDate(s.decidedAt) : "—"],
              [t("sub.col.due"), <SubDue key="d" s={s} today={today} t={t} />]
            ]} />
            <div className="m-subs-formula" style={{ marginTop: 12 }}>
              {t("sub.formulaShort")} = <b className={cx(s.submitLate && "m-subs-late")}>{fmtShortDate(s.submitByDate)}</b>
            </div>
          </Panel>

          <Panel title={t("sub.people")}>
            <div className="m-stack-v">
              <div><div className="m-field-label">{t("rfi.ballInCourt")}</div>{isOpenStep(s) && s.ballInCourtName ? <PersonChip name={s.ballInCourtName} sub={mine ? t("sub.you") : undefined} /> : <span className="m-muted">—</span>}</div>
              <div><div className="m-field-label">{t("sub.form.company")}</div><PersonChip name={s.responsibleName || s.responsibleCompanyName} sub={s.responsibleName ? s.responsibleCompanyName : t("sub.chain.anyone")} /></div>
              <div><div className="m-field-label">{t("sub.form.gcReviewer")}</div><PersonChip name={s.gcReviewerName} sub={t("sub.chain.completeness")} /></div>
              <div><div className="m-field-label">{t("sub.form.reviewer")}</div><PersonChip name={s.designReviewerName} /></div>
              <div><div className="m-field-label">{t("sub.createdBy")}</div><span className="m-small">{s.createdByName} · {fmtDate(s.createdAt)}</span></div>
            </div>
          </Panel>

          {s.description ? (
            <Panel title={t("sub.form.description")}>
              <p className="m-subs-msg-text" style={{ margin: 0 }}>{s.description}</p>
            </Panel>
          ) : null}

          {can.seeInternal && s.internalNotes ? (
            <Panel title={<span className="m-row"><Lock size={15} />{t("sub.form.internal")}</span>}>
              <p className="m-subs-msg-text" style={{ margin: 0 }}>{s.internalNotes}</p>
              <p className="m-muted m-small" style={{ marginBottom: 0 }}>{t("sub.form.internalHint")}</p>
            </Panel>
          ) : null}

          <Panel title={<span className="m-row"><AlarmClock size={15} />{t("sub.reminders")}</span>}>
            <div className="m-stack-v m-small" style={{ gap: 6 }}>
              {isOpenStep(s) && s.dueDate ? <span>{fmt(t("sub.reminders.before"), { date: fmtShortDate(addWorkingDays(s.dueDate, -2)) })}</span> : <span className="m-muted">{t("sub.reminders.none")}</span>}
              <span className="m-muted">{t("sub.reminders.later")}</span>
              {s.overdue ? <Note tone="danger">{fmt(t("sub.reminders.overdue"), { date: fmtDate(s.dueDate) })}</Note> : null}
            </div>
          </Panel>

          <Panel title={t("sub.parallel")} release="R3">
            <p className="m-muted m-small" style={{ marginTop: 0 }}>{t("sub.parallelText")}</p>
            <div className="m-row" style={{ justifyContent: "space-between" }}><PersonChip name={s.designReviewerName} /><Badge tone="blue">{t("sub.parallelLead")}</Badge></div>
            <div style={{ marginTop: 8 }}><Button small variant="secondary" icon={<Plus size={13} />} disabled title={t("sub.parallelLater")}>{t("sub.parallelAdd")}</Button></div>
          </Panel>
        </div>
      </div>

      {dialog === "edit" && list.data ? (
        <SubmittalFormDialog ctx={ctx} list={list.data} initial={s} onClose={() => setDialog("")} onDone={() => setDialog("")} />
      ) : null}
      {dialog === "void" ? (
        <ReasonDialog
          title={fmt(t("sub.voidTitle"), { number: s.number })} note={t("sub.voidNote")} label={t("sub.voidReason")} danger confirm={t("sub.void")} t={t}
          onClose={() => setDialog("")}
          onConfirm={async (reason) => Boolean(await run("void", { action: "void", submittalId: s.ItemId, version: s.version, reason }, () => fmt(t("sub.toast.voided"), { number: s.number })))}
        />
      ) : null}
      {dialog === "newRevision" ? (
        <ReasonDialog
          title={fmt(t("sub.act.openRevision"), { rev: rev + 1 })} note={fmt(t("sub.newRevisionNote"), { number: s.number, company: s.responsibleCompanyName ?? "" })} label={t("sub.newRevisionReason")} confirm={fmt(t("sub.act.openRevision"), { rev: rev + 1 })} t={t}
          onClose={() => setDialog("")}
          onConfirm={async (reason) => {
            const d = await run("newRevision", { action: "newRevision", submittalId: s.ItemId, version: s.version, reason }, (x) => fmt(t("sub.toast.newRevision"), { rev: x.submittal.revision, company: x.submittal.responsibleCompanyName ?? "" }));
            if (d) setPkg([]);
            return Boolean(d);
          }}
        />
      ) : null}
      {dialog === "distribute" ? (
        <DistributeDialog ctx={ctx} s={s} people={distributable} busy={busy} onClose={() => setDialog("")}
          onSend={async (userIds, note) => Boolean(await run("distribute", { action: "distribute", submittalId: s.ItemId, userIds, note: note || undefined }, (d) => fmt(t("sub.toast.distributed"), { count: (d as SubmittalDetail & { sentTo?: number }).sentTo ?? userIds.length })))} />
      ) : null}
    </>
  );
}

function ReasonDialog({ title, note, label, confirm, danger, t, onClose, onConfirm }: {
  title: string; note: string; label: string; confirm: string; danger?: boolean; t: T; onClose: () => void; onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3;
  const go = async () => {
    setBusy(true);
    const done = await onConfirm(reason.trim());
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Dialog title={title} onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button variant={danger ? "danger" : "primary"} icon={busy ? <Loader2 className="spin" size={15} /> : undefined} onClick={go} disabled={!ok || busy}>{confirm}</Button></>}>
      <div className="m-stack-v">
        <Note tone={danger ? "warn" : "info"}>{note}</Note>
        <Field label={`${label} *`} hint={t("sub.reasonHint")}><textarea className="m-input" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </div>
    </Dialog>
  );
}

function DistributeDialog({ ctx, s, people, busy, onClose, onSend }: {
  ctx: Ctx; s: SubmittalRow; people: Ctx["team"]; busy: boolean; onClose: () => void; onSend: (userIds: string[], note: string) => Promise<boolean>;
}) {
  const { t } = ctx;
  // Preselected: the subcontractor's people, the superintendents and the GC's managers.
  const [picked, setPicked] = useState<string[]>(() =>
    people.filter((m) => m.companyId === s.responsibleCompanyId || ["superintendent", "project-manager", "document-controller"].includes(m.role)).map((m) => m.userId).slice(0, 50)
  );
  const [note, setNote] = useState("");
  const go = async () => { if (await onSend(picked, note.trim())) onClose(); };
  return (
    <Dialog title={fmt(t("sub.distributeTitle"), { number: s.number })} onClose={onClose} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button icon={busy ? <Loader2 className="spin" size={14} /> : <Send size={14} />} onClick={go} disabled={!picked.length || busy}>{fmt(t("sub.distributeSend"), { count: picked.length })}</Button></>}>
      <div className="m-stack-v">
        <p className="m-muted m-small" style={{ margin: 0 }}>{fmt(t("sub.distributeText"), { decision: decisionLabel(t, s.decision ?? "") })}</p>
        <div className="m-subs-pick">
          {people.map((m) => (
            <Checkbox key={m.userId} checked={picked.includes(m.userId)} onChange={(v) => setPicked((p) => (v ? [...p, m.userId] : p.filter((x) => x !== m.userId)))}
              label={<span>{m.displayName} <span className="m-muted m-small">· {m.companyName} · {roleName(t, m.role)}</span></span>} />
          ))}
        </div>
        <Field label={t("sub.distributeNote")}><textarea className="m-input" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 50 }} /></Field>
      </div>
    </Dialog>
  );
}
