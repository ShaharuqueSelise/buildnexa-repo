// Project home (PRJ-02), built from the demo app's HomePage (mock/src/mock/pages/HomePage.tsx):
// the project header, quick actions, "My items" first, then the project's health.
// Real now: the header (project, dates, time elapsed, contract value for cost roles), the role
// notes, "My items" for RFIs (ball in court on me) and the RFI numbers. Submittals, punch, daily
// logs and activity fill in as each module is built; until then their panels say which phase
// brings them.
import { CalendarDays, Camera, CheckCircle2, ClipboardCheck, FileQuestion, HardHat, Lock, MapPin, Plus, Users } from "lucide-react";
import { useState } from "react";
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
import "./Home.css";

// What the person does next on an RFI that waits on them.
function rfiAction(r: RfiRow): "finish" | "review" | "pass" | "respond" {
  if (r.status === "draft") return "finish";
  if (r.ballInCourtRole === "manager") return r.status === "answered" ? "review" : "pass";
  return "respond";
}

const DAY = 86_400_000;
const daysBetween = (a: number, b: number) => Math.round((b - a) / DAY);
const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 }).format(n);

export function HomePage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const me = useCurrentUser();
  const { project, myRole, isAdmin, seesCost, ws, query, myUserId } = useProjects();
  const rfiList = useRfiList(myRole ? project?.ItemId : undefined);
  const [showAllMine, setShowAllMine] = useState(false);

  if (query.isLoading) return <div className="m-panel m-empty"><strong>{t("shell.loading")}</strong></div>;
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
  const mine = rfisOnMe(rfis, myUserId, today);
  const shownMine = showAllMine ? mine : mine.slice(0, 8);
  const overdueMine = mine.filter((r) => r.status === "open" && r.dueDate && r.dueDate < today).length;
  const openRfis = rfis.filter((r) => r.status === "open" || r.status === "answered");
  const answeredRfis = rfis.filter((r) => r.status === "answered").length;
  const overdueRfis = openRfis.filter((r) => r.status === "open" && r.dueDate && r.dueDate < today);
  const rfisLoading = rfiList.isLoading && Boolean(myRole);
  const rfiValue = (n: number) => (rfisLoading ? "…" : rfiList.isError ? "—" : n);

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

      {!rfisLoading && !rfiList.isError && rfis.length === 0 ? (
        <Panel>
          <Empty icon={<HardHat size={28} />} title={t("home.emptyTitle")}>{t("home.emptyText")}</Empty>
        </Panel>
      ) : null}

      <div className="m-grid m-grid-main">
        <div>
          <Panel
            className="m-panel-flush"
            title={<>{t("home.myItems")} <Badge tone={mine.length ? "blue" : "green"}>{rfisLoading ? "…" : mine.length}</Badge></>}
            actions={<span className="m-muted m-small m-hide-mobile">{t("home.myItemsHint")}</span>}
          >
            {rfisLoading ? (
              <div className="m-empty m-small">{t("shell.loading")}</div>
            ) : rfiList.isError ? (
              <div className="m-empty m-small">{t("home.myItemsError")}</div>
            ) : mine.length === 0 ? (
              <Empty icon={<CheckCircle2 size={26} />} title={t("home.nothingTitle")}>{t("home.nothingText")}</Empty>
            ) : (
              <div className="m-home-mine">
                {shownMine.map((r) => {
                  const over = r.status === "open" && Boolean(r.dueDate) && String(r.dueDate) < today;
                  return (
                    <button key={r.ItemId} className={cx("m-home-mine-row", over && "m-home-mine-over")} onClick={() => onNavigate(`/rfis/${r.ItemId}`)}>
                      <span className="m-home-mine-icon"><FileQuestion size={16} /></span>
                      <span className="m-home-mine-text">
                        <span className="m-row" style={{ gap: 6 }}><b className="m-mono">{r.number || t("rfi.status.draft")}</b><span className="m-muted m-small">RFI</span></span>
                        <span className="m-home-mine-title">{r.subject}</span>
                        <span className="m-small m-muted">{t(`home.action.${rfiAction(r)}`)}</span>
                      </span>
                      <span className="m-home-mine-meta">
                        <StatusPill status={r.status} t={t} />
                        <DueLabel due={r.dueDate} today={today} t={t} />
                      </span>
                    </button>
                  );
                })}
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
            <Kpi label={t("home.kpi.overdueSubmittals")} value="—" hint={later(4)} />
            {myRole !== "design-reviewer" ? <Kpi label={isSub ? t("home.kpi.myPunch") : t("home.kpi.openPunch")} value="—" hint={later(3)} /> : null}
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
