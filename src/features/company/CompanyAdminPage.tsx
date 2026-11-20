// Company admin (ADM-01), built from the demo app's Company admin page (mock/src/mock/pages/
// CompanyAdminPage.tsx): same layout, columns, buttons and dialogs, with real data from the
// company-people Function. Only the People tab is built so far; the other tabs say when they come.
import { useMemo, useState } from "react";
import { Building2, Download, Loader2, Mail, RotateCcw, UserMinus, UserPlus, Users } from "lucide-react";
import { useMyRoles } from "../profile/useCurrentUser";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { PROJECT_ROLES, ROLE_LABEL, isProjectRole } from "../../lib/roles";
import {
  Avatar, Badge, Button, CompanyChip, Dialog, Empty, Field, KeyValue, Kpi, Note, PageTitle, ReleaseTag, SearchInput, Select,
  StatusBadge, Tabs, Toasts, colorFor, downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import type { ToastTone } from "../../shared/m/ui";
import type { Release } from "../../shared/m/ui";
import {
  personStatus, useDeactivate, useInvitePerson, usePeople, useReactivate, useResendInvite, useSetDefaultRole
} from "./peopleApi";
import type { Company, Membership, Person, Project } from "./peopleApi";
import "./CompanyAdmin.css";

type TabKey = "people" | "roles" | "reference" | "branding" | "languages" | "security" | "billing" | "templates";


const shortDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";

const companyColor = (c?: Pick<Company, "name" | "brandColor">) => c?.brandColor || colorFor(c?.name ?? "?");
const projectColor = (p: Project) => colorFor(p.number || p.name);

export function CompanyAdminPage() {
  const { t } = useT();
  const roles = useMyRoles();
  const isAdmin = roles?.includes("company-admin") ?? false;
  const tenant = roles?.find((r) => r.startsWith("co-"));
  const [tab, setTab] = useState<TabKey>("people");
  const people = usePeople(isAdmin);
  const own = people.data?.companies.find((c) => c.relation === "self");

  if (!roles) {
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  if (!isAdmin) {
    return (
      <div>
        <PageTitle title={t("coadmin.title")} />
        <Note tone="warn">{t("coadmin.adminsOnly")}</Note>
      </div>
    );
  }

  const later = (phase: TranslationKey) => <Note>{fmt(t("coadmin.notBuilt"), { when: t(phase) })}</Note>;
  const tabLabel = (key: TranslationKey, release?: Release) => <>{t(key)}{release ? <> <ReleaseTag release={release} /></> : null}</>;

  return (
    <div>
      <PageTitle
        title={t("coadmin.title")}
        subtitle={<>{own?.name ?? "…"} · {t("coadmin.subtitle")}</>}
        actions={tenant ? <Badge tone="purple"><Building2 size={12} /> {fmt(t("coadmin.tenant"), { tenant })}</Badge> : undefined}
      />
      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "people", label: tabLabel("coadmin.tab.people") },
          { key: "roles", label: tabLabel("coadmin.tab.roles") },
          { key: "reference", label: tabLabel("coadmin.tab.reference") },
          { key: "branding", label: tabLabel("coadmin.tab.branding") },
          { key: "languages", label: tabLabel("coadmin.tab.languages") },
          { key: "security", label: tabLabel("coadmin.tab.security", "R2") },
          { key: "billing", label: tabLabel("coadmin.tab.billing", "R2") },
          { key: "templates", label: tabLabel("coadmin.tab.templates", "R2") }
        ]}
      />
      {tab === "people" ? <PeopleTab query={people} /> : null}
      {tab === "roles" || tab === "reference" || tab === "branding" || tab === "languages" ? later("coadmin.whenPhase5") : null}
      {tab === "security" || tab === "billing" || tab === "templates" ? later("coadmin.whenR2") : null}
    </div>
  );
}

// ---------- People ----------

