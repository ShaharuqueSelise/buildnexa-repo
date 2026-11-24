// Company admin › Roles, built from the demo app's Roles tab (mock/src/mock/pages/CompanyAdminPage.tsx):
// "Default project role by company type" and "What each role can do". Both read the shared
// permission table (functions/_shared/permissions.js), the same one the Functions enforce, so this
// page can't drift from what the server allows. Read-only for now: the roles are the agreed ones.
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { PROJECT_ROLES, projectPermissionsOf } from "../../lib/permissions";
import { ROLE_LABEL, defaultRoleFor, rolesFor } from "../../lib/roles";
import { Badge, Note, Panel } from "../../shared/m/ui";
import { relationLabelKey } from "./CompaniesTab";
import type { Relation } from "./peopleApi";

const RELATIONS: Relation[] = ["self", "sub", "design", "owner", "supplier"];
// The spec's "Limited": the right only covers the person's own or assigned records.
const isLimited = (key: string) => /_(assigned|own|involved|relevant|company)$/.test(key);

export function RolesTab() {
  const { t } = useT();

  return (
    <div className="m-stack-v">
      <Panel title={t("roles.defaultsTitle")}>
        <p className="m-muted m-small m-coadmin-p">{t("roles.defaultsText")}</p>
        <div className="m-table-wrap">
          <table className="m-table">
            <thead><tr><th>{t("roles.col.type")}</th><th>{t("roles.col.default")}</th><th>{t("roles.col.allowed")}</th></tr></thead>
            <tbody>
              {RELATIONS.map((r) => {
                const def = defaultRoleFor(r);
                return (
                  <tr key={r}>
                    <td className="m-strong">{t(relationLabelKey(r))}</td>
                    <td>{t(ROLE_LABEL[def].label)}<div className="m-mono m-muted m-small">{def}</div></td>
                    <td><div className="m-row m-row-wrap">{rolesFor(r).map((x) => <Badge key={x} tone={x === def ? "blue" : "gray"}>{t(ROLE_LABEL[x].short)}</Badge>)}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="m-muted m-small" style={{ marginTop: 10 }}>{t("roles.fixedNote")}</p>
      </Panel>
      <Panel title={t("roles.whatTitle")}>
        <div className="m-stack-v">
          <p className="m-muted m-small m-coadmin-p">{t("roles.whatText")}</p>
          {PROJECT_ROLES.map((role) => {
            const byModule = new Map<string, string[]>();
            for (const key of projectPermissionsOf(role)) {
              const mod = key.split(".")[0] ?? key;
              byModule.set(mod, [...(byModule.get(mod) ?? []), key]);
            }
            return (
              <div key={role} className="m-coadmin-rolecard">
                <div className="m-row"><b>{t(ROLE_LABEL[role].label)}</b><span className="m-mono m-muted">{role}</span></div>
                {[...byModule].map(([mod, keys]) => (
                  <div key={mod} className="m-small">
                    <span className="m-strong">{t(`perm.mod.${mod}` as TranslationKey)}: </span>
                    {keys.map((key, i) => (
                      <span key={key}>
                        {i > 0 ? " · " : null}
                        {t(`perm.${key}` as TranslationKey)}
                        {isLimited(key) ? <> <Badge tone="amber">{t("roles.limited")}</Badge></> : null}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
          <Note>{t("roles.limitedText")}</Note>
        </div>
      </Panel>
    </div>
  );
}
