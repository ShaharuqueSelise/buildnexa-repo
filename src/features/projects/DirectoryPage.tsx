// Project directory (PRJ-03), built from the demo app's Directory page
// (mock/src/mock/pages/DirectoryPage.tsx): people, companies and distribution lists of the current
// project. The Project Manager and Company Admins change the team; everyone else sees it read-only.
// Not real yet: last-active and language (IAM details are read by company admins on Company admin
// › People), the RFI / punch / submittal numbers per company, and distribution lists (they come
// with RFIs and submittals).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Download, Loader2, RefreshCw, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { PROJECT_ROLES, ROLE_LABEL, defaultRoleFor, rolesFor } from "../../lib/roles";
import { FunctionRefused } from "../../lib/blocks/functions";
import {
  Avatar, Badge, Button, CompanyChip, Dialog, Empty, Field, Kpi, Note, PageTitle, Panel, SearchInput, Select, StatusBadge, Tabs,
  Toasts, colorFor, downloadCsv, fmt, initials, useToasts
} from "../../shared/m/ui";
import type { Tone, ToastTone } from "../../shared/m/ui";
import { useDeactivate, useReactivate, useResendInvite } from "../company/peopleApi";
import { personName, useAddMembers, useProjects, useRemoveMember, useSetProjectRole } from "./projectsApi";
import type { CompanyRow, OrgMemberRow, TeamRow } from "./projectsApi";
import { fmtShortDate } from "./ProjectsPage";
import "./Directory.css";

type Nav = { onNavigate: (path: string) => void };
type Tab = "people" | "companies" | "lists";
type Status = "Active" | "Invited" | "Deactivated";
type Row = TeamRow & { member?: OrgMemberRow; name: string; status: Status };

const statusOf = (m?: OrgMemberRow): Status => (m?.status === "deactivated" ? "Deactivated" : m?.status === "active" ? "Active" : "Invited");
const companyColor = (c?: Pick<CompanyRow, "name" | "brandColor">) => c?.brandColor || colorFor(c?.name ?? "?");
const TYPE: Record<string, { key: "dir.type.gc" | "dir.type.sub" | "dir.type.design" | "dir.type.owner" | "dir.type.supplier"; tone: Tone }> = {
  self: { key: "dir.type.gc", tone: "blue" },
  sub: { key: "dir.type.sub", tone: "gray" },
  design: { key: "dir.type.design", tone: "purple" },
  owner: { key: "dir.type.owner", tone: "teal" },
  supplier: { key: "dir.type.supplier", tone: "gray" }
};

