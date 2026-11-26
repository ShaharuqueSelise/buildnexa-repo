// Inbox (NOT-01 bell + inbox, NOT-03 settings), built from the demo app's InboxPage
// (mock/src/mock/pages/InboxPage.tsx).
// Real now: every notification in the person's Blocks inbox (newest first, grouped by day), all or
// unread, filter by kind, open the record (marks it read), mark one or all read; the email on/off
// setting and the reminder-email setting (RFI Part 4). Not yet: marking unread and selecting several (Blocks Notifier marks read only), the
// per-event matrix, quiet hours, the daily digest (R2), push (R2) and a test email.
import { AlarmClock, Bell, BellOff, CheckCheck, CircleDot, ExternalLink, Info, Mail, MailOpen, Moon, Smartphone, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { todayIso } from "../../lib/workdays";
import { Badge, Button, Empty, Note, PageTitle, Panel, ReleaseTag, Segmented, Select, Tabs, Toasts, Toggle, cx, fmt, useToasts } from "../../shared/m/ui";
import type { Tone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtDate } from "../projects/ProjectsPage";
import type { AppNotification } from "../notifications/notificationsApi";
import { useInbox, useMarkAllRead, useMarkRead, useNotificationSettings, useSetNotificationSettings } from "../notifications/notificationsApi";
import "./Inbox.css";

// The kinds the rfis Function sends (payload `kind`), plus Blocks' own notices (sign-ins, ...).
type Kind = "turn" | "reminder" | "decided" | "info";
const KIND_META: Record<Kind, { label: TranslationKey; icon: ReactNode; tone: Tone }> = {
  turn: { label: "inbox.kind.turn", icon: <CircleDot size={16} />, tone: "purple" },
  reminder: { label: "inbox.kind.reminder", icon: <AlarmClock size={16} />, tone: "red" },
  decided: { label: "inbox.kind.decided", icon: <CheckCheck size={16} />, tone: "green" },
  info: { label: "inbox.kind.info", icon: <Info size={16} />, tone: "gray" }
};
// Reminders: RFIs due soon or overdue, the RFI manager's list of overdue RFIs, and the punch
// list's daily overdue digest (per company, the PM copied).
const REMINDER_KINDS = ["rfi.due", "rfi.overdue", "rfi.digest", "punch.overdue", "punch.digest", "dailyLog.remind", "dailyLog.missing"];
// Work that lands on me: an RFI's ball, new punch items for my company, a fix to check, a fix sent back.
const TURN_KINDS = ["rfi.turn", "punch.assigned", "punch.ready", "punch.rejected"];
const DECIDED_KINDS = ["rfi.decided", "punch.closed"];
const kindOf = (n: AppNotification): Kind =>
  TURN_KINDS.includes(n.kind ?? "") ? "turn" : REMINDER_KINDS.includes(n.kind ?? "") ? "reminder" : DECIDED_KINDS.includes(n.kind ?? "") ? "decided" : "info";

const timeOf = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const dayOf = (iso?: string) => {
  const d = iso ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-CA") : "";
};

type Tab = "inbox" | "settings";

export function InboxPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const { items: toasts, toast } = useToasts();
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get("tab") === "settings" ? "settings" : "inbox"));
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [kind, setKind] = useState("");
  const inbox = useInbox(filter === "unread");
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const all = inbox.data?.items ?? [];
  const unread = inbox.data?.unread ?? 0;
  const list = all.filter((n) => !kind || kindOf(n) === kind);
  const today = todayIso();

  // Group by day, newest first (the inbox already comes sorted).
  const groups: { day: string; items: AppNotification[] }[] = [];
  for (const n of list) {
    const day = dayOf(n.at);
    const g = groups.find((x) => x.day === day);
    if (g) g.items.push(n);
    else groups.push({ day, items: [n] });
  }

  const open = (n: AppNotification) => {
    if (!n.read) markRead.mutate(n.id);
    if (n.link) onNavigate(n.link);
  };

  return (
    <div>
      <PageTitle
        title={t("inbox.title")}
        subtitle={t("inbox.subtitle")}
        actions={tab === "inbox" ? (
          <Button variant="secondary" icon={<CheckCheck size={15} />} disabled={!unread || markAll.isPending} onClick={() => markAll.mutate(undefined, { onSuccess: () => toast(t("inbox.allRead")) })}>
            {t("shell.markAllRead")}
          </Button>
        ) : null}
      />

      <Tabs<Tab> tabs={[{ key: "inbox", label: t("inbox.tab.notifications"), count: unread }, { key: "settings", label: t("inbox.tab.settings") }]} value={tab} onChange={setTab} />

      {tab === "inbox" ? (
        <>
          <div className="m-toolbar">
            <Segmented
              options={[
                { key: "all", label: t("inbox.all") },
                { key: "unread", label: fmt(t("inbox.unread"), { count: unread }) }
              ]}
              value={filter}
              onChange={setFilter}
            />
            <Select value={kind} onChange={setKind} placeholder={t("inbox.allKinds")} options={(Object.keys(KIND_META) as Kind[]).map((k) => ({ value: k, label: t(KIND_META[k].label) }))} />
          </div>

          {inbox.isLoading ? (
            <Panel><div className="m-empty m-small">{t("shell.loading")}</div></Panel>
          ) : inbox.isError ? (
            <Panel><div className="m-empty m-small">{t("shell.notificationsError")}</div></Panel>
          ) : list.length === 0 ? (
            <Panel><Empty icon={<BellOff size={28} />} title={filter === "unread" ? t("inbox.noneUnread") : t("shell.noNotifications")}>{t("inbox.caughtUp")}</Empty></Panel>
          ) : (
            <div className="m-panel m-panel-flush">
              {groups.map((g) => (
                <div key={g.day || "unknown"}>
                  <div className="m-inbox-day">{g.day === today ? t("inbox.today") : g.day ? fmtDate(g.day) : "—"}</div>
                  {g.items.map((n) => {
                    const meta = KIND_META[kindOf(n)];
                    return (
                      <div key={n.id} className={cx("m-inbox-row", !n.read && "m-inbox-unread")}>
                        <span className={`m-inbox-icon m-tone-${meta.tone}`}>{meta.icon}</span>
                        <button className="m-inbox-main" onClick={() => open(n)}>
                          <span className="m-row m-row-wrap" style={{ gap: 6 }}>
                            <b style={{ fontWeight: n.read ? 500 : 700 }}>{n.title}</b>
                            <Badge tone={meta.tone}>{t(meta.label)}</Badge>
                          </span>
                          {n.body ? <span className="m-inbox-body">{n.body}</span> : null}
                          <span className="m-small m-muted">{timeOf(n.at)}</span>
                        </button>
                        <div className="m-inbox-actions">
                          {!n.read ? (
                            <button className="m-icon-btn" title={t("inbox.markRead")} aria-label={t("inbox.markRead")} onClick={() => markRead.mutate(n.id)}><MailOpen size={16} /></button>
                          ) : null}
                          {n.link ? (
                            <button className="m-icon-btn" title={t("inbox.open")} aria-label={t("inbox.open")} onClick={() => open(n)}><ExternalLink size={16} /></button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <p className="m-small m-muted">{t("inbox.footnote")}</p>
        </>
      ) : null}

      {tab === "settings" ? <SettingsTab toast={toast} onNavigate={onNavigate} /> : null}
      <Toasts items={toasts} />
    </div>
  );
}

function SettingsTab({ toast, onNavigate }: { toast: (text: string) => void; onNavigate: (path: string) => void }) {
  const { t } = useT();
  const { project } = useProjects();
  const settings = useNotificationSettings();
  const save = useSetNotificationSettings();
  // While a save runs, show the choice just made (a save can take several seconds).
  const emailOn = save.isPending && save.variables?.emailEnabled !== undefined ? save.variables.emailEnabled : settings.data?.emailEnabled ?? true;
  const remindersOn = save.isPending && save.variables?.reminderEmails !== undefined ? save.variables.reminderEmails : settings.data?.reminderEmails ?? true;

  const setEmail = (v: boolean) =>
    save.mutate({ emailEnabled: v }, {
      onSuccess: () => toast(v ? t("inbox.emailOnSaved") : t("inbox.emailOffSaved")),
      onError: () => toast(t("common.error"))
    });
  const setReminders = (v: boolean) =>
    save.mutate({ reminderEmails: v }, {
      onSuccess: () => toast(v ? t("inbox.remindersOnSaved") : t("inbox.remindersOffSaved")),
      onError: () => toast(t("common.error"))
    });

  const rows: { label: TranslationKey; hint: TranslationKey; email: boolean; on?: boolean }[] = [
    { label: "inbox.event.turn", hint: "inbox.event.turnHint", email: true },
    { label: "inbox.event.reminder", hint: "inbox.event.reminderHint", email: true, on: remindersOn },
    { label: "inbox.event.punchAssigned", hint: "inbox.event.punchAssignedHint", email: true },
    { label: "inbox.event.punchReady", hint: "inbox.event.punchReadyHint", email: true },
    { label: "inbox.event.punchOverdue", hint: "inbox.event.punchOverdueHint", email: true, on: remindersOn },
    { label: "inbox.event.punchClosed", hint: "inbox.event.punchClosedHint", email: false },
    { label: "inbox.event.mine", hint: "inbox.event.mineHint", email: true },
    { label: "inbox.event.list", hint: "inbox.event.listHint", email: false }
  ];

  return (
    <div className="m-grid m-grid-main">
      <Panel title={t("inbox.whatTitle")} className="m-panel-flush">
        <div className="m-table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="m-table">
            <thead>
              <tr>
                <th>{t("inbox.event")}</th>
                <th className="m-inbox-c"><span className="m-row"><Bell size={13} /> {t("inbox.inApp")}</span></th>
                <th className="m-inbox-c"><span className="m-row"><Mail size={13} /> {t("inbox.email")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>
                    <div className="m-inbox-event">
                      <b>{t(r.label)}</b>
                      <span className="m-small m-muted">{t(r.hint)}</span>
                    </div>
                  </td>
                  <td className="m-inbox-c">{t("inbox.always")}</td>
                  <td className="m-inbox-c">{r.email ? (emailOn && r.on !== false ? t("inbox.yes") : t("inbox.off")) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 16px" }}><Note>{t("inbox.matrixLater")}</Note></div>
      </Panel>

      <div>
        <Panel title={<span className="m-row"><Mail size={15} /> {t("inbox.email")}</span>}>
          <div className="m-stack-v">
            {settings.isLoading ? (
              <span className="m-small m-muted">{t("shell.loading")}</span>
            ) : settings.isError ? (
              <span className="m-small m-muted">{t("common.error")}</span>
            ) : (
              <>
                <Toggle checked={emailOn} onChange={(v) => { if (!save.isPending) setEmail(v); }} label={t("inbox.emailToggle")} />
                <Toggle checked={emailOn && remindersOn} disabled={!emailOn} onChange={(v) => { if (!save.isPending) setReminders(v); }} label={t("inbox.remindersToggle")} />
              </>
            )}
            {save.isPending ? <span className="m-small m-muted">{t("inbox.saving")}</span> : null}
            <span className="m-small m-muted">{t("inbox.emailHint")}</span>
            <div className="m-inbox-preview">
              <span className="m-small m-muted">{t("inbox.preview")}</span>
              <b>{fmt(t("inbox.previewTitle"), { number: "RFI-044" })}</b>
              <span className="m-small">{fmt(t("inbox.previewText"), { project: project?.name ?? "" })}</span>
              <span className="m-link m-small">{t("inbox.previewLink")}</span>
            </div>
          </div>
        </Panel>

        <Panel title={<span className="m-row"><AlarmClock size={15} /> {t("inbox.comingTitle")}</span>}>
          <ul className="m-small m-muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            <li className="m-row"><Moon size={13} /> {t("inbox.coming.quiet")}</li>
            <li>{t("inbox.coming.digest")} <ReleaseTag release="R2" /></li>
            <li className="m-row"><Smartphone size={13} /> {t("inbox.coming.push")} <ReleaseTag release="R2" /></li>
          </ul>
        </Panel>

        <Panel title={<span className="m-row"><Users size={15} /> {t("inbox.followingTitle")}</span>}>
          <span className="m-small m-muted">{t("inbox.followingText")}</span>
          <div style={{ marginTop: 8 }}><button className="m-link m-small" onClick={() => onNavigate("/rfis")}>{t("nav.rfis")}</button></div>
        </Panel>
      </div>
    </div>
  );
}
