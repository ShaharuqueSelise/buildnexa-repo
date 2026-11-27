// Revision impact (docs/architecture/02-drawings.md §4.7), the viewer's Changes tab, built from the
// demo app's ImpactPanel: what the newest revision changed (found by comparing the two PDFs in the
// browser), the open RFIs and punch items pinned where it changed, and which subcontractor companies
// confirmed they build to it.
import { AlertTriangle, BellRing, CheckCircle2, Clock, Eye, EyeOff, GitCompareArrows, Loader2, Move, RotateCcw, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Note, ProgressBar, Toggle, cx, fmt } from "../../shared/m/ui";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { compareRevision } from "./compare";
import { useDrawingAction } from "./drawingsApi";
import type { CompanyAnswer, Impact, SheetDetail, SheetPin } from "./drawingsApi";
import { errorText } from "./DrawingsPage";
import type { T, Toast } from "./DrawingsPage";

const REMIND_EVERY_MS = 12 * 3600_000;
const timeOf = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function ImpactPanel({ projectId, data, impact, comparing, viewingIndex, showClouds, myName, t, toast, onShowClouds, onFocus, onMove, onViewCurrent }: {
  projectId: string;
  data: SheetDetail;
  impact: Impact;
  comparing: boolean;
  viewingIndex: number;
  showClouds: boolean;
  myName: string;
  t: T;
  toast: Toast;
  onShowClouds: (v: boolean) => void;
  onFocus: (x: number, y: number, pinId?: string) => void;
  onMove: (pin: SheetPin) => void;
  onViewCurrent: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useDrawingAction(projectId);
  const { sheet, can } = data;
  const rev = data.revisions.find((r) => r.ItemId === impact.revisionId);
  const L = impact.revisionLabel;
  const P = impact.previousLabel;
  const first = impact.state === "first";
  const pending = impact.state === "pending";
  const byId = new Map(data.pins.map((p) => [p.ItemId, p]));
  const toCheck = impact.toCheck.map((id) => byId.get(id)).filter((p): p is SheetPin => Boolean(p));
  const checked = impact.checked.map((id) => byId.get(id)).filter((p): p is SheetPin => Boolean(p));
  const compares = can.upload || can.manage;
  const fail = (error: unknown) => toast(errorText(t, error), "warn");

  const run = (force: boolean) => {
    void compareRevision({ projectId, sheetId: sheet.ItemId, revisionId: impact.revisionId, detail: data, queryClient, force });
  };
  const check = (p: SheetPin, undo = false) =>
    action.mutateAsync({ action: "checkPin", sheetId: sheet.ItemId, pinId: p.ItemId, undo, revisionIndex: impact.revisionIndex, byName: myName })
      .then(() => toast(fmt(t(undo ? "drw.imp.uncheckedToast" : "drw.imp.checkedToast"), { number: p.number, label: L })))
      .catch(fail);
  const confirm = () =>
    action.mutateAsync({ action: "confirmRevision", sheetId: sheet.ItemId, revisionId: impact.revisionId, byName: myName })
      .then(() => toast(fmt(t("drw.imp.confirmedToast"), { number: sheet.sheetNumber, label: L })))
      .catch(fail);
  const remind = (companyId?: string) =>
    action.mutateAsync({ action: "remindRevision", sheetId: sheet.ItemId, revisionId: impact.revisionId, companyId })
      .then((a) => {
        const names = a.reminded ?? [];
        if (names.length) toast(fmt(t(names.length === 1 ? "drw.imp.remindedOne" : "drw.imp.reminded"), { names: names.join(", "), count: names.length }));
        else toast(t("drw.imp.remindedSoon"), "warn");
      })
      .catch(fail);
  const ask = () =>
    action.mutateAsync({ action: "askHolders", sheetId: sheet.ItemId, revisionId: impact.revisionId })
      .then((a) => toast(a.notified ? fmt(t(a.notified === 1 ? "drw.imp.askedOne" : "drw.imp.asked"), { count: a.notified }) : t("drw.imp.askedNone"), a.notified ? "good" : "warn"))
      .catch(fail);

  const changeLine = () => {
    if (comparing) return <span className="m-row m-small"><Loader2 className="spin" size={14} /> {fmt(t("drw.imp.comparing"), { prev: P })}</span>;
    if (pending) {
      return (
        <div className="m-stack-v" style={{ gap: 6 }}>
          <Note tone="info">{compares ? t("drw.imp.pendingUploader") : t("drw.imp.pending")}</Note>
          {compares ? <Button variant="secondary" small icon={<GitCompareArrows size={13} />} onClick={() => run(true)}>{t("drw.imp.compareNow")}</Button> : null}
        </div>
      );
    }
    if (impact.state === "failed") {
      return (
        <div className="m-stack-v" style={{ gap: 6 }}>
          <Note tone="warn">{t("drw.imp.failed")}</Note>
          {compares ? <Button variant="secondary" small icon={<RotateCcw size={13} />} onClick={() => run(true)}>{t("drw.imp.compareAgain")}</Button> : null}
        </div>
      );
    }
    if (impact.state === "notComparable") return <Note tone="warn">{fmt(t("drw.imp.notComparable"), { prev: P })}</Note>;
    if (impact.state === "redrawn") return <Note tone="warn">{fmt(t("drw.imp.redrawn"), { prev: P })}</Note>;
    if (!impact.areas.length) return <Note tone="good">{fmt(t("drw.imp.noChange"), { prev: P })}</Note>;
    return (
      <>
        <Toggle checked={showClouds} onChange={onShowClouds} label={<span className="m-small">{t("drw.imp.showClouds")}</span>} />
        <div className="m-imp-changes">
          {impact.areas.map((a, i) => (
            <button key={i} type="button" className="m-imp-change" onClick={() => onFocus(a.x + a.w / 2, a.y + a.h / 2)}>
              <span className="m-imp-cloud">{i + 1}</span>
              <span>
                <b>{fmt(t("drw.imp.changeN"), { n: i + 1 })}</b>
                <span className="m-small m-muted">{where(a.x + a.w / 2, a.y + a.h / 2, t)} · {fmt(t("drw.imp.size"), { pct: Math.max(1, Math.round(a.w * a.h * 100)) })}</span>
              </span>
            </button>
          ))}
        </div>
      </>
    );
  };

  const itemRow = (p: SheetPin, done: boolean) => {
    const moved = done && Boolean(p.movedFromPinId) && p.fromRevisionIndex === impact.revisionIndex;
    return (
      <div key={p.ItemId} className={cx("m-imp-item", done && "m-imp-item-done")}>
        <button type="button" className="m-imp-item-main" onClick={() => onFocus(p.x, p.y, p.ItemId)}>
          {done ? <CheckCircle2 size={16} color="hsl(var(--m-green-fg))" /> : <AlertTriangle size={16} color="hsl(var(--m-amber-fg))" />}
          <span>
            <span className="m-drw-item-title">{p.number} · {p.title}</span>
            <span className="m-small m-muted">
              {[p.type === "punchItem" ? p.companyName : "", p.ballInCourtName ? fmt(t("drw.imp.ball"), { name: p.ballInCourtName }) : "", p.dueDate ? fmt(t("drw.v.dueOn"), { date: fmtShortDate(p.dueDate) }) : ""].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
        {done ? (
          <span className="m-row" style={{ justifyContent: "space-between" }}>
            <span className="m-small">{moved ? fmt(t("drw.imp.movedOn"), { label: L }) : fmt(t("drw.imp.stillFits"), { name: p.checkedByName || "—", label: L })}</span>
            {!moved && p.canCheck && !p.saving ? <button type="button" className="m-link m-small" onClick={() => void check(p, true)}>{t("drw.imp.undo")}</button> : null}
          </span>
        ) : p.saving ? (
          <span className="m-small m-muted"><Loader2 className="spin" size={12} /> {t("drw.v.saving")}</span>
        ) : p.canCheck ? (
          <span className="m-row m-row-wrap">
            <Button variant="secondary" small icon={<CheckCircle2 size={13} />} onClick={() => void check(p)}>{t("drw.imp.stillValid")}</Button>
            {p.canMove ? <Button variant="ghost" small icon={<Move size={13} />} onClick={() => onMove(p)}>{t("drw.imp.movePin")}</Button> : null}
          </span>
        ) : (
          <span className="m-small m-muted">{fmt(t("drw.imp.waiting"), { name: p.ballInCourtName || t("drw.imp.theGc") })}</span>
        )}
      </div>
    );
  };

  return (
    <div className="m-stack-v m-imp">
      <div className="m-imp-head">
        <b>{fmt(t("drw.rev"), { label: L })}{rev ? ` · ${fmtShortDate(rev.issuedDate)}` : ""}</b>
        {rev ? <span className="m-small">{fmt(t("drw.imp.issuedBy"), { name: rev.uploadedByName || "—" })}{rev.note ? ` · “${rev.note}”` : ""}</span> : null}
        {!first ? (
          <div className="m-imp-stats">
            <span><b>{impact.state === "compared" ? impact.areas.length : "—"}</b>{t(impact.areas.length === 1 ? "drw.imp.statChange" : "drw.imp.statChanges")}</span>
            <span className={cx(toCheck.length + impact.hiddenToCheck > 0 && "m-imp-warn")}><b>{pending ? "—" : toCheck.length + impact.hiddenToCheck}</b>{t("drw.imp.statToCheck")}</span>
            <span><b>{impact.total ? `${impact.confirmed}/${impact.total}` : "—"}</b>{t("drw.imp.statConfirmed")}</span>
          </div>
        ) : null}
      </div>

      {viewingIndex !== impact.revisionIndex ? (
        <Note tone="warn">
          {fmt(t("drw.imp.aboutCurrent"), { label: L })}{" "}
          <button type="button" className="m-link m-small" onClick={onViewCurrent}>{fmt(t("drw.v.openCurrent"), { label: L })}</button>
        </Note>
      ) : null}

      {impact.mine && !first ? (
        impact.mine.status === "confirmed" ? (
          <Note tone="good">{fmt(t("drw.imp.youConfirmed"), { label: L, date: fmtDate(impact.mine.confirmedAt?.slice(0, 10) ?? ""), name: impact.mine.confirmedByName || "—" })}</Note>
        ) : (
          <div className="m-imp-confirm">
            <b>{fmt(t("drw.imp.buildFrom"), { label: L })}</b>
            <span className="m-small">{fmt(t("drw.imp.buildFromText"), { company: impact.mine.companyName || t("drw.imp.yourCompany"), prev: P })}</span>
            <Button small icon={<CheckCircle2 size={14} />} onClick={() => void confirm()} disabled={action.isPending || !can.confirm}>{fmt(t("drw.imp.weBuild"), { label: L })}</Button>
          </div>
        )
      ) : null}

      {first ? (
        <Note tone="info">{fmt(t("drw.imp.first"), { label: L })}</Note>
      ) : (
        <>
          <section>
            <div className="m-imp-title"><span>{fmt(t("drw.imp.whatChanged"), { prev: P })}</span></div>
            {changeLine()}
          </section>

          {!pending ? (
            <section>
              <div className="m-imp-title">
                <span>{impact.state === "compared" ? t("drw.imp.itemsInArea") : t("drw.imp.itemsAll")}</span>
                {can.followUp && toCheck.length ? <Button variant="secondary" small icon={<BellRing size={13} />} onClick={() => void ask()} disabled={action.isPending}>{t("drw.imp.ask")}</Button> : null}
              </div>
              {toCheck.length + checked.length === 0 && !impact.hiddenToCheck ? <Note tone="good">{fmt(t("drw.imp.nothingToCheck"), { label: L })}</Note> : null}
              {toCheck.map((p) => itemRow(p, false))}
              {checked.map((p) => itemRow(p, true))}
              {impact.hiddenToCheck ? <span className="m-small m-muted">{fmt(t(impact.hiddenToCheck === 1 ? "drw.imp.hiddenOne" : "drw.imp.hidden"), { count: impact.hiddenToCheck })}</span> : null}
            </section>
          ) : null}

          {can.followUp ? <Companies impact={impact} busy={action.isPending} t={t} onRemind={(id) => void remind(id)} /> : null}
        </>
      )}

      <div className="m-imp-how">
        <b>{t("drw.imp.howTitle")}</b>
        <span>{t("drw.imp.how")}</span>
      </div>
    </div>
  );
}

function Companies({ impact, busy, t, onRemind }: { impact: Impact; busy: boolean; t: T; onRemind: (companyId?: string) => void }) {
  const L = impact.revisionLabel;
  const recent = (a: CompanyAnswer) => Boolean(a.remindedAt && Date.now() - Date.parse(a.remindedAt) < REMIND_EVERY_MS);
  const open = impact.companies.filter((a) => a.status !== "confirmed");
  const canRemindSome = open.some((a) => !recent(a));
  return (
    <section>
      <div className="m-imp-title">
        <span>{fmt(t("drw.imp.whoBuilds"), { label: L })}</span>
        {open.length > 1 && canRemindSome ? <button type="button" className="m-link m-small" disabled={busy} onClick={() => onRemind()}><Send size={13} /> {t("drw.imp.remindAll")}</button> : null}
      </div>
      {impact.total === 0 ? <span className="m-small m-muted">{t("drw.imp.noCompanies")}</span> : (
        <>
          <span className="m-small">{fmt(t("drw.imp.confirmedOf"), { done: impact.confirmed, total: impact.total, label: L })}</span>
          <ProgressBar value={(impact.confirmed / Math.max(impact.total, 1)) * 100} tone={impact.confirmed === impact.total ? "green" : "amber"} />
          <div className="m-imp-acks">
            {impact.companies.map((a) => (
              <div key={a.companyId} className="m-imp-ack">
                <span className="m-imp-ack-name" title={a.companyName}>{a.companyName || a.companyId}</span>
                <span className="m-imp-ack-state">
                  {a.status === "confirmed" ? (
                    <span title={`${a.confirmedByName ?? ""} · ${timeOf(a.confirmedAt)}`}><Badge tone="green"><CheckCircle2 size={11} /> {fmtShortDate(a.confirmedAt?.slice(0, 10))}</Badge></span>
                  ) : a.status === "opened" ? (
                    <span title={timeOf(a.openedAt)}><Badge tone="amber"><Eye size={11} /> {t("drw.imp.opened")}</Badge></span>
                  ) : (
                    <Badge tone="red"><EyeOff size={11} /> {t("drw.imp.notOpened")}</Badge>
                  )}
                  {a.status !== "confirmed" ? (
                    recent(a)
                      ? <span className="m-small m-muted" title={timeOf(a.remindedAt)}><Clock size={11} /> {t("drw.imp.sent")}</span>
                      : <button type="button" className="m-link m-small" disabled={busy} onClick={() => onRemind(a.companyId)}>{t("drw.imp.remind")}</button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** "top left", "middle", … of the sheet, for a change's line in the list. */
function where(x: number, y: number, t: T) {
  const col = x < 0.34 ? 0 : x < 0.67 ? 1 : 2;
  const row = y < 0.34 ? 0 : y < 0.67 ? 1 : 2;
  const keys = [
    ["drw.imp.at.tl", "drw.imp.at.tc", "drw.imp.at.tr"],
    ["drw.imp.at.ml", "drw.imp.at.mm", "drw.imp.at.mr"],
    ["drw.imp.at.bl", "drw.imp.at.bc", "drw.imp.at.br"]
  ] as const;
  return t(keys[row]![col]!);
}
