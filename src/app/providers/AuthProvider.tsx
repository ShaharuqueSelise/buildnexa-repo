import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fetchSessionClaims, logout as endSession, onSessionExpired, signInWithPassword, startLogin } from "../../lib/blocks/auth";
import type { SignInResult } from "../../lib/blocks/auth";

type AuthStatus = "authenticated" | "loading" | "unauthenticated";

type AuthContextValue = {
  claims: Record<string, unknown> | undefined;
  login: (returnTo?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  status: AuthStatus;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
// A long backup interval, not the primary signal -- polling auth/me every
// few seconds would hit IAM constantly even while the tab sits idle in the
// background. Regaining focus (below) is what actually needs to be prompt,
// e.g. after signing out in another tab or the session expiring meanwhile.
const STATUS_POLL_MS = 5 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [claims, setClaims] = useState<Record<string, unknown> | undefined>();

  // The session's source of truth is IAM's GET /iam/v4/auth/me
  // (blocksClient.auth.userInfo()), not a token this app can inspect --
  // the default hosted login flow sets the session as a Secure, httpOnly
  // cookie that never reaches this app's JS, so a successful call here is
  // what "signed in" means, not the presence of a cached access token.
  const refresh = useCallback(async () => {
    const sessionClaims = await fetchSessionClaims();
    setClaims(sessionClaims);
    setStatus(sessionClaims ? "authenticated" : "unauthenticated");
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, STATUS_POLL_MS);

    function onVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Fires when a reactive 401 forced a refresh and IAM rejected the refresh
  // token outright (invalid_grant) -- blocks/auth.ts already ended the
  // session server-side, this just gets the UI to notice and redirect.
  useEffect(() => onSessionExpired(() => void refresh()), [refresh]);

  const login = useCallback(async (returnTo?: string) => {
    await startLogin(returnTo);
  }, []);

  // App-owned login screen: sign in, then confirm the session with IAM like every other path.
  const signIn = useCallback(async (email: string, password: string) => {
    const result = await signInWithPassword(email, password);
    if (!result.ok) return result;
    const sessionClaims = await fetchSessionClaims();
    if (!sessionClaims) {
      return { ok: false as const, reason: "other" as const, message: "Signed in, but the session could not be confirmed. Please try again." };
    }
    setClaims(sessionClaims);
    setStatus("authenticated");
    return result;
  }, []);

  const logout = useCallback(async () => {
    await endSession();
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(() => ({
    claims,
    login,
    logout,
    refresh,
    signIn,
    status
  }), [claims, login, logout, refresh, signIn, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
