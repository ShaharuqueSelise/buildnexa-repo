import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { AppShell } from "../layout/AppShell";
import { RedirectIfAuthenticated, RequireAuth } from "./guards";
import { CallbackPage } from "../../features/auth/CallbackPage";
import { ErrorPage } from "../../features/auth/ErrorPage";
import { ActivatePage, ResetPasswordPage } from "../../features/auth/AccountLinkPages";
import { LoginPage } from "../../features/auth/LoginPage";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { NotFoundPage } from "../../features/auth/NotFoundPage";
import { CompanyAdminPage } from "../../features/company/CompanyAdminPage";
import { ProfilePage } from "../../features/profile/ProfilePage";
import { DirectoryPage } from "../../features/projects/DirectoryPage";
import { ProjectsPage } from "../../features/projects/ProjectsPage";
import { SpikePage } from "../../features/spike/SpikePage";
import { ComingSoonPage } from "../../features/home/ComingSoonPage";
import { HomePage } from "../../features/home/HomePage";
import { PlatformAdminPage } from "../../features/platform/PlatformAdminPage";
import { RfisPage } from "../../features/rfis/RfisPage";
import { DocumentsPage } from "../../features/documents/DocumentsPage";
import { DrawingsPage } from "../../features/drawings/DrawingsPage";
import { PhotosPage } from "../../features/photos/PhotosPage";
import { PunchPage } from "../../features/punch/PunchPage";
import { DailyLogsPage } from "../../features/dailyLogs/DailyLogsPage";
import { InboxPage } from "../../features/inbox/InboxPage";
import { setCurrentProject } from "../../features/projects/projectsApi";
import { navItemFor } from "../layout/navItems";

const LOGIN_NOTICES: Record<string, TranslationKey> = {
  activated: "auth.noticeActivated",
  reset: "auth.noticeReset"
};

type PageProps = { onNavigate: (path: string) => void; params?: string[] };

// Pages get the router's navigate function; pages that don't need it ignore it.
const protectedRoutes: Record<string, ComponentType<PageProps>> = {
  "/": HomePage,
  "/rfis": RfisPage,
  "/drawings": DrawingsPage,
  "/photos": PhotosPage,
  "/punch": PunchPage,
  "/daily-logs": DailyLogsPage,
  "/documents": DocumentsPage,
  "/inbox": InboxPage,
  "/profile": ProfilePage,
  "/projects": ProjectsPage,
  "/directory": DirectoryPage,
  "/company": CompanyAdminPage,
  "/platform": PlatformAdminPage,
  "/spike": SpikePage,
  "/error": ErrorPage
};

// Pages that also open one record by id: /rfis/<id> renders the /rfis page with params ["<id>"].
const ROUTES_WITH_ID = new Set(["/rfis", "/photos", "/drawings", "/punch", "/daily-logs"]);

function matchRoute(path: string): { base: string; params: string[] } {
  if (protectedRoutes[path]) return { base: path, params: [] };
  const [, first = "", ...rest] = path.split("/");
  const base = `/${first}`;
  if (ROUTES_WITH_ID.has(base) && rest.length === 1 && rest[0]) return { base, params: [decodeURIComponent(rest[0])] };
  return { base: path, params: [] };
}

export function AppRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [search, setSearch] = useState(() => window.location.search);
  const { t } = useT();

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // A link with ?project=<id> (emails, notifications) makes that project the current one.
  useEffect(() => {
    const projectId = new URLSearchParams(search).get("project");
    if (projectId) setCurrentProject(projectId);
  }, [search]);

  function navigate(nextPath: string) {
    const [nextPathname = "/", queryString = ""] = nextPath.split("?");
    window.history.pushState({}, "", nextPath);
    setPath(nextPathname);
    setSearch(queryString ? `?${queryString}` : "");
  }

  if (path === "/login/callback") {
    return <CallbackPage onNavigate={navigate} />;
  }

  if (path === "/login") {
    const params = new URLSearchParams(search);
    const returnTo = params.get("returnTo") || undefined;
    const notice = LOGIN_NOTICES[params.get("notice") ?? ""];
    return (
      <RedirectIfAuthenticated onNavigate={navigate} to={returnTo}>
        <LoginPage notice={notice ? t(notice) : undefined} />
      </RedirectIfAuthenticated>
    );
  }

  // Emailed links. IAM builds them as <accountActionBaseUrl>/<path>?code=..., with the paths
  // from `blocks auth config` (accountActivationPath "oidc/activate/", recoverAccountPath
  // "resetpassword"); the short forms are accepted too.
  if (/^\/(oidc\/)?activate(\/|$)/.test(path)) {
    return <ActivatePage onNavigate={navigate} />;
  }
  if (/^\/(resetpassword|reset-password)(\/|$)/.test(path)) {
    return <ResetPasswordPage onNavigate={navigate} />;
  }

  // Modules not built yet open a page that says which phase builds them.
  const { base, params } = matchRoute(path);
  const later = navItemFor(base)?.phase;
  const Page = protectedRoutes[base];
  if (!Page && !later) {
    return <NotFoundPage onNavigate={navigate} />;
  }

  return (
    <RequireAuth currentPath={`${path}${search}`} onNavigate={navigate}>
      <AppShell activePath={base} onNavigate={navigate}>
        {Page ? <Page onNavigate={navigate} params={params} /> : <ComingSoonPage path={base} />}
      </AppShell>
    </RequireAuth>
  );
}
