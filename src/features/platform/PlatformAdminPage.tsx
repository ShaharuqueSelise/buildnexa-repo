// Platform admin (ADM-02), built from the demo app's PlatformAdminPage
// (mock/src/mock/pages/PlatformAdminPage.tsx): Buildnexa operations look after customer
// companies, usage and the other platform admins. Never project records.
// Real now: the page and who may open it (role platform-admin). Companies, usage and platform
// admins are filled in next; the remaining tabs come in Phase 5.
import { Building2, Construction, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { Empty, Note, PageTitle, Panel, Tabs, fmt } from "../../shared/m/ui";

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

const NEXT: Partial<Record<TabKey, { icon: ReactNode; text: TranslationKey }>> = {
  companies: { icon: <Building2 size={28} />, text: "plat.companiesNext" },
  usage: { icon: <Users size={28} />, text: "plat.usageNext" },
  admins: { icon: <ShieldCheck size={28} />, text: "plat.adminsNext" }
};

export function PlatformAdminPage(_props: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>("companies");
  const next = NEXT[tab];
  const label = t(TABS.find((x) => x.key === tab)?.label ?? "plat.tab.companies");

  return (
    <div>
      <PageTitle title={t("nav.platform")} subtitle={t("plat.subtitle")} />
      <Tabs<TabKey> value={tab} onChange={setTab} tabs={TABS.map((x) => ({ key: x.key, label: t(x.label) }))} />
      <Panel>
        {next ? (
          <Empty icon={next.icon} title={t("plat.nextTitle")}>{t(next.text)}</Empty>
        ) : (
          <Empty icon={<Construction size={28} />} title={fmt(t("shell.phaseTitle"), { phase: 5 })}>{fmt(t("plat.later"), { module: label })}</Empty>
        )}
      </Panel>
      <Note>{t("plat.note")}</Note>
    </div>
  );
}