export function DirectoryPage({ onNavigate }: Nav) {
  const { t } = useT();
  const { query, ws, project, myUserId, isAdmin, canEditTeam } = useProjects();
  const queryClient = useQueryClient();
  const { items: toasts, toast } = useToasts();
  const setRole = useSetProjectRole();
  const removeMember = useRemoveMember();
  const resend = useResendInvite();
  const deactivate = useDeactivate();
  const reactivate = useReactivate();
  const [tab, setTab] = useState<Tab>("people");
  const [q, setQ] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Row | null>(null);
  const [profile, setProfile] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("dir.title")} />
        <Panel><Empty icon={<Building2 size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }

  const roleLabel = (r: string) => (r in ROLE_LABEL ? t(ROLE_LABEL[r as keyof typeof ROLE_LABEL].label) : r);
  const editReason = t("dir.editReason");
  const people: Row[] = ws.team
    .filter((r) => r.projectId === project.ItemId && r.status === "active")
    .map((r) => {
      const member = ws.people.find((m) => m.ItemId === r.orgMemberId) ?? ws.people.find((m) => m.userId === r.userId);
      return { ...r, member, name: member ? personName(member) : r.displayName || r.email || "?", status: statusOf(member) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const companyById = (id?: string) => ws.companies.find((c) => c.ItemId === id);
  const companies = [...new Set(people.map((p) => p.companyId).filter(Boolean))].map((id) => companyById(id)).filter((c): c is CompanyRow => Boolean(c));
  const filtered = people.filter((p) =>
    (!q || `${p.name} ${p.email ?? ""} ${p.member?.jobTitle ?? ""} ${p.companyName ?? ""}`.toLowerCase().includes(q.toLowerCase())) &&
    (!companyFilter || p.companyId === companyFilter) &&
    (!roleFilter || p.role === roleFilter) &&
    (!statusFilter || p.status === statusFilter)
  );

  async function run(key: string, action: () => Promise<unknown>, ok: string, tone?: ToastTone) {
    setBusy(key);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      toast(ok, tone);
    } catch (error) {
      toast(error instanceof FunctionRefused ? error.message : t("common.error"), "warn");
    } finally {
      setBusy(null);
    }
  }

  const exportCsv = () => downloadCsv(`${project.number}-directory.csv`, people.map((p) => ({
    Name: p.name, Email: p.email, Company: p.companyName, Title: p.member?.jobTitle ?? "", Role: roleLabel(p.role), SystemRole: p.role, Status: p.status
  })));

  const active = people.filter((p) => p.status === "Active").length;
  const invited = people.filter((p) => p.status === "Invited").length;

  return (
    <div>
      <PageTitle
        title={t("dir.title")}
        subtitle={fmt(t("dir.subtitle"), { project: project.name })}
        actions={
          <>
            <Button variant="secondary" icon={<Download size={15} />} onClick={exportCsv}>{t("coadmin.exportCsv")}</Button>
            <Button icon={<UserPlus size={15} />} onClick={() => setAddOpen(true)} disabled={!canEditTeam} title={canEditTeam ? undefined : editReason}>{t("dir.invite")}</Button>
          </>
        }
      />

      {!canEditTeam ? <div style={{ marginBottom: 12 }}><Note>{fmt(t("dir.viewOnly"), { reason: editReason })}</Note></div> : null}

      <div className="m-kpis">
        <Kpi label={t("dir.kpi.people")} value={people.length} hint={fmt(t("dir.kpi.active"), { count: active })} />
        <Kpi label={t("dir.kpi.joined")} value={`${people.length ? Math.round((active / people.length) * 100) : 0} %`} hint={t("dir.kpi.joinedHint")} tone={active / Math.max(1, people.length) >= 0.8 ? "green" : "amber"} />
        <Kpi label={t("dir.kpi.pending")} value={invited} hint={t("dir.kpi.pendingHint")} tone="amber" />
        <Kpi label={t("coadmin.kpi.companies")} value={companies.length} hint={fmt(t("dir.kpi.subs"), { count: companies.filter((c) => c.relation === "sub").length })} />
      </div>

      <Tabs<Tab>
        tabs={[
          { key: "people", label: t("coadmin.tab.people"), count: people.length },
          { key: "companies", label: t("coadmin.kpi.companies"), count: companies.length },
          { key: "lists", label: t("dir.tab.lists") }
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "people" ? (
        <>
          <div className="m-toolbar">
            <SearchInput value={q} onChange={setQ} placeholder={t("coadmin.search")} />
            <Select value={companyFilter} onChange={setCompanyFilter} placeholder={t("coadmin.allCompanies")} options={companies.map((c) => ({ value: c.ItemId, label: c.name }))} />
            <Select value={roleFilter} onChange={setRoleFilter} placeholder={t("dir.allRoles")} options={PROJECT_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} />
            <Select value={statusFilter} onChange={setStatusFilter} placeholder={t("dir.allStatuses")} options={[
              { value: "Active", label: t("coadmin.status.active") }, { value: "Invited", label: t("coadmin.status.invited") }, { value: "Deactivated", label: t("coadmin.status.deactivated") }
            ]} />
          </div>

          {filtered.length === 0 ? <Panel><Empty icon={<Users size={26} />} title={t("coadmin.emptyTitle")}>{t("coadmin.emptyText")}</Empty></Panel> : (
            <div className="m-table-wrap">
              <table className="m-table">
                <thead>
                  <tr><th>{t("coadmin.col.person")}</th><th>{t("coadmin.col.company")}</th><th>{t("dir.col.role")}</th><th>{t("coadmin.col.status")}</th><th className="m-hide-mobile">{t("coadmin.col.lastActive")}</th><th className="m-hide-mobile">{t("dir.col.lang")}</th><th /></tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const isMe = p.userId === myUserId;
                    const editable = canEditTeam && !isMe;
                    const c = companyById(p.companyId);
                    const rowBusy = busy === p.ItemId;
                    return (
                      <tr key={p.ItemId} className="m-clickable" onClick={() => setProfile(p)}>
                        <td>
                          <span className="m-person">
                            <Avatar name={p.name} color={companyColor(c)} size={32} />
                            <span><span className="m-person-name">{p.name}{isMe ? <> <Badge tone="blue">{t("dir.you")}</Badge></> : null}</span><span className="m-person-sub">{[p.member?.jobTitle, p.email].filter(Boolean).join(" · ")}</span></span>
                          </span>
                        </td>
                        <td>{c ? <CompanyChip name={c.name} color={companyColor(c)} /> : p.companyName ?? "—"}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {editable ? (
                            <div className="m-dir-role">
                              <Select value={p.role} disabled={rowBusy} onChange={(v) => void run(p.ItemId, () => setRole.mutateAsync({ projectId: project.ItemId, projectMemberId: p.ItemId, role: v }), fmt(t("dir.roleChanged"), { name: p.name, role: roleLabel(v) }))} options={rolesFor(p.companyRelation).map((r) => ({ value: r, label: roleLabel(r) }))} />
                              <span className="m-mono m-muted m-small">{p.role}</span>
                            </div>
                          ) : (
                            <div className="m-dir-role" title={isMe ? t("coadmin.cantChangeOwn") : editReason}>
                              <b>{roleLabel(p.role)}</b>
                              <span className="m-mono m-muted m-small">{p.role}</span>
                            </div>
                          )}
                        </td>
                        <td><StatusBadge status={p.status} label={t(p.status === "Active" ? "coadmin.status.active" : p.status === "Invited" ? "coadmin.status.invited" : "coadmin.status.deactivated")} /></td>
                        <td className="m-hide-mobile">{p.status === "Invited" ? <span className="m-muted">{t("dir.neverSignedIn")}</span> : <span className="m-muted" title={t("dir.lastActiveLater")}>—</span>}</td>
                        <td className="m-hide-mobile"><span className="m-muted" title={t("dir.lastActiveLater")}>—</span></td>
                        <td onClick={(e) => e.stopPropagation()} className="m-right">
                          <span className="m-row" style={{ justifyContent: "flex-end" }}>
                            {rowBusy ? <Loader2 className="spin" size={15} /> : null}
                            {p.status === "Invited" && p.member && isAdmin ? <Button small variant="secondary" icon={<RefreshCw size={13} />} disabled={isMe || rowBusy} onClick={() => void run(p.ItemId, () => resend.mutateAsync({ memberId: p.member!.ItemId }), fmt(t("coadmin.resent"), { email: p.email ?? "" }))}>{t("coadmin.resend")}</Button> : null}
                            {p.status === "Deactivated" && p.member ? (
                              <Button small variant="ghost" disabled={!isAdmin || isMe || rowBusy} onClick={() => void run(p.ItemId, () => reactivate.mutateAsync({ memberId: p.member!.ItemId }), fmt(t("coadmin.reactivated"), { name: p.name }))}>{t("coadmin.reactivate")}</Button>
                            ) : p.status === "Active" && isAdmin && p.member ? (
                              <Button small variant="ghost" disabled={isMe || rowBusy} title={isMe ? t("coadmin.cantDeactivateSelf") : t("dir.deactivateTitle")} onClick={() => void run(p.ItemId, () => deactivate.mutateAsync({ memberId: p.member!.ItemId }), fmt(t("coadmin.deactivated"), { name: p.name }), "warn")}>{t("coadmin.deactivate")}</Button>
                            ) : null}
                            <Button small variant="ghost" icon={<UserMinus size={13} />} disabled={!editable || rowBusy} title={editable ? t("dir.removeTitle") : isMe ? t("dir.cantRemoveSelf") : editReason} onClick={() => setRemoveTarget(p)} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {tab === "companies" ? (
        <div className="m-cards">
          {companies.map((c) => {
            const members = people.filter((p) => p.companyId === c.ItemId);
            const type = TYPE[c.relation] ?? TYPE.sub!;
            return (
              <div key={c.ItemId} className="m-card">
                <div className="m-dir-company-head" style={{ borderTopColor: companyColor(c) }}>
                  <span className="m-dir-company-logo" style={{ background: companyColor(c) }}>{initials(c.name)}</span>
                  <div style={{ minWidth: 0 }}>
                    <b className="m-dir-ellipsis">{c.name}</b>
                    <div className="m-small m-muted">{[c.tradeCodes?.join(", "), c.address?.city].filter(Boolean).join(" · ") || "—"}</div>
                  </div>
                  <Badge tone={type.tone}>{t(type.key)}</Badge>
                </div>
                <div className="m-card-body">
                  <div className="m-dir-company-stats">
                    <button onClick={() => { setCompanyFilter(c.ItemId); setTab("people"); }}><b>{members.length}</b><span>{t("coadmin.tab.people")}</span></button>
                    <button disabled title={t("prj.notYet")}><b>—</b><span>{t("dir.openPunch")}</span></button>
                    <button disabled title={t("prj.notYet")}><b>—</b><span>{t("prj.col.openRfis")}</span></button>
                    <button disabled title={t("prj.notYet")}><b>—</b><span>{t("dir.submittals")}</span></button>
                  </div>
                  <div className="m-row m-row-wrap" style={{ gap: 4 }}>
                    {members.slice(0, 6).map((m) => <Avatar key={m.ItemId} name={m.name} color={companyColor(c)} size={26} />)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {tab === "lists" ? <Note>{t("dir.listsLater")}</Note> : null}

      {addOpen ? (
        <AddPeopleDialog
          candidates={ws.people.filter((m) => m.status !== "removed" && m.status !== "deactivated" && !people.some((p) => p.userId === m.userId))}
          companies={ws.companies}
          isAdmin={isAdmin}
          onClose={() => setAddOpen(false)}
          onCompanyAdmin={() => onNavigate("/company")}
          onAdded={(text) => { setAddOpen(false); toast(text); }}
          projectId={project.ItemId}
        />
      ) : null}

      {removeTarget ? (
        <Dialog
          size="sm"
          title={fmt(t("dir.removeQ"), { name: removeTarget.name })}
          onClose={() => setRemoveTarget(null)}
          footer={<>
            <Button variant="secondary" onClick={() => setRemoveTarget(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" icon={busy === removeTarget.ItemId ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />} disabled={busy === removeTarget.ItemId} onClick={() => void run(removeTarget.ItemId, () => removeMember.mutateAsync({ projectId: project.ItemId, projectMemberId: removeTarget.ItemId }), fmt(t("dir.removed"), { name: removeTarget.name, project: project.name })).then(() => setRemoveTarget(null))}>{t("dir.removeButton")}</Button>
          </>}
        >
          <div className="m-stack-v">
            <p style={{ margin: 0 }}>{fmt(t("dir.removeText"), { name: removeTarget.name, company: removeTarget.companyName ?? "", project: project.name })}</p>
            <Note tone="warn">{t("dir.removeNote")}</Note>
          </div>
        </Dialog>
      ) : null}

      {profile ? (
        <Dialog size="sm" title={<span className="m-row"><Avatar name={profile.name} color={companyColor(companyById(profile.companyId))} size={30} />{profile.name}</span>} onClose={() => setProfile(null)}>
          <dl className="m-kv">
            <div><dt>{t("dir.f.title")}</dt><dd>{profile.member?.jobTitle || "—"}</dd></div>
            <div><dt>{t("coadmin.col.company")}</dt><dd>{profile.companyName ?? "—"}</dd></div>
            <div><dt>{t("dir.col.role")}</dt><dd>{roleLabel(profile.role)}<br /><span className="m-mono m-muted">{profile.role}</span></dd></div>
            <div><dt>{t("coadmin.col.status")}</dt><dd><StatusBadge status={profile.status} /></dd></div>
            <div><dt>{t("coadmin.email")}</dt><dd>{profile.email ? <a className="m-link" href={`mailto:${profile.email}`}>{profile.email}</a> : "—"}</dd></div>
            <div><dt>{t("coadmin.phone")}</dt><dd>{profile.member?.phone || "—"}</dd></div>
            <div><dt>{t("dir.f.onProject")}</dt><dd>{fmtShortDate(profile.joinedAt)}</dd></div>
          </dl>
          <hr className="m-sep" />
          <div className="m-small m-muted">{t("dir.ballLater")}</div>
        </Dialog>
      ) : null}
      <Toasts items={toasts} />
    </div>
  );
}

function AddPeopleDialog({ candidates, companies, isAdmin, projectId, onClose, onCompanyAdmin, onAdded }: {
  candidates: OrgMemberRow[];
  companies: CompanyRow[];
  isAdmin: boolean;
  projectId: string;
  onClose: () => void;
  onCompanyAdmin: () => void;
  onAdded: (text: string) => void;
}) {
  const { t } = useT();
  const add = useAddMembers();
  const [memberId, setMemberId] = useState("");
  const [role, setRole] = useState("field-user");
  const [error, setError] = useState<string | null>(null);
  const member = candidates.find((m) => m.ItemId === memberId);
  const roleLabel = (r: string) => (r in ROLE_LABEL ? t(ROLE_LABEL[r as keyof typeof ROLE_LABEL].label) : r);
  const company = companies.find((c) => c.ItemId === member?.companyId);
  const relation = company?.relation;
  // People from partner companies only get the partner roles (the server checks the same).
  const allowed = rolesFor(member?.companyRelation ?? relation);
  const mismatch = (relation === "sub" && role !== "field-user") || (relation === "design" && role !== "design-reviewer") || (relation === "owner" && role !== "owner-viewer");

  async function send() {
    if (!member) return;
    setError(null);
    try {
      await add.mutateAsync({ projectId, team: [{ orgMemberId: member.ItemId, role }] });
      onAdded(fmt(t("dir.added"), { name: personName(member), role: roleLabel(role) }));
    } catch (e) {
      setError(e instanceof FunctionRefused ? e.message : t("common.error"));
    }
  }

  return (
    <Dialog
      title={t("dir.invite")}
      onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button icon={add.isPending ? <Loader2 className="spin" size={14} /> : <UserPlus size={14} />} disabled={!member || add.isPending} onClick={() => void send()}>{t("dir.addButton")}</Button>
      </>}
    >
      <div className="m-form">
        <Field label={t("dir.f.person")} wide hint={candidates.length ? undefined : t("dir.everyoneOn")}>
          <Select value={memberId} placeholder={t("dir.choosePerson")} onChange={(v) => { setMemberId(v); const m = candidates.find((x) => x.ItemId === v); const ok = rolesFor(m?.companyRelation); setRole(m?.defaultRole && ok.includes(m.defaultRole as (typeof ok)[number]) ? m.defaultRole : defaultRoleFor(m?.companyRelation)); }} options={candidates.map((m) => ({ value: m.ItemId, label: `${personName(m)} · ${m.companyName ?? ""}` }))} />
        </Field>
        <Field label={t("coadmin.col.company")}><span className="m-small" style={{ paddingTop: 8 }}>{company?.name ?? "—"}</span></Field>
        <Field label={t("dir.col.role")}><Select value={role} onChange={setRole} options={allowed.map((r) => ({ value: r, label: `${roleLabel(r)} (${r})` }))} /></Field>
        <div className="m-field-wide m-stack-v">
          {mismatch && company ? <Note tone="warn">{fmt(t("dir.mismatch"), { company: company.name, role: roleLabel(role) })}</Note> : null}
          {error ? <Note tone="danger">{error}</Note> : null}
          <Note>
            <span className="m-row m-row-wrap"><Building2 size={14} /> {t("dir.newPersonNote")}
              {isAdmin ? <button className="m-link" onClick={onCompanyAdmin}>{t("dir.openCompanyAdmin")}</button> : null}
            </span>
          </Note>
        </div>
      </div>
    </Dialog>
  );
}
