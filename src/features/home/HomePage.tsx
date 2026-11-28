// Project home (PRJ-02), built from the demo app's HomePage (mock/src/mock/pages/HomePage.tsx):
// the project header, quick actions, "My items" first, then the project's health.
// Real now: the header (project, dates, time elapsed, contract value for cost roles), the role
// notes, "My items" for RFIs, submittals and punch items (ball in court on me), and the RFI,
// submittal and punch numbers. Daily logs and activity fill in as each module is built; until then
// their panels say which phase brings them.
import { CalendarDays, Camera, CheckCircle2, ClipboardCheck, FileQuestion, FileStack, HardHat, Lock, MapPin, Plus, Users } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ROLE_LABEL, isProjectRole } from "../../lib/roles";
import { todayIso, workingDaysBetween } from "../../lib/workdays";
import { Badge, Button, Empty, Kpi, Note, Panel, cx, fmt } from "../../shared/m/ui";
import { useCurrentUser } from "../profile/useCurrentUser";
import { hueOf, stageOf, timeElapsed, useProjects } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { rfisOnMe, useRfiList } from "../rfis/rfisApi";
import type { RfiRow } from "../rfis/rfisApi";
import { DueLabel, StatusPill } from "../rfis/RfisPage";
import { punchOnMe, usePunchList } from "../punch/punchApi";
import type { PunchRow } from "../punch/punchApi";
import { StatusPill as PunchStatusPill } from "../punch/PunchPage";
import { submittalsOnMe, useSubmittalList } from "../submittals/submittalsApi";
import type { SubmittalRow } from "../submittals/submittalsApi";
import { ViewPill } from "../submittals/submittalsUi";
import "./Home.css";
import { Sk, SkRows, SkeletonPage } from "../../shared/m/Skeleton";

// What the person does next on an RFI that waits on them.
function rfiAction(r: RfiRow): "finish" | "review" | "pass" | "respond" {
  if (r.status === "draft") return "finish";
  if (r.ballInCourtRole === "manager") return r.status === "answered" ? "review" : "pass";
  return "respond";
}

// What the person does next on a punch item that waits on them.
function punchAction(p: PunchRow): "verify" | "start" | "fix" {
  if (p.ballInCourtRole === "verifier" || p.status === "readyForReview") return "verify";
  return p.status === "open" ? "start" : "fix";
}

// What the person does next on a submittal that waits on them.
function submittalAction(s: SubmittalRow): "finish" | "upload" | "resubmit" | "checkForward" | "decide" {
  if (s.status === "draft") return "finish";
  if (s.status === "inGcReview") return "checkForward";
  if (s.status === "inDesignReview") return "decide";
  return Number(s.revision) > 0 ? "resubmit" : "upload";
}

type MineRow = { key: string; kind: "rfi" | "submittal" | "punch"; number: string; title: string; status: ReactNode; due?: string; over: boolean; done: boolean; action: string; link: string };

const DAY = 86_400_000;
const daysBetween = (a: number, b: number) => Math.round((b - a) / DAY);
const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 }).format(n);

