// The app frame in grey while sign-in is checked: dark sidebar, top bar and a page skeleton, so the
// screen already looks like Buildnexa instead of a spinner on white. Same classes as AppShell.
import { ClipboardList } from "lucide-react";
import "./Shell.css";
import { Sk, SkeletonPage } from "../../shared/m/Skeleton";
import type { SkeletonKind } from "../../shared/m/Skeleton";

/** Sidebar menu rows in grey (also used by AppShell until the user's roles are known). */
export function SkNav({ rows = 8 }: { rows?: number }) {
  return (
    <div className="m-sk-nav" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ alignItems: "center", display: "flex", gap: 12, marginTop: i === 0 || i === 4 ? 10 : 0 }}>
          <Sk w={18} h={18} r={5} />
          <Sk w={[110, 86, 124, 96][i % 4]} h={12} />
        </div>
      ))}
    </div>
  );
}

export function ShellSkeleton({ kind = "home" }: { kind?: SkeletonKind }) {
  return (
    <div className="m-root">
      <aside className="m-side">
        <div className="m-side-brand">
          <span className="m-logo"><ClipboardList size={18} /></span>
          <div>Buildnexa</div>
        </div>
        <SkNav />
      </aside>
      <div className="m-main">
        <header className="m-top" aria-hidden="true">
          <Sk w={32} h={32} r={8} />
          <Sk w={200} h={36} r={10} />
          <div className="m-top-spacer" />
          <Sk w={32} h={32} r={999} />
          <Sk w={32} h={32} r={999} />
        </header>
        <div className="m-content">
          <div className="m-content-inner">
            <SkeletonPage kind={kind} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The sign-in card in grey, while we check whether someone is already signed in. */
export function AuthSkeleton() {
  return (
    <div className="auth-screen" role="status" aria-busy="true">
      <span className="m-sr">Loading</span>
      <div className="auth-card" aria-hidden="true">
        <Sk w={40} h={40} r={10} />
        <Sk w={180} h={22} />
        <Sk w="80%" h={13} />
        <Sk w="100%" h={40} r={10} style={{ marginTop: 10 }} />
        <Sk w="100%" h={40} r={10} />
        <Sk w="100%" h={42} r={10} style={{ marginTop: 6 }} />
      </div>
    </div>
  );
}
