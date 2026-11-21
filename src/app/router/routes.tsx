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
import { setCurrentProject } from "../../features/projects/projectsApi";
import { navItemFor } from "../layout/navItems";

const LOGIN_NOTICES: Record<string, TranslationKey> = {
  activated: "auth.noticeActivated",
  reset: "auth.noticeReset"
};

// Pages get the router's navigate function; pages that don't need it ignore it.
const protectedRoutes: Record<string, ComponentType<{ onNavigate: (path: string) => void }>> = {
  "/": HomePage,
  "/profile": ProfilePage,
  "/projects": ProjectsPage,
  "/directory": DirectoryPage,
  "/company": CompanyAdminPage,
  "/platform": PlatformAdminPage,
  "/spike": SpikePage,
  "/error": ErrorPage
};

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
  const later = navItemFor(path)?.phase;
  const Page = protectedRoutes[path];
  if (!Page && !later) {
    return <NotFoundPage onNavigate={navigate} />;
  }

  return (
    <RequireAuth currentPath={`${path}${search}`} onNavigate={navigate}>
      <AppShell activePath={path} onNavigate={navigate}>
        {Page ? <Page onNavigate={navigate} /> : <ComingSoonPage path={path} />}
      </AppShell>
    </RequireAuth>
  );
}
