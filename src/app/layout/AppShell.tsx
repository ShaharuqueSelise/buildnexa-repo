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
import { rfisOnMe, useRfiList } from "../../features/rfis/rfisApi";
import { todayIso } from "../../lib/workdays";
import { useQueryClient } from "@tanstack/react-query";
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
  const { roles, myRole, isAdmin, isPlatformAdmin, platformOnly, query, project, myUserId } = useProjects();
  const unread = useNotifications().data?.unread ?? 0;
  // RFIs waiting on me in the current project (the same list the RFI page uses, so one call).
  const rfiList = useRfiList(myRole ? project?.ItemId : undefined);
  const rfisMine = rfisOnMe(rfiList.data?.rfis, myUserId, todayIso()).length;
  // A new notification usually means an RFI moved: refresh the RFI screens and My items.
  const queryClient = useQueryClient();
  const lastUnread = useRef(unread);
  useEffect(() => {
    if (unread > lastUnread.current) {
      void queryClient.invalidateQueries({ queryKey: ["rfis"] });
      void queryClient.invalidateQueries({ queryKey: ["rfi"] });
    }
    lastUnread.current = unread;
  }, [unread, queryClient]);
  const visible = visibleModules({ projectRole: myRole, isAdmin, isPlatformAdmin, platformOnly });
  // A platform admin outside any company starts in the platform area.
  const startPath = platformOnly ? "/platform" : "/";
  const active = navItemFor(activePath);
  // Wait for roles and projects before saying "no access", so the page does not flash it.
  const ready = Boolean(roles) && !query.isLoading;
  const allowed = !active || !ready || visible.has(active.module);

  useEffect(() => {
    if (ready && platformOnly && activePath === "/") onNavigate("/platform");
  }, [ready, platformOnly, activePath, onNavigate]);

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
  const counts: Partial<Record<string, number>> = { "/inbox": unread || undefined, "/rfis": rfisMine || undefined };

  return (
    <div className="m-root">
      <aside className={cx("m-side", collapsed && "m-side-collapsed")}>
        <a className="m-side-brand" href={startPath} onClick={(e) => { e.preventDefault(); onNavigate(startPath); }} style={{ textDecoration: "none" }}>
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
          {platformOnly ? <strong className="m-top-area">{t("nav.platform")}</strong> : <ProjectSwitcher onNavigate={onNavigate} />}
          {platformOnly ? null : (
            <div className="m-top-search">
              <input className="m-input" placeholder={t("shell.search")} disabled title={t("shell.searchLater")} />
            </div>
          )}
          <div className="m-top-spacer" />
          <LanguageSwitcher />
          <NotificationsMenu onNavigate={onNavigate} />
          <UserMenu onNavigate={onNavigate} />
        </header>
        <div className="m-content" ref={contentRef}>
          <div className="m-content-inner">
            {platformOnly && activePath === "/" ? null : allowed ? children : <NoAccess home={startPath} onNavigate={onNavigate} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function NoAccess({ home, onNavigate }: { home: string; onNavigate: (path: string) => void }) {
  const { t } = useT();
  return (
    <div className="m-panel m-empty">
      <Eye size={28} />
      <strong>{t("shell.noAccess")}</strong>
      <p>{home === "/" ? t("shell.noAccessText") : t("shell.noAccessPlatformText")}</p>
      <button className="m-link" onClick={() => onNavigate(home)}>{home === "/" ? t("shell.goHome") : t("shell.goPlatform")}</button>
    </div>
  );
}
