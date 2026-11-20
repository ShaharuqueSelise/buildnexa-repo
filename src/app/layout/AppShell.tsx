// The app shell, as in the demo app (mock/src/mock/MockApp.tsx): grouped sidebar filtered by the
// person's role on the current project, top bar with the project switcher, search (R2), the bell
// and the user menu. Hiding a menu item is never the only control: pages and Functions check too.
import { ClipboardList, Eye, PanelLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NAV_GROUPS, navItemFor, navItems, visibleModules } from "./navItems";
import { NotificationsMenu } from "./NotificationsMenu";
import { UserMenu } from "./UserMenu";
import "./Shell.css";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ProjectSwitcher } from "../../features/projects/ProjectSwitcher";
import { useProjects } from "../../features/projects/projectsApi";
import { useNotifications } from "../../features/notifications/notificationsApi";
import { cx } from "../../shared/m/ui";

const COLLAPSED_KEY = "buildnexa:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function AppShell({ activePath, children, onNavigate }: { activePath: string; children: ReactNode; onNavigate: (path: string) => void }) {
  const { t } = useT();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { roles, myRole, isAdmin, query } = useProjects();
  const unread = useNotifications().data?.unread ?? 0;
  const visible = visibleModules({ projectRole: myRole, isAdmin, isPlatformAdmin: roles?.includes("platform-admin") });
  const active = navItemFor(activePath);
  // Wait for roles and projects before saying "no access", so the page does not flash it.
  const ready = Boolean(roles) && !query.isLoading;
  const allowed = !active || !ready || visible.has(active.module);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    } catch {
      // private window: the choice lasts until reload
    }
  }, [collapsed]);

  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [activePath]);

  // What needs attention, per item (more counts arrive with each module).
  const counts: Partial<Record<string, number>> = { "/inbox": unread || undefined };

  return (
    <div className="m-root">
      <aside className={cx("m-side", collapsed && "m-side-collapsed")}>
        <a className="m-side-brand" href="/" onClick={(e) => { e.preventDefault(); onNavigate("/"); }} style={{ textDecoration: "none" }}>
          <span className="m-logo"><ClipboardList size={18} /></span>
          <div>{t("app.name")}<small>{t("app.tagline")}</small></div>
        </a>
        <nav>
          {NAV_GROUPS.map((group) => {
            const items = navItems.filter((item) => item.group === group.key && visible.has(item.module));
            if (items.length === 0) return null;
            return (
              <div key={group.key}>
                <div className="m-side-group">{t(group.labelKey)}</div>
                {items.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    title={item.phase ? `${t(item.labelKey)} · ${t("shell.phaseTitle").replace("{phase}", String(item.phase))}` : t(item.labelKey)}
                    className={cx(item.href === activePath && "m-active", item.phase && "m-side-later")}
                    onClick={(e) => { e.preventDefault(); onNavigate(item.href); }}
                  >
                    <item.icon size={17} />
                    <span>{t(item.labelKey)}</span>
                    {counts[item.href] ? <em className="m-side-count">{counts[item.href]}</em> : item.phase ? <em className="m-side-phase">P{item.phase}</em> : null}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="m-main">
        <header className="m-top">
          <button className="m-icon-btn" onClick={() => setCollapsed((v) => !v)} aria-label={t("shell.toggleSidebar")}><PanelLeft size={18} /></button>
          <ProjectSwitcher onNavigate={onNavigate} />
          <div className="m-top-search">
            <input className="m-input" placeholder={t("shell.search")} disabled title={t("shell.searchLater")} />
          </div>
          <div className="m-top-spacer" />
          <LanguageSwitcher />
          <NotificationsMenu onNavigate={onNavigate} />
          <UserMenu onNavigate={onNavigate} />
        </header>
        <div className="m-content" ref={contentRef}>
          <div className="m-content-inner">{allowed ? children : <NoAccess onNavigate={onNavigate} />}</div>
        </div>
      </div>
    </div>
  );
}

function NoAccess({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  return (
    <div className="m-panel m-empty">
      <Eye size={28} />
      <strong>{t("shell.noAccess")}</strong>
      <p>{t("shell.noAccessText")}</p>
      <button className="m-link" onClick={() => onNavigate("/")}>{t("shell.goHome")}</button>
    </div>
  );
}
