// Field app (MOB-01), built from the demo app's FieldPage (mock/src/mock/pages/FieldPage.tsx).
// On a phone /field is the whole screen: an app bar, the tab's content and a bottom tab bar. On a
// wider screen the same app sits in a phone-sized frame, so the office can see what the site sees.
// It runs on the same Functions as the desktop pages (punch, RFIs, daily logs); nothing is stored
// apart. Not here, unlike the demo: the simulated network and upload queue panels (the real
// connection is used), offline sheets and offline entry (R3) and installing as an app (R2).
//
// The tab and an open screen live in the address (?tab=punch, ?item=<id>, ?new=1), so a reload
// keeps them and the phone's back button closes a screen.
// Built: part 1 (the shell, Today), part 2 (Punch: list, 3-tap capture, item; FieldPunch.tsx).
// Drawings, Log and More come in parts 3-5; until then each opens the module on the full site.
import { Bell, Camera, ChevronRight, ClipboardCheck, HardHat, Home, Map as MapIcon, Menu, Monitor, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { todayIso } from "../../lib/workdays";
import { Badge, Button, Empty, Toasts, cx, fmt, useToasts } from "../../shared/m/ui";
import { useCurrentUser } from "../profile/useCurrentUser";
import { useProjects } from "../projects/projectsApi";
import { fmtShortDate } from "../projects/ProjectsPage";
import { usePunchList, usePunchPhotoQueue } from "../punch/punchApi";
import { rfisOnMe, useRfiList } from "../rfis/rfisApi";
import { useLogDay } from "../dailyLogs/dailyLogsApi";
import type { LogDetail } from "../dailyLogs/dailyLogsApi";
import { COND_ICON } from "../dailyLogs/DailyLogsPage";
import { AppBar, PunchLine, TAB_KEYS, myPunch } from "./fieldUi";
import type { Ctx, Screen, Tab } from "./fieldUi";
import { CaptureScreen, ItemScreen, PunchTab } from "./FieldPunch";
import "./Field.css";

const TABS: { key: Tab; label: TranslationKey; icon: ReactNode }[] = [
  { key: "today", label: "fld.tab.today", icon: <Home size={22} /> },
  { key: "punch", label: "fld.tab.punch", icon: <ClipboardCheck size={22} /> },
  { key: "drawings", label: "fld.tab.drawings", icon: <MapIcon size={22} /> },
  { key: "log", label: "fld.tab.log", icon: <HardHat size={22} /> },
  { key: "more", label: "fld.tab.more", icon: <Menu size={22} /> }
];

// ---------- the address ----------
function readUrl(): { tab: Tab; screen: Screen } {
  const q = new URLSearchParams(window.location.search);
  const tab = TAB_KEYS.find((k) => k === q.get("tab")) ?? "today";
  const item = q.get("item");
  return { tab, screen: item ? { kind: "item", id: item } : q.get("new") ? { kind: "capture" } : null };
}
function urlOf(tab: Tab, screen: Screen) {
  const q = new URLSearchParams();
  if (tab !== "today") q.set("tab", tab);
  if (screen?.kind === "item") q.set("item", screen.id);
  if (screen?.kind === "capture") q.set("new", "1");
  const s = q.toString();
  return `/field${s ? `?${s}` : ""}`;
}
const scrollTop = () => document.querySelector(".fld-body")?.scrollTo({ top: 0 });

export function FieldPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const me = useCurrentUser();
  const { project, myRole, myUserId, myCompanyName, query } = useProjects();
  const [{ tab, screen }, setState] = useState(readUrl);
  const { items: toasts, toast } = useToasts();
  const isSub = myRole === "field-user";
  const isGc = myRole === "superintendent" || myRole === "project-manager";
  const seesPunch = Boolean(myRole) && myRole !== "design-reviewer";
  // One read of the list, shared with the tabs (React Query's cache).
  const punch = usePunchList(seesPunch ? project?.ItemId : undefined);
  // Re-reads an item and the list when one of its photos has arrived.
  const photoQueue = usePunchPhotoQueue(project?.ItemId);
  const badge = myPunch(punch.data?.items, { isSub, isGc, myUserId }).mine.length;
  const firstName = (me.data?.data as { firstName?: string } | undefined)?.firstName ?? "";

  useEffect(() => {
    const onPop = () => { setState(readUrl()); scrollTop(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setTab = useCallback((next: Tab) => {
    window.history.replaceState(null, "", urlOf(next, null));
    setState({ tab: next, screen: null });
    scrollTop();
  }, []);
  const open = useCallback((next: Screen) => {
    window.history.pushState({ fld: true }, "", urlOf(tab, next));
    setState({ tab, screen: next });
    scrollTop();
  }, [tab]);
  const back = useCallback(() => {
    // Opened from inside the app: a real step back (the phone's back button does the same).
    if ((window.history.state as { fld?: boolean } | null)?.fld) { window.history.back(); return; }
    window.history.replaceState(null, "", urlOf(tab, null));
    setState({ tab, screen: null });
  }, [tab]);
  const leaveTo = useCallback((next: Tab) => {
    window.history.replaceState(null, "", urlOf(next, null));
    setState({ tab: next, screen: null });
    scrollTop();
  }, []);

  // A designer has no punch items or daily logs (as on the desktop).
  const tabs = TABS.filter((x) => seesPunch || (x.key !== "punch" && x.key !== "log"));
  const shownTab = tabs.some((x) => x.key === tab) ? tab : "today";

  let content: ReactNode;
  if (query.isLoading) {
    content = <div className="fld-body"><p className="fld-muted fld-center">{t("shell.loading")}</p></div>;
  } else if (!project) {
    content = (
      <div className="fld-body">
        <Empty icon={<HardHat size={28} />} title={t("prj.noneTitle")}>{t("prj.noneAsk")}</Empty>
      </div>
    );
  } else {
    const ctx: Ctx = { t, project, myRole, myUserId, myCompanyName, today: todayIso(), isSub, isGc, seesPunch, photoQueue, setTab, open, back, leaveTo, toast, onNavigate };
    content = screen?.kind === "item" && seesPunch ? <ItemScreen key={screen.id} ctx={ctx} id={screen.id} />
      : screen?.kind === "capture" && seesPunch ? <CaptureScreen ctx={ctx} />
      : shownTab === "today" ? <TodayTab ctx={ctx} firstName={firstName} />
      : shownTab === "punch" ? <PunchTab ctx={ctx} />
      : <LaterTab ctx={ctx} tab={shownTab} />;
  }

  return (
    <div className="fld-page">
      <div className="fld-preview">
        <span><Smartphone size={16} /> {t("fld.preview")}</span>
        <Button small variant="secondary" icon={<Monitor size={14} />} onClick={() => onNavigate("/")}>{t("fld.fullSite")}</Button>
      </div>
      <div className="fld-phone">
        <div className="fld-app">
          {content}
          {project && !screen ? (
            <nav className="fld-tabs" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} aria-label={t("nav.field")}>
              {tabs.map((x) => (
                <button key={x.key} type="button" className={cx("fld-tab", shownTab === x.key && "fld-tab-on")} aria-current={shownTab === x.key ? "page" : undefined} onClick={() => setTab(x.key)}>
                  {x.icon}
                  {t(x.label)}
                  {x.key === "punch" && badge ? <b>{badge}</b> : null}
                </button>
              ))}
            </nav>
          ) : null}
          <Toasts items={toasts} />
        </div>
      </div>
    </div>
  );
}

// ---------- Today ----------

function TodayTab({ ctx, firstName }: { ctx: Ctx; firstName: string }) {
  const { t, project, isSub, isGc, seesPunch, today, setTab, onNavigate } = ctx;
  const punch = usePunchList(seesPunch ? project.ItemId : undefined);
  const rfis = useRfiList(project.ItemId);
  const day = useLogDay(seesPunch ? project.ItemId : undefined, today);
  const { mine, scope } = myPunch(punch.data?.items, ctx);
  const overdue = scope.filter((p) => p.overdue).length;
  const rfiCount = rfisOnMe(rfis.data?.rfis, ctx.myUserId, today).length;
  const punchTitle = isSub ? t("fld.myPunch") : isGc ? t("fld.toVerify") : t("fld.openPunch");

  return (
    <>
      <AppBar
        title={firstName ? fmt(t("fld.hi"), { name: firstName }) : t("fld.hiNoName")}
        sub={`${project.number} · ${project.name}`}
        right={<span className="fld-date">{fmtShortDate(today)}</span>}
      />
      <div className="fld-body">
        {seesPunch ? <LogCard ctx={ctx} day={day.data} loading={day.isLoading} failed={day.isError} /> : null}

        {seesPunch ? (
          <button type="button" className="fld-card" onClick={() => setTab("punch")}>
            <h4>
              <span><ClipboardCheck size={16} /> {punchTitle}</span>
              {punch.isLoading ? <span className="m-muted">…</span> : <Badge tone={mine.length ? "amber" : "green"}>{mine.length}</Badge>}
            </h4>
            {punch.isLoading
              ? <span className="fld-muted">{t("shell.loading")}</span>
              : punch.isError
              ? <span className="fld-muted">{t("fld.couldNotLoad")}</span>
              : overdue ? <span className="fld-over">{fmt(t(overdue === 1 ? "fld.overdue1" : "fld.overdue"), { count: overdue })}</span>
                : <span className="fld-muted">{t("fld.noneOverdue")}</span>}
          </button>
        ) : null}
        {seesPunch && mine.length ? (
          <div className="fld-list">
            {mine.slice(0, 3).map((p) => <PunchLine key={p.ItemId} p={p} ctx={ctx} />)}
            {mine.length > 3 ? <button type="button" className="fld-more" onClick={() => setTab("punch")}>{fmt(t("fld.seeAll"), { count: mine.length })} <ChevronRight size={15} /></button> : null}
          </div>
        ) : null}

        <button type="button" className="fld-card" onClick={() => onNavigate("/rfis")}>
          <h4>
            <span><Bell size={16} /> {t("fld.rfisWithMe")}</span>
            {rfis.isLoading ? <span className="m-muted">…</span> : <Badge tone={rfiCount ? "blue" : "gray"}>{rfiCount}</Badge>}
          </h4>
          <span className="fld-muted">{rfis.isLoading ? t("shell.loading") : rfis.isError ? t("fld.couldNotLoad") : rfiCount ? t("fld.rfisAnswer") : t("fld.rfisNone")}</span>
        </button>

        <div className="fld-actions">
          {punch.data?.can.create ? <button type="button" className="fld-big fld-primary" onClick={() => ctx.open({ kind: "capture" })}><Camera size={20} /> {t("fld.newPunch")}</button> : null}
          {isSub && day.data?.can.editOwnCrew ? <button type="button" className="fld-big fld-secondary" onClick={() => setTab("log")}><HardHat size={20} /> {t("fld.addCrew")}</button> : null}
          {isGc ? <button type="button" className="fld-big fld-secondary" onClick={() => setTab("log")}><HardHat size={20} /> {t("fld.openLog")}</button> : null}
        </div>
      </div>
    </>
  );
}

function LogCard({ ctx, day, loading, failed }: { ctx: Ctx; day?: LogDetail; loading: boolean; failed: boolean }) {
  const { t, isSub, isGc, setTab } = ctx;
  const log = day?.log;
  const w = log?.weather;
  const Icon = w?.condition ? COND_ICON[w.condition] : null;
  let badge: ReactNode = null;
  let line: ReactNode = null;
  if (loading) line = <span className="fld-muted">{t("shell.loading")}</span>;
  else if (failed || !day) line = <span className="fld-muted">{t("fld.couldNotLoad")}</span>;
  else if (day.pending) {
    badge = <Badge tone="gray">{t("fld.logPending")}</Badge>;
  } else if (!log) {
    badge = <Badge tone="red">{t("fld.logNotStarted")}</Badge>;
    line = <span className="fld-muted">{isGc ? t("fld.logStartGc") : t("fld.logStartOther")}</span>;
  } else {
    badge = log.status === "submitted" ? <Badge tone="green">{t("fld.logSubmitted")}</Badge> : <Badge tone="amber">{t("dlog.draft")}</Badge>;
    if (isSub) {
      const own = day.crews.find((c) => c.companyId === day.ownCompanyId);
      line = own && own.headcount > 0
        ? <span className="fld-good">{fmt(t(own.headcount === 1 ? "fld.yourCrew1" : "fld.yourCrew"), { count: own.headcount })}</span>
        : <span className="fld-muted">{log.status === "submitted" ? t("fld.noCrewSubmitted") : t("fld.noCrewYet")}</span>;
    } else if (isGc) {
      const subs = day.companies.filter((c) => !c.own).length;
      const added = subs - day.missingCrews.length;
      line = <span className={added < subs && log.status === "draft" ? "fld-muted" : "fld-good"}>{fmt(t("fld.crewsAdded"), { added, total: subs })}</span>;
    } else if (log.totalHeadcount) {
      line = <span className="fld-muted">{fmt(t(log.totalHeadcount === 1 ? "fld.onSite1" : "fld.onSite"), { count: log.totalHeadcount })}</span>;
    }
  }
  return (
    <button type="button" className="fld-card" onClick={() => setTab("log")}>
      <h4><span><HardHat size={16} /> {t("fld.todaysLog")}</span>{badge}</h4>
      {w && (w.condition || w.tempMaxC != null) ? (
        <span className="fld-weather">
          {Icon ? <Icon size={16} /> : null}
          {w.condition ? t(`dlog.cond.${w.condition}` as TranslationKey) : null}
          {w.tempMaxC != null ? <> · {Math.round(w.tempMaxC)}° / {Math.round(w.tempMinC ?? w.tempMaxC)}°</> : null}
          {w.windMaxKph != null ? <> · {fmt(t("fld.wind"), { kph: Math.round(w.windMaxKph) })}</> : null}
        </span>
      ) : null}
      {line}
    </button>
  );
}

// ---------- tabs still to build ----------

const LATER: Record<"drawings" | "log" | "more", { title: TranslationKey; path: string; open: TranslationKey }> = {
  drawings: { title: "fld.tab.drawings", path: "/drawings", open: "fld.openDrawings" },
  log: { title: "fld.tab.log", path: "/daily-logs", open: "fld.openLogPage" },
  more: { title: "fld.tab.more", path: "/", open: "fld.fullSite" }
};

function LaterTab({ ctx, tab }: { ctx: Ctx; tab: Tab }) {
  const { t, onNavigate, today } = ctx;
  const x = LATER[tab as keyof typeof LATER] ?? LATER.more;
  const path = tab === "log" ? `${x.path}/${today}` : x.path;
  return (
    <>
      <AppBar title={t(x.title)} />
      <div className="fld-body">
        <Empty icon={<Smartphone size={28} />} title={t("fld.laterTitle")}>{t("fld.laterBody")}</Empty>
        <div className="fld-actions">
          <button type="button" className="fld-big fld-secondary" onClick={() => onNavigate(path)}><Monitor size={20} /> {t(x.open)}</button>
        </div>
      </div>
    </>
  );
}
