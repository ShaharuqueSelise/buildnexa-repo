// Daily logs (PRD LOG-01..LOG-04, stories 10-12), built from the demo app's Daily logs page
// (mock/src/mock/pages/DailyLogsPage.tsx): the month calendar (or list) on the left with the month's
// completion and the companies that added their crew, the chosen day's log on the right with its
// cards (weather, manpower per company, equipment, deliveries, visitors, delays, safety, notes,
// photos, PM corrections), the submit dialog and the PM's audited correction.
// Every action goes through the daily-logs Function, which decides who may do what; the buttons
// follow its `can` answers. Each card saves on its own (with the card as it was shown, so two people
// on different cards never block each other).
// The weather is the day's Open-Meteo forecast for the project's city, fetched by the Function when
// the day is opened and again at submit; the superintendent can refresh it or type over it.
// Photos on a log go through the app's photo queue and the photos Function (Part 4).
// Submit tells the PMs, a correction tells whoever submitted, and "Remind" asks a subcontractor
// for their crew (bell + email, Part 5). Not real yet: the 18:00 "log missing" reminder, copy
// yesterday and the weekly / monthly PDF (R2), offline entry (R3).
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  AlertTriangle, CalendarDays, Camera, CheckCircle2, ChevronLeft, ChevronRight, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSun, Copy, Snowflake, Sun, BellRing, Download, FileText, HardHat, History, ImageOff, List, Loader2,
  Lock, MapPin, Pencil, Plus, RefreshCw, Send, ShieldCheck, StickyNote, Trash2, Truck, UserCheck, Users, Wifi, Wind, Wrench
} from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FUNCTIONS } from "../../lib/blocks/functions";
import { addDays, isWeekend, todayIso } from "../../lib/workdays";
import {
  Badge, Button, CompanyChip, Dialog, Empty, Field, KeyValue, Note, PageTitle, Panel, ProgressBar, ReleaseTag, Segmented, Select, Timeline, Toasts,
  colorFor, cx, downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import type { Tone, ToastTone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import {
  CONDITIONS, DELAY_TYPES, EQUIPMENT_STATUS, SAFETY_TYPES, SITE_CONDITIONS, addLogPhotos, refusalText, totalsOf, useLogAction, useLogDay, useLogMonth, useLogPhotoQueue
} from "./dailyLogsApi";
import type { Crew, CrewCompany, LogAction, LogDetail, LogPhoto, LogView, ManpowerRow, RowSectionKey, SectionKey, Weather } from "./dailyLogsApi";
import { photoRefusal, retryPhoto } from "../photos/photosApi";
import { projectCan } from "../../lib/permissions";
import { usePhotoPins } from "../drawings/drawingsApi";
import { PinPhotoDialog, PinnedChip } from "../drawings/PhotoPin";
import "./DailyLogsPage.css";
import { Sk, SkPanel, SkStatus, SkeletonPage } from "../../shared/m/Skeleton";

type Nav = { onNavigate: (path: string) => void; params?: string[] };
type T = (key: TranslationKey) => string;
type Ctx = { t: T; projectId: string; startDate: string; city: string; toast: (text: string, tone?: ToastTone) => void; onNavigate: (path: string) => void };
type DayState = "submitted" | "draft" | "missing" | "pending" | "future" | "off";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtShort = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekdayName = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const monthLabel = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const nowTime = () => new Date().toTimeString().slice(0, 5);
const workersText = (t: T, n: number) => fmt(t(n === 1 ? "dlog.worker1" : "dlog.workersN"), { count: n });
const totalsText = (t: T, x: { headcount: number; hours: number }) => fmt(t("dlog.totals"), { workers: workersText(t, x.headcount), hours: fmt(t(x.hours === 1 ? "dlog.hour1" : "dlog.hoursN"), { count: x.hours }) });

function monthDays(ym: string): string[] {
  const out: string[] = [];
  for (let d = `${ym}-01`; d.slice(0, 7) === ym; d = addDays(d, 1)) out.push(d);
  return out;
}
function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}
const label = (t: T, prefix: string, value?: string) => (value ? t(`${prefix}.${value}` as TranslationKey) : "—");
const DELAY_TONE: Tone = "amber";
const SAFETY_TONE: Record<string, Tone> = { incident: "red", nearMiss: "amber", inspection: "blue", toolboxTalk: "green", observation: "gray" };

// ---------- page ----------
export function DailyLogsPage({ onNavigate, params = [] }: Nav) {
  const { t } = useT();
  const { query, ws, project, myRole } = useProjects();
  const { items: toasts, toast } = useToasts();

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <SkeletonPage kind="calendar" label={t("common.loading")} />;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("dlog.title")} />
        <Panel><Empty icon={<CalendarDays size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }
  if (!FUNCTIONS.dailyLogs) {
    return <div><PageTitle title={t("dlog.title")} /><Note tone="warn">{t("dlog.notDeployed")}</Note></div>;
  }
  if (myRole === "design-reviewer" || !myRole) {
    return (
      <div>
        <PageTitle title={t("dlog.title")} />
        <Panel><Empty icon={<Lock size={28} />} title={t("dlog.noAccessTitle")}>{t("dlog.noAccess")}</Empty></Panel>
      </div>
    );
  }
  const ctx: Ctx = { t, projectId: project.ItemId, startDate: String(project.startDate ?? "").slice(0, 10), city: project.address?.city ?? "", toast, onNavigate };
  return (
    <div>
      <LogsView key={project.ItemId} ctx={ctx} projectName={project.name} wanted={params[0]} />
      <Toasts items={toasts} />
    </div>
  );
}

