// Company admin › Companies: the partner companies (subcontractors, design firms, owners, suppliers)
// whose people work on this company's projects. Not in the demo app; built in its style (People tab
// table, dialogs). The company-people Function decides: only company admins, no duplicate names,
// and a company is only removed once nobody works for it.
import { useMemo, useState } from "react";
import { Building2, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { Badge, Button, CompanyChip, Dialog, Empty, Field, Note, SearchInput, Select, Toasts, colorFor, fmt, useToasts } from "../../shared/m/ui";
import type { Tone } from "../../shared/m/ui";
import { personStatus, useAddCompany, useRemoveCompany, useUpdateCompany } from "./peopleApi";
import type { Company, PartnerRelation, PeopleList, Relation } from "./peopleApi";

const PARTNER_RELATIONS: PartnerRelation[] = ["sub", "design", "owner", "supplier"];
const RELATION_TONE: Record<Relation, Tone> = { self: "purple", sub: "blue", design: "teal", owner: "amber", supplier: "gray" };

export const relationLabelKey = (r?: Relation) => `comp.rel.${r ?? "self"}` as TranslationKey;

export function CompaniesTab({ data }: { data: PeopleList }) {
  const { t } = useT();
  const { items: toasts, toast } = useToasts();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const [removing, setRemoving] = useState<Company | null>(null);

  // People who still count for a company: not deactivated (the Function's rule for removing).
  const peopleCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of data.people) if (p.companyId && personStatus(p) !== "Deactivated") map[p.companyId] = (map[p.companyId] ?? 0) + 1;
    return map;
  }, [data.people]);

  const companies = useMemo(
    () => [...data.companies].sort((a, b) => (a.relation === "self" ? -1 : b.relation === "self" ? 1 : a.name.localeCompare(b.name))),
    [data.companies]
  );
  const rows = companies.filter((c) =>
    (!q || `${c.name} ${(c.tradeCodes ?? []).join(" ")} ${c.address?.city ?? ""}`.toLowerCase().includes(q.toLowerCase())) &&
    (!type || c.relation === type)
  );
  const partners = companies.filter((c) => c.relation !== "self");

  return (
    <>
      <p className="m-muted m-small m-coadmin-p">{t("comp.intro")}</p>
      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("comp.search")} />
        <Select value={type} onChange={setType} placeholder={t("comp.anyType")} options={PARTNER_RELATIONS.map((r) => ({ value: r, label: t(relationLabelKey(r)) }))} />
        <span className="m-coadmin-grow" />
        <Button icon={<Plus size={15} />} onClick={() => setEditing("new")}>{t("comp.add")}</Button>
      </div>

      {partners.length === 0 ? <Note>{t("comp.emptyText")}</Note> : null}
      {rows.length === 0 ? (
        <div className="m-table-wrap"><Empty icon={<Building2 size={26} />} title={t("comp.emptyTitle")}>{t("comp.emptyText")}</Empty></div>
      ) : (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th>{t("comp.col.company")}</th><th>{t("comp.col.type")}</th><th>{t("comp.col.trades")}</th>
                <th>{t("comp.col.city")}</th><th>{t("comp.col.people")}</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.ItemId}>
                  <td><CompanyChip name={c.name} color={c.brandColor || colorFor(c.name)} /></td>
                  <td><Badge tone={RELATION_TONE[c.relation] ?? "gray"}>{t(relationLabelKey(c.relation))}</Badge></td>
                  <td>
                    <div className="m-row m-row-wrap">
                      {(c.tradeCodes ?? []).length === 0 ? <span className="m-muted">—</span> : (c.tradeCodes ?? []).map((x) => <Badge key={x}>{x}</Badge>)}
                    </div>
                  </td>
                  <td>{c.address?.city || <span className="m-muted">—</span>}</td>
                  <td>{peopleCount[c.ItemId] ?? 0}</td>
                  <td className="m-right">
                    {c.relation === "self" ? <span className="m-muted m-small">{t("comp.yours")}</span> : (
                      <span className="m-row" style={{ justifyContent: "flex-end" }}>
                        <Button small variant="ghost" icon={<Pencil size={13} />} title={t("comp.edit")} onClick={() => setEditing(c)} />
                        <Button small variant="ghost" icon={<Trash2 size={13} />} title={t("comp.remove")} onClick={() => setRemoving(c)} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <CompanyDialog
          company={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={(text) => { setEditing(null); toast(text, "good"); }}
        />
      ) : null}
      {removing ? (
        <RemoveDialog
          company={removing}
          people={peopleCount[removing.ItemId] ?? 0}
          onClose={() => setRemoving(null)}
          onDone={(text) => { setRemoving(null); toast(text, "warn"); }}
        />
      ) : null}
      <Toasts items={toasts} />
    </>
  );
}

