import { useEffect } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../providers/AuthProvider";
import { AuthSkeleton, ShellSkeleton } from "../layout/ShellSkeleton";

type GuardProps = { children: ReactNode; onNavigate: (path: string) => void };

// currentPath is passed in from router state rather than read live from
// window.location.pathname: under StrictMode's dev-only double-invoked
// effects, the first invocation's pushState() already mutates
// window.location before the second invocation runs, which would nest the
// returnTo query param (e.g. /login?returnTo=%2Flogin) if read live here.
export function RequireAuth({ children, currentPath, onNavigate }: GuardProps & { currentPath: string }) {
  const { status } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      onNavigate(`/login?returnTo=${encodeURIComponent(currentPath)}`);
    }
  }, [currentPath, status, onNavigate]);

  if (status !== "authenticated") return <ShellSkeleton />;
  return <>{children}</>;
}

// `to` must be an app path (starts with one slash); anything else falls back to "/".
export function RedirectIfAuthenticated({ children, onNavigate, to: requested }: GuardProps & { to?: string }) {
  const to = requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  const { returnPathFor, status } = useAuth();

  useEffect(() => {
    if (status === "authenticated") onNavigate(returnPathFor(to));
  }, [status, onNavigate, returnPathFor, to]);

  // Signed in: the app is on its way, so show its frame; still checking: show the sign-in card.
  if (status === "authenticated") return <ShellSkeleton />;
  if (status === "loading") return <AuthSkeleton />;
  return <>{children}</>;
}
