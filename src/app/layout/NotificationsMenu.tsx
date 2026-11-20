// The bell (NOT-01), as in the demo app's top bar: the latest notifications from the person's
// Blocks inbox, mark one or all read, open the linked page.
import { Bell, Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { cx } from "../../shared/m/ui";
import { useMarkAllRead, useMarkRead, useNotifications } from "../../features/notifications/notificationsApi";

const when = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function NotificationsMenu({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const query = useNotifications();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const items = query.data?.items ?? [];
  const unread = query.data?.unread ?? 0;

  return (
    <div className="m-rel" ref={ref}>
      <button className="m-icon-btn" onClick={() => setOpen(!open)} aria-label={t("shell.notifications")}>
        <Bell size={18} />
        {unread ? <span className="m-bell-dot">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="m-popover" style={{ top: 42, right: 0, width: 380 }}>
          <div className="m-row" style={{ justifyContent: "space-between", padding: "6px 10px" }}>
            <strong>{t("shell.notifications")}</strong>
            {unread ? <button className="m-link m-small" disabled={markAll.isPending} onClick={() => markAll.mutate()}>{t("shell.markAllRead")}</button> : null}
          </div>
          {items.map((n) => (
            <button
              key={n.id}
              className="m-popover-item"
              style={{ alignItems: "flex-start" }}
              onClick={() => {
                if (!n.read) markRead.mutate(n.id);
                setOpen(false);
                if (n.link) onNavigate(n.link);
              }}
            >
              <span className="m-dot" style={{ marginTop: 6, background: n.read ? "transparent" : "#3b82f6" }} />
              <span style={{ flex: 1 }}>
                <b style={{ fontWeight: n.read ? 500 : 700 }}>{n.title}</b>
                {n.body ? <small>{n.body}</small> : null}
                <small>{when(n.at)}</small>
              </span>
            </button>
          ))}
          {query.isLoading ? <div className="m-empty m-small">{t("shell.loading")}</div> : null}
          {query.isError ? <div className="m-empty m-small">{t("shell.notificationsError")}</div> : null}
          {!query.isLoading && !query.isError && items.length === 0 ? (
            <div className={cx("m-empty", "m-small")}>
              <strong>{t("shell.noNotifications")}</strong>
              <p>{t("shell.noNotificationsText")}</p>
            </div>
          ) : null}
          <hr className="m-sep" style={{ margin: "6px 0" }} />
          <button className="m-popover-item" onClick={() => { setOpen(false); onNavigate("/inbox"); }}><Inbox size={15} /> {t("shell.openInbox")}</button>
        </div>
      ) : null}
    </div>
  );
}