function CompanyDialog({ company, onClose, onDone }: { company?: Company; onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useT();
  const add = useAddCompany();
  const update = useUpdateCompany();
  const [name, setName] = useState(company?.name ?? "");
  const [relation, setRelation] = useState<PartnerRelation>(company && company.relation !== "self" ? company.relation : "sub");
  const [trades, setTrades] = useState((company?.tradeCodes ?? []).join(", "));
  const [city, setCity] = useState(company?.address?.city ?? "");
  const [error, setError] = useState<string | undefined>();
  const busy = add.isPending || update.isPending;
  const valid = name.trim().length >= 2;

  async function save() {
    setError(undefined);
    const input = { name: name.trim(), tradeCodes: trades.split(",").map((x) => x.trim()).filter(Boolean), city: city.trim() };
    try {
      if (company) await update.mutateAsync({ ...input, companyId: company.ItemId });
      else await add.mutateAsync({ ...input, relation });
      onDone(fmt(t(company ? "comp.saved" : "comp.added"), { name: input.name }));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <Dialog
      title={company ? fmt(t("comp.editTitle"), { name: company.name }) : t("comp.addTitle")}
      onClose={onClose}
      size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button icon={busy ? <Loader2 className="spin" size={15} /> : undefined} disabled={!valid || busy} onClick={() => void save()}>{company ? t("comp.save") : t("comp.add")}</Button>
      </>}
    >
      {error ? <div style={{ marginBottom: 12 }}><Note tone="danger">{error}</Note></div> : null}
      <div className="m-form">
        <Field label={t("comp.name")}><input className="m-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("comp.namePlaceholder")} autoFocus maxLength={120} /></Field>
        <Field label={t("comp.type")} hint={company ? t("comp.typeFixed") : undefined}>
          <Select
            value={relation}
            onChange={(v) => setRelation(v as PartnerRelation)}
            disabled={Boolean(company)}
            options={PARTNER_RELATIONS.map((r) => ({ value: r, label: t(relationLabelKey(r)) }))}
          />
        </Field>
        <Field label={t("comp.trades")} hint={t("comp.tradesHint")}><input className="m-input" value={trades} onChange={(e) => setTrades(e.target.value)} /></Field>
        <Field label={t("comp.city")}><input className="m-input" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} /></Field>
      </div>
    </Dialog>
  );
}

function RemoveDialog({ company, people, onClose, onDone }: { company: Company; people: number; onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useT();
  const remove = useRemoveCompany();
  const [error, setError] = useState<string | undefined>();

  async function confirm() {
    setError(undefined);
    try {
      await remove.mutateAsync({ companyId: company.ItemId });
      onDone(fmt(t("comp.removed"), { name: company.name }));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <Dialog
      title={fmt(t("comp.removeTitle"), { name: company.name })}
      onClose={onClose}
      size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" disabled={people > 0 || remove.isPending} icon={remove.isPending ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />} onClick={() => void confirm()}>{t("comp.remove")}</Button>
      </>}
    >
      {error ? <div style={{ marginBottom: 12 }}><Note tone="danger">{error}</Note></div> : null}
      {people > 0 ? <Note tone="warn">{fmt(t("comp.removeBlocked"), { count: people })}</Note> : <p>{t("comp.removeText")}</p>}
    </Dialog>
  );
}
