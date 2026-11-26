// All projects (PRJ-04 switcher, PRJ-01 create), built from the demo app's All projects page
// (mock/src/mock/pages/PortfolioPage.tsx): same cards, table, filters and wizard, with real
// projects. Not real yet: the portfolio dashboard, templates and archive (release 2), and the
// RFI / punch numbers (those modules come in later phases). "Progress" is the share of the planned
// time already gone until daily logs report real progress.
import { useState } from "react";
import { Archive, ArrowRight, Building2, CheckCircle2, Copy, FolderTree, LayoutGrid, List, Loader2, Lock, MapPin, Plus, Trash2, UserPlus } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { PROJECT_ROLES, ROLE_LABEL, rolesFor } from "../../lib/roles";
import { FunctionRefused } from "../../lib/blocks/functions";
import {
  Badge, Button, Dialog, Empty, Field, Kpi, Note, PageTitle, Panel, ProgressBar, ReleaseTag, SearchInput, Segmented, Select,
  Toasts, cx, fmt, useToasts
} from "../../shared/m/ui";
import type { Tone } from "../../shared/m/ui";
import { hueOf, personName, setCurrentProject, stageOf, timeElapsed, useCreateProject, useProjects } from "./projectsApi";
import type { NewProject, OrgMemberRow, ProjectRow, Stage } from "./projectsApi";
import "./Portfolio.css";
import { SkeletonPage } from "../../shared/m/Skeleton";

type Nav = { onNavigate: (path: string) => void };

const STAGE_TONE: Record<Stage, Tone> = { preconstruction: "purple", construction: "blue", closeout: "amber", archived: "gray" };
const STAGES: Stage[] = ["preconstruction", "construction", "closeout", "archived"];
const STAGE_LABEL: Record<Stage, TranslationKey> = {
  preconstruction: "prj.stage.preconstruction",
  construction: "prj.stage.construction",
  closeout: "prj.stage.closeout",
  archived: "prj.stage.archived"
};

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const fmtShortDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
const money = (v: number, compact = false) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: compact ? 1 : 0, notation: compact ? "compact" : "standard" }).format(v);
export const cover = (p: Pick<ProjectRow, "ItemId" | "number">) => {
  const hue = hueOf(p);
  return `linear-gradient(135deg, hsl(${hue} 65% 50%), hsl(${(hue + 35) % 360} 55% 28%))`;
};

