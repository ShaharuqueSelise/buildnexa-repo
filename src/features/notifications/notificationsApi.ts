// The signed-in person's notification inbox, from Blocks Notifier (blocksClient.notifier). Reading
// and marking read need blocks-logic::notifier::read and ::manage on the person's role, granted
// INSIDE their company's organization (a grant in "default" alone still gives 403), so company
// onboarding must grant them. Sending is server-only: the rfis Function sends through the
// "cpm-inbox" configuration with the service identity (functions/_shared/blocks.js notify).
// Email on/off lives in NotificationPreference, read and saved through the projects Function.
//
// Payload we send (and read here): denormalizedPayload = JSON
//   { title, body?, link?, projectId?, kind? }   link = an app path, e.g. "/rfis?project=<id>"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { blocksClient } from "../../lib/blocks/client";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";

export type AppNotification = {
  id: string;
  at?: string;
  read: boolean;
  title: string;
  body?: string;
  link?: string;
  kind?: string;
};

const KEY = ["notifications"] as const;
const INBOX_KEY = ["notifications", "inbox"] as const;
const SETTINGS_KEY = ["notification-settings"] as const;

function parsePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : { title: raw };
  } catch {
    return { title: raw };
  }
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

function toNotification(n: Record<string, unknown>): AppNotification {
  const p = parsePayload(n.denormalizedPayload ?? n.payload);
  return {
    id: String(n.id ?? n.itemId ?? n.ItemId ?? ""),
    at: text(n.createdTime) ?? text(n.createdDate) ?? text(n.CreatedDate),
    read: Boolean(n.isRead),
    title: text(p.title) ?? text(n.responseValue) ?? "Notification",
    // Blocks' own notifications (e.g. "New sign-in") use `description`.
    body: text(p.body) ?? text(p.description),
    link: text(p.link)?.startsWith("/") ? text(p.link) : undefined,
    kind: text(p.kind)
  };
}

/** The latest notifications and the unread count; re-read every 30 s and when the tab is focused. */
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    refetchInterval: 30_000,
    queryFn: async () => {
      // Notifier pages start at 0 (page 1 is the second page).
      const res = await blocksClient.notifier.getNotifications({ page: 0, pageSize: 8, sortBy: "createdTime", sortDescending: true });
      return {
        items: (res?.notifications ?? []).map(toNotification).filter((n) => n.id),
        unread: Number(res?.unReadNotificationsCount ?? 0),
        total: Number(res?.totalNotificationsCount ?? 0)
      };
    }
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => blocksClient.notifier.markNotificationAsRead({ id }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY })
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => blocksClient.notifier.markAllNotificationAsRead(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY })
  });
}

/** The Inbox page: up to 100 of the latest notifications, optionally unread only. */
export function useInbox(unreadOnly: boolean) {
  return useQuery({
    queryKey: [...INBOX_KEY, unreadOnly],
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await blocksClient.notifier.getNotifications({ page: 0, pageSize: 100, isUnreadOnly: unreadOnly, sortBy: "createdTime", sortDescending: true });
      return {
        items: (res?.notifications ?? []).map(toNotification).filter((n) => n.id),
        unread: Number(res?.unReadNotificationsCount ?? 0),
        total: Number(res?.totalNotificationsCount ?? 0)
      };
    }
  });
}

export type NotificationSettings = { emailEnabled: boolean };

/** My notification settings (email on or off; the bell is always on). */
export function useNotificationSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => callFunction<NotificationSettings>(FUNCTIONS.projects, { action: "notificationSettings" })
  });
}

export function useSetNotificationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: NotificationSettings) => callFunction<NotificationSettings>(FUNCTIONS.projects, { action: "setNotificationSettings", ...settings }),
    onSuccess: (saved) => queryClient.setQueryData(SETTINGS_KEY, { emailEnabled: saved.emailEnabled })
  });
}
