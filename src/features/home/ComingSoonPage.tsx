// A module that is not built yet: the sidebar lists it (as in the demo app) and this page says
// which phase builds it. The demo app shows how it will look.
import { Construction } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { navItemFor } from "../../app/layout/navItems";
import { Empty, PageTitle, Panel, fmt } from "../../shared/m/ui";

export function ComingSoonPage({ path }: { path: string }) {
  const { t } = useT();
  const item = navItemFor(path);
  if (!item?.phase) return null;
  return (
    <>
      <PageTitle title={t(item.labelKey)} />
      <Panel>
        <Empty icon={<Construction size={28} />} title={fmt(t("shell.phaseTitle"), { phase: item.phase })}>
          {fmt(t(`shell.phase${item.phase}` as "shell.phase2"), { module: t(item.labelKey) })}
        </Empty>
      </Panel>
    </>
  );
}