function LogsView({ ctx, projectName, wanted }: { ctx: Ctx; projectName: string; wanted?: string }) {
  const { t, projectId, startDate, onNavigate } = ctx;
  const date = wanted && DATE.test(wanted) ? wanted : undefined;
  const [ym, setYm] = useState(() => (date ?? todayIso()).slice(0, 7));
  const [view, setView] = useState<"calendar" | "list">("calendar");
  useEffect(() => {
    if (date) setYm(date.slice(0, 7));
  }, [date]);

  const month = useLogMonth(projectId, ym);
  const today = month.data?.today ?? todayIso();
  const selected = date ?? today;
  const day = useLogDay(projectId, selected);
  const role = month.data?.role ?? day.data?.role ?? "";
  const writer = role === "project-manager" || role === "superintendent";
  const ownerOnly = role === "owner-viewer";
  const go = (d: string) => onNavigate(`/daily-logs/${d}`);

  const byDate = useMemo(() => new Map((month.data?.days ?? []).map((d) => [d.date, d] as const)), [month.data]);
  const stateOf = (d: string): DayState => {
    if (d > today) return "future";
    if (startDate && d < startDate && !byDate.has(d)) return "off";
    const row = byDate.get(d);
    if (row) return row.status;
    return isWeekend(d) ? "off" : "missing";
  };
  const days = monthDays(ym);
  const elapsedWork = days.filter((d) => !isWeekend(d) && d <= today && (!startDate || d >= startDate));
  const submitted = elapsedWork.filter((d) => stateOf(d) === "submitted").length;
  const completion = elapsedWork.length ? Math.round((submitted / elapsedWork.length) * 100) : 0;
  // Missing or unsubmitted past working days of the month shown.
  const overdue = elapsedWork.filter((d) => d < today && ["missing", "draft"].includes(stateOf(d))).reverse();

  const exportMonth = () => {
    const rows = (month.data?.days ?? []).filter((d) => d.status !== "pending").map((d) => ({
      date: d.date, status: d.status, working_day: d.isWorkingDay ? "yes" : "no", weather: d.condition ? label(t, "dlog.cond", d.condition) : "",
      workers: d.headcount ?? "", corrections: d.corrections ?? 0
    }));
    if (!rows.length) {
      ctx.toast(t("dlog.csvNone"), "warn");
      return;
    }
    downloadCsv(`daily-logs-${ym}.csv`, rows);
    ctx.toast(fmt(t("dlog.csvDone"), { count: rows.length }));
  };

  const subtitle = fmt(t(ctx.city ? "dlog.subtitleCity" : "dlog.subtitle"), { project: projectName, city: ctx.city });
  return (
    <>
      <PageTitle
        title={t("dlog.title")}
        subtitle={subtitle}
        actions={
          <>
            <Button variant="secondary" icon={<Wifi size={15} />} disabled title={t("dlog.offlineLater")}>{t("dlog.offline")} <ReleaseTag release="R3" /></Button>
            {role !== "field-user" ? <Button variant="secondary" icon={<FileText size={15} />} disabled title={t("dlog.reportLater")}>{t("dlog.report")} <ReleaseTag release="R2" /></Button> : null}
            <Button variant="secondary" icon={<Download size={15} />} onClick={exportMonth} disabled={!month.data}>CSV</Button>
          </>
        }
      />

      {month.error ? <Note tone="danger">{refusalText(month.error, t("common.error"))}</Note> : null}

      {writer && overdue.length ? (
        <div className="m-dlog-alert">
          <Note tone="danger">
            <div className="m-row m-row-wrap">
              <AlertTriangle size={16} />
              <b>{fmt(t("dlog.overdue"), { missing: overdue.filter((d) => stateOf(d) === "missing").length, drafts: overdue.filter((d) => stateOf(d) === "draft").length })}</b>
              {overdue.slice(0, 8).map((d) => (
                <button key={d} className="m-link" onClick={() => go(d)}>{fmtShort(d)}{stateOf(d) === "draft" ? ` (${t("dlog.draft").toLowerCase()})` : ""}</button>
              ))}
              {overdue.length > 8 ? <span>{fmt(t("dlog.more"), { count: overdue.length - 8 })}</span> : null}
            </div>
          </Note>
        </div>
      ) : null}

      <div className="m-dlog-layout">
        <div className="m-dlog-side">
          <Panel
            title={<><CalendarDays size={16} /> {monthLabel(ym)}</>}
            actions={<Segmented options={[{ key: "calendar", label: <CalendarDays size={14} /> }, { key: "list", label: <List size={14} /> }]} value={view} onChange={setView} />}
          >
            {view === "calendar" ? (
              <MonthCalendar
                t={t} ym={ym} setYm={setYm} today={today} selected={selected} days={days} byDate={byDate} stateOf={stateOf}
                ownerOnly={ownerOnly} busy={month.isFetching} loading={month.isFetching && !month.data}
                completion={completion} submitted={submitted} total={elapsedWork.length} onOpen={go}
              />
            ) : (
              <>
              <div className="m-dlog-cal-head">
                <button className="m-icon-btn" onClick={() => setYm(shiftMonth(ym, -1))} aria-label={t("dlog.prevMonth")}><ChevronLeft size={18} /></button>
                <div style={{ flex: 1 }}>
                  <div className="m-row" style={{ justifyContent: "space-between" }}>
                    <span className="m-small m-muted">{t("dlog.completion")}</span>
                    <strong>{month.isFetching && !month.data ? <Sk w={36} h={14} /> : `${completion} %`}</strong>
                  </div>
                  <ProgressBar value={completion} tone={completion >= 90 ? "green" : completion >= 60 ? "amber" : "red"} />
                  <span className="m-small m-muted">{fmt(t("dlog.completionHint"), { done: submitted, total: elapsedWork.length })}</span>
                </div>
                <button className="m-icon-btn" onClick={() => setYm(shiftMonth(ym, 1))} aria-label={t("dlog.nextMonth")} disabled={ym >= today.slice(0, 7)}><ChevronRight size={18} /></button>
              </div>
              <div className="m-table-wrap">
                <table className="m-table">
                  <thead><tr><th>{t("dlog.day")}</th><th>{t("dlog.status")}</th><th className="m-num">{t("dlog.workers")}</th></tr></thead>
                  <tbody>
                    {days.filter((d) => d <= today && (!isWeekend(d) || byDate.has(d))).reverse().map((d) => {
                      const s = stateOf(d);
                      const row = byDate.get(d);
                      return (
                        <tr key={d} className={cx("m-clickable", d === selected && "m-selected")} onClick={() => go(d)}>
                          <td>{fmtShort(d)} <span className="m-muted m-small">{weekdayName(d).slice(0, 3)}</span></td>
                          <td><DayBadge s={s} t={t} /></td>
                          <td className="m-num">{row?.headcount ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Panel>

          {day.data?.log && writer ? <Contributors ctx={ctx} detail={day.data} /> : null}
        </div>

        <div>
          {day.isLoading ? (
            <SkStatus label={t("common.loading")}><SkPanel lines={5} /><SkPanel rows={3} /></SkStatus>
          ) : day.error ? (
            <Note tone="danger">{refusalText(day.error, t("common.error"))}</Note>
          ) : day.data?.log ? (
            <LogDetailView key={`${day.data.date}`} ctx={ctx} detail={day.data} log={day.data.log} />
          ) : day.data ? (
            <NoLog ctx={ctx} detail={day.data} date={selected} />
          ) : null}
        </div>
      </div>
    </>
  );
}

function DayBadge({ s, t }: { s: DayState; t: T }) {
  if (s === "submitted") return <Badge tone="green">{t("dlog.day.submitted")}</Badge>;
  if (s === "draft") return <Badge tone="amber">{t("dlog.day.draft")}</Badge>;
  if (s === "pending") return <Badge>{t("dlog.day.pending")}</Badge>;
  if (s === "missing") return <Badge tone="red">{t("dlog.day.missing")}</Badge>;
  return <Badge>—</Badge>;
}

// ---------- a day without a log ----------
function NoLog({ ctx, detail, date }: { ctx: Ctx; detail: LogDetail; date: string }) {
  const { t, projectId } = ctx;
  const action = useLogAction(projectId, date);
  const open = () =>
    action.mutate({ action: "open" }, {
      onSuccess: () => ctx.toast(fmt(t("dlog.opened"), { date: fmtDate(date) })),
      onError: (e) => ctx.toast(refusalText(e, t("common.error")), "warn")
    });
  const beforeStart = Boolean(ctx.startDate) && date < ctx.startDate;
  const working = !isWeekend(date) && !beforeStart;
  return (
    <Panel>
      <div className="m-dlog-head">
        <div>
          <h2>{weekdayName(date)}, {fmtDate(date)}</h2>
          <span className="m-muted">{detail.pending ? t("dlog.pendingHint") : beforeStart ? fmt(t("dlog.beforeStart"), { date: fmtDate(ctx.startDate) }) : working ? t("dlog.noLogWorking") : t("dlog.noLogWeekend")}</span>
        </div>
      </div>
      {detail.pending ? (
        <Empty icon={<Lock size={28} />} title={t("dlog.pendingTitle")}>{t("dlog.pendingBody")}</Empty>
      ) : (
        <Empty icon={<CalendarDays size={28} />} title={working && date <= detail.today ? t("dlog.missingTitle") : t("dlog.noLogTitle")}>
          {detail.can.open ? (
            <Button icon={action.isPending ? <Loader2 className="spin" size={16} /> : <Plus size={16} />} disabled={action.isPending} onClick={open}>
              {date === detail.today ? t("dlog.openToday") : fmt(t("dlog.openFor"), { date: fmtShort(date) })}
            </Button>
          ) : detail.archived ? t("dlog.archived") : detail.role === "field-user" ? t("dlog.subOpensToday") : t("dlog.onlySupt")}
        </Empty>
      )}
    </Panel>
  );
}

// ---------- the month calendar ----------
// Tiles tinted by status, with the day's weather and a mark for PM corrections. Tap a status chip
// to highlight those days; hover (or focus) a day to preview it below the grid; arrow keys move
// between days, Enter opens one, and a month change slides in from the side it came from.
export const COND_ICON: Record<string, typeof Sun> = {
  clear: Sun, partlyCloudy: CloudSun, cloudy: Cloud, fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, snow: Snowflake, thunderstorm: CloudLightning
};
type DayRowLike = { status: string; condition?: string; headcount?: number | null; corrections?: number };
type Highlight = "submitted" | "draft" | "missing" | null;

function Ring({ value, tone }: { value: number; tone: Tone }) {
  const r = 22;
  const len = 2 * Math.PI * r;
  return (
    <svg className={`m-dlog-ring m-dlog-ring-${tone}`} viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
      <circle cx="26" cy="26" r={r} className="m-dlog-ring-bg" />
      <circle cx="26" cy="26" r={r} className="m-dlog-ring-fg" strokeDasharray={len} strokeDashoffset={len * (1 - Math.min(100, Math.max(0, value)) / 100)} />
    </svg>
  );
}

function MonthCalendar({ t, ym, setYm, today, selected, days, byDate, stateOf, ownerOnly, busy, loading, completion, submitted, total, onOpen }: {
  t: T; ym: string; setYm: (ym: string) => void; today: string; selected: string; days: string[]; byDate: Map<string, DayRowLike>;
  stateOf: (d: string) => DayState; ownerOnly: boolean; busy: boolean; loading: boolean; completion: number; submitted: number; total: number; onOpen: (d: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [slide, setSlide] = useState<"left" | "right" | "">("");
  const grid = useRef<HTMLDivElement>(null);
  const lastMonth = today.slice(0, 7);
  const move = (by: number) => {
    const next = shiftMonth(ym, by);
    if (next > lastMonth) return;
    setSlide(by > 0 ? "left" : "right");
    setHighlight(null);
    setYm(next);
  };
  const toToday = () => {
    if (ym !== lastMonth) setSlide(ym < lastMonth ? "left" : "right");
    setYm(lastMonth);
    onOpen(today);
  };
  const draftKey = ownerOnly ? "pending" : "draft";
  const count = (k: DayState) => days.filter((d) => stateOf(d) === k).length;
  const chips: { key: Exclude<Highlight, null>; state: DayState; label: string; tone: string; n: number }[] = [
    { key: "submitted", state: "submitted", label: t("dlog.day.submitted"), tone: "green", n: count("submitted") },
    { key: "draft", state: draftKey, label: t(`dlog.day.${draftKey}` as TranslationKey), tone: ownerOnly ? "gray" : "amber", n: count(draftKey) },
    { key: "missing", state: "missing", label: t("dlog.day.missing"), tone: "red", n: count("missing") }
  ];
  const openable = (d: string) => stateOf(d) !== "future" || d === addDays(today, 1);
  const focusDay = (d: string) => {
    if (d.slice(0, 7) !== ym) {
      if (d.slice(0, 7) > lastMonth) return;
      setSlide(d > ym ? "left" : "right");
      setYm(d.slice(0, 7));
    }
    setHover(d);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-date="${d}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, d: string) => {
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (by === undefined) return;
    e.preventDefault();
    const next = addDays(d, by);
    if (next > addDays(today, 1)) return;
    focusDay(next);
  };

  const shown = hover && hover.slice(0, 7) === ym ? hover : selected;
  const shownState = stateOf(shown);
  const shownRow = byDate.get(shown);
  const ShownIcon = shownRow?.condition ? COND_ICON[shownRow.condition] : null;
  const lead = (new Date(`${ym}-01T12:00:00Z`).getUTCDay() + 6) % 7;

  return (
    <div className="m-dlog-calendar">
      <div className="m-dlog-cal-top">
        <div className="m-dlog-cal-score">
          <div className="m-dlog-ring-wrap">
            <Ring value={completion} tone={completion >= 90 ? "green" : completion >= 60 ? "amber" : "red"} />
            <b>{loading ? <Sk w={28} h={12} /> : `${completion}%`}</b>
          </div>
          <div>
            <div className="m-small m-muted">{t("dlog.completion")}</div>
            <div className="m-small">{loading ? <Sk w={150} h={12} style={{ marginTop: 4 }} /> : <b>{fmt(t("dlog.completionHint"), { done: submitted, total })}</b>}</div>
          </div>
        </div>
        <div className="m-dlog-cal-nav">
          <button className="m-icon-btn" onClick={() => move(-1)} aria-label={t("dlog.prevMonth")}><ChevronLeft size={18} /></button>
          <button className="m-dlog-today-btn" onClick={toToday} disabled={selected === today && ym === lastMonth}>{t("dlog.today")}</button>
          <button className="m-icon-btn" onClick={() => move(1)} aria-label={t("dlog.nextMonth")} disabled={ym >= lastMonth}><ChevronRight size={18} /></button>
        </div>
      </div>

      <div className="m-dlog-chips" role="group" aria-label={t("dlog.highlightDays")}>
        {chips.map((c) => (
          <button key={c.key} type="button" className={cx("m-dlog-chip", `m-dlog-chip-${c.tone}`, highlight === c.key && "m-on")} aria-pressed={highlight === c.key}
            onClick={() => setHighlight(highlight === c.key ? null : c.key)}>
            <i />{c.label}<b>{c.n}</b>
          </button>
        ))}
      </div>

      <div className="m-dlog-dows">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d, i) => <div key={d} className={cx("m-dlog-dow", i > 4 && "m-dlog-dow-we")}>{d}</div>)}
      </div>
      <div ref={grid} key={ym} className={cx("m-dlog-cal", slide && `m-dlog-slide-${slide}`, busy && "m-dlog-busy")} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: lead }, (_, i) => <span key={`pad-${i}`} />)}
        {days.map((d) => {
          const st = stateOf(d);
          const row = byDate.get(d);
          const Icon = row?.condition ? COND_ICON[row.condition] : null;
          const hl = highlight ? chips.find((c) => c.key === highlight)!.state : null;
          return (
            <button
              key={d}
              data-date={d}
              className={cx("m-dlog-day", `m-dlog-${st}`, d === today && "m-dlog-today", d === selected && "m-dlog-sel", hl && st !== hl && "m-dlog-dim", hl && st === hl && "m-dlog-glow", isWeekend(d) && "m-dlog-we")}
              disabled={!openable(d)}
              tabIndex={d === selected ? 0 : -1}
              onClick={() => onOpen(d)}
              onMouseEnter={() => setHover(d)}
              onFocus={() => setHover(d)}
              onKeyDown={(e) => onKey(e, d)}
              aria-current={d === selected ? "date" : undefined}
              aria-label={`${fmtDate(d)} · ${t(`dlog.day.${st}` as TranslationKey)}`}
            >
              <span className="m-dlog-day-n">{Number(d.slice(8))}</span>
              {Icon ? <Icon className="m-dlog-day-wx" size={12} /> : null}
              {row?.corrections ? <span className="m-dlog-day-fix" /> : null}
            </button>
          );
        })}
      </div>

      <div className={cx("m-dlog-peek", `m-dlog-peek-${shownState}`)} aria-live="polite">
        <span className="m-dlog-peek-bar" />
        <div className="m-dlog-peek-main">
          <strong>{weekdayName(shown).slice(0, 3)}, {fmtShort(shown)}</strong>
          <span className="m-dlog-peek-meta">
            <span>{t(`dlog.day.${shownState}` as TranslationKey)}</span>
            {ShownIcon ? <span><ShownIcon size={13} /> {label(t, "dlog.cond", shownRow?.condition)}</span> : null}
            {shownRow?.headcount != null ? <span><Users size={13} /> {workersText(t, shownRow.headcount)}</span> : null}
            {shownRow?.corrections ? <span><Pencil size={12} /> {fmt(t(shownRow.corrections === 1 ? "dlog.correction1" : "dlog.correctionN"), { count: shownRow.corrections })}</span> : null}
          </span>
        </div>
        {shown !== selected && openable(shown) ? <button className="m-dlog-peek-go" onClick={() => onOpen(shown)} aria-label={t("dlog.openDay")}><ChevronRight size={16} /></button> : null}
      </div>
    </div>
  );
}

// ---------- contributors ----------
// "Remind" sends the company's people on the project a bell + email (the server allows one an hour).
const REMIND_EVERY_MS = 60 * 60 * 1000;
function Contributors({ ctx, detail }: { ctx: Ctx; detail: LogDetail }) {
  const { t } = ctx;
  const action = useLogAction(ctx.projectId, detail.date);
  const [sending, setSending] = useState("");
  const subs = detail.companies.filter((c) => !c.own);
  if (!subs.length) return null;
  const remind = (c: CrewCompany) => {
    setSending(c.companyId);
    action.mutate({ action: "remind", companyId: c.companyId }, {
      onSuccess: (d) => ctx.toast(fmt(t(d.reminded?.people === 1 ? "dlog.reminded1" : "dlog.reminded"), { company: c.companyName, count: d.reminded?.people ?? 0 })),
      onError: (e) => ctx.toast(refusalText(e, t("common.error")), "warn"),
      onSettled: () => setSending("")
    });
  };
  const done = subs.length - detail.missingCrews.length;
  return (
    <Panel title={<><UserCheck size={16} /> {t("dlog.contributors")}</>} actions={<Badge tone={done === subs.length ? "green" : "amber"}>{fmt(t("dlog.subsDone"), { done, total: subs.length })}</Badge>}>
      <p className="m-small m-muted" style={{ marginTop: 0 }}>{t("dlog.contributorsHint")}</p>
      <div className="m-dlog-contrib">
        {subs.map((c) => {
          const crew = detail.crews.find((x) => x.companyId === c.companyId && x.manpower.length);
          return (
            <div key={c.companyId}>
              <CompanyChip name={c.companyName} color={colorFor(c.companyId)} />
              {crew ? <Badge tone="green"><CheckCircle2 size={12} />{fmt(t("dlog.crewN"), { count: crew.headcount })}</Badge> : (
                <span className="m-row" style={{ gap: 6 }}>
                  <Badge>{t("dlog.notAdded")}</Badge>
                  {detail.can.remind ? (() => {
                    const at = detail.remindedAt?.[c.companyId];
                    const recent = Boolean(at) && Date.now() - Date.parse(at!) < REMIND_EVERY_MS;
                    return recent
                      ? <span className="m-small m-muted" title={fmtDateTime(at)}><BellRing size={12} /> {fmt(t("dlog.remindedAt"), { time: new Date(at!).toTimeString().slice(0, 5) })}</span>
                      : <Button small variant="ghost" icon={sending === c.companyId ? <Loader2 className="spin" size={13} /> : <BellRing size={13} />} disabled={Boolean(sending)} onClick={() => remind(c)}>{t("dlog.remind")}</Button>;
                  })() : null}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ---------- one day's log ----------
function LogDetailView({ ctx, detail, log }: { ctx: Ctx; detail: LogDetail; log: LogView }) {
  const { t, projectId } = ctx;
  const action = useLogAction(projectId, detail.date);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [correctOpen, setCorrectOpen] = useState(false);
  const [crewFor, setCrewFor] = useState<{ company: CrewCompany; crew?: Crew } | null>(null);
  const draft = log.status === "draft";
  const can = detail.can;
  const full = log.equipment !== undefined;
  const role = detail.role;

  const run = (body: LogAction, done?: string, after?: () => void) =>
    action.mutate(body, {
      onSuccess: () => {
        if (done) ctx.toast(done);
        after?.();
      },
      onError: (e) => ctx.toast(refusalText(e, t("common.error")), "warn")
    });
  const saveSection = (section: SectionKey, value: unknown, base: unknown, done?: string, after?: () => void) => run({ action: "saveSection", section, value, base }, done, after);

  const readOnly = !draft
    ? can.correct ? t("dlog.roSubmittedPm") : t("dlog.roSubmitted")
    : role === "field-user" ? t("dlog.roSub")
    : role === "document-controller" ? t("dlog.roDc")
    : "";
  const busy = action.isPending;

  const crews = detail.crews;
  const totals = crews.reduce((s, c) => ({ headcount: s.headcount + c.headcount, hours: s.hours + c.hours }), { headcount: 0, hours: 0 });
  const ownCompany: CrewCompany | undefined = detail.ownCompanyId ? { companyId: detail.ownCompanyId, companyName: detail.ownCompanyName ?? "", own: false } : undefined;
  const ownCrew = crews.find((c) => c.companyId === detail.ownCompanyId);
  const addable = detail.companies.filter((c) => !crews.some((x) => x.companyId === c.companyId));
  const corrections = detail.history.filter((h) => h.action === "corrected");

  return (
    <>
      <Panel>
        <div className="m-dlog-head">
          <div>
            <h2>{weekdayName(log.date)}, {fmtDate(log.date)}</h2>
            <div className="m-row m-row-wrap">
              <Badge tone={draft ? "amber" : "green"}>{draft ? t("dlog.day.draft") : t("dlog.day.submitted")}</Badge>
              {log.submittedByName ? <span className="m-small m-muted">{fmt(t("dlog.submittedBy"), { name: log.submittedByName, when: fmtDateTime(log.submittedAt) })}</span> : <span className="m-small m-muted">{t("dlog.notSubmitted")}</span>}
              {log.correctionCount ? <Badge tone="purple"><Pencil size={11} />{fmt(t(log.correctionCount === 1 ? "dlog.correction1" : "dlog.correctionN"), { count: log.correctionCount })}</Badge> : null}
              {!draft ? <Badge><Lock size={11} />{t("dlog.readOnly")}</Badge> : null}
              {!log.isWorkingDay ? <Badge>{t("dlog.weekend")}</Badge> : null}
              {busy ? <span className="m-small m-muted"><Loader2 className="spin" size={12} /> {t("dlog.saving")}</span> : null}
            </div>
          </div>
          <div className="m-actions">
            {can.editSections ? <Button variant="secondary" icon={<Copy size={16} />} disabled title={t("dlog.copyLater")}>{t("dlog.copy")} <ReleaseTag release="R2" /></Button> : null}
            {can.submit ? <Button icon={<Send size={16} />} onClick={() => setSubmitOpen(true)} disabled={busy || log.date > detail.today} title={log.date > detail.today ? t("dlog.submitFuture") : t("dlog.submitHint")}>{t("dlog.submit")}</Button> : null}
            {role === "project-manager" && !draft ? <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => setCorrectOpen(true)} disabled={!can.correct || busy} title={t("dlog.correctHint")}>{t("dlog.correct")}</Button> : null}
          </div>
        </div>
        {readOnly ? <Note tone={draft ? "info" : "warn"}>{readOnly}</Note> : null}
      </Panel>

      <div className="m-dlog-sections">
        <WeatherCard ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} onRefresh={() => run({ action: "refreshWeather" }, t("dlog.wxRefreshed"))} />

        <Panel
          className="m-dlog-wide m-panel-flush"
          title={<><Users size={16} /> {t("dlog.manpower")}</>}
          actions={<span className="m-small m-muted">{totalsText(t, totals)}</span>}
        >
          {crews.length ? (
            <div className="m-table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="m-table">
                <thead><tr><th>{t("dlog.company")}</th><th>{t("dlog.trade")}</th><th className="m-num">{t("dlog.workers")}</th><th className="m-num">{t("dlog.hours")}</th><th>{t("dlog.workDone")}</th><th /></tr></thead>
                <tbody>
                  {crews.map((c) => {
                    const editable = can.editAnyCrew || (can.editOwnCrew && c.companyId === detail.ownCompanyId);
                    const rows = c.manpower.length ? c.manpower : [{ headcount: 0 } as ManpowerRow];
                    return rows.map((r, i) => (
                      <tr key={`${c.id}-${r.rowId ?? i}`} className={cx(c.companyId === detail.ownCompanyId && role === "field-user" && "m-selected")}>
                        <td>{i === 0 ? <><CompanyChip name={c.companyName} color={colorFor(c.companyId)} />{c.notes ? <div className="m-small m-muted m-dlog-crew-note">{c.notes}</div> : null}</> : null}</td>
                        <td>{r.trade || <span className="m-muted">—</span>}</td>
                        <td className="m-num">{r.headcount}</td>
                        <td className="m-num">{r.hours ?? "—"}</td>
                        <td>{r.workDone || <span className="m-muted">—</span>}{r.location ? <span className="m-small m-muted"> · {r.location}</span> : null}</td>
                        <td className="m-right">
                          {i === 0 && editable ? (
                            <button className="m-icon-btn" aria-label={fmt(t("dlog.editCrewOf"), { company: c.companyName })} title={t("dlog.editCrew")} disabled={busy} onClick={() => setCrewFor({ company: { companyId: c.companyId, companyName: c.companyName, own: false }, crew: c })}><Pencil size={15} /></button>
                          ) : i === 0 && draft && !editable ? <span title={t("dlog.readOnlyForYou")}><Lock size={13} className="m-muted" /></span> : null}
                        </td>
                      </tr>
                    ));
                  })}
                </tbody>
                <tfoot><tr><td>{crews.length === 1 ? t("dlog.crews1") : fmt(t("dlog.crewsN"), { count: crews.length })}</td><td /><td className="m-num">{totals.headcount}</td><td className="m-num">{totals.hours} h</td><td colSpan={2} /></tr></tfoot>
              </table>
            </div>
          ) : <p className="m-muted" style={{ margin: 12 }}>{t("dlog.noCrew")}</p>}
          {can.editOwnCrew || can.editAnyCrew ? (
            <div style={{ padding: 12 }} className="m-row m-row-wrap">
              {!can.editAnyCrew && can.editOwnCrew && !ownCrew && ownCompany ? (
                <Button icon={<HardHat size={16} />} disabled={busy} onClick={() => setCrewFor({ company: ownCompany })}>{fmt(t("dlog.addMyCrew"), { company: ownCompany.companyName })}</Button>
              ) : null}
              {can.editAnyCrew && addable.length ? <AddCompanyRow t={t} options={addable} onAdd={(company) => setCrewFor({ company })} /> : null}
            </div>
          ) : null}
        </Panel>

        {full ? (
          <>
            <RowCard section="equipment" ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} icon={<Wrench size={16} />} />
            <RowCard section="deliveries" ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} icon={<Truck size={16} />} />
            <RowCard section="visitors" ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} icon={<UserCheck size={16} />} />
            <RowCard
              section="delays" ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} icon={<AlertTriangle size={16} />}
              badge={log.delays?.length ? <Badge tone="red">{fmt(t("dlog.hoursLost"), { hours: log.delays.reduce((s, x) => s + (Number(x.durationHours) || 0), 0) })}</Badge> : null}
            />
            <RowCard
              section="safety" ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} icon={<ShieldCheck size={16} />}
              badge={log.safety?.some((s) => s.type === "incident") ? <Badge tone="red">{t("dlog.safety.incident")}</Badge> : log.safety?.some((s) => s.type === "nearMiss") ? <Badge tone="amber">{t("dlog.safety.nearMiss")}</Badge> : <Badge tone="green">{t("dlog.noIncidents")}</Badge>}
            />
            <NotesCard ctx={ctx} log={log} editable={can.editSections} busy={busy} onSave={saveSection} />

            <PhotosCard ctx={ctx} logId={log.id} date={log.date} photos={detail.photos ?? []} canAdd={Boolean(can.addPhotos)} canPin={projectCan(detail.role, "drawing.pin") && !detail.archived} own={false} />

            <Panel className="m-dlog-wide" title={<><Pencil size={16} /> {t("dlog.corrections")}</>} actions={<Badge tone="purple">{t("dlog.audited")}</Badge>}>
              {corrections.length ? (
                <Timeline items={corrections.map((c) => ({ who: c.actorName, when: fmtDateTime(c.at), title: c.summary ?? t("dlog.correction"), body: c.reason ? fmt(t("dlog.reasonIs"), { reason: c.reason }) : undefined, tone: "purple" as const }))} />
              ) : <p className="m-muted" style={{ margin: 0 }}>{t("dlog.noCorrections")}</p>}
            </Panel>

            {detail.history.length ? <HistoryCard t={t} history={detail.history} /> : null}
          </>
        ) : <PhotosCard ctx={ctx} logId={log.id} date={log.date} photos={detail.photos ?? []} canAdd={Boolean(can.addPhotos)} canPin={projectCan(detail.role, "drawing.pin") && !detail.archived} own />}
      </div>

      {submitOpen ? (
        <Dialog title={<><Send size={18} /> {fmt(t("dlog.submitTitle"), { date: fmtDate(log.date) })}</>} onClose={() => setSubmitOpen(false)} size="sm"
          footer={<>
            <Button variant="secondary" onClick={() => setSubmitOpen(false)}>{t("common.cancel")}</Button>
            <Button icon={busy ? <Loader2 className="spin" size={15} /> : <Lock size={15} />} disabled={busy} onClick={() => run({ action: "submit" }, fmt(t("dlog.submitted"), { date: fmtShort(log.date) }), () => setSubmitOpen(false))}>{t("dlog.submitLock")}</Button>
          </>}>
          <KeyValue items={[
            [t("dlog.crews"), crews.filter((c) => c.manpower.length).length],
            [t("dlog.workers"), totals.headcount],
            [t("dlog.delays"), `${(log.delays ?? []).reduce((s, x) => s + (Number(x.durationHours) || 0), 0)} h`],
            [t("dlog.safetyTitle"), (log.safety ?? []).length]
          ]} />
          <div className="m-stack-v" style={{ marginTop: 14 }}>
            {detail.missingCrews.length ? (
              <Note tone="warn">{fmt(t(detail.missingCrews.length === 1 ? "dlog.missingCrews1" : "dlog.missingCrews"), { count: detail.missingCrews.length, names: detail.missingCrews.slice(0, 4).map((c) => c.companyName).join(", ") + (detail.missingCrews.length > 4 ? "…" : "") })}</Note>
            ) : <Note tone="good">{t("dlog.allCrews")}</Note>}
            {!log.weather ? <Note tone="warn">{t("dlog.noWeatherYet")}</Note> : null}
            <Note>{t("dlog.submitNote")}</Note>
          </div>
        </Dialog>
      ) : null}

      {correctOpen ? <CorrectionDialog ctx={ctx} detail={detail} log={log} busy={busy} onRun={run} onClose={() => setCorrectOpen(false)} /> : null}
      {crewFor ? <CrewDialog t={t} company={crewFor.company} crew={crewFor.crew} busy={busy} onClose={() => setCrewFor(null)}
        onSave={(manpower, notes) => run({ action: "saveCrew", companyId: crewFor.company.companyId, manpower, notes, version: crewFor.crew?.version }, fmt(t("dlog.crewSaved"), { company: crewFor.company.companyName }), () => setCrewFor(null))} /> : null}
    </>
  );
}

type SaveFn = (section: SectionKey, value: unknown, base: unknown, done?: string, after?: () => void) => void;

// ---------- weather and site conditions ----------
function WeatherCard({ ctx, log, editable, busy, onSave, onRefresh }: { ctx: Ctx; log: LogView; editable: boolean; busy: boolean; onSave: SaveFn; onRefresh: () => void }) {
  const { t } = ctx;
  const [editing, setEditing] = useState(false);
  const w = log.weather;
  const manual = w?.source === "manual";
  const windFlag = Number(w?.windMaxKph ?? 0) > 50;
  const num = (v?: number, unit = "") => (v === undefined || v === null ? "—" : `${v}${unit}`);
  return (
    <Panel
      className="m-dlog-wide"
      title={<><CloudSun size={16} /> {t("dlog.weather")}</>}
      actions={<>
        {w ? <Badge tone={manual ? "blue" : "teal"}>{manual ? t("dlog.wxManual") : fmt(t("dlog.wxAuto"), { place: w.place || ctx.city })}</Badge> : null}
        {editable && !manual && !editing && ctx.city ? <Button small variant="ghost" icon={<RefreshCw size={14} />} disabled={busy} onClick={onRefresh}>{t("dlog.wxRefresh")}</Button> : null}
        {editable && !editing ? <Button small variant="secondary" icon={<Pencil size={14} />} disabled={busy} onClick={() => setEditing(true)}>{manual ? t("dlog.wxEdit") : t("dlog.wxEnter")}</Button> : null}
        {editable && manual && !editing ? <Button small variant="ghost" disabled={busy} onClick={() => onSave("weatherOverride", null, log.weatherOverride ?? null, t("dlog.wxCleared"))}>{t("dlog.wxClear")}</Button> : null}
      </>}
    >
      {editing ? (
        <WeatherForm t={t} initial={manual ? w : undefined} busy={busy} onCancel={() => setEditing(false)}
          onSave={(value) => onSave("weatherOverride", value, log.weatherOverride ?? null, t("dlog.wxSaved"), () => setEditing(false))} />
      ) : w ? (
        <>
          <div className="m-dlog-weather">
            <div className="m-dlog-wx"><small>{t("dlog.wxCondition")}</small><b>{label(t, "dlog.cond", w.condition)}</b></div>
            <div className="m-dlog-wx"><small>{t("dlog.wxHighLow")}</small><b>{num(w.tempMaxC, "°")} / {num(w.tempMinC, "°C")}</b></div>
            <div className="m-dlog-wx"><small>{t("dlog.wxPrecip")}</small><b>{num(w.precipitationMm, " mm")}</b></div>
            <div className={cx("m-dlog-wx", windFlag && "m-tone-red")}><small>{t("dlog.wxWind")}</small><b><Wind size={14} /> {num(w.windMaxKph, " km/h")}</b></div>
            <div className="m-dlog-wx m-dlog-wx-wide"><small>{t("dlog.wxSummary")}</small><b style={{ fontSize: 13 }}>{w.summary || "—"}</b></div>
          </div>
          {w.source === "open-meteo" ? (
            <p className="m-small m-muted" style={{ margin: "8px 0 0" }}>
              {w.fetchedAt ? `${fmt(t("dlog.wxFetched"), { when: new Date(w.fetchedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })} · ` : ""}
              <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">{t("dlog.wxCredit")}</a>
            </p>
          ) : null}
          {windFlag ? (
            <div style={{ marginTop: 10 }}>
              <Note tone="danger">
                <div className="m-row m-row-wrap" style={{ justifyContent: "space-between" }}>
                  <span><AlertTriangle size={14} /> {fmt(t("dlog.windFlag"), { wind: w.windMaxKph ?? 0 })}</span>
                  {log.delays?.some((x) => x.type === "weather") ? <Badge tone="red">{t("dlog.delayLogged")}</Badge> : editable ? (
                    <Button small variant="danger" disabled={busy} onClick={() => onSave("delays", [...(log.delays ?? []), { type: "weather", durationHours: 2, description: fmt(t("dlog.windDelay"), { wind: w.windMaxKph ?? 0 }) }], log.delays ?? [], t("dlog.delayAdded"))}>{t("dlog.flagDelay")}</Button>
                  ) : null}
                </div>
              </Note>
            </div>
          ) : null}
        </>
      ) : <p className="m-muted" style={{ margin: 0 }}>{!editable ? t("dlog.wxNone") : ctx.city ? t("dlog.wxNoneEditor") : t("dlog.wxNoCity")}</p>}

      <div className="m-dlog-site">
        <span className="m-small m-muted">{t("dlog.siteConditions")}</span>
        {editable ? (
          <Select value={log.siteConditions} disabled={busy} placeholder={t("dlog.siteChoose")}
            onChange={(v) => onSave("siteConditions", v, log.siteConditions, t("dlog.siteSaved"))}
            options={SITE_CONDITIONS.map((s) => ({ value: s, label: t(`dlog.site.${s}` as TranslationKey) }))} />
        ) : <b>{log.siteConditions ? t(`dlog.site.${log.siteConditions}` as TranslationKey) : "—"}</b>}
      </div>
    </Panel>
  );
}

function WeatherForm({ t, initial, busy, onSave, onCancel }: { t: T; initial?: Weather; busy: boolean; onSave: (w: Partial<Weather>) => void; onCancel: () => void }) {
  const [v, setV] = useState({
    condition: initial?.condition ?? "",
    tempMaxC: initial?.tempMaxC?.toString() ?? "",
    tempMinC: initial?.tempMinC?.toString() ?? "",
    precipitationMm: initial?.precipitationMm?.toString() ?? "",
    windMaxKph: initial?.windMaxKph?.toString() ?? "",
    summary: initial?.summary ?? ""
  });
  const n = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      onSave({ condition: v.condition || undefined, tempMaxC: n(v.tempMaxC), tempMinC: n(v.tempMinC), precipitationMm: n(v.precipitationMm), windMaxKph: n(v.windMaxKph), summary: v.summary.trim() || undefined });
    }}>
      <div className="m-dlog-inline">
        <Field label={t("dlog.wxCondition")}><Select value={v.condition} placeholder={t("dlog.choose")} onChange={(c) => setV({ ...v, condition: c })} options={CONDITIONS.map((c) => ({ value: c, label: t(`dlog.cond.${c}` as TranslationKey) }))} /></Field>
        <Field label={t("dlog.wxHigh")}><input className="m-input" type="number" step="0.1" value={v.tempMaxC} onChange={set("tempMaxC")} /></Field>
        <Field label={t("dlog.wxLow")}><input className="m-input" type="number" step="0.1" value={v.tempMinC} onChange={set("tempMinC")} /></Field>
        <Field label={t("dlog.wxPrecipMm")}><input className="m-input" type="number" min={0} step="0.1" value={v.precipitationMm} onChange={set("precipitationMm")} /></Field>
        <Field label={t("dlog.wxWindKmh")}><input className="m-input" type="number" min={0} value={v.windMaxKph} onChange={set("windMaxKph")} /></Field>
      </div>
      <div style={{ marginTop: 8 }}><Field label={t("dlog.wxSummary")} wide><input className="m-input" value={v.summary} maxLength={200} placeholder={t("dlog.wxSummaryHint")} onChange={set("summary")} /></Field></div>
      <div className="m-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
        <Button small variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button small type="submit" disabled={busy || (!v.condition && !v.tempMaxC && !v.tempMinC)}>{t("common.save")}</Button>
      </div>
    </form>
  );
}

// ---------- photos on the log ----------
// Added through the app's photo queue (functions/photos, linked to this log); they also show in
// Photos. A subcontractor sees and adds their own company's (`own`). Each photo can be pinned on a
// drawing where it was taken (`canPin`: whoever places pins; the drawings Function checks again).
function PhotosCard({ ctx, logId, date, photos, canAdd, canPin, own }: { ctx: Ctx; logId: string; date: string; photos: LogPhoto[]; canAdd: boolean; canPin: boolean; own: boolean }) {
  const { t, projectId } = ctx;
  const input = useRef<HTMLInputElement>(null);
  const pins = usePhotoPins(projectId, photos.map((p) => p.ItemId));
  const [pinning, setPinning] = useState<string>();
  const queue = useLogPhotoQueue(projectId, logId, date);
  const add = (files: FileList | null) => {
    const list = [...(files ?? [])];
    const good = list.filter((f) => !photoRefusal(f));
    if (good.length < list.length) ctx.toast(t("dlog.notAPhoto"), "warn");
    if (!good.length) return;
    addLogPhotos(projectId, logId, good);
    ctx.toast(fmt(t(good.length === 1 ? "dlog.photoUploading1" : "dlog.photosUploading"), { count: good.length }));
  };
  const count = photos.length + queue.busy.length;
  return (
    <Panel className="m-dlog-wide" title={<><Camera size={16} /> {t("dlog.photos")} {count ? <Badge>{count}</Badge> : null}</>}
      actions={canAdd ? <Button small variant="secondary" icon={<Camera size={14} />} onClick={() => input.current?.click()}>{t("dlog.addPhotos")}</Button> : null}>
      <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      {photos.length || queue.busy.length ? (
        <div className="m-dlog-photos">
          {queue.busy.map((x) => (
            <div key={x.id} className="m-dlog-photo m-dlog-photo-busy">
              {x.localUrl ? <img src={x.localUrl} alt="" /> : <span className="m-dlog-nophoto"><Camera size={20} /></span>}
              <small><Loader2 className="spin" size={11} /> {t("dlog.photoSending")}</small>
            </div>
          ))}
          {photos.map((ph) => {
            const place = pins.data?.[ph.ItemId];
            return (
              <div key={ph.ItemId} className="m-dlog-photo-cell">
                <button type="button" className="m-dlog-photo" onClick={() => ctx.onNavigate(`/photos/${ph.ItemId}`)} title={ph.caption || undefined}>
                  {ph.thumbUrl || ph.previewUrl ? <img src={ph.thumbUrl ?? ph.previewUrl} alt={ph.caption} loading="lazy" /> : <span className="m-dlog-nophoto"><ImageOff size={20} /></span>}
                  <small>{ph.uploadedByName}{ph.companyName ? ` · ${ph.companyName}` : ""} · {fmtDateTime(ph.takenAt)}</small>
                </button>
                {place ? <PinnedChip place={place} onNavigate={ctx.onNavigate} t={t} />
                  : canPin && pins.data ? <button type="button" className="m-link m-small m-pin-chip" onClick={() => setPinning(ph.ItemId)}><MapPin size={12} /> {t("drw.photo.pinOnDrawing")}</button>
                  : null}
              </div>
            );
          })}
        </div>
      ) : <p className="m-muted" style={{ margin: 0 }}>{own ? t("dlog.noPhotosOwn") : canAdd ? t("dlog.noPhotos") : t("dlog.noPhotosRead")}</p>}
      {queue.failed.length ? (
        <div style={{ marginTop: 10 }}>
          <Note tone="warn">
            <div className="m-row m-row-wrap" style={{ justifyContent: "space-between" }}>
              <span>{fmt(t(queue.failed.length === 1 ? "dlog.photoFailed1" : "dlog.photosFailed"), { count: queue.failed.length })}{queue.failed[0]?.error ? ` ${queue.failed[0].error}` : ""}</span>
              <Button small variant="secondary" icon={<RefreshCw size={13} />} onClick={() => queue.failed.forEach((x) => retryPhoto(x.id))}>{t("dlog.retryPhotos")}</Button>
            </div>
          </Note>
        </div>
      ) : null}
      {pinning ? <PinPhotoDialog projectId={projectId} photoId={pinning} onNavigate={ctx.onNavigate} onClose={() => setPinning(undefined)} t={t} /> : null}
    </Panel>
  );
}

// ---------- notes ----------
function NotesCard({ ctx, log, editable, busy, onSave }: { ctx: Ctx; log: LogView; editable: boolean; busy: boolean; onSave: SaveFn }) {
  const { t } = ctx;
  const saved = log.notes ?? "";
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const changed = text !== saved;
  return (
    <Panel className="m-dlog-wide" title={<><StickyNote size={16} /> {t("dlog.notes")}</>}
      actions={editable && changed ? <Button small disabled={busy} onClick={() => onSave("notes", text, saved, t("dlog.notesSaved"))}>{t("common.save")}</Button> : null}>
      {editable ? (
        <textarea className="m-input" value={text} maxLength={8000} placeholder={t("dlog.notesHint")} onChange={(e) => setText(e.target.value)} />
      ) : <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{saved || <span className="m-muted">{t("dlog.noNotes")}</span>}</p>}
    </Panel>
  );
}

// ---------- the five row cards ----------
type FieldDef = { key: string; label: TranslationKey; type?: "text" | "number" | "time"; options?: readonly string[]; optionPrefix?: string; required?: boolean; wide?: boolean };

const CARD: Record<RowSectionKey, { title: TranslationKey; fields: FieldDef[] }> = {
  equipment: {
    title: "dlog.equipment",
    fields: [
      { key: "name", label: "dlog.f.equipment", required: true },
      { key: "quantity", label: "dlog.f.quantity", type: "number" },
      { key: "hoursUsed", label: "dlog.f.hours", type: "number" },
      { key: "status", label: "dlog.f.status", options: EQUIPMENT_STATUS, optionPrefix: "dlog.eq" },
      { key: "notes", label: "dlog.f.notes", wide: true }
    ]
  },
  deliveries: {
    title: "dlog.deliveries",
    fields: [
      { key: "time", label: "dlog.f.time", type: "time" },
      { key: "supplier", label: "dlog.f.supplier", required: true },
      { key: "material", label: "dlog.f.material", required: true },
      { key: "quantity", label: "dlog.f.quantity" },
      { key: "deliveryNoteNo", label: "dlog.f.noteNo" }
    ]
  },
  visitors: {
    title: "dlog.visitors",
    fields: [
      { key: "name", label: "dlog.f.name", required: true },
      { key: "organisation", label: "dlog.f.organisation" },
      { key: "purpose", label: "dlog.f.purpose" },
      { key: "timeIn", label: "dlog.f.timeIn", type: "time" },
      { key: "timeOut", label: "dlog.f.timeOut", type: "time" }
    ]
  },
  delays: {
    title: "dlog.delays",
    fields: [
      { key: "type", label: "dlog.f.type", options: DELAY_TYPES, optionPrefix: "dlog.delay" },
      { key: "durationHours", label: "dlog.f.hoursLost", type: "number" },
      { key: "description", label: "dlog.f.description", required: true, wide: true }
    ]
  },
  safety: {
    title: "dlog.safetyTitle",
    fields: [
      { key: "type", label: "dlog.f.type", options: SAFETY_TYPES, optionPrefix: "dlog.safety" },
      { key: "description", label: "dlog.f.description", required: true, wide: true },
      { key: "actionTaken", label: "dlog.f.action", wide: true }
    ]
  }
};

type AnyRow = Record<string, unknown>;

function rowLine(t: T, section: RowSectionKey, r: AnyRow): ReactNode {
  const s = (k: string) => (r[k] === undefined || r[k] === null || r[k] === "" ? "" : String(r[k]));
  switch (section) {
    case "equipment":
      return <><b>{s("name")}</b>{s("quantity") ? <span>× {s("quantity")}</span> : null}{s("hoursUsed") ? <span>{s("hoursUsed")} h</span> : null}<Badge tone={r.status === "broken" ? "red" : r.status === "idle" ? "gray" : "green"}>{label(t, "dlog.eq", s("status"))}</Badge>{s("notes") ? <span className="m-muted m-small">{s("notes")}</span> : null}</>;
    case "deliveries":
      return <>{s("time") ? <span className="m-mono">{s("time")}</span> : null}<b>{s("supplier")}</b><span>{s("material")}{s("quantity") ? ` · ${s("quantity")}` : ""}</span>{s("deliveryNoteNo") ? <span className="m-muted m-small">{fmt(t("dlog.noteNoIs"), { no: s("deliveryNoteNo") })}</span> : null}</>;
    case "visitors":
      return <>{s("timeIn") ? <span className="m-mono">{s("timeIn")}{s("timeOut") ? `–${s("timeOut")}` : ""}</span> : null}<b>{s("name")}</b>{s("organisation") ? <span className="m-small m-muted">{s("organisation")}</span> : null}{s("purpose") ? <span>{s("purpose")}</span> : null}</>;
    case "delays":
      return <><Badge tone={DELAY_TONE}>{label(t, "dlog.delay", s("type"))}</Badge>{s("durationHours") ? <b>{s("durationHours")} h</b> : null}<span>{s("description")}</span></>;
    case "safety":
      return <><Badge tone={SAFETY_TONE[s("type")] ?? "gray"}>{label(t, "dlog.safety", s("type"))}</Badge><span>{s("description")}</span>{s("actionTaken") ? <span className="m-small m-muted">{fmt(t("dlog.actionIs"), { action: s("actionTaken") })}</span> : null}</>;
  }
}

function RowCard({ section, ctx, log, editable, busy, onSave, icon, badge }: { section: RowSectionKey; ctx: Ctx; log: LogView; editable: boolean; busy: boolean; onSave: SaveFn; icon: ReactNode; badge?: ReactNode }) {
  const { t } = ctx;
  const def = CARD[section];
  const rows = (log[section] ?? []) as AnyRow[];
  const empty = useMemo(() => Object.fromEntries(def.fields.map((f) => [f.key, f.options?.[0] ?? (f.type === "time" && f.key !== "timeOut" ? nowTime() : "")])), [def]);
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(empty);
  const missing = def.fields.some((f) => f.required && !String(values[f.key] ?? "").trim());
  const toRow = (): AnyRow => Object.fromEntries(def.fields.map((f) => {
    const v = String(values[f.key] ?? "").trim();
    return [f.key, f.type === "number" ? (v === "" ? undefined : Number(v)) : v];
  }));
  return (
    <Panel
      title={<>{icon} {t(def.title)} <Badge>{rows.length}</Badge></>}
      actions={<>{badge}{editable && !adding ? <Button small variant="ghost" icon={<Plus size={14} />} disabled={busy} onClick={() => { setValues(empty); setAdding(true); }}>{t("dlog.add")}</Button> : null}</>}
    >
      {rows.length ? (
        <ul className="m-dlog-list">
          {rows.map((r, i) => (
            <li key={String(r.rowId ?? i)}>
              <div className="m-row m-row-wrap" style={{ gap: 10 }}>{rowLine(t, section, r)}</div>
              {editable ? (
                <button className="m-icon-btn" aria-label={fmt(t("dlog.removeFrom"), { card: t(def.title) })} disabled={busy}
                  onClick={() => onSave(section, rows.filter((_, n) => n !== i), rows, t("dlog.removed"))}><Trash2 size={14} /></button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="m-muted" style={{ margin: 0 }}>{t("dlog.noneRecorded")}</p>}
      {adding ? (
        <form onSubmit={(e) => { e.preventDefault(); if (!missing) onSave(section, [...rows, toRow()], rows, t("dlog.added"), () => setAdding(false)); }}>
          <div className="m-dlog-inline">
            {def.fields.map((f) => (
              <div key={f.key} className={cx(f.wide && "m-dlog-inline-wide")}>
                <Field label={`${t(f.label)}${f.required ? " *" : ""}`}>
                  {f.options ? (
                    <Select value={values[f.key] ?? ""} onChange={(v) => setValues({ ...values, [f.key]: v })} options={f.options.map((o) => ({ value: o, label: t(`${f.optionPrefix}.${o}` as TranslationKey) }))} />
                  ) : (
                    <input className="m-input" type={f.type ?? "text"} min={f.type === "number" ? 0 : undefined} step={f.type === "number" ? "0.5" : undefined} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                  )}
                </Field>
              </div>
            ))}
          </div>
          <div className="m-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <Button small variant="ghost" onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
            <Button small type="submit" disabled={busy || missing}>{busy ? t("dlog.saving") : t("common.save")}</Button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}

// ---------- history ----------
function HistoryCard({ t, history }: { t: T; history: LogDetail["history"] }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel className="m-dlog-wide" title={<><History size={16} /> {t("dlog.history")} <Badge>{history.length}</Badge></>}
      actions={<Button small variant="ghost" onClick={() => setOpen(!open)}>{open ? t("dlog.hide") : t("dlog.show")}</Button>}>
      {open ? <Timeline items={history.map((h) => ({ who: h.actorName, when: fmtDateTime(h.at), title: h.summary ?? h.action, body: h.reason || undefined }))} /> : <p className="m-muted m-small" style={{ margin: 0 }}>{t("dlog.historyHint")}</p>}
    </Panel>
  );
}

// ---------- add a company's crew (GC) ----------
function AddCompanyRow({ t, options, onAdd }: { t: T; options: CrewCompany[]; onAdd: (c: CrewCompany) => void }) {
  const [id, setId] = useState("");
  return (
    <div className="m-row">
      <div style={{ minWidth: 220 }}><Select value={id} onChange={setId} placeholder={t("dlog.addCompany")} options={options.map((c) => ({ value: c.companyId, label: c.companyName }))} /></div>
      <Button small variant="secondary" icon={<Plus size={14} />} disabled={!id} onClick={() => { const c = options.find((x) => x.companyId === id); if (c) onAdd(c); setId(""); }}>{t("dlog.add")}</Button>
    </div>
  );
}

// ---------- one company's crew ----------
type CrewDraft = { rowId?: string; trade: string; headcount: string; hours: string; workDone: string; location: string };
const toDraft = (r: ManpowerRow): CrewDraft => ({ rowId: r.rowId, trade: r.trade ?? "", headcount: String(r.headcount ?? 0), hours: r.hours === undefined ? "" : String(r.hours), workDone: r.workDone ?? "", location: r.location ?? "" });
const fromDraft = (d: CrewDraft): ManpowerRow => ({ rowId: d.rowId, trade: d.trade.trim(), headcount: Math.max(0, Math.round(Number(d.headcount) || 0)), hours: d.hours.trim() === "" ? undefined : Number(d.hours), workDone: d.workDone.trim(), location: d.location.trim() });

function CrewEditor({ t, rows, setRows }: { t: T; rows: CrewDraft[]; setRows: (r: CrewDraft[]) => void }) {
  const put = (i: number, k: keyof CrewDraft, v: string) => setRows(rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  return (
    <div className="m-dlog-crew">
      {rows.map((r, i) => (
        <div key={r.rowId ?? `new-${i}`} className="m-dlog-crew-row">
          <Field label={t("dlog.trade")}><input className="m-input" value={r.trade} maxLength={60} onChange={(e) => put(i, "trade", e.target.value)} /></Field>
          <Field label={t("dlog.workers")}><input className="m-input m-dlog-num" type="number" min={0} max={500} value={r.headcount} onChange={(e) => put(i, "headcount", e.target.value)} /></Field>
          <Field label={t("dlog.hoursTotal")}><input className="m-input m-dlog-num" type="number" min={0} step="0.5" value={r.hours} onChange={(e) => put(i, "hours", e.target.value)} /></Field>
          <Field label={t("dlog.workDone")}><input className="m-input" value={r.workDone} maxLength={1000} onChange={(e) => put(i, "workDone", e.target.value)} /></Field>
          <Field label={t("dlog.location")}><input className="m-input" value={r.location} maxLength={120} onChange={(e) => put(i, "location", e.target.value)} /></Field>
          <button type="button" className="m-icon-btn" aria-label={t("dlog.removeRow")} onClick={() => setRows(rows.filter((_, n) => n !== i))}><Trash2 size={15} /></button>
        </div>
      ))}
      <div><Button small variant="ghost" icon={<Plus size={14} />} onClick={() => setRows([...rows, { trade: "", headcount: "1", hours: "8", workDone: "", location: "" }])}>{t("dlog.addRow")}</Button></div>
    </div>
  );
}

function CrewDialog({ t, company, crew, busy, onSave, onClose }: { t: T; company: CrewCompany; crew?: Crew; busy: boolean; onSave: (manpower: ManpowerRow[], notes: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState<CrewDraft[]>(() => (crew?.manpower.length ? crew.manpower.map(toDraft) : [{ trade: "", headcount: "1", hours: "8", workDone: "", location: "" }]));
  const [notes, setNotes] = useState(crew?.notes ?? "");
  const total = totalsOf(rows.map(fromDraft));
  return (
    <Dialog size="lg" title={<><HardHat size={18} /> {fmt(t("dlog.crewTitle"), { company: company.companyName })}</>} onClose={onClose}
      footer={<>
        <span className="m-small m-muted" style={{ marginRight: "auto" }}>{totalsText(t, total)}</span>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={busy} icon={busy ? <Loader2 className="spin" size={15} /> : undefined} onClick={() => onSave(rows.map(fromDraft), notes.trim())}>{t("common.save")}</Button>
      </>}>
      <p className="m-small m-muted" style={{ marginTop: 0 }}>{t("dlog.crewHint")}</p>
      <CrewEditor t={t} rows={rows} setRows={setRows} />
      <div style={{ marginTop: 12 }}>
        <Field label={t("dlog.crewNotes")} wide><textarea className="m-input" value={notes} maxLength={4000} placeholder={t("dlog.crewNotesHint")} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

// ---------- audited correction (PM, submitted logs) ----------
function CorrectionDialog({ ctx, detail, log, busy, onRun, onClose }: { ctx: Ctx; detail: LogDetail; log: LogView; busy: boolean; onRun: (body: LogAction, done?: string, after?: () => void) => void; onClose: () => void }) {
  const { t } = ctx;
  const crewTargets = detail.companies.map((c) => ({ company: c, crew: detail.crews.find((x) => x.companyId === c.companyId) }));
  const [target, setTarget] = useState(crewTargets[0] ? `crew:${crewTargets[0].company.companyId}` : "notes");
  const chosen = target.startsWith("crew:") ? crewTargets.find((c) => `crew:${c.company.companyId}` === target) : undefined;
  const startRows = (c?: Crew) => (c?.manpower.length ? c.manpower.map(toDraft) : [{ trade: "", headcount: "0", hours: "", workDone: "", location: "" }]);
  const [rows, setRows] = useState<CrewDraft[]>(() => startRows(chosen?.crew));
  const [crewNotes, setCrewNotes] = useState(chosen?.crew?.notes ?? "");
  const [notes, setNotes] = useState(log.notes ?? "");
  const [site, setSite] = useState(log.siteConditions);
  const [reason, setReason] = useState("");
  const choose = (v: string) => {
    setTarget(v);
    const c = crewTargets.find((x) => `crew:${x.company.companyId}` === v);
    setRows(startRows(c?.crew));
    setCrewNotes(c?.crew?.notes ?? "");
  };
  const tooShort = reason.trim().length < 5;
  const save = () => {
    const body: LogAction = chosen
      ? { action: "correct", reason: reason.trim(), crewCompanyId: chosen.company.companyId, manpower: rows.map(fromDraft), notes: crewNotes.trim() }
      : target === "notes"
        ? { action: "correct", reason: reason.trim(), section: "notes", value: notes }
        : { action: "correct", reason: reason.trim(), section: "siteConditions", value: site };
    onRun(body, t("dlog.correctionSaved"), onClose);
  };
  return (
    <Dialog size="lg" title={<><Pencil size={18} /> {t("dlog.correct")}</>} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={tooShort || busy} title={tooShort ? t("dlog.reasonNeeded") : undefined} onClick={save}>{t("dlog.saveCorrection")}</Button>
      </>}>
      <div className="m-form">
        <Field label={t("dlog.correctWhat")} wide>
          <Select value={target} onChange={choose} options={[
            ...crewTargets.map((c) => ({ value: `crew:${c.company.companyId}`, label: fmt(t("dlog.correctCrew"), { company: c.company.companyName }) })),
            { value: "notes", label: t("dlog.notes") },
            { value: "siteConditions", label: t("dlog.siteConditions") }
          ]} />
        </Field>
        {chosen ? (
          <div className="m-dlog-wide-field">
            <CrewEditor t={t} rows={rows} setRows={setRows} />
            <div style={{ marginTop: 8 }}><Field label={t("dlog.crewNotes")} wide><textarea className="m-input" value={crewNotes} onChange={(e) => setCrewNotes(e.target.value)} /></Field></div>
          </div>
        ) : target === "notes" ? (
          <Field label={t("dlog.notes")} wide><textarea className="m-input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        ) : (
          <Field label={t("dlog.siteConditions")} wide>
            <Select value={site} onChange={setSite} placeholder={t("dlog.siteChoose")} options={SITE_CONDITIONS.map((s) => ({ value: s, label: t(`dlog.site.${s}` as TranslationKey) }))} />
          </Field>
        )}
        <Field label={t("dlog.reasonLabel")} wide hint={tooShort ? t("dlog.reasonMin") : undefined}>
          <textarea className="m-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("dlog.reasonHint")} />
        </Field>
      </div>
    </Dialog>
  );
}

