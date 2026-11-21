// Platform admin (ADM-02), built from the demo app's PlatformAdminPage
// (mock/src/mock/pages/PlatformAdminPage.tsx): Buildnexa operations look after customer
// companies, usage and the other platform admins. Never project records.
// Real now: Companies (list, details, Create company, Add company admin), Usage and Platform
// admins, from the Function `platform`.
// Not real yet: plans, data region, storage and record counts, feature flags (not in the data
// model yet), support lookup, health and limits (Phase 5).
import { Building2, Construction, Mail, Plus, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import {
  Badge, Button, Dialog, Empty, Field, KeyValue, Kpi, Note, PageTitle, Panel, ProgressBar, SearchInput, Tabs, Toasts, downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import {
  shortNameFrom, useAddCompanyAdmin, useAddPlatformAdmin, useCompanies, useCreateCompany, usePlatformAdmins, useRemovePlatformAdmin
} from "./platformApi";
import type { NewAdmin, PlatformAdmin, PlatformCompany } from "./platformApi";
import "./PlatformAdmin.css";

type TabKey = "companies" | "usage" | "admins" | "flags" | "support" | "health" | "limits";

const TABS: { key: TabKey; label: TranslationKey }[] = [
  { key: "companies", label: "plat.tab.companies" },
  { key: "usage", label: "plat.tab.usage" },
  { key: "admins", label: "plat.tab.admins" },
  { key: "flags", label: "plat.tab.flags" },
  { key: "support", label: "plat.tab.support" },
  { key: "health", label: "plat.tab.health" },
  { key: "limits", label: "plat.tab.limits" }
];

// Scale targets from the PRD, to verify on Blocks.
const TARGETS = { projects: 500, people: 2000 };

/** "Admin invited" until a company admin has set up their account. */
const isWaiting = (c: PlatformCompany) => c.admins.length > 0 && c.admins.every((a) => a.status === "invited");

export function PlatformAdminPage(_props: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>("companies");
  const companies = useCompanies();
  const { items: toasts, toast } = useToasts();
  const rows = companies.data ?? [];
  const label = t(TABS.find((x) => x.key === tab)?.label ?? "plat.tab.companies");
  const total = (k: "projects" | "people") => rows.reduce((s, c) => s + c[k], 0);

  return (
    <div>
      <PageTitle title={t("nav.platform")} subtitle={t("plat.subtitle")} />
      <div className="m-kpis">
        <Kpi label={t("plat.kpi.companies")} value={companies.data ? rows.length : "—"} hint={companies.data ? fmt(t("plat.kpi.waiting"), { count: rows.filter(isWaiting).length }) : undefined} onClick={() => setTab("companies")} />
        <Kpi label={t("plat.kpi.projects")} value={companies.data ? total("projects") : "—"} onClick={() => setTab("usage")} />
        <Kpi label={t("plat.kpi.people")} value={companies.data ? total("people") : "—"} onClick={() => setTab("usage")} />
      </div>
      <Tabs<TabKey> value={tab} onChange={setTab} tabs={TABS.map((x) => ({ key: x.key, label: t(x.label), count: x.key === "companies" && companies.data ? rows.length : undefined }))} />

      {companies.isError && (tab === "companies" || tab === "usage") ? <Note tone="danger">{(companies.error as Error).message}</Note> : null}
      {tab === "companies" && <CompaniesTab rows={rows} loading={companies.isLoading} toast={toast} />}
      {tab === "usage" && <UsageTab rows={rows} />}
      {tab === "admins" && <AdminsTab toast={toast} />}
      {tab !== "companies" && tab !== "usage" && tab !== "admins" && (
        <Panel>
          <Empty icon={<Construction size={28} />} title={fmt(t("shell.phaseTitle"), { phase: 5 })}>{fmt(t("plat.later"), { module: label })}</Empty>
        </Panel>
      )}
      <Note>{t("plat.note")}</Note>
      <Toasts items={toasts} />
    </div>
  );
}

// ---------- Companies ----------

function CompaniesTab({ rows, loading, toast }: { rows: PlatformCompany[]; loading: boolean; toast: (text: string, tone?: "good" | "warn") => void }) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<PlatformCompany | null>(null);
  const shown = rows.filter((c) => !q || `${c.name} ${c.tag} ${c.admins.map((a) => `${a.name} ${a.email}`).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  const status = (c: PlatformCompany) =>
    c.status !== "active" ? <Badge tone="red">{t("plat.status.inactive")}</Badge> : isWaiting(c) ? <Badge tone="amber">{t("plat.status.invited")}</Badge> : <Badge tone="green">{t("plat.status.active")}</Badge>;

  return (
    <>
      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("plat.search")} />
        <span className="m-plat-grow" />
        <Button
          variant="secondary"
          disabled={rows.length === 0}
          onClick={() => downloadCsv("companies.csv", rows.map((c) => ({ company: c.name, tag: c.tag, admins: c.admins.map((a) => a.email).join(" "), projects: c.projects, people: c.people, invited: c.invited, created: c.createdAt ?? "" })))}
        >
          {t("plat.exportCsv")}
        </Button>
        <Button icon={<Plus size={15} />} onClick={() => setOpen(true)}>{t("plat.create")}</Button>
      </div>
      <div className="m-table-wrap">
        <table className="m-table">
          <thead>
            <tr>
              <th>{t("plat.col.company")}</th>
              <th>{t("plat.col.admins")}</th>
              <th className="m-num">{t("plat.col.projects")}</th>
              <th className="m-num">{t("plat.col.people")}</th>
              <th>{t("plat.col.created")}</th>
              <th>{t("plat.col.status")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className="m-clickable" onClick={() => setDetail(c)}>
                <td>
                  <div className="m-row">
                    <span className="m-plat-logo">{c.name.slice(0, 2).toUpperCase()}</span>
                    <div><b>{c.name}</b><div className="m-small m-muted m-mono">{c.tag}</div></div>
                  </div>
                </td>
                <td>
                  {c.admins.length === 0 ? <span className="m-muted">—</span> : c.admins.map((a) => (
                    <div key={a.email}><div>{a.name}</div><div className="m-small m-muted">{a.email}</div></div>
                  ))}
                </td>
                <td className="m-num">{c.projects}</td>
                <td className="m-num">{c.people}</td>
                <td className="m-muted">{c.createdAt ? fmtShortDate(c.createdAt) : "—"}</td>
                <td>{status(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? <div className="m-empty m-small">{t("shell.loading")}</div> : null}
        {!loading && shown.length === 0 ? (
          <Empty icon={<Building2 size={26} />} title={rows.length ? t("plat.noMatch") : t("plat.noneTitle")}>{rows.length ? null : t("plat.noneText")}</Empty>
        ) : null}
      </div>
      <p className="m-small m-muted">{t("plat.companyExplain")}</p>

      {open ? (
        <CreateCompanyDialog
          taken={rows.map((c) => c.tag)}
          onClose={() => setOpen(false)}
          onCreated={(name, email) => {
            setOpen(false);
            toast(fmt(t("plat.created"), { name, email }), "good");
          }}
        />
      ) : null}
      {detail ? (
        <Dialog title={detail.name} onClose={() => setDetail(null)} size="md" footer={<Button variant="secondary" onClick={() => setDetail(null)}>{t("common.close")}</Button>}>
          <KeyValue items={[
            [t("plat.tag"), <span className="m-mono">{detail.tag}</span>],
            [t("plat.col.status"), status(detail)],
            [t("plat.col.created"), detail.createdAt ? fmtDate(detail.createdAt) : "—"],
            [t("plat.col.admins"), detail.admins.map((a) => `${a.name} · ${a.email}`).join(", ") || "—"],
            [t("plat.col.projects"), detail.projects],
            [t("plat.col.people"), fmt(t("plat.peopleInvited"), { people: detail.people, invited: detail.invited })]
          ]} />
          <div className="m-plat-mt"><Note>{t("plat.detailNote")}</Note></div>
          <AddCompanyAdmin
            company={detail}
            onAdded={(email, invited) => {
              setDetail(null);
              toast(fmt(invited ? t("plat.coAdminInvited") : t("plat.coAdminAdded"), { email, name: detail.name }), "good");
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}

function CreateCompanyDialog({ taken, onClose, onCreated }: { taken: string[]; onClose: () => void; onCreated: (name: string, email: string) => void }) {
  const { t } = useT();
  const create = useCreateCompany();
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [edited, setEdited] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const short = edited ? shortName : shortNameFrom(name);
  const shortOk = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(short) && !short.includes("--") && short !== "admin";
  const shortTaken = taken.includes(`company-${short}`);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const valid = name.trim().length >= 2 && shortOk && !shortTaken && firstName.trim() && lastName.trim() && emailOk;

  async function submit() {
    try {
      await create.mutateAsync({ name: name.trim(), shortName: short, admin: { email: email.trim(), firstName: firstName.trim(), lastName: lastName.trim() } });
      onCreated(name.trim(), email.trim());
    } catch {
      // the error shows in the dialog
    }
  }

  return (
    <Dialog
      title={t("plat.create")}
      onClose={create.isPending ? () => undefined : onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>{t("common.cancel")}</Button>
          <Button disabled={!valid || create.isPending} icon={<Mail size={15} />} onClick={submit}>{create.isPending ? t("plat.creating") : t("plat.createSend")}</Button>
        </>
      }
    >
      <div className="m-form">
        <Field label={t("plat.f.name")}><input className="m-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weser Bau GmbH" /></Field>
        <Field
          label={t("plat.f.short")}
          hint={short && !shortOk ? t("plat.f.shortBad") : shortTaken ? t("plat.f.shortTaken") : fmt(t("plat.f.shortHint"), { tag: `company-${short || "…"}` })}
        >
          <input className="m-input m-mono" value={short} onChange={(e) => { setEdited(true); setShortName(e.target.value.toLowerCase()); }} placeholder="weser-bau" />
        </Field>
        <Field label={t("plat.f.first")}><input className="m-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
        <Field label={t("plat.f.last")}><input className="m-input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
        <Field label={t("plat.f.email")} hint={email && !emailOk ? t("plat.f.emailBad") : undefined} wide>
          <input className="m-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@customer.example" />
        </Field>
      </div>
      <div className="m-plat-mt">
        {create.isError ? <Note tone="danger">{(create.error as Error).message}</Note> : <Note>{t("plat.createNote")}</Note>}
      </div>
    </Dialog>
  );
}

// ---------- story 3.4: add a company admin ----------

function AdminFields({ value, onChange, wideEmail }: { value: NewAdmin; onChange: (v: NewAdmin) => void; wideEmail?: boolean }) {
  const { t } = useT();
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email.trim());
  return (
    <div className="m-form">
      <Field label={t("plat.f.firstOnly")}><input className="m-input" value={value.firstName} onChange={(e) => onChange({ ...value, firstName: e.target.value })} /></Field>
      <Field label={t("plat.f.last")}><input className="m-input" value={value.lastName} onChange={(e) => onChange({ ...value, lastName: e.target.value })} /></Field>
      <Field label={t("plat.f.emailOnly")} hint={value.email && !emailOk ? t("plat.f.emailBad") : undefined} wide={wideEmail}>
        <input className="m-input" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} placeholder="name@company.example" />
      </Field>
    </div>
  );
}
const adminValid = (a: NewAdmin) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email.trim()) && Boolean(a.firstName.trim()) && Boolean(a.lastName.trim());
const trimAdmin = (a: NewAdmin): NewAdmin => ({ email: a.email.trim(), firstName: a.firstName.trim(), lastName: a.lastName.trim() });

function AddCompanyAdmin({ company, onAdded }: { company: PlatformCompany; onAdded: (email: string, invited: boolean) => void }) {
  const { t } = useT();
  const add = useAddCompanyAdmin();
  const [open, setOpen] = useState(false);
  const [admin, setAdmin] = useState<NewAdmin>({ email: "", firstName: "", lastName: "" });
  if (!open) {
    return (
      <div className="m-plat-mt">
        <Button variant="secondary" icon={<UserPlus size={15} />} onClick={() => setOpen(true)}>{t("plat.addCoAdmin")}</Button>
      </div>
    );
  }
  return (
    <div className="m-plat-mt">
      <h4 className="m-plat-h4">{t("plat.addCoAdmin")}</h4>
      <p className="m-small m-muted">{fmt(t("plat.addCoAdminText"), { name: company.name })}</p>
      <AdminFields value={admin} onChange={setAdmin} wideEmail />
      {add.isError ? <div className="m-plat-mt"><Note tone="danger">{(add.error as Error).message}</Note></div> : null}
      <div className="m-row m-plat-mt">
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={add.isPending}>{t("common.cancel")}</Button>
        <Button
          icon={<Mail size={15} />}
          disabled={!adminValid(admin) || add.isPending}
          onClick={async () => {
            try {
              const res = await add.mutateAsync({ companyId: company.id, admin: trimAdmin(admin) });
              onAdded(admin.email.trim(), res.invited);
            } catch {
              // shown above
            }
          }}
        >
          {add.isPending ? t("plat.working") : t("plat.addCoAdminSend")}
        </Button>
      </div>
    </div>
  );
}

// ---------- stories 3.5 to 3.7: platform admins ----------

function AdminsTab({ toast }: { toast: (text: string, tone?: "good" | "warn") => void }) {
  const { t } = useT();
  const admins = usePlatformAdmins();
  const add = useAddPlatformAdmin();
  const remove = useRemovePlatformAdmin();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NewAdmin>({ email: "", firstName: "", lastName: "" });
  const [removing, setRemoving] = useState<PlatformAdmin | null>(null);
  const rows = admins.data ?? [];
  const stateBadge = (a: PlatformAdmin) =>
    a.state === "active" ? <Badge tone="green">{t("plat.status.active")}</Badge> : a.state === "invited" ? <Badge tone="amber">{t("plat.admin.invited")}</Badge> : <Badge tone="red">{t("plat.status.inactive")}</Badge>;

  return (
    <>
      <div className="m-toolbar">
        <span className="m-small m-muted">{t("plat.admin.explain")}</span>
        <span className="m-plat-grow" />
        <Button icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>{t("plat.admin.add")}</Button>
      </div>
      {admins.isError ? <Note tone="danger">{(admins.error as Error).message}</Note> : null}
      <div className="m-table-wrap">
        <table className="m-table">
          <thead><tr><th>{t("plat.admin.col.person")}</th><th>{t("plat.col.status")}</th><th>{t("plat.admin.col.last")}</th><th /></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.userId}>
                <td><b>{a.name}</b>{a.isMe ? <span className="m-muted m-small"> {t("coadmin.you")}</span> : null}<div className="m-small m-muted">{a.email}</div></td>
                <td>{stateBadge(a)}</td>
                <td className="m-muted">{a.lastLoggedInTime ? fmtShortDate(a.lastLoggedInTime) : "—"}</td>
                <td className="m-right">
                  <Button
                    small
                    variant="ghost"
                    icon={<UserMinus size={13} />}
                    disabled={a.isMe || rows.length <= 1}
                    title={a.isMe ? t("plat.admin.cantSelf") : rows.length <= 1 ? t("plat.admin.cantLast") : undefined}
                    onClick={() => setRemoving(a)}
                  >
                    {t("plat.admin.remove")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {admins.isLoading ? <div className="m-empty m-small">{t("shell.loading")}</div> : null}
      </div>
      {rows.length === 1 ? <Note tone="warn">{t("plat.admin.onlyOne")}</Note> : null}

      {adding ? (
        <Dialog
          title={t("plat.admin.add")}
          onClose={add.isPending ? () => undefined : () => setAdding(false)}
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setAdding(false)} disabled={add.isPending}>{t("common.cancel")}</Button>
              <Button
                icon={<ShieldCheck size={15} />}
                disabled={!adminValid(draft) || add.isPending}
                onClick={async () => {
                  try {
                    const res = await add.mutateAsync(trimAdmin(draft));
                    setAdding(false);
                    toast(fmt(res.invited ? t("plat.admin.invitedToast") : t("plat.admin.addedToast"), { email: draft.email.trim() }), "good");
                    setDraft({ email: "", firstName: "", lastName: "" });
                  } catch {
                    // shown in the dialog
                  }
                }}
              >
                {add.isPending ? t("plat.working") : t("plat.admin.addConfirm")}
              </Button>
            </>
          }
        >
          <AdminFields value={draft} onChange={setDraft} wideEmail />
          <div className="m-plat-mt">{add.isError ? <Note tone="danger">{(add.error as Error).message}</Note> : <Note tone="warn">{t("plat.admin.addWarn")}</Note>}</div>
        </Dialog>
      ) : null}

      {removing ? (
        <Dialog
          title={t("plat.admin.removeTitle")}
          onClose={remove.isPending ? () => undefined : () => setRemoving(null)}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setRemoving(null)} disabled={remove.isPending}>{t("common.cancel")}</Button>
              <Button
                disabled={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(removing.userId);
                    toast(fmt(t("plat.admin.removedToast"), { name: removing.name }), "good");
                    setRemoving(null);
                  } catch {
                    // shown in the dialog
                  }
                }}
              >
                {remove.isPending ? t("plat.working") : t("plat.admin.remove")}
              </Button>
            </>
          }
        >
          <p>{fmt(t("plat.admin.removeText"), { name: removing.name })}</p>
          {remove.isError ? <Note tone="danger">{(remove.error as Error).message}</Note> : null}
        </Dialog>
      ) : null}
    </>
  );
}

// ---------- Usage ----------

function UsageTab({ rows }: { rows: PlatformCompany[] }) {
  const { t } = useT();
  return (
    <div className="m-grid m-grid-main">
      <Panel title={t("plat.usageDetail")} className="m-panel-flush">
        <div className="m-table-wrap m-plat-flat">
          <table className="m-table">
            <thead><tr><th>{t("plat.col.company")}</th><th className="m-num">{t("plat.col.projects")}</th><th className="m-num">{t("plat.col.people")}</th><th className="m-num">{t("plat.col.invited")}</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}><td className="m-strong">{c.name}</td><td className="m-num">{c.projects}</td><td className="m-num">{c.people}</td><td className="m-num">{c.invited}</td></tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>{t("plat.total")}</td>
                <td className="m-num">{rows.reduce((s, c) => s + c.projects, 0)}</td>
                <td className="m-num">{rows.reduce((s, c) => s + c.people, 0)}</td>
                <td className="m-num">{rows.reduce((s, c) => s + c.invited, 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>
      <Panel title={t("plat.headroom")}>
        <div className="m-stack-v">
          {rows.map((c) => (
            <div key={c.id} className="m-plat-headroom">
              <b className="m-small">{c.name}</b>
              <div className="m-plat-hrow"><span>{t("plat.col.people")}</span><ProgressBar value={(c.people / TARGETS.people) * 100} /><span className="m-small m-muted">{c.people}/{TARGETS.people}</span></div>
              <div className="m-plat-hrow"><span>{t("plat.col.projects")}</span><ProgressBar value={(c.projects / TARGETS.projects) * 100} tone="teal" /><span className="m-small m-muted">{c.projects}/{TARGETS.projects}</span></div>
            </div>
          ))}
        </div>
        <p className="m-small m-muted">{t("plat.headroomNote")}</p>
      </Panel>
    </div>
  );
}
