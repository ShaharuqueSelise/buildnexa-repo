// Platform admin (ADM-02), built from the demo app's PlatformAdminPage
// (mock/src/mock/pages/PlatformAdminPage.tsx): Buildnexa operations look after customer
// companies, usage and the other platform admins. Never project records.
// Real now: Companies (list, details, Create company) and Usage, from the Function `platform`.
// Not real yet: plans, data region, storage and record counts, feature flags (not in the data
// model yet), Platform admins (next step), support lookup, health and limits (Phase 5).
import { Building2, Construction, Mail, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import {
  Badge, Button, Dialog, Empty, Field, KeyValue, Kpi, Note, PageTitle, Panel, ProgressBar, SearchInput, Tabs, Toasts, downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { shortNameFrom, useCompanies, useCreateCompany } from "./platformApi";
import type { PlatformCompany } from "./platformApi";
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
      {tab === "admins" && (
        <Panel><Empty icon={<ShieldCheck size={28} />} title={t("plat.nextTitle")}>{t("plat.adminsNext")}</Empty></Panel>
      )}
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