export function HomePage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const me = useCurrentUser();
  const { project, myRole, isAdmin, seesCost, ws, query, myUserId } = useProjects();
  const rfiList = useRfiList(myRole ? project?.ItemId : undefined);
  const seesPunch = Boolean(myRole) && myRole !== "design-reviewer";
  const punchList = usePunchList(seesPunch ? project?.ItemId : undefined);
  // Every project role sees submittals (a subcontractor only their company's).
  const subList = useSubmittalList(myRole ? project?.ItemId : undefined);
  const [showAllMine, setShowAllMine] = useState(false);

  if (query.isLoading) return <SkeletonPage kind="home" label={t("shell.loading")} />;
  if (!project) {
    return (
      <Panel>
        <Empty icon={<HardHat size={28} />} title={t("prj.noneTitle")}>{isAdmin ? t("prj.noneCreate") : t("prj.noneAsk")}</Empty>
        <div style={{ textAlign: "center" }}><Button variant="secondary" onClick={() => onNavigate("/projects")}>{t("nav.projects")}</Button></div>
      </Panel>
    );
  }

  const later = (phase: number) => fmt(t("shell.phaseTitle"), { phase });
  const isOwner = myRole === "owner-viewer";
  const isSub = myRole === "field-user";
  const cost = seesCost && !isSub;
  const roleLabel = isProjectRole(myRole) ? t(ROLE_LABEL[myRole].label) : isAdmin ? t("role.coadmin") : "";
  const firstName = (me.data?.data as { firstName?: string } | undefined)?.firstName ?? "";
  const team = (ws?.team ?? []).filter((r) => r.projectId === project.ItemId && r.status === "active");
  const stage = stageOf(project);
  const hue = hueOf(project);

  const now = Date.now();
  const start = project.startDate ? Date.parse(project.startDate) : NaN;
  const end = project.endDate ? Date.parse(project.endDate) : NaN;
  const totalDays = Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, daysBetween(start, end)) : 0;
  const schedule = !totalDays
    ? "—"
    : now < start
      ? fmt(t("home.startsIn"), { days: daysBetween(now, start), total: totalDays })
      : fmt(daysBetween(now, end) >= 0 ? t("home.dayOf") : t("home.pastEnd"), { day: Math.min(daysBetween(start, now), totalDays), total: totalDays, left: Math.abs(daysBetween(now, end)) });
  const elapsed = timeElapsed(project);
  const greeting = new Date().getHours() < 12 ? t("home.morning") : t("home.hello");

  const canCreateRfi = ["project-manager", "superintendent", "document-controller", "field-user"].includes(myRole ?? "");
  const canCreatePunch = myRole === "project-manager" || myRole === "superintendent";

  // RFIs: what waits on me, and the project's numbers (only the RFIs my role may see).
  const today = todayIso();
  const rfis = rfiList.data?.rfis ?? [];
  const rfisLoading = rfiList.isLoading && Boolean(myRole);
  const punch = punchList.data?.items ?? [];
  const punchLoading = punchList.isLoading && seesPunch;
  const subs = subList.data?.submittals ?? [];
  const subsLoading = subList.isLoading && Boolean(myRole);
  const mine: MineRow[] = [
    ...rfisOnMe(rfis, myUserId, today).map((r): MineRow => ({
      key: r.ItemId, kind: "rfi", number: r.number || t("rfi.status.draft"), title: r.subject, status: <StatusPill status={r.status} t={t} />,
      due: r.dueDate, over: r.status === "open" && Boolean(r.dueDate) && String(r.dueDate) < today, done: r.status !== "open" && r.status !== "draft",
      action: t(`home.action.${rfiAction(r)}`), link: `/rfis/${r.ItemId}`
    })),
    ...submittalsOnMe(subs, myUserId).map((x): MineRow => ({
      key: x.ItemId, kind: "submittal", number: `${x.number} rev ${Number(x.revision ?? 0)}`, title: x.title, status: <ViewPill s={x} t={t} />,
      due: x.dueDate, over: x.overdue, done: false, action: t(`home.action.${submittalAction(x)}`), link: `/submittals/${x.ItemId}`
    })),
    ...punchOnMe(punch, myUserId).map((p): MineRow => ({
      key: p.ItemId, kind: "punch", number: p.number, title: p.location ? `${p.title} · ${p.location}` : p.title, status: <PunchStatusPill status={p.status} t={t} />,
      due: p.dueDate, over: p.overdue, done: false, action: t(`home.action.${punchAction(p)}`), link: `/punch/${p.ItemId}`
    }))
  ].sort((a, b) => Number(b.over) - Number(a.over) || String(a.due || "9999").localeCompare(String(b.due || "9999")));
  const shownMine = showAllMine ? mine : mine.slice(0, 8);
  const overdueMine = mine.filter((r) => r.over).length;
  const openPunch = punch.filter((p) => p.status === "open" || p.status === "inProgress" || p.status === "readyForReview");
  const readyPunch = openPunch.filter((p) => p.status === "readyForReview").length;
  const overduePunch = openPunch.filter((p) => p.overdue).length;
  const mineLoading = rfisLoading || punchLoading || subsLoading;
  // Submittals in review or not yet submitted (drafts and decided ones aside), and the overdue ones.
  const openSubs = subs.filter((x) => x.status === "awaitingSubmission" || x.status === "inGcReview" || x.status === "inDesignReview");
  const overdueSubs = openSubs.filter((x) => x.overdue).length;
  const openRfis = rfis.filter((r) => r.status === "open" || r.status === "answered");
  const answeredRfis = rfis.filter((r) => r.status === "answered").length;
  const overdueRfis = openRfis.filter((r) => r.status === "open" && r.dueDate && r.dueDate < today);
  const rfiValue = (n: number) => (rfisLoading ? <Sk w={40} h={24} /> : rfiList.isError ? "—" : n);

  return (
    <div className="m-home">
      <div className="m-home-hero" style={{ background: `linear-gradient(120deg, hsl(${hue} 65% 38%), hsl(${(hue + 35) % 360} 55% 24%))` }}>
        <div className="m-home-hero-main">
          <div className="m-row m-row-wrap" style={{ gap: 6 }}>
            <span className="m-home-chip">{project.number}</span>
            <span className="m-home-chip">{t(`prj.stage.${stage}`)}</span>
            {project.projectType ? <span className="m-home-chip">{project.projectType}</span> : null}
            {isOwner ? <span className="m-home-chip"><Lock size={11} /> {t("home.readOnly")}</span> : null}
          </div>
          <h1>{project.name}</h1>
          <p className="m-row m-row-wrap">
            <MapPin size={14} /> {[project.address?.street, project.address?.city].filter(Boolean).join(", ")}
            {project.clientName ? ` · ${fmt(t("home.client"), { client: project.clientName })}` : ""}
          </p>
          <p className="m-home-hero-greet">
            {[`${greeting}${firstName ? `, ${firstName}` : ""}`, roleLabel, fmtDate(new Date().toISOString())].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="m-home-hero-side">
          <div className="m-home-hero-stat"><span>{t("home.schedule")}</span><strong>{fmtShortDate(project.startDate)} → {fmtShortDate(project.endDate)}</strong><small>{schedule}</small></div>
          <div className="m-home-hero-stat" title={t("prj.progressTitle")}><span>{t("prj.col.progress")}</span><strong>{elapsed} %</strong><div className="m-home-hero-bar"><i style={{ width: `${elapsed}%` }} /></div></div>
          {cost && project.contractValue !== undefined && project.contractValue !== null ? (
            <div className="m-home-hero-stat"><span>{t("prj.contract")}</span><strong>{money(project.contractValue)}</strong><small>EUR · {project.timezone ?? "Europe/Berlin"}</small></div>
          ) : null}
        </div>
      </div>

      {isOwner ? <Note>{t("home.ownerNote")}</Note> : null}
      {isSub ? <Note>{t("home.subNote")}</Note> : null}

      {!isOwner ? (
        <div className="m-home-quick">
          {canCreateRfi ? <Button icon={<Plus size={15} />} onClick={() => onNavigate("/rfis")}>{t("home.newRfi")}</Button> : null}
          {canCreatePunch ? <Button variant="secondary" icon={<ClipboardCheck size={15} />} onClick={() => onNavigate("/punch?new=1")}>{t("home.newPunch")}</Button> : null}
          {myRole && myRole !== "design-reviewer" ? <Button variant="secondary" icon={<CalendarDays size={15} />} disabled title={later(3)}>{t("home.todaysLog")}</Button> : null}
          <Button variant="secondary" icon={<Camera size={15} />} disabled title={later(2)}>{t("nav.photos")}</Button>
          <Button variant="ghost" icon={<Users size={15} />} onClick={() => onNavigate("/directory")}>{fmt(t("home.team"), { count: team.length })}</Button>
        </div>
      ) : null}

      {!mineLoading && !rfiList.isError && rfis.length === 0 && punch.length === 0 && subs.length === 0 ? (
        <Panel>
          <Empty icon={<HardHat size={28} />} title={t("home.emptyTitle")}>{t("home.emptyText")}</Empty>
        </Panel>
      ) : null}

      <div className="m-grid m-grid-main">
        <div>
          <Panel
            className="m-panel-flush"
            title={<>{t("home.myItems")} <Badge tone={mine.length ? "blue" : "green"}>{mineLoading ? "…" : mine.length}</Badge></>}
            actions={<span className="m-muted m-small m-hide-mobile">{t("home.myItemsHint")}</span>}
          >
            {mineLoading ? (
              <SkRows rows={3} label={t("shell.loading")} />
            ) : rfiList.isError && !mine.length ? (
              <div className="m-empty m-small">{t("home.myItemsError")}</div>
            ) : mine.length === 0 ? (
              <Empty icon={<CheckCircle2 size={26} />} title={t("home.nothingTitle")}>{t("home.nothingText")}</Empty>
            ) : (
              <div className="m-home-mine">
                {shownMine.map((r) => (
                  <button key={`${r.kind}-${r.key}`} className={cx("m-home-mine-row", r.over && "m-home-mine-over")} onClick={() => onNavigate(r.link)}>
                    <span className="m-home-mine-icon">{r.kind === "punch" ? <ClipboardCheck size={16} /> : r.kind === "submittal" ? <FileStack size={16} /> : <FileQuestion size={16} />}</span>
                    <span className="m-home-mine-text">
                      <span className="m-row" style={{ gap: 6 }}><b className="m-mono">{r.number}</b><span className="m-muted m-small">{r.kind === "punch" ? t("home.kindPunch") : r.kind === "submittal" ? t("home.kindSubmittal") : "RFI"}</span></span>
                      <span className="m-home-mine-title">{r.title}</span>
                      <span className="m-small m-muted">{r.action}</span>
                    </span>
                    <span className="m-home-mine-meta">
                      {r.status}
                      <DueLabel due={r.due} done={r.done} today={today} t={t} />
                    </span>
                  </button>
                ))}
                {mine.length > 8 ? (
                  <button className="m-home-mine-more m-link m-small" onClick={() => setShowAllMine(!showAllMine)}>
                    {showAllMine ? t("home.showFewer") : fmt(t("home.showAll"), { count: mine.length, overdue: overdueMine })}
                  </button>
                ) : null}
              </div>
            )}
          </Panel>

          <div className="m-kpis">
            <Kpi label={t("home.kpi.openRfis")} value={rfiValue(openRfis.length)} hint={fmt(t("home.kpi.openRfisHint"), { count: answeredRfis })} tone="blue" onClick={() => onNavigate("/rfis")} />
            <Kpi
              label={t("home.kpi.overdueRfis")}
              value={rfiValue(overdueRfis.length)}
              hint={openRfis.length ? fmt(t("home.kpi.overdueRfisHint"), { pct: Math.round((overdueRfis.length / openRfis.length) * 100), days: overdueRfis.length ? Math.max(...overdueRfis.map((r) => workingDaysBetween(String(r.dueDate), today))) : 0 }) : t("home.kpi.noneOpen")}
              tone={overdueRfis.length ? "red" : "green"}
              onClick={() => onNavigate("/rfis")}
            />
            <Kpi
              label={t("home.kpi.overdueSubmittals")}
              value={subsLoading ? <Sk w={40} h={24} /> : subList.isError ? "—" : overdueSubs}
              hint={fmt(t("home.kpi.overdueSubmittalsHint"), { count: openSubs.length })}
              tone={overdueSubs ? "red" : "green"}
              onClick={() => onNavigate("/submittals")}
            />
            {seesPunch ? (
              <Kpi
                label={isSub ? t("home.kpi.myPunch") : t("home.kpi.openPunch")}
                value={punchLoading ? <Sk w={40} h={24} /> : punchList.isError ? "—" : openPunch.length}
                hint={fmt(t("home.kpi.openPunchHint"), { ready: readyPunch, overdue: overduePunch })}
                tone={overduePunch ? "red" : readyPunch ? "amber" : undefined}
                onClick={() => onNavigate("/punch")}
              />
            ) : null}
            {myRole !== "design-reviewer" ? <Kpi label={t("home.kpi.todaysLog")} value="—" hint={later(3)} /> : null}
            {cost ? <Kpi label={t("home.kpi.budget")} value="—" hint={later(4)} /> : null}
            {cost ? <Kpi label={t("home.kpi.pendingCos")} value="—" hint={later(4)} /> : null}
          </div>
        </div>

        <div>
          <Panel title={t("home.todayOnSite")}>
            <Empty title={t("home.noLog")}>{stage === "preconstruction" ? t("home.noLogPrecon") : later(3)}</Empty>
          </Panel>
          <Panel title={t("home.activity")}>
            <Empty title={t("home.noActivity")}>{t("home.activityLater")}</Empty>
          </Panel>
        </div>
      </div>
    </div>
  );
}
