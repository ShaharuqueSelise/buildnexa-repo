// Project home (PRJ-02), built from the demo app's HomePage (mock/src/mock/pages/HomePage.tsx):
// the project header, quick actions, "My items" first, then the project's health.
// Real now: the header (project, dates, time elapsed, contract value for cost roles) and the
// role notes. RFIs, submittals, punch, daily logs and activity fill in as each module is built;
// until then their panels say which phase brings them.
import { CalendarDays, Camera, CheckCircle2, ClipboardCheck, HardHat, Lock, MapPin, Plus, Users } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ROLE_LABEL, isProjectRole } from "../../lib/roles";
import { Badge, Button, Empty, Kpi, Note, Panel, fmt } from "../../shared/m/ui";
import { useCurrentUser } from "../profile/useCurrentUser";
import { hueOf, stageOf, timeElapsed, useProjects } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import "./Home.css";

const DAY = 86_400_000;
const daysBetween = (a: number, b: number) => Math.round((b - a) / DAY);
const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 }).format(n);

export function HomePage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const me = useCurrentUser();
  const { project, myRole, isAdmin, seesCost, ws, query } = useProjects();

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
          {canCreateRfi ? <Button icon={<Plus size={15} />} disabled title={later(2)}>{t("home.newRfi")}</Button> : null}
          {canCreatePunch ? <Button variant="secondary" icon={<ClipboardCheck size={15} />} disabled title={later(3)}>{t("home.newPunch")}</Button> : null}
          {myRole && myRole !== "design-reviewer" ? <Button variant="secondary" icon={<CalendarDays size={15} />} disabled title={later(3)}>{t("home.todaysLog")}</Button> : null}
          <Button variant="secondary" icon={<Camera size={15} />} disabled title={later(2)}>{t("nav.photos")}</Button>
          <Button variant="ghost" icon={<Users size={15} />} onClick={() => onNavigate("/directory")}>{fmt(t("home.team"), { count: team.length })}</Button>
        </div>
      ) : null}

      <Panel>
        <Empty icon={<HardHat size={28} />} title={t("home.emptyTitle")}>{t("home.emptyText")}</Empty>
      </Panel>

      <div className="m-grid m-grid-main">
        <div>
          <Panel className="m-panel-flush" title={<>{t("home.myItems")} <Badge tone="green">0</Badge></>} actions={<span className="m-muted m-small m-hide-mobile">{t("home.myItemsHint")}</span>}>
            <Empty icon={<CheckCircle2 size={26} />} title={t("home.nothingTitle")}>{t("home.nothingText")}</Empty>
          </Panel>

          <div className="m-kpis">
            <Kpi label={t("home.kpi.openRfis")} value="—" hint={later(2)} />
            <Kpi label={t("home.kpi.overdueRfis")} value="—" hint={later(2)} />
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
            <Empty title={t("home.noActivity")}>{later(2)}</Empty>
          </Panel>
        </div>
      </div>
    </div>
  );
}