function PeopleTab({ query }: { query: ReturnType<typeof usePeople> }) {
  const { t } = useT();
  const { items: toasts, toast } = useToasts();
  const [q, setQ] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [status, setStatus] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const setRole = useSetDefaultRole();
  const resend = useResendInvite();
  const deactivate = useDeactivate();
  const reactivate = useReactivate();

  const data = query.data;
  const people = data?.people ?? [];
  const companies = data?.companies ?? [];
  const projects = data?.projects ?? [];

  const companyById = useMemo(() => new Map(companies.map((c) => [c.ItemId, c])), [companies]);
  const membership = useMemo(() => {
    const map: Record<string, Membership[]> = {};
    for (const m of data?.memberships ?? []) (map[m.userId] ??= []).push(m);
    return map;
  }, [data?.memberships]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.ItemId, p])), [projects]);
  const companyOptions = useMemo(
    () => [...companies].sort((a, b) => (a.relation === "self" ? -1 : b.relation === "self" ? 1 : a.name.localeCompare(b.name))),
    [companies]
  );

  const roleLabel = (slug?: string) => (slug && (isProjectRole(slug) || slug === "company-admin") ? t(ROLE_LABEL[slug].label) : "—");
  // Seeded people have no default role yet: show the role they hold on their first project.
  const defaultRoleOf = (p: Person) => p.defaultRole ?? (membership[p.userId] ?? [])[0]?.role ?? "";

  const rows = people.filter((p) =>
    (!q || `${p.displayName} ${p.email} ${p.jobTitle ?? ""}`.toLowerCase().includes(q.toLowerCase())) &&
    (!companyFilter || p.companyId === companyFilter) &&
    (!status || personStatus(p) === status)
  );

  const counts = {
    active: people.filter((p) => personStatus(p) === "Active").length,
    invited: people.filter((p) => personStatus(p) === "Invited").length,
    deactivated: people.filter((p) => personStatus(p) === "Deactivated").length
  };

  async function run(p: Person, action: () => Promise<unknown>, ok: string, tone?: ToastTone) {
    setBusyId(p.ItemId);
    try {
      await action();
      toast(ok, tone);
    } catch (error) {
      toast((error as Error).message, "warn");
    } finally {
      setBusyId(null);
    }
  }

  const selected = people.find((p) => p.ItemId === selectedId) ?? null;
  const statusLabel = (s: string) => t(`coadmin.status.${s.toLowerCase()}` as TranslationKey);

  if (query.isLoading) {
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  if (query.error) {
    return <Note tone="danger">{(query.error as Error).message}</Note>;
  }

  return (
    <>
      <div className="m-kpis">
        <Kpi label={t("coadmin.kpi.people")} value={people.length} hint={t("coadmin.kpi.peopleHint")} onClick={() => setStatus("")} />
        <Kpi label={t("coadmin.status.active")} value={counts.active} tone="green" onClick={() => setStatus("Active")} />
        <Kpi label={t("coadmin.kpi.invited")} value={counts.invited} tone="amber" onClick={() => setStatus("Invited")} />
        <Kpi label={t("coadmin.status.deactivated")} value={counts.deactivated} tone="red" onClick={() => setStatus("Deactivated")} />
        <Kpi label={t("coadmin.kpi.companies")} value={new Set(people.map((p) => p.companyId)).size} />
      </div>
      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("coadmin.search")} />
        <Select value={companyFilter} onChange={setCompanyFilter} placeholder={t("coadmin.allCompanies")} options={companyOptions.map((c) => ({ value: c.ItemId, label: c.name }))} />
        <Select
          value={status}
          onChange={setStatus}
          placeholder={t("coadmin.anyStatus")}
          options={(["Active", "Invited", "Deactivated"] as const).map((s) => ({ value: s, label: statusLabel(s) }))}
        />
        <span className="m-coadmin-grow" />
        <Button variant="secondary" icon={<Download size={15} />} onClick={() => {
          downloadCsv("company-people.csv", rows.map((p) => ({
            name: p.displayName, email: p.email, company: p.companyName, title: p.jobTitle ?? "",
            defaultRole: defaultRoleOf(p), status: personStatus(p), projects: (membership[p.userId] ?? []).length,
            lastActive: p.lastLoggedInTime ?? ""
          })));
          toast(fmt(t("coadmin.exported"), { count: rows.length }));
        }}>{t("coadmin.exportCsv")}</Button>
        <Button icon={<UserPlus size={15} />} onClick={() => setInviteOpen(true)}>{t("coadmin.invite")}</Button>
      </div>

      {rows.length === 0 ? (
        <div className="m-table-wrap"><Empty icon={<Users size={26} />} title={t("coadmin.emptyTitle")}>{t("coadmin.emptyText")}</Empty></div>
      ) : (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th>{t("coadmin.col.person")}</th><th>{t("coadmin.col.company")}</th><th>{t("coadmin.col.defaultRole")}</th>
                <th>{t("coadmin.col.projects")}</th><th>{t("coadmin.col.lang")}</th><th>{t("coadmin.col.lastActive")}</th>
                <th>{t("coadmin.col.status")}</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const projs = membership[p.userId] ?? [];
                const company = p.companyId ? companyById.get(p.companyId) : undefined;
                const st = personStatus(p);
                const busy = busyId === p.ItemId;
                const role = defaultRoleOf(p);
                return (
                  <tr key={p.ItemId} className="m-clickable" onClick={() => setSelectedId(p.ItemId)}>
                    <td>
                      <span className="m-person">
                        <Avatar name={p.displayName ?? p.email} color={companyColor(company ?? { name: p.companyName ?? "" })} size={30} />
                        <span>
                          <span className="m-person-name">{p.displayName}{p.isMe ? <span className="m-muted m-small"> {t("coadmin.you")}</span> : null}</span>
                          <span className="m-person-sub">{p.email}</span>
                        </span>
                      </span>
                    </td>
                    <td><CompanyChip name={p.companyName ?? "—"} color={companyColor(company ?? { name: p.companyName ?? "" })} /><div className="m-small m-muted">{p.jobTitle}</div></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {p.isMe || p.isCompanyAdmin ? (
                        <select className="m-input m-coadmin-role" value="company-admin" disabled title={p.isMe ? t("coadmin.cantChangeOwn") : undefined}>
                          <option value="company-admin">{roleLabel("company-admin")}</option>
                        </select>
                      ) : (
                        <select
                          className="m-input m-coadmin-role"
                          value={role}
                          disabled={busy || st === "Deactivated"}
                          onChange={(e) => {
                            const r = e.target.value;
                            void run(p, () => setRole.mutateAsync({ memberId: p.ItemId, role: r }), fmt(t("coadmin.roleChanged"), { name: p.displayName ?? p.email, role: roleLabel(r) }));
                          }}
                        >
                          {role ? null : <option value="">{t("coadmin.chooseRole")}</option>}
                          {PROJECT_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      <div className="m-coadmin-projs">
                        {projs.length === 0 ? <span className="m-muted m-small">{t("coadmin.none")}</span> : projs.map((m) => {
                          const pr = projectById.get(m.projectId);
                          return pr ? <span key={m.ItemId} className="m-coadmin-proj" title={pr.name} style={{ background: projectColor(pr) }}>{pr.number.slice(-3)}</span> : null;
                        })}
                      </div>
                    </td>
                    <td>{(p.language ?? "en").slice(0, 2).toUpperCase()}</td>
                    <td className="m-muted">{st === "Invited" ? fmt(t("coadmin.invitedOn"), { date: shortDate(p.invitedAt) }) : shortDate(p.lastLoggedInTime)}</td>
                    <td><StatusBadge status={st} label={statusLabel(st)} /></td>
                    <td onClick={(e) => e.stopPropagation()} className="m-right">
                      {busy ? <Loader2 className="spin" size={16} /> : st === "Invited" ? (
                        <Button small variant="ghost" icon={<Mail size={13} />} onClick={() => void run(p, () => resend.mutateAsync({ memberId: p.ItemId }), fmt(t("coadmin.resent"), { email: p.email }))}>{t("coadmin.resend")}</Button>
                      ) : (
                        <Button
                          small
                          variant="ghost"
                          icon={st === "Deactivated" ? <RotateCcw size={13} /> : <UserMinus size={13} />}
                          disabled={p.isMe}
                          title={p.isMe ? t("coadmin.cantDeactivateSelf") : undefined}
                          onClick={() => st === "Deactivated"
                            ? void run(p, () => reactivate.mutateAsync({ memberId: p.ItemId }), fmt(t("coadmin.reactivated"), { name: p.displayName ?? p.email }), "good")
                            : void run(p, () => deactivate.mutateAsync({ memberId: p.ItemId }), fmt(t("coadmin.deactivated"), { name: p.displayName ?? p.email }), "warn")}
                        >
                          {st === "Deactivated" ? t("coadmin.reactivate") : t("coadmin.deactivate")}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-small m-muted">{t("coadmin.deactivateNote")}</p>

      {inviteOpen ? (
        <InviteDialog
          companies={companyOptions}
          projects={projects}
          taken={people.map((p) => p.email.toLowerCase())}
          onClose={() => setInviteOpen(false)}
          onInvited={(email) => {
            setInviteOpen(false);
            toast(fmt(t("coadmin.inviteSent"), { email }));
          }}
        />
      ) : null}

      {selected ? (
        <Dialog title={selected.displayName ?? selected.email} onClose={() => setSelectedId(null)} size="md" footer={<Button variant="secondary" onClick={() => setSelectedId(null)}>{t("coadmin.close")}</Button>}>
          <div className="m-stack-v">
            <div className="m-row">
              <Avatar name={selected.displayName ?? selected.email} color={companyColor(selected.companyId ? companyById.get(selected.companyId) : undefined)} size={44} />
              <div>
                <div className="m-strong">{selected.jobTitle ?? "—"}</div>
                <CompanyChip name={selected.companyName ?? "—"} color={companyColor(selected.companyId ? companyById.get(selected.companyId) : undefined)} />
              </div>
            </div>
            <KeyValue items={[
              [t("auth.email"), selected.email],
              [t("coadmin.phone"), selected.phoneNumber ?? selected.phone ?? "—"],
              [t("coadmin.col.defaultRole"), roleLabel(selected.isCompanyAdmin ? "company-admin" : defaultRoleOf(selected))],
              [t("coadmin.systemRole"), <span className="m-mono">{selected.isCompanyAdmin ? "company-admin" : defaultRoleOf(selected) || "—"}</span>],
              [t("coadmin.col.lang"), (selected.language ?? "en").slice(0, 2).toUpperCase()],
              [t("coadmin.col.status"), <StatusBadge status={personStatus(selected)} label={statusLabel(personStatus(selected))} />]
            ]} />
            <h4 className="m-coadmin-h4">{fmt(t("coadmin.projectsCount"), { count: (membership[selected.userId] ?? []).length })}</h4>
            {(membership[selected.userId] ?? []).length === 0 ? <p className="m-muted">{t("coadmin.noProjects")}</p> : (
              <div className="m-stack-v">
                {(membership[selected.userId] ?? []).map((m) => {
                  const pr = projectById.get(m.projectId);
                  if (!pr) return null;
                  return (
                    <div key={m.ItemId} className="m-coadmin-projrow">
                      <span className="m-coadmin-swatch" style={{ background: projectColor(pr) }} />
                      <div><b>{pr.name}</b><div className="m-small m-muted">{pr.number}</div></div>
                      <Badge tone="blue">{isProjectRole(m.role) ? t(ROLE_LABEL[m.role].short) : m.role}</Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog>
      ) : null}
      <Toasts items={toasts} />
    </>
  );
}

function InviteDialog({ companies, projects, taken, onClose, onInvited }: {
  companies: Company[]; projects: Project[]; taken: string[]; onClose: () => void; onInvited: (email: string) => void;
}) {
  const { t } = useT();
  const invite = useInvitePerson();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyId, setCompanyId] = useState(companies[0]?.ItemId ?? "");
  const [role, setRole] = useState<string>("superintendent");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const isTaken = taken.includes(email.trim().toLowerCase());
  const valid = firstName.trim().length > 0 && lastName.trim().length > 0 && emailOk && !isTaken && !!companyId;

  async function send() {
    setError(undefined);
    try {
      await invite.mutateAsync({ email: email.trim(), firstName, lastName, jobTitle, companyId, defaultRole: role, projectIds });
      onInvited(email.trim());
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <Dialog
      title={t("coadmin.inviteTitle")}
      onClose={onClose}
      size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button icon={invite.isPending ? <Loader2 className="spin" size={15} /> : <Mail size={15} />} disabled={!valid || invite.isPending} onClick={() => void send()}>{t("coadmin.sendInvite")}</Button>
      </>}
    >
      {error ? <div style={{ marginBottom: 12 }}><Note tone="danger">{error}</Note></div> : null}
      <div className="m-form">
        <Field label={t("auth.firstName")}><input className="m-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="e.g. Jana" autoFocus /></Field>
        <Field label={t("auth.lastName")}><input className="m-input" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="e.g. Wolff" /></Field>
        <Field label={t("coadmin.email")} hint={email && !emailOk ? t("auth.errorEmail") : isTaken ? t("coadmin.taken") : undefined}>
          <input className="m-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.example" inputMode="email" />
        </Field>
        <Field label={t("coadmin.jobTitle")}><input className="m-input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder={t("coadmin.jobTitlePlaceholder")} /></Field>
        <Field label={t("coadmin.col.company")}><Select value={companyId} onChange={setCompanyId} options={companies.map((c) => ({ value: c.ItemId, label: c.name }))} /></Field>
        <Field label={t("coadmin.col.defaultRole")}><Select value={role} onChange={setRole} options={PROJECT_ROLES.map((r) => ({ value: r, label: t(ROLE_LABEL[r].label) }))} /></Field>
        <Field label={t("coadmin.addToProjects")} wide>
          <div className="m-coadmin-checks">
            {projects.length === 0 ? <span className="m-muted m-small">{t("coadmin.noProjectsYet")}</span> : projects.map((p) => (
              <label key={p.ItemId} className="m-check">
                <input type="checkbox" checked={projectIds.includes(p.ItemId)} onChange={(e) => setProjectIds((prev) => e.target.checked ? [...prev, p.ItemId] : prev.filter((x) => x !== p.ItemId))} />
                {p.name} <span className="m-muted m-small">{p.number}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Note>{t("coadmin.inviteNote")}</Note>
      </div>
    </Dialog>
  );
}
