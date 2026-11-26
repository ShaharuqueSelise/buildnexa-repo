// Shared pieces of the Field app: the screen state, the context every tab gets, the app bar and
// the punch row. See FieldPage.tsx for the shell.
import { AlertTriangle, ArrowLeft, Camera, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import type { ToastTone } from "../../shared/m/ui";
import type { ProjectRow } from "../projects/projectsApi";
import { PUNCH_ACTIVE } from "../punch/punchApi";
import type { PunchRow, usePunchPhotoQueue } from "../punch/punchApi";
import { StatusPill } from "../punch/PunchPage";
import { DueLabel } from "../rfis/RfisPage";

export type T = (key: TranslationKey) => string;
export type Tab = "today" | "punch" | "drawings" | "log" | "more";
export const TAB_KEYS: Tab[] = ["today", "punch", "drawings", "log", "more"];
/** A screen over the tabs (no tab bar): a punch item, or the 3-tap capture. */
export type Screen = null | { kind: "item"; id: string } | { kind: "capture" };

export type Ctx = {
  t: T;
  project: ProjectRow;
  myRole?: string;
  myUserId: string;
  myCompanyName?: string;
  today: string;
  isSub: boolean;
  isGc: boolean;
  seesPunch: boolean;
  /** Punch photos still going up or failed, per item (the app's photo queue). */
  photoQueue: ReturnType<typeof usePunchPhotoQueue>;
  setTab: (tab: Tab) => void;
  /** Opens a screen; the phone's back button closes it. */
  open: (screen: Screen) => void;
  /** Closes the screen (back to the tab it was opened from). */
  back: () => void;
  /** Leaves the screen for another tab without a step back (after saving a new item). */
  leaveTo: (tab: Tab) => void;
  toast: (text: string, tone?: ToastTone) => void;
  onNavigate: (path: string) => void;
};

export function AppBar({ title, sub, right, onBack, backLabel }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onBack?: () => void; backLabel?: string }) {
  return (
    <header className="fld-appbar">
      {onBack ? <button type="button" className="fld-back" onClick={onBack} aria-label={backLabel}><ArrowLeft size={22} /></button> : null}
      <div className="fld-appbar-title">
        <h1>{title}</h1>
        {sub ? <small>{sub}</small> : null}
      </div>
      {right}
    </header>
  );
}

const byDue = (a: PunchRow, b: PunchRow) => Number(b.overdue) - Number(a.overdue) || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999"));
export const live = (items?: PunchRow[]) => (items ?? []).filter((p) => !p.isVoided && PUNCH_ACTIVE.includes(p.status));

/** The GC's "to verify" list: ready for review, the ones waiting on me first. */
export function toVerify(items: PunchRow[] | undefined, myUserId: string) {
  return live(items)
    .filter((p) => p.status === "readyForReview")
    .sort((a, b) => Number(b.ballInCourtUserId === myUserId) - Number(a.ballInCourtUserId === myUserId) || byDue(a, b));
}

/** The punch items the Today tab and the tab badge are about. A subcontractor: their company's open
 *  and in-progress items (the server sends a subcontractor their company's items only). The GC:
 *  items ready for review. Others (owner, document controller): every active item. */
export function myPunch(items: PunchRow[] | undefined, c: { isSub: boolean; isGc: boolean; myUserId: string }) {
  const scope = live(items);
  if (c.isSub) return { mine: scope.filter((p) => p.status === "open" || p.status === "inProgress").sort(byDue), scope };
  if (c.isGc) return { mine: toVerify(items, c.myUserId), scope };
  return { mine: [...scope].sort(byDue), scope };
}

export const fmtWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export const sortByDue = (rows: PunchRow[]) => [...rows].sort(byDue);

export function PunchLine({ p, ctx }: { p: PunchRow; ctx: Ctx }) {
  const { t, today } = ctx;
  const q = ctx.photoQueue.get(p.ItemId);
  const done = !PUNCH_ACTIVE.includes(p.status);
  return (
    <button type="button" className="fld-row" onClick={() => ctx.open({ kind: "item", id: p.ItemId })}>
      <span className="fld-thumb">{p.beforeThumbUrl ? <img src={p.beforeThumbUrl} alt="" loading="lazy" /> : <Camera size={18} />}</span>
      <span className="fld-row-main">
        <b>{p.title}</b>
        <small>{p.number}{p.location ? ` · ${p.location}` : ""}{ctx.isSub || !p.assigneeCompanyName ? "" : ` · ${p.assigneeCompanyName}`}</small>
        {q?.failed.length ? <small className="fld-over"><AlertTriangle size={11} /> {t("fld.photoFailed")}</small>
          : q?.uploading ? <small><Loader2 size={11} className="spin" /> {t("punch.photoUploading")}</small>
          : <small><DueLabel due={p.dueDate} done={done} today={today} t={t} /></small>}
      </span>
      <StatusPill status={p.status} t={t} />
    </button>
  );
}