export function ProjectsPage({ onNavigate }: Nav) {
  const { t } = useT();
  const { query, ws, projects, project, canCreate, seesCost } = useProjects();
  const { items: toasts, toast } = useToasts();
  const [view, setView] = useState<"cards" | "table">("cards");
  const [stage, setStage] = useState<"all" | Stage>("all");
  const [q, setQ] = useState("");
  const [opened, setOpened] = useState(false);
  // The wizard is also open while the address says ?new=1 (the switcher's "New project…").
  const askedNew = new URLSearchParams(window.location.search).get("new") === "1";
  const wizard = opened || (askedNew && canCreate);
  const setWizard = (open: boolean) => {
    setOpened(open);
    if (!open && askedNew) onNavigate("/projects");
  };

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <SkeletonPage kind="cards" label={t("common.loading")} />;
  }

  const rows = projects.map((p) => ({ p, stage: stageOf(p), progress: timeElapsed(p), members: ws.team.filter((r) => r.projectId === p.ItemId && r.status === "active").length }));
  const filtered = rows.filter((r) =>
    (stage === "all" || r.stage === stage) &&
    (!q || `${r.p.name} ${r.p.number} ${r.p.clientName ?? ""} ${r.p.address?.city ?? ""} ${r.p.projectType ?? ""}`.toLowerCase().includes(q.toLowerCase()))
  );
  const live = rows.filter((r) => r.stage !== "archived");
  const value = live.reduce((s, r) => s + (r.p.contractValue ?? 0), 0);
  const avg = live.length ? Math.round(live.reduce((s, r) => s + r.progress, 0) / live.length) : 0;

  const open = (p: ProjectRow) => { setCurrentProject(p.ItemId); onNavigate("/directory"); };
  const stageLabel = (s: Stage) => t(STAGE_LABEL[s]);
  const notYet = t("prj.notYet");

  return (
    <div className="m-portfolio">
      <PageTitle
        title={t("prj.title")}
        subtitle={t("prj.subtitle")}
        actions={
          <>
            <Segmented options={[{ key: "cards", label: <span className="m-row"><LayoutGrid size={14} /> {t("prj.cards")}</span> }, { key: "table", label: <span className="m-row"><List size={14} /> {t("prj.table")}</span> }]} value={view} onChange={setView} />
            <Button icon={<Plus size={15} />} onClick={() => setWizard(true)} disabled={!canCreate} title={canCreate ? undefined : t("prj.cantCreate")}>{t("prj.new")}</Button>
          </>
        }
      />

      <Panel title={t("prj.dashboard")} release="R2">
        <div className="m-kpis" style={{ marginBottom: 12 }}>
          <Kpi label={t("prj.kpi.active")} value={live.length} hint={fmt(t("prj.kpi.archived"), { count: rows.length - live.length })} />
          {seesCost ? <Kpi label={t("prj.kpi.value")} value={money(value, true)} hint={t("prj.kpi.valueHint")} /> : null}
          <Kpi label={t("prj.kpi.progress")} value={`${avg} %`} hint={t("prj.kpi.progressHint")} />
        </div>
        <Note>{t("prj.dashboardLater")}</Note>
      </Panel>

      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("prj.search")} />
        <Segmented
          options={[{ key: "all" as const, label: `${t("prj.all")} (${rows.length})` }, ...STAGES.map((s) => ({ key: s, label: `${stageLabel(s)} (${rows.filter((r) => r.stage === s).length})` }))]}
          value={stage}
          onChange={setStage}
        />
      </div>

      {rows.length === 0 ? (
        <Panel><Empty icon={<Building2 size={26} />} title={t("prj.noneTitle")}>{canCreate ? t("prj.noneCreate") : t("prj.noneAsk")}</Empty></Panel>
      ) : filtered.length === 0 ? (
        <Panel><Empty title={t("prj.noMatch")}>{t("prj.noMatchText")}</Empty></Panel>
      ) : null}

      {view === "cards" ? (
        <div className="m-cards">
          {filtered.map(({ p, stage: st, progress, members }) => {
            const current = p.ItemId === project?.ItemId;
            return (
              <div key={p.ItemId} className={cx("m-card m-portfolio-card", current && "m-portfolio-active")}>
                <button className="m-portfolio-cover" style={{ background: cover(p) }} onClick={() => open(p)}>
                  <span className="m-portfolio-num">{p.number}</span>
                  <Badge tone={STAGE_TONE[st]}>{st === "archived" ? <><Lock size={10} /> {stageLabel(st)}</> : stageLabel(st)}</Badge>
                  {current ? <span className="m-portfolio-current">{t("prj.current")}</span> : null}
                </button>
                <div className="m-card-body">
                  <button className="m-portfolio-name" onClick={() => open(p)}>{p.name}</button>
                  <span className="m-muted m-small m-row"><MapPin size={12} /> {[p.address?.street, p.address?.city].filter(Boolean).join(", ") || "—"}</span>
                  <span className="m-small">{[p.clientName, p.projectType].filter(Boolean).join(" · ") || "—"}</span>
                  <div className="m-row" style={{ justifyContent: "space-between" }}>
                    <span className="m-small m-muted">{fmtShortDate(p.startDate)} → {fmtDate(p.endDate)}</span>
                    <b className="m-small" title={t("prj.progressTitle")}>{progress} %</b>
                  </div>
                  <ProgressBar value={progress} tone={st === "closeout" ? "amber" : st === "archived" ? "gray" : "blue"} />
                  <div className="m-portfolio-stats">
                    <span title={t("prj.members")}><UserPlus size={13} /> {members}</span>
                    {seesCost && p.contractValue ? <span title={t("prj.contract")}>{money(p.contractValue, true)}</span> : null}
                  </div>
                  <div className="m-row" style={{ justifyContent: "space-between", marginTop: 4 }}>
                    <Button small variant={current ? "secondary" : "primary"} onClick={() => open(p)} icon={<ArrowRight size={13} />}>{current ? t("prj.openTeam") : t("prj.switch")}</Button>
                    <Button small variant="ghost" icon={<Archive size={13} />} disabled title={t("prj.archiveLater")}>{t("prj.archive")} <ReleaseTag release="R2" /></Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : filtered.length ? (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th>{t("prj.col.number")}</th><th>{t("prj.col.project")}</th><th className="m-hide-mobile">{t("prj.col.client")}</th><th>{t("prj.col.stage")}</th><th>{t("prj.col.progress")}</th>
                <th className="m-hide-mobile">{t("prj.col.dates")}</th><th className="m-num">{t("prj.col.openRfis")}</th><th className="m-num">{t("prj.col.overdue")}</th><th className="m-num">{t("prj.col.punch")}</th>
                {seesCost ? <th className="m-num">{t("prj.col.contract")}</th> : null}<th />
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ p, stage: st, progress }) => (
                <tr key={p.ItemId} className={cx("m-clickable", p.ItemId === project?.ItemId && "m-selected")} onClick={() => open(p)}>
                  <td className="m-mono">{p.number}</td>
                  <td><span className="m-row"><span className="m-portfolio-swatch" style={{ background: `hsl(${hueOf(p)} 60% 45%)` }} /><b>{p.name}</b></span></td>
                  <td className="m-hide-mobile">{p.clientName ?? "—"}</td>
                  <td><Badge tone={STAGE_TONE[st]}>{stageLabel(st)}</Badge></td>
                  <td style={{ minWidth: 110 }} title={t("prj.progressTitle")}><div className="m-row"><ProgressBar value={progress} /><span className="m-small">{progress}%</span></div></td>
                  <td className="m-hide-mobile m-small">{fmtShortDate(p.startDate)} – {fmtShortDate(p.endDate)}</td>
                  <td className="m-num m-muted" title={notYet}>—</td>
                  <td className="m-num m-muted" title={notYet}>—</td>
                  <td className="m-num m-muted" title={notYet}>—</td>
                  {seesCost ? <td className="m-num">{p.contractValue ? money(p.contractValue, true) : "—"}</td> : null}
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button small variant="ghost" icon={<Archive size={13} />} disabled title={t("prj.archiveLater")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {wizard ? (
        <CreateProjectWizard
          projects={ws.projects}
          people={ws.people}
          onClose={() => setWizard(false)}
          onOpen={(id) => { setCurrentProject(id); setWizard(false); onNavigate("/directory"); }}
          toast={toast}
        />
      ) : null}
      <Toasts items={toasts} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-project wizard (PRJ-01; templates are release 2)

type Invite = { email: string; role: string };
const STEPS: TranslationKey[] = ["prj.step.basics", "prj.step.template", "prj.step.team", "prj.step.review"];
const TYPES = ["Healthcare", "Commercial office", "Residential", "Education", "Industrial", "Hospitality", "Infrastructure", "Retail"];
const TIMEZONES = ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "Europe/London", "Europe/Amsterdam"];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (days: number) => isoDay(new Date(Date.now() + days * 86_400_000));

function CreateProjectWizard({ projects, people, onClose, onOpen, toast }: {
  projects: ProjectRow[];
  people: OrgMemberRow[];
  onClose: () => void;
  onOpen: (projectId: string) => void;
  toast: (text: string, tone?: "good" | "warn") => void;
}) {
  const { t } = useT();
  const { myUserId } = useProjects();
  const create = useCreateProject();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<{ projectId: string; added: number } | null>(null);
  const nextNumber = `PRJ-${String(projects.length + 1).padStart(3, "0")}`;
  const [f, setF] = useState({
    number: projects.some((p) => p.number === nextNumber) ? "" : nextNumber,
    name: "",
    client: "",
    address: "",
    city: "Berlin",
    start: addDays(30),
    end: addDays(30 + 540),
    timezone: "Europe/Berlin",
    type: "Commercial office",
    contractValue: "",
    stage: "preconstruction" as "preconstruction" | "construction"
  });
  const [invites, setInvites] = useState<Invite[]>([{ email: "", role: "superintendent" }]);
  const set = (k: keyof typeof f, v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const me = people.find((m) => m.userId === myUserId);
  const candidates = people.filter((m) => m.userId !== myUserId && m.status !== "removed" && m.status !== "deactivated");
  const roleLabel = (r: string) => (r in ROLE_LABEL ? t(ROLE_LABEL[r as keyof typeof ROLE_LABEL].label) : r);

  const basicsErrors = [
    !f.number.trim() && t("prj.err.number"),
    projects.some((p) => p.number.toLowerCase() === f.number.trim().toLowerCase()) && t("prj.err.numberTaken"),
    !f.name.trim() && t("prj.err.name"),
    !f.address.trim() && t("prj.err.address"),
    f.end <= f.start && t("prj.err.dates")
  ].filter(Boolean) as string[];
  const filled = invites.filter((i) => i.email.trim());
  const resolved = filled.map((i) => ({ ...i, member: candidates.find((m) => m.email.toLowerCase() === i.email.trim().toLowerCase()) }));
  const badInvites = resolved.filter((i) => !EMAIL.test(i.email.trim()));
  const unknown = resolved.filter((i) => EMAIL.test(i.email.trim()) && !i.member);
  const team = resolved.filter((i) => i.member).map((i) => ({ orgMemberId: i.member!.ItemId, role: i.role, name: personName(i.member!) }));

  const next = () => {
    if (step === 0 && basicsErrors.length) { toast(basicsErrors[0] ?? t("prj.err.check"), "warn"); return; }
    if (step === 2 && (badInvites.length || unknown.length)) { toast(fmt(t("prj.err.invite"), { email: (badInvites[0] ?? unknown[0])!.email }), "warn"); return; }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  async function finish() {
    const input: NewProject = {
      number: f.number.trim(),
      name: f.name.trim(),
      clientName: f.client.trim() || undefined,
      projectType: f.type,
      street: f.address.trim(),
      city: f.city.trim(),
      startDate: f.start,
      endDate: f.end,
      timezone: f.timezone,
      stage: f.stage,
      contractValue: f.contractValue ? Number(f.contractValue) : undefined,
      team: team.map(({ orgMemberId, role }) => ({ orgMemberId, role }))
    };
    try {
      const result = await create.mutateAsync(input);
      setDone({ projectId: result.projectId, added: result.added });
      toast(t("prj.created"));
    } catch (error) {
      if (!(error instanceof FunctionRefused)) console.error("create project failed", error);
      toast(error instanceof FunctionRefused ? error.message : t("common.error"), "warn");
    }
  }

  if (done) {
    const steps = [t("prj.done.created"), t("prj.done.pm"), fmt(t("prj.done.team"), { count: done.added })];
    return (
      <Dialog title={t("prj.done.title")} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>{t("prj.done.stay")}</Button><Button icon={<ArrowRight size={14} />} onClick={() => onOpen(done.projectId)}>{t("prj.openTeam")}</Button></>}>
        <div className="m-stack-v">
          <Note tone="good">{fmt(t("prj.done.live"), { name: f.name, number: f.number })}</Note>
          <ul className="m-portfolio-provision">
            {steps.map((s) => <li key={s} className="m-portfolio-done"><CheckCircle2 size={16} /> {s}</li>)}
          </ul>
          <Note>{t("prj.done.later")}</Note>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t("prj.new")}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="m-muted m-small" style={{ marginRight: "auto" }}>{fmt(t("prj.stepOf"), { step: step + 1, total: STEPS.length })}</span>
          {step > 0 ? <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={create.isPending}>{t("prj.back")}</Button> : <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>}
          {step < STEPS.length - 1
            ? <Button onClick={next}>{t("prj.next")}</Button>
            : <Button variant="success" icon={create.isPending ? <Loader2 className="spin" size={14} /> : <Building2 size={14} />} disabled={create.isPending} onClick={() => void finish()}>{create.isPending ? t("prj.creating") : t("prj.create")}</Button>}
        </>
      }
    >
      <ol className="m-portfolio-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={cx(i === step && "m-portfolio-step-on", i < step && "m-portfolio-step-done")}>
            <span>{i < step ? <CheckCircle2 size={14} /> : i + 1}</span>{t(s)}{s === "prj.step.template" ? <ReleaseTag release="R2" /> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="m-form">
          <Field label={t("prj.f.number")} hint={t("prj.f.numberHint")}><input className="m-input" value={f.number} onChange={(e) => set("number", e.target.value)} /></Field>
          <Field label={t("prj.f.name")}><input className="m-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={t("prj.f.namePlaceholder")} autoFocus /></Field>
          <Field label={t("prj.f.client")}><input className="m-input" value={f.client} onChange={(e) => set("client", e.target.value)} placeholder={t("prj.f.clientPlaceholder")} /></Field>
          <Field label={t("prj.f.type")}><Select value={f.type} onChange={(v) => set("type", v)} options={TYPES} /></Field>
          <Field label={t("prj.f.address")}><input className="m-input" value={f.address} onChange={(e) => set("address", e.target.value)} placeholder={t("prj.f.addressPlaceholder")} /></Field>
          <Field label={t("prj.f.city")} hint={t("prj.f.cityHint")}><input className="m-input" value={f.city} onChange={(e) => set("city", e.target.value)} /></Field>
          <Field label={t("prj.f.start")}><input className="m-input" type="date" value={f.start} onChange={(e) => set("start", e.target.value)} /></Field>
          <Field label={t("prj.f.end")}><input className="m-input" type="date" value={f.end} onChange={(e) => set("end", e.target.value)} /></Field>
          <Field label={t("prj.f.currency")} hint={t("prj.f.currencyHint")}><Select value="EUR" onChange={() => undefined} options={["EUR"]} /></Field>
          <Field label={t("prj.f.timezone")}><Select value={f.timezone} onChange={(v) => set("timezone", v)} options={TIMEZONES} /></Field>
          <Field label={t("prj.f.stage")}><Select value={f.stage} onChange={(v) => set("stage", v)} options={[{ value: "preconstruction", label: t("prj.stage.preconstruction") }, { value: "construction", label: t("prj.stage.construction") }]} /></Field>
          <Field label={t("prj.f.value")}><input className="m-input" type="number" min={0} value={f.contractValue} onChange={(e) => set("contractValue", e.target.value)} /></Field>
          {basicsErrors.length && f.name ? <div className="m-field-wide"><Note tone="warn">{basicsErrors.join(" · ")}</Note></div> : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="m-stack-v">
          <div className="m-portfolio-tpl">
            <button className="m-portfolio-tpl-opt m-on">
              <FolderTree size={20} />
              <b>{t("prj.tpl.defaults")}</b>
              <span className="m-small m-muted">{t("prj.tpl.defaultsText")}</span>
            </button>
            <button className="m-portfolio-tpl-opt" disabled title={t("prj.tpl.copyLater")}>
              <Copy size={20} />
              <b>{t("prj.tpl.copy")} <ReleaseTag release="R2" /></b>
              <span className="m-small m-muted">{t("prj.tpl.copyText")}</span>
            </button>
          </div>
          <Note>{t("prj.tpl.note")}</Note>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="m-stack-v">
          <Note>{fmt(t("prj.team.note"), { name: me ? personName(me) : "" })}</Note>
          <datalist id="prj-people">
            {candidates.map((m) => <option key={m.ItemId} value={m.email}>{`${personName(m)} · ${m.companyName ?? ""}`}</option>)}
          </datalist>
          {invites.map((inv, i) => {
            const match = candidates.find((m) => m.email.toLowerCase() === inv.email.trim().toLowerCase());
            return (
              <div key={i} className="m-portfolio-invite">
                <input className="m-input" list="prj-people" placeholder={t("prj.team.placeholder")} value={inv.email} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} title={match ? `${personName(match)} · ${match.companyName ?? ""}` : undefined} />
                <Select value={inv.role} onChange={(v) => setInvites(invites.map((x, j) => (j === i ? { ...x, role: v } : x)))} options={(match ? rolesFor(match.companyRelation) : PROJECT_ROLES).map((r) => ({ value: r, label: roleLabel(r) }))} />
                <button className="m-icon-btn" aria-label={t("prj.team.remove")} onClick={() => setInvites(invites.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
              </div>
            );
          })}
          <div><Button small variant="secondary" icon={<UserPlus size={14} />} onClick={() => setInvites([...invites, { email: "", role: "field-user" }])}>{t("prj.team.add")}</Button></div>
          {badInvites.length ? <Note tone="warn">{fmt(t("prj.team.badEmail"), { emails: badInvites.map((b) => b.email).join(", ") })}</Note> : null}
          {unknown.length ? <Note tone="warn">{fmt(t("prj.team.unknown"), { emails: unknown.map((b) => b.email).join(", ") })}</Note> : null}
        </div>
      ) : null}

      {step === 3 ? (
        <div className="m-stack-v">
          <div className="m-portfolio-review" style={{ background: "linear-gradient(120deg, hsl(210 60% 45%), hsl(245 50% 30%))" }}>
            <span className="m-small">{f.number} · {f.type}</span>
            <strong>{f.name || t("prj.untitled")}</strong>
            <span className="m-small">{f.address}, {f.city}</span>
          </div>
          <dl className="m-kv">
            <div><dt>{t("prj.f.client")}</dt><dd>{f.client || "—"}</dd></div>
            <div><dt>{t("prj.col.dates")}</dt><dd>{fmtDate(f.start)} → {fmtDate(f.end)}</dd></div>
            <div><dt>{t("prj.r.currencyTz")}</dt><dd>EUR · {f.timezone}</dd></div>
            <div><dt>{t("prj.f.stage")}</dt><dd>{t(STAGE_LABEL[f.stage])}</dd></div>
            <div><dt>{t("prj.col.contract")}</dt><dd>{f.contractValue ? money(Number(f.contractValue)) : "—"}</dd></div>
            <div><dt>{t("prj.step.template")}</dt><dd>{t("prj.tpl.defaults")}</dd></div>
            <div><dt>{t("prj.r.team")}</dt><dd>{fmt(t("prj.r.people"), { count: team.length })}</dd></div>
            <div><dt>{t("role.pm")}</dt><dd>{me ? personName(me) : "—"}</dd></div>
          </dl>
          {team.length ? (
            <div className="m-row m-row-wrap">{team.map((v) => <Badge key={v.orgMemberId} tone="blue">{v.name} · {t(ROLE_LABEL[v.role as keyof typeof ROLE_LABEL].short)}</Badge>)}</div>
          ) : null}
          <Note>{t("prj.r.note")}</Note>
        </div>
      ) : null}
    </Dialog>
  );
}
