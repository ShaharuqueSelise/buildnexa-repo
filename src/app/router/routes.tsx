import { useEffect, useState } from "react";
import { AppShell } from "../layout/AppShell";
import { RedirectIfAuthenticated, RequireAuth } from "./guards";
import { CallbackPage } from "../../features/auth/CallbackPage";
import { ErrorPage } from "../../features/auth/ErrorPage";
import { ActivatePage, ResetPasswordPage } from "../../features/auth/AccountLinkPages";
import { LoginPage } from "../../features/auth/LoginPage";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { NotFoundPage } from "../../features/auth/NotFoundPage";
import { ProfilePage } from "../../features/profile/ProfilePage";
import { SpikePage } from "../../features/spike/SpikePage";

const LOGIN_NOTICES: Record<string, TranslationKey> = {
  activated: "auth.noticeActivated",
  reset: "auth.noticeReset"
};

const protectedRoutes = {
  "/": ProfilePage,
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

  const Page = protectedRoutes[path as keyof typeof protectedRoutes];
  if (!Page) {
    return <NotFoundPage onNavigate={navigate} />;
  }

  return (
    <RequireAuth currentPath={path} onNavigate={navigate}>
      <AppShell activePath={path} onNavigate={navigate}>
        <Page />
      </AppShell>
    </RequireAuth>
  );
}
