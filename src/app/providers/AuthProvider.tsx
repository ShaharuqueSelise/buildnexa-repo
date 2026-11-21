import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { fetchSessionClaims, logout as endSession, onSessionExpired, signInWithPassword, startLogin } from "../../lib/blocks/auth";
import type { SignInResult } from "../../lib/blocks/auth";

type AuthStatus = "authenticated" | "loading" | "unauthenticated";

type AuthContextValue = {
  claims: Record<string, unknown> | undefined;
  login: (returnTo?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** The page to open after signing in: the remembered page, or the start page when someone else signed in. */
  returnPathFor: (path: string) => string;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  status: AuthStatus;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
// A long backup interval, not the primary signal -- polling auth/me every
// few seconds would hit IAM constantly even while the tab sits idle in the
// background. Regaining focus (below) is what actually needs to be prompt,
// e.g. after signing out in another tab or the session expiring meanwhile.
const STATUS_POLL_MS = 5 * 60_000;

/** Who the session belongs to, from IAM's auth/me claims. */
function identityOf(claims?: Record<string, unknown>): string | undefined {
  const id = claims?.sub ?? claims?.user_id ?? claims?.userId ?? claims?.email;
  return typeof id === "string" && id ? id : undefined;
}

// Who was last signed in on this tab. It outlives a sign-out and a reload on purpose: after an
// expired session, the next sign-in can tell whether the same person came back.
const LAST_USER_KEY = "buildnexa:last-user";
function readLastUser(): string | undefined {
  try {
    return sessionStorage.getItem(LAST_USER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeLastUser(identity: string) {
  try {
    sessionStorage.setItem(LAST_USER_KEY, identity);
  } catch {
    // private window: the check falls back to this page's memory
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [claims, setClaims] = useState<Record<string, unknown> | undefined>();
  const queryClient = useQueryClient();
  const lastIdentity = useRef<string | undefined>(readLastUser());
  const signedIn = useRef(false);
  // true when the person who signed in is not the one who was here before (set at each sign-in).
  const personChanged = useRef(false);

  // Everything the app has read (my roles, company, projects, the bell…) belongs to one person.
  // When the session ends or another person signs in, drop it all, so nobody ever sees the
  // previous person's screens or data, not even for a moment.
  const adopt = useCallback((sessionClaims?: Record<string, unknown>) => {
    const identity = identityOf(sessionClaims);
    const previous = readLastUser() ?? lastIdentity.current;
    const changed = Boolean(identity && previous && identity !== previous);
    if (sessionClaims && !signedIn.current) personChanged.current = changed;
    if (!sessionClaims || changed) queryClient.clear();
    if (identity) {
      lastIdentity.current = identity;
      writeLastUser(identity);
    }
    signedIn.current = Boolean(sessionClaims);
    setClaims(sessionClaims);
    setStatus(sessionClaims ? "authenticated" : "unauthenticated");
  }, [queryClient]);

  // An expired session keeps the page you were on, so you come back to it after signing in.
  // That page belongs to the person who was here: someone else starts on their own start page.
  const returnPathFor = useCallback((path: string) => (personChanged.current ? "/" : path), []);

  // The session's source of truth is IAM's GET /iam/v4/auth/me
  // (blocksClient.auth.userInfo()), not a token this app can inspect --
  // the default hosted login flow sets the session as a Secure, httpOnly
  // cookie that never reaches this app's JS, so a successful call here is
  // what "signed in" means, not the presence of a cached access token.
  const refresh = useCallback(async () => {
    adopt(await fetchSessionClaims());
  }, [adopt]);

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
    // A fresh sign-in always starts with an empty cache, whoever was here before.
    queryClient.clear();
    adopt(sessionClaims);
    return result;
  }, [adopt, queryClient]);

  const logout = useCallback(async () => {
    // Signed out at once: the login page shows straight away instead of bouncing back into the
    // app (and flashing its screens) while the sign-out request is still running.
    adopt(undefined);
    await endSession();
    await refresh();
  }, [adopt, refresh]);

  const value = useMemo<AuthContextValue>(() => ({
    claims,
    login,
    logout,
    refresh,
    returnPathFor,
    signIn,
    status
  }), [claims, login, logout, refresh, returnPathFor, signIn, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
