// Punch list (PRD PUN-01..PUN-05, stories 13-15), built from the demo app's Punch page
// (mock/src/mock/pages/PunchPage.tsx): the list with KPIs, filters and three views (table with bulk
// changes, board with drag and drop, by company), the quick-create form (photo first, ≤ 15 s) and
// the item panel with the status steps, before / after photos, actions, edit, comments and history.
// Every action goes through the punch Function, which decides who may do what; the buttons shown
// here follow its `can` answers. Photos go up through the app's photo queue (features/photos) and
// are linked to the item as before or after photos by the photos Function.
// Pins (part 3): "New punch item here" in the sheet viewer opens the same quick-create form with the
// spot (PunchHereDialog; the photo is optional then); the item panel shows where it is pinned, with a
// preview of the sheet, and opens the sheet on that pin.
// Not real yet: the bell and emails for punch changes and the overdue digest (Part 4), walkthrough
// mode, the punch report PDF and offline capture (R2).
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle, Camera, CheckCircle2, ClipboardCheck, Download, FileText, ImageOff, Kanban, Loader2, Lock, MapPin, MessageSquare, Pencil,
  Play, Plus, RefreshCw, RotateCcw, Table2, Timer, Upload, UserRoundCog, Users, XCircle
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FUNCTIONS } from "../../lib/blocks/functions";
import { addDays, todayIso } from "../../lib/workdays";
import {
  Badge, Button, Checkbox, CompanyChip, Dialog, Drawer, Empty, Field, KeyValue, Kpi, Note, PageTitle, Panel, ReleaseTag, SearchInput, Segmented,
  Select, Timeline, Toasts, Toggle, colorFor, cx, downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import type { Tone, ToastTone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtDate } from "../projects/ProjectsPage";
import { DueLabel } from "../rfis/RfisPage";
import { photoRefusal, retryPhoto } from "../photos/photosApi";
import {
  BULK_MAX, PUNCH_ACTIVE, PUNCH_STATUSES, addPunchPhoto, createPunch, dropCreate, refusalText, retryCreate, runBulk, usePendingCreates, usePunchAction,
  usePunchItem, usePunchList, usePunchPhotoQueue
} from "./punchApi";
import type { PendingCreate, PunchBulkOp, PunchDetail, PunchInput, PunchList, PunchPhoto, PunchPin, PunchPriority, PunchRow, PunchStatus } from "./punchApi";
import "./PunchPage.css";

type Nav = { onNavigate: (path: string) => void; params?: string[] };
type T = (key: TranslationKey) => string;

const STATUS_TONE: Record<PunchStatus, Tone> = { open: "blue", inProgress: "amber", readyForReview: "purple", closed: "green", void: "gray" };
const PRIORITY_TONE: Record<PunchPriority, Tone> = { low: "gray", normal: "blue", high: "red" };
const PRIORITIES: PunchPriority[] = ["high", "normal", "low"];
const STEPS: PunchStatus[] = ["open", "inProgress", "readyForReview", "closed"];

const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const isActive = (s: PunchStatus) => PUNCH_ACTIVE.includes(s);

type Ctx = {
  t: T;
  projectId: string;
  projectNumber: string;
  myUserId: string;
  today: string;
  toast: (text: string, tone?: ToastTone) => void;
  onNavigate: (path: string) => void;
};

export function StatusPill({ status, t }: { status: PunchStatus; t: T }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{t(`punch.status.${status}` as TranslationKey)}</Badge>;
}

function PriorityPill({ priority, t }: { priority: PunchPriority; t: T }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? "gray"}>{t(`punch.priority.${priority}` as TranslationKey)}</Badge>;
}

/** The sheet viewer on this item's pin. */
const sheetLink = (p: { sheetId?: string; pinId?: string }) => `/drawings/${encodeURIComponent(p.sheetId ?? "")}${p.pinId ? `?pin=${encodeURIComponent(p.pinId)}` : ""}`;

function Thumb({ url, size = 44, state }: { url?: string; size?: number; state?: "uploading" | "failed" | "missing" | "pin" }) {
  if (url) return <img className="m-punch-thumb" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} loading="lazy" />;
  const icon = state === "uploading" ? <Loader2 size={16} className="spin" /> : state === "failed" || state === "missing" ? <ImageOff size={16} /> : state === "pin" ? <MapPin size={16} /> : <Camera size={16} />;
  return <span className={cx("m-punch-thumb m-punch-thumb-empty", (state === "failed" || state === "missing") && "m-punch-thumb-warn")} style={{ width: size, height: size }}>{icon}</span>;
}

export function PunchPage({ onNavigate, params = [] }: Nav) {
  const { t } = useT();
  const { query, ws, project, myUserId } = useProjects();
  const { items: toasts, toast } = useToasts();
  const today = todayIso();

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("punch.title")} />
        <Panel><Empty icon={<ClipboardCheck size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }
  if (!FUNCTIONS.punch) {
    return (
      <div>
        <PageTitle title={t("punch.title")} />
        <Note tone="warn">{t("punch.notDeployed")}</Note>
      </div>
    );
  }

  const ctx: Ctx = { t, projectId: project.ItemId, projectNumber: project.number, myUserId, today, toast, onNavigate };
  return (
    <div>
      <PunchListView ctx={ctx} openId={params[0]} />
      <Toasts items={toasts} />
    </div>
  );
}

// ---------- list ----------
type View = "table" | "board" | "company";
type StatusFilter = "" | "active" | PunchStatus;
type SortKey = "newest" | "due" | "priority";

function PunchListView({ ctx, openId }: { ctx: Ctx; openId?: string }) {
  const { t, projectId, myUserId, onNavigate } = ctx;
  const list = usePunchList(projectId);
  const pending = usePendingCreates(projectId);
  const photoQueue = usePunchPhotoQueue(projectId);
  const search = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>("table");
  const [status, setStatus] = useState<StatusFilter>("active");
  // The company's notices (new items, overdue digest) link here with ?company=<id>.
  const [company, setCompany] = useState(() => search.get("company") ?? "");
  const [location, setLocation] = useState("");
  const [priority, setPriority] = useState("");
  const [ball, setBall] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(() => search.get("overdue") === "1");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [quickOpen, setQuickOpen] = useState(() => search.get("new") === "1");

  const data = list.data;
  const today = data?.today ?? ctx.today;
  const items = useMemo(() => data?.items ?? [], [data]);
  const manage = data?.can.bulk ?? false;
  const seesAll = data?.can.seesAllCompanies ?? true;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank: Record<PunchPriority, number> = { high: 0, normal: 1, low: 2 };
    const out = items.filter((p) =>
      (status === "" || (status === "active" ? isActive(p.status) : p.status === status)) &&
      (!company || p.assigneeCompanyId === company) &&
      (!location || p.location === location) &&
      (!priority || p.priority === priority) &&
      (!ball || p.ballInCourtUserId === ball) &&
      (!overdueOnly || p.overdue) &&
      (!mine || p.createdByUserId === myUserId || p.assigneeUserId === myUserId || p.ballInCourtUserId === myUserId) &&
      (!needle || `${p.number} ${p.title} ${p.location ?? ""} ${p.assigneeCompanyName ?? ""} ${p.assigneeName ?? ""} ${p.description ?? ""}`.toLowerCase().includes(needle))
    );
    if (sort === "due") out.sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
    else if (sort === "priority") out.sort((a, b) => rank[a.priority] - rank[b.priority] || Number(b.seq ?? 0) - Number(a.seq ?? 0));
    else out.sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0));
    return out;
  }, [items, status, company, location, priority, ball, overdueOnly, mine, q, sort, myUserId]);

  const count = (s: PunchStatus) => items.filter((p) => p.status === s).length;
  const weekAgo = addDays(today, -6);
  const closedWeek = items.filter((p) => p.status === "closed" && String(p.closedAt ?? "").slice(0, 10) >= weekAgo).length;
  const overdueCount = items.filter((p) => p.overdue).length;

  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of items) if (p.assigneeCompanyId) m.set(p.assigneeCompanyId, p.assigneeCompanyName ?? "");
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);
  const locations = useMemo(() => [...new Set(items.map((p) => p.location).filter((x): x is string => Boolean(x)))].sort(), [items]);
  const balls = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of items) if (p.ballInCourtUserId && isActive(p.status)) m.set(p.ballInCourtUserId, p.ballInCourtName ?? "");
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  const reset = () => { setStatus(""); setCompany(""); setLocation(""); setPriority(""); setBall(""); setOverdueOnly(false); setMine(false); setQ(""); };
  const kpiFilter = (s: StatusFilter, over = false) => { reset(); setStatus(s); setOverdueOnly(over); };
  const filtersOn = status !== "active" || company || location || priority || ball || overdueOnly || mine || q;

  const exportCsv = () => {
    const headers = ["Number", "Title", "Status", "Priority", "Location", "Company", "Assignee", "Ball in court", "Due date", "Overdue", "Created on", "Created by", "Before photos", "After photos", "Times sent back"];
    downloadCsv(`${ctx.projectNumber || "project"}-punch-list-${today}.csv`, filtered.map((p) => ({
      number: p.number,
      title: p.title,
      status: t(`punch.status.${p.status}` as TranslationKey),
      priority: t(`punch.priority.${p.priority}` as TranslationKey),
      location: p.location ?? "",
      company: p.assigneeCompanyName ?? "",
      assignee: p.assigneeName ?? "",
      ball: isActive(p.status) ? p.ballInCourtName ?? "" : "",
      due: p.dueDate ?? "",
      overdue: p.overdue ? "yes" : "",
      created: String(p.createdAt ?? "").slice(0, 10),
      createdBy: p.createdByName ?? "",
      before: p.beforePhotos,
      after: p.afterPhotos,
      reopened: p.reopenCount || ""
    })), headers);
    ctx.toast(fmt(t("punch.csvDone"), { count: filtered.length }));
  };

  const closeQuick = () => {
    setQuickOpen(false);
    if (new URLSearchParams(window.location.search).get("new") === "1") onNavigate("/punch");
  };

  const createWhy = data && !data.can.create ? (data.archived ? t("punch.archived") : t("punch.createWhy")) : undefined;

  return (
    <>
      <PageTitle
        title={t("punch.title")}
        subtitle={seesAll ? t("punch.subtitle") : t("punch.subtitleSub")}
        actions={
          <>
            <Button variant="secondary" icon={<FileText size={15} />} disabled title={t("punch.reportLater")}>{t("punch.report")} <ReleaseTag release="R2" /></Button>
            <Button variant="secondary" icon={<Download size={15} />} onClick={exportCsv} disabled={!filtered.length}>{t("coadmin.exportCsv")}</Button>
            <Button icon={<Plus size={15} />} onClick={() => setQuickOpen(true)} disabled={!data?.can.create} title={createWhy ?? t("punch.quickHint")}>{t("punch.new")}</Button>
          </>
        }
      />

      {list.error ? <div style={{ marginBottom: 12 }}><Note tone="danger">{refusalText(list.error, t("common.error"))}</Note></div> : null}
      {data?.archived ? <div style={{ marginBottom: 12 }}><Note tone="warn">{t("punch.archived")}</Note></div> : null}

      <div className="m-kpis">
        <Kpi label={t("punch.status.open")} value={count("open")} tone="blue" onClick={() => kpiFilter("open")} />
        <Kpi label={t("punch.status.inProgress")} value={count("inProgress")} tone="amber" onClick={() => kpiFilter("inProgress")} />
        <Kpi label={t("punch.status.readyForReview")} value={count("readyForReview")} hint={manage ? t("punch.kpi.readyHintGc") : t("punch.kpi.readyHint")} onClick={() => kpiFilter("readyForReview")} />
        <Kpi label={t("punch.kpi.overdue")} value={overdueCount} tone={overdueCount ? "red" : "green"} hint={t("punch.kpi.overdueHint")} onClick={() => kpiFilter("active", true)} />
        <Kpi label={t("punch.kpi.closedWeek")} value={closedWeek} tone="green" hint={t("punch.kpi.closedWeekHint")} onClick={() => kpiFilter("closed")} />
      </div>

      <Panel>
        <div className="m-toolbar" style={{ justifyContent: "space-between" }}>
          <div className="m-row m-row-wrap">
            <SearchInput value={q} onChange={setQ} placeholder={t("punch.search")} />
            <Segmented<View>
              value={view}
              onChange={setView}
              options={[
                { key: "table", label: <span className="m-row" style={{ gap: 5 }}><Table2 size={14} />{t("punch.view.table")}</span> },
                { key: "board", label: <span className="m-row" style={{ gap: 5 }}><Kanban size={14} />{t("punch.view.board")}</span> },
                { key: "company", label: <span className="m-row" style={{ gap: 5 }}><Users size={14} />{t("punch.view.company")}</span> }
              ]}
            />
          </div>
          <span className="m-small m-muted">{fmt(t("punch.shown"), { count: filtered.length, total: items.length })}</span>
        </div>
        <div className="m-punch-filters">
          <Select
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[{ value: "", label: t("punch.allStatuses") }, { value: "active", label: t("punch.activeOnly") }, ...PUNCH_STATUSES.map((s) => ({ value: s, label: t(`punch.status.${s}` as TranslationKey) }))]}
          />
          {seesAll ? <Select value={company} onChange={setCompany} placeholder={t("punch.allCompanies")} options={companies} /> : null}
          <Select value={location} onChange={setLocation} placeholder={t("punch.allLocations")} options={locations} />
          <Select value={priority} onChange={setPriority} placeholder={t("punch.anyPriority")} options={PRIORITIES.map((p) => ({ value: p, label: t(`punch.priority.${p}` as TranslationKey) }))} />
          <Select value={ball} onChange={setBall} placeholder={t("punch.anyBall")} options={balls} />
          <Select
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={[{ value: "newest", label: t("punch.sort.newest") }, { value: "due", label: t("punch.sort.due") }, { value: "priority", label: t("punch.sort.priority") }]}
          />
          <Toggle checked={overdueOnly} onChange={setOverdueOnly} label={t("punch.overdueOnly")} />
          <Toggle checked={mine} onChange={setMine} label={t("punch.mine")} />
          {filtersOn ? <Button small variant="ghost" onClick={() => { reset(); setStatus("active"); }}>{t("rfi.clearFilters")}</Button> : null}
        </div>
      </Panel>

      {pending.length ? <PendingRows ctx={ctx} pending={pending} /> : null}

      {list.isLoading ? (
        <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>
      ) : !filtered.length ? (
        <Panel>
          <Empty icon={<ClipboardCheck size={28} />} title={items.length ? t("punch.noMatch") : t("punch.none")}>
            {items.length ? t("punch.noMatchText") : data?.can.create ? t("punch.noneText") : t("punch.noneReadOnly")}
          </Empty>
        </Panel>
      ) : view === "table" ? (
        <TableView ctx={ctx} items={filtered} data={data!} photoQueue={photoQueue} />
      ) : view === "board" ? (
        <BoardView ctx={ctx} items={filtered} photoQueue={photoQueue} />
      ) : (
        <CompanyView ctx={ctx} items={filtered} onFilter={(cid) => { setCompany(cid); setView("table"); }} />
      )}

      {openId ? <PunchDrawer ctx={ctx} itemId={openId} list={data} photoQueue={photoQueue} onClose={() => onNavigate("/punch")} /> : null}
      {quickOpen && data ? <QuickCreate ctx={ctx} data={data} onClose={closeQuick} /> : null}
    </>
  );
}

// Items still being sent (quick create saves in the background).
function PendingRows({ ctx, pending }: { ctx: Ctx; pending: PendingCreate[] }) {
  const { t } = ctx;
  const queryClient = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="m-punch-pending">
      {pending.map((p) => (
        <div key={p.clientRequestId} className={cx("m-punch-pending-row", p.state === "failed" && "m-punch-pending-failed")}>
          <Thumb url={p.localUrl} size={40} state={p.file ? undefined : "missing"} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="m-strong">{p.input.title}</div>
            <div className="m-small m-muted">{p.companyName}{p.input.location ? ` · ${p.input.location}` : ""}</div>
            {p.state === "failed" ? <div className="m-small m-due-over">{p.error}</div> : null}
          </div>
          {p.state === "sending" ? (
            <span className="m-small m-muted m-row" style={{ gap: 6 }}><Loader2 size={14} className="spin" />{fmt(t("punch.sending"), { secs: Math.round((Date.now() - p.startedAt) / 1000) })}</span>
          ) : (
            <span className="m-row">
              <Button small icon={<RefreshCw size={13} />} onClick={() => void retryCreate(queryClient, p.clientRequestId)}>{t("punch.retry")}</Button>
              <Button small variant="ghost" onClick={() => dropCreate(p.clientRequestId)}>{t("punch.discard")}</Button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

type PhotoQueueState = ReturnType<typeof usePunchPhotoQueue>;

// What the row's picture shows: the photo, or why there is none (still going up, failed, missing, a pin).
function rowThumb(p: PunchRow, queue: PhotoQueueState): { url?: string; state?: "uploading" | "failed" | "missing" | "pin" } {
  const q = queue.get(p.ItemId);
  if (p.beforeThumbUrl) return { url: p.beforeThumbUrl };
  if (q?.uploading && q.before) return { state: "uploading" };
  if (q?.failed.length) return { state: "failed" };
  if (p.photoMissing) return { state: "missing" };
  if (p.pinId) return { state: "pin" };
  return {};
}

// ---------- table + bulk changes ----------
function TableView({ ctx, items, data, photoQueue }: { ctx: Ctx; items: PunchRow[]; data: PunchList; photoQueue: PhotoQueueState }) {
  const { t, projectId, today, onNavigate } = ctx;
  const queryClient = useQueryClient();
  const action = usePunchAction(projectId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCompany, setBulkCompany] = useState("");
  const [bulkOp, setBulkOp] = useState("");
  const [bulkDue, setBulkDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<null | { kind: "void" | "sendBack"; ids: string[]; number: string }>(null);
  const manage = data.can.bulk;
  const sel = items.filter((p) => selected.has(p.ItemId));
  const pickable = items.filter((p) => isActive(p.status)).slice(0, BULK_MAX);
  const allOn = pickable.length > 0 && pickable.every((p) => selected.has(p.ItemId));

  // Drop selected items that left the list (filtered out, closed by someone, …).
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((id) => items.some((p) => p.ItemId === id && isActive(p.status))));
      return keep.size === s.size ? s : keep;
    });
  }, [items]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) {
      if (next.size >= BULK_MAX) { ctx.toast(fmt(t("punch.bulkMax"), { count: BULK_MAX }), "warn"); return; }
      next.add(id);
    } else next.delete(id);
    setSelected(next);
  };

  const bulk = async (op: PunchBulkOp, extra: { assigneeCompanyId?: string; dueDate?: string; reason?: string } = {}) => {
    const ids = sel.map((p) => p.ItemId);
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await runBulk(queryClient, projectId, op, ids, extra);
      const first = r.rejected[0];
      ctx.toast(
        r.rejected.length
          ? fmt(t("punch.bulkPartly"), { done: r.updated.length, skipped: r.rejected.length, why: `${first?.number ? `${first.number}: ` : ""}${first?.error ?? ""}` })
          : fmt(t("punch.bulkDone"), { count: r.updated.length }),
        r.rejected.length ? "warn" : "good"
      );
      setSelected(new Set());
      setBulkCompany(""); setBulkOp(""); setBulkDue("");
    } catch (e) {
      ctx.toast(refusalText(e, t("common.error")), "warn");
    } finally {
      setBusy(false);
    }
  };

  const one = async (body: Parameters<typeof action.mutateAsync>[0], ok: string) => {
    try {
      await action.mutateAsync(body);
      ctx.toast(ok);
    } catch (e) {
      ctx.toast(refusalText(e, t("common.error")), "warn");
    }
  };

  return (
    <>
      {manage && sel.length ? (
        <div className="m-punch-bulk">
          <b>{fmt(t("punch.selected"), { count: sel.length })}</b>
          <span className="m-small">{fmt(t("punch.bulkNote"), { count: BULK_MAX })}</span>
          <select className="m-input" value={bulkCompany} onChange={(e) => setBulkCompany(e.target.value)} disabled={busy}>
            <option value="">{t("punch.assignTo")}</option>
            {data.companies.map((c) => <option key={c.companyId} value={c.companyId}>{c.companyName}{c.trade ? ` · ${c.trade}` : ""}</option>)}
          </select>
          <Button small onClick={() => void bulk("reassign", { assigneeCompanyId: bulkCompany })} disabled={!bulkCompany || busy}>{t("punch.assign")}</Button>
          <select className="m-input" value={bulkOp} onChange={(e) => setBulkOp(e.target.value)} disabled={busy}>
            <option value="">{t("punch.changeStatus")}</option>
            <option value="start">{t("punch.action.start")}</option>
            <option value="markReady">{t("punch.action.markReady")}</option>
            <option value="close">{t("punch.action.close")}</option>
            {data.can.void ? <option value="void">{t("punch.action.void")}</option> : null}
          </select>
          <Button
            small
            disabled={!bulkOp || busy}
            onClick={() => (bulkOp === "void" ? setReason({ kind: "void", ids: sel.map((p) => p.ItemId), number: fmt(t("punch.nItems"), { count: sel.length }) }) : void bulk(bulkOp as PunchBulkOp))}
          >
            {t("punch.apply")}
          </Button>
          <input className="m-input" type="date" value={bulkDue} min={today} onChange={(e) => setBulkDue(e.target.value)} aria-label={t("punch.newDue")} disabled={busy} />
          <Button small onClick={() => void bulk("setDue", { dueDate: bulkDue })} disabled={!bulkDue || busy}>{t("punch.setDue")}</Button>
          {busy ? <Loader2 size={16} className="spin" /> : <Button small variant="ghost" onClick={() => setSelected(new Set())}>{t("punch.clearSelection")}</Button>}
        </div>
      ) : null}
      <div className="m-table-wrap m-punch-table">
        <table className="m-table">
          <thead>
            <tr>
              {manage ? <th style={{ width: 36 }}><Checkbox checked={allOn} onChange={(on) => setSelected(on ? new Set(pickable.map((p) => p.ItemId)) : new Set())} /></th> : null}
              <th>#</th>
              <th>{t("punch.col.item")}</th>
              <th className="m-hide-mobile">{t("punch.location")}</th>
              <th className="m-hide-mobile">{t("punch.company")}</th>
              <th className="m-hide-mobile">{t("punch.priority")}</th>
              <th>{t("punch.col.status")}</th>
              <th>{t("punch.col.due")}</th>
              <th className="m-hide-mobile" />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const thumb = rowThumb(p, photoQueue);
              return (
                <tr key={p.ItemId} className={cx("m-clickable", selected.has(p.ItemId) && "m-selected")} onClick={() => onNavigate(`/punch/${p.ItemId}`)}>
                  {manage ? <td onClick={(e) => e.stopPropagation()}>{isActive(p.status) ? <Checkbox checked={selected.has(p.ItemId)} onChange={(on) => toggle(p.ItemId, on)} /> : null}</td> : null}
                  <td className="m-mono m-strong">{p.number}</td>
                  <td>
                    <div className="m-punch-title">
                      <Thumb url={thumb.url} state={thumb.state} />
                      <div style={{ minWidth: 0 }}>
                        <div className="m-strong">{p.title}</div>
                        <div className="m-small m-muted">
                          {p.assigneeName || p.assigneeCompanyName}
                          {p.afterPhotos ? ` · ${t("punch.afterPhotoTick")}` : ""}
                          {p.reopenCount ? ` · ${fmt(t("punch.sentBackN"), { count: p.reopenCount })}` : ""}
                          {thumb.state === "missing" || thumb.state === "failed" ? <span className="m-due-over"> · {t("punch.photoMissing")}</span> : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="m-small m-hide-mobile">{p.location || <span className="m-muted">—</span>}</td>
                  <td className="m-hide-mobile">{p.assigneeCompanyName ? <CompanyChip name={p.assigneeCompanyName} color={colorFor(p.assigneeCompanyId)} /> : null}</td>
                  <td className="m-hide-mobile"><PriorityPill priority={p.priority} t={t} /></td>
                  <td><StatusPill status={p.status} t={t} /></td>
                  <td><DueLabel due={p.dueDate} done={!isActive(p.status)} today={today} t={t} /></td>
                  <td className="m-hide-mobile" onClick={(e) => e.stopPropagation()}>
                    <div className="m-row">
                      {p.sheetId ? <button className="m-icon-btn" title={p.sheetNumber ? `${t("punch.openSheet")} · ${p.sheetNumber}` : t("punch.openSheet")} onClick={() => onNavigate(sheetLink(p))}><MapPin size={15} /></button> : null}
                      {manage && p.status === "readyForReview" ? (
                        <>
                          <Button small variant="success" disabled={action.isPending} onClick={() => void one({ action: "close", itemId: p.ItemId }, fmt(t("punch.closedToast"), { number: p.number }))}>{t("punch.action.close")}</Button>
                          <Button small variant="ghost" onClick={() => setReason({ kind: "sendBack", ids: [p.ItemId], number: p.number })}>{t("punch.action.sendBack")}</Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {reason ? (
        <ReasonDialog
          t={t}
          kind={reason.kind}
          number={reason.number}
          busy={busy || action.isPending}
          onClose={() => setReason(null)}
          onSave={(why) => {
            const r = reason;
            setReason(null);
            if (r.kind === "void" && r.ids.length > 1) void bulk("void", { reason: why });
            else if (r.kind === "void") void one({ action: "void", itemId: r.ids[0]!, reason: why }, fmt(t("punch.voidedToast"), { number: r.number }));
            else void one({ action: "sendBack", itemId: r.ids[0]!, reason: why }, fmt(t("punch.sentBackToast"), { number: r.number }));
          }}
        />
      ) : null}
    </>
  );
}

// ---------- board ----------
// Moving a card is the same action as the button in the item panel; the Function checks it.
function moveOf(from: PunchStatus, to: PunchStatus): { op: "start" | "markReady" | "close" | "sendBack" | "reopen" | "void" } | { why: TranslationKey } {
  if (from === to) return { why: "punch.move.same" };
  if (from === "void") return { why: "punch.move.void" };
  if (to === "void") return isActive(from) ? { op: "void" } : { why: "punch.move.notActive" };
  if (to === "closed") return isActive(from) ? { op: "close" } : { why: "punch.move.notActive" };
  if (to === "readyForReview") return from === "open" || from === "inProgress" ? { op: "markReady" } : { why: "punch.move.notThere" };
  if (to === "inProgress") {
    if (from === "open") return { op: "start" };
    if (from === "readyForReview") return { op: "sendBack" };
    if (from === "closed") return { op: "reopen" };
  }
  return { why: "punch.move.notThere" };
}

function BoardView({ ctx, items, photoQueue }: { ctx: Ctx; items: PunchRow[]; photoQueue: PhotoQueueState }) {
  const { t, projectId, today, onNavigate } = ctx;
  const action = usePunchAction(projectId);
  const [over, setOver] = useState<PunchStatus | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<null | { kind: "void" | "sendBack" | "reopen"; item: PunchRow }>(null);

  const run = async (item: PunchRow, op: "start" | "markReady" | "close" | "sendBack" | "reopen" | "void", why?: string) => {
    setBusy((s) => new Set(s).add(item.ItemId));
    try {
      const body = op === "sendBack" || op === "reopen" || op === "void" ? { action: op, itemId: item.ItemId, reason: why ?? "" } : { action: op, itemId: item.ItemId };
      const d = await action.mutateAsync(body);
      ctx.toast(`${item.number} → ${t(`punch.status.${d.item.status}` as TranslationKey)}`);
    } catch (e) {
      ctx.toast(`${item.number}: ${refusalText(e, t("common.error"))}`, "warn");
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(item.ItemId);
        return n;
      });
    }
  };

  const onDrop = (e: DragEvent, to: PunchStatus) => {
    e.preventDefault();
    setOver(null);
    const item = items.find((p) => p.ItemId === e.dataTransfer.getData("text/plain"));
    if (!item || busy.has(item.ItemId)) return;
    const m = moveOf(item.status, to);
    if ("why" in m) {
      if (item.status !== to) ctx.toast(`${item.number}: ${t(m.why)}`, "warn");
      return;
    }
    if (m.op === "void" || m.op === "sendBack" || m.op === "reopen") setReason({ kind: m.op, item });
    else void run(item, m.op);
  };

  return (
    <>
      <div className="m-kanban">
        {PUNCH_STATUSES.map((s) => {
          const col = items.filter((p) => p.status === s);
          return (
            <div
              key={s}
              className={cx("m-kanban-col", over === s && "m-punch-col-over")}
              onDragOver={(e) => { e.preventDefault(); setOver(s); }}
              onDragLeave={() => setOver((o) => (o === s ? null : o))}
              onDrop={(e) => onDrop(e, s)}
            >
              <h4><StatusPill status={s} t={t} /><span className="m-muted m-small">{col.length}</span></h4>
              <div className="m-kanban-list">
                {col.slice(0, 60).map((p) => (
                  <button
                    key={p.ItemId}
                    type="button"
                    className={cx("m-kanban-card", busy.has(p.ItemId) && "m-punch-card-busy")}
                    draggable={!busy.has(p.ItemId)}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", p.ItemId)}
                    onClick={() => onNavigate(`/punch/${p.ItemId}`)}
                  >
                    <div className="m-row" style={{ justifyContent: "space-between" }}>
                      <span className="m-mono m-muted">{p.number}</span>
                      {busy.has(p.ItemId) ? <Loader2 size={14} className="spin" /> : <PriorityPill priority={p.priority} t={t} />}
                    </div>
                    <div className="m-row" style={{ alignItems: "flex-start" }}>
                      <Thumb url={p.beforeThumbUrl} size={48} state={rowThumb(p, photoQueue).state} />
                      <span className="m-strong">{p.title}</span>
                    </div>
                    <div className="m-punch-card-meta">
                      {p.assigneeCompanyName ? <CompanyChip name={p.assigneeCompanyName} color={colorFor(p.assigneeCompanyId)} /> : <span />}
                      <DueLabel due={p.dueDate} done={!isActive(p.status)} today={today} t={t} />
                    </div>
                    {p.location ? <span className="m-small m-muted">{p.location}</span> : null}
                  </button>
                ))}
                {col.length > 60 ? <span className="m-small m-muted">{fmt(t("punch.boardMore"), { count: col.length - 60 })}</span> : null}
                {!col.length ? <span className="m-small m-muted" style={{ padding: 8 }}>{t("punch.dropHere")}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      {reason ? (
        <ReasonDialog
          t={t}
          kind={reason.kind}
          number={reason.item.number}
          busy={false}
          onClose={() => setReason(null)}
          onSave={(why) => {
            const r = reason;
            setReason(null);
            void run(r.item, r.kind, why);
          }}
        />
      ) : null}
    </>
  );
}

// ---------- by company ----------
function CompanyView({ ctx, items, onFilter }: { ctx: Ctx; items: PunchRow[]; onFilter: (companyId: string) => void }) {
  const { t } = ctx;
  const rows = useMemo(() => {
    const ids = [...new Set(items.map((p) => p.assigneeCompanyId))];
    return ids.map((cid) => {
      const mine = items.filter((p) => p.assigneeCompanyId === cid);
      return {
        cid,
        name: mine[0]?.assigneeCompanyName || "—",
        open: mine.filter((p) => p.status === "open").length,
        prog: mine.filter((p) => p.status === "inProgress").length,
        ready: mine.filter((p) => p.status === "readyForReview").length,
        closed: mine.filter((p) => p.status === "closed").length,
        overdue: mine.filter((p) => p.overdue).length,
        total: mine.length
      };
    }).sort((a, b) => b.open + b.prog + b.ready - (a.open + a.prog + a.ready) || a.name.localeCompare(b.name));
  }, [items]);
  const max = Math.max(1, ...rows.map((r) => r.open + r.prog + r.ready));
  const maxOver = Math.max(1, ...rows.map((r) => r.overdue));
  return (
    <div className="m-grid m-grid-main">
      <div className="m-table-wrap">
        <table className="m-table">
          <thead>
            <tr>
              <th>{t("punch.company")}</th>
              <th className="m-num">{t("punch.status.open")}</th>
              <th className="m-num">{t("punch.status.inProgress")}</th>
              <th className="m-num">{t("punch.readyShort")}</th>
              <th className="m-num">{t("punch.kpi.overdue")}</th>
              <th className="m-num m-hide-mobile">{t("punch.status.closed")}</th>
              <th className="m-num">{t("punch.total")}</th>
              <th className="m-hide-mobile" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cid} className="m-clickable" onClick={() => onFilter(r.cid)}>
                <td><CompanyChip name={r.name} color={colorFor(r.cid)} /></td>
                <td className="m-num">{r.open}</td>
                <td className="m-num">{r.prog}</td>
                <td className="m-num">{r.ready}</td>
                <td className="m-num">{r.overdue ? <span className="m-due-over">{r.overdue}</span> : 0}</td>
                <td className="m-num m-hide-mobile">{r.closed}</td>
                <td className="m-num m-strong">{r.total}</td>
                <td className="m-hide-mobile" onClick={(e) => e.stopPropagation()}>
                  <Button small variant="ghost" icon={<FileText size={14} />} disabled title={t("punch.reportLater")}>PDF <ReleaseTag release="R2" /></Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Panel title={t("punch.openByCompany")}>
        <div className="m-punch-bars">
          {rows.map((r) => (
            <button key={r.cid} type="button" onClick={() => onFilter(r.cid)}>
              <span>{r.name}</span>
              <span className="m-punch-bar"><i style={{ width: `${((r.open + r.prog + r.ready) / max) * 100}%`, background: colorFor(r.cid) }} /></span>
              <b>{r.open + r.prog + r.ready}</b>
            </button>
          ))}
        </div>
        {rows.some((r) => r.overdue) ? (
          <>
            <hr className="m-sep" />
            <h4 className="m-small m-muted" style={{ margin: "0 0 8px" }}>{t("punch.overdueByCompany")}</h4>
            <div className="m-punch-bars">
              {rows.filter((r) => r.overdue).map((r) => (
                <button key={r.cid} type="button" onClick={() => onFilter(r.cid)}>
                  <span>{r.name}</span>
                  <span className="m-punch-bar"><i style={{ width: `${(r.overdue / maxOver) * 100}%`, background: "hsl(var(--m-red-fg))" }} /></span>
                  <b>{r.overdue}</b>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </Panel>
    </div>
  );
}

// ---------- quick create ----------
type PinSpot = NonNullable<PunchInput["pin"]> & { label: string };

function QuickCreate({ ctx, data, onClose, pin, onSaving }: {
  ctx: Ctx; data: PunchList; onClose: () => void;
  /** From the sheet viewer: the item is pinned there, so the photo is optional. */
  pin?: PinSpot;
  onSaving?: (saving: Promise<PunchDetail>, title: string) => void;
}) {
  const { t, projectId, today } = ctx;
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | undefined>();
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState(() => (data.companies.some((c) => c.companyId === data.suggestions.lastCompanyId) ? data.suggestions.lastCompanyId : ""));
  const [personId, setPersonId] = useState("");
  const [location, setLocation] = useState("");
  const [priority, setPriority] = useState<PunchPriority>("normal");
  const [due, setDue] = useState(data.defaultDueDate);
  const [description, setDescription] = useState("");
  const [startedAt] = useState(() => Date.now());
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const company = data.companies.find((c) => c.companyId === companyId);
  const titleOk = title.trim().length >= 3;
  const valid = Boolean(file || pin) && titleOk && Boolean(company);
  const missing = !file && !pin ? t("punch.needPhoto") : !titleOk ? t("punch.needTitle") : !company ? t("punch.needCompany") : "";

  const pick = (f?: File) => {
    if (!f) return;
    const why = photoRefusal(f);
    if (why) { ctx.toast(t(why === "type" ? "punch.notAPhoto" : why === "size" ? "punch.photoTooBig" : "punch.photoEmpty"), "warn"); return; }
    setFile(f);
    setPreview(/^image\/(jpeg|png|webp)$/.test(f.type) ? URL.createObjectURL(f) : undefined);
  };

  const save = () => {
    if (!valid || !company) return;
    const input: PunchInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      location: location.trim() || undefined,
      dueDate: due || undefined,
      assigneeCompanyId: company.companyId,
      assigneeUserId: personId || undefined,
      pin: pin ? { sheetId: pin.sheetId, revisionIndex: pin.revisionIndex, x: pin.x, y: pin.y } : undefined
    };
    const saving = createPunch(queryClient, projectId, input, company.companyName, file ?? undefined);
    onSaving?.(saving, input.title);
    saving
      .then((d) => ctx.toast(fmt(t("punch.savedToast"), { number: d.item.number, company: d.item.assigneeCompanyName ?? "" })))
      .catch((e) => ctx.toast(refusalText(e, t("punch.sendFailed")), "warn"));
    ctx.toast(fmt(t("punch.savingToast"), { secs }));
    onClose();
  };

  return (
    <Dialog
      size="md"
      title={<>{t("punch.new")} <Badge tone={secs <= 15 ? "green" : "amber"}><Timer size={12} /> <span className="m-punch-timer">{secs} s</span></Badge></>}
      onClose={onClose}
      footer={
        <>
          {missing ? <span className="m-small m-muted" style={{ marginRight: "auto" }}>{missing}</span> : null}
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="secondary" disabled title={t("punch.walkLater")}>{t("punch.saveNext")} <ReleaseTag release="R2" /></Button>
          <Button onClick={save} disabled={!valid}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="m-stack-v">
        {pin ? <Note tone="info"><MapPin size={13} style={{ display: "inline", verticalAlign: -2 }} /> {pin.label}</Note> : null}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }}
        />
        {!file ? (
          <button type="button" className={cx("m-punch-capture", pin && "m-punch-capture-small")} onClick={() => fileInput.current?.click()}>
            <Camera size={pin ? 24 : 34} />
            {t(pin ? "punch.addPhotoOptional" : "punch.takePhoto")}
            <span className="m-small m-muted">{t("punch.takePhotoHint")}</span>
          </button>
        ) : (
          <div className="m-punch-shot">
            {preview ? <img src={preview} alt="" /> : <div className="m-punch-nophoto"><Camera size={22} />{file.name}</div>}
            <div className="m-punch-shot-retake"><Button small variant="secondary" icon={<RotateCcw size={13} />} onClick={() => fileInput.current?.click()}>{t("punch.retake")}</Button></div>
          </div>
        )}
        <Field label={t("punch.whatsWrong")}>
          <input className="m-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("punch.titlePh")} list="punch-titles" maxLength={140} />
          <datalist id="punch-titles">{data.suggestions.titles.map((x) => <option key={x} value={x} />)}</datalist>
        </Field>
        {data.suggestions.titles.length ? (
          <div className="m-punch-chips">
            {data.suggestions.titles.slice(0, 6).map((x) => <button key={x} type="button" className={cx("m-punch-chip", x === title && "m-punch-on")} onClick={() => setTitle(x)}>{x}</button>)}
          </div>
        ) : null}
        {!data.companies.length ? <Note tone="warn">{t("punch.noCompanies")}</Note> : null}
        <div className="m-form">
          <Field label={t("punch.company")}>
            <Select
              value={companyId}
              onChange={(v) => { setCompanyId(v); setPersonId(""); }}
              placeholder={t("punch.chooseCompany")}
              options={data.companies.map((c) => ({ value: c.companyId, label: c.trade ? `${c.companyName} · ${c.trade}` : c.companyName }))}
            />
          </Field>
          <Field label={t("punch.person")} hint={t("punch.personHint")}>
            <Select
              value={personId}
              onChange={setPersonId}
              disabled={!company}
              placeholder={t("punch.anyoneThere")}
              options={(company?.people ?? []).map((p) => ({ value: p.userId, label: p.displayName }))}
            />
          </Field>
          <Field label={t("punch.location")}>
            <input className="m-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t("punch.locationPh")} list="punch-locations" maxLength={120} />
            <datalist id="punch-locations">{data.suggestions.locations.map((x) => <option key={x} value={x} />)}</datalist>
          </Field>
          <Field label={t("punch.due")} hint={t("punch.dueHint")}>
            <input className="m-input" type="date" value={due} min={today} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label={t("punch.priority")} wide>
            <Segmented<PunchPriority> value={priority} onChange={setPriority} options={(["low", "normal", "high"] as PunchPriority[]).map((p) => ({ key: p, label: t(`punch.priority.${p}` as TranslationKey) }))} />
          </Field>
          <Field label={t("punch.descriptionOptional")} wide>
            <textarea className="m-input" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minHeight: 56 }} maxLength={2000} />
          </Field>
        </div>
        {!pin ? <p className="m-small m-muted" style={{ margin: 0 }}><MapPin size={12} /> {t("punch.pinLater")}</p> : null}
      </div>
    </Dialog>
  );
}

/**
 * "New punch item here" from the sheet viewer: the quick-create form with the spot on the sheet.
 * Saves in the background like any quick create; `onSaving` lets the viewer show the pin at once.
 */
export function PunchHereDialog({ projectId, pin, toast, onNavigate, onClose, onSaving }: {
  projectId: string;
  pin: PinSpot;
  toast: (text: string, tone?: ToastTone) => void;
  onNavigate: (path: string) => void;
  onClose: () => void;
  onSaving: (saving: Promise<PunchDetail>, title: string) => void;
}) {
  const { t } = useT();
  const { project, myUserId } = useProjects();
  const list = usePunchList(projectId);
  if (!list.data || !list.data.can.create) {
    return (
      <Dialog title={t("punch.new")} onClose={onClose} size="sm">
        {list.data ? <Note tone="warn">{t("punch.createWhy")}</Note>
          : list.error ? <Note tone="danger">{refusalText(list.error, t("common.error"))}</Note>
          : <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>}
      </Dialog>
    );
  }
  const ctx: Ctx = { t, projectId, projectNumber: project?.number ?? "", myUserId, today: todayIso(), toast, onNavigate };
  return <QuickCreate ctx={ctx} data={list.data} pin={pin} onClose={onClose} onSaving={onSaving} />;
}

/** Where the item is pinned: the sheet's thumbnail with the spot, opening the sheet on the pin. */
function PinPreview({ pin, t, onNavigate }: { pin: PunchPin; t: T; onNavigate: (path: string) => void }) {
  return (
    <button type="button" className="m-punch-pinprev" onClick={() => onNavigate(sheetLink(pin))} title={t("punch.openSheet")}>
      <span className="m-punch-pinprev-img">
        {pin.thumbUrl ? <img src={pin.thumbUrl} alt="" loading="lazy" /> : <span className="m-punch-pinprev-none"><MapPin size={20} /></span>}
        {pin.thumbUrl ? <i style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }} /> : null}
      </span>
      <span className="m-punch-pinprev-text">
        <b><span className="m-mono">{pin.sheetNumber}</span>{pin.sheetTitle ? ` · ${pin.sheetTitle}` : ""}</b>
        <span className="m-small m-muted">{pin.revisionLabel ? `${fmt(t("punch.revShort"), { label: pin.revisionLabel })} · ` : ""}{t("punch.openSheet")}</span>
      </span>
    </button>
  );
}

// ---------- the item panel ----------
function PunchDrawer({ ctx, itemId, list, photoQueue, onClose }: { ctx: Ctx; itemId: string; list?: PunchList; photoQueue: PhotoQueueState; onClose: () => void }) {
  const { t, projectId, onNavigate } = ctx;
  const detail = usePunchItem(projectId, itemId);
  const action = usePunchAction(projectId);
  const [reason, setReason] = useState<null | "sendBack" | "reopen" | "void">(null);
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [reassign, setReassign] = useState(false);
  const beforeInput = useRef<HTMLInputElement>(null);
  const afterInput = useRef<HTMLInputElement>(null);
  const d = detail.data;
  const today = d?.today ?? ctx.today;

  if (detail.isLoading || (!d && !detail.error)) {
    return <Drawer title={t("punch.item")} onClose={onClose}><div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div></Drawer>;
  }
  if (!d) {
    return (
      <Drawer title={t("punch.item")} onClose={onClose}>
        <Empty icon={<Lock size={28} />} title={t("punch.cantOpen")}>{refusalText(detail.error, t("common.error"))}</Empty>
      </Drawer>
    );
  }

  const p = d.item;
  const can = d.can;
  const q = photoQueue.get(p.ItemId);
  const before = d.photos.filter((x) => x.role === "before");
  const after = d.photos.filter((x) => x.role === "after");
  const at = STEPS.indexOf(p.status);
  const busy = action.isPending;
  const anything = can.start || can.markReady || can.close || can.sendBack || can.reopen || can.void;

  const run = async (body: Parameters<typeof action.mutateAsync>[0], ok: string) => {
    try {
      await action.mutateAsync(body);
      ctx.toast(ok);
      return true;
    } catch (e) {
      ctx.toast(refusalText(e, t("common.error")), "warn");
      return false;
    }
  };

  const addPhotos = (role: "before" | "after", files: FileList | null) => {
    const list = [...(files ?? [])];
    const bad = list.filter((f) => photoRefusal(f));
    const good = list.filter((f) => !photoRefusal(f));
    if (bad.length) ctx.toast(t("punch.notAPhoto"), "warn");
    if (!good.length) return;
    addPunchPhoto(projectId, p.ItemId, role, good, p.location);
    ctx.toast(t(role === "after" ? "punch.afterUploading" : "punch.beforeUploading"));
  };

  const photoColumn = (role: "before" | "after", photos: PunchPhoto[]) => {
    const uploading = q && q[role] > 0 && q.uploading > 0;
    const failed = q?.failed.length ? q.failed : [];
    const canAdd = role === "before" ? can.addBeforePhoto : can.addAfterPhoto;
    return (
      <div>
        <h4>{t(role === "before" ? "punch.before" : "punch.after")}{photos.length > 1 ? ` · ${photos.length}` : ""}</h4>
        {photos.length ? (
          <div className="m-punch-photo-list">
            {photos.map((ph) => (
              <button key={ph.ItemId} type="button" className="m-punch-photo" onClick={() => onNavigate(`/photos/${ph.ItemId}`)} title={`${ph.uploadedByName} · ${fmtDateTime(ph.uploadedAt)}`}>
                {ph.thumbUrl || ph.previewUrl ? <img src={ph.previewUrl ?? ph.thumbUrl} alt="" loading="lazy" /> : <span className="m-punch-nophoto"><ImageOff size={20} /></span>}
                <small>{ph.uploadedByName} · {fmtDateTime(ph.uploadedAt)}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="m-punch-nophoto">
            {uploading ? (
              <><Upload size={22} /><span>{t("punch.photoUploading")}</span></>
            ) : role === "before" && p.pinId && !p.photoMissing ? (
              <><MapPin size={22} /><span>{t("punch.fromPin")}</span></>
            ) : (
              <>
                {role === "before" && p.photoMissing ? <AlertTriangle size={22} /> : <Camera size={22} />}
                <span>{role === "before" ? (p.photoMissing ? t("punch.photoMissingLong") : t("punch.noBefore")) : t("punch.noAfter")}</span>
              </>
            )}
          </div>
        )}
        <div className="m-row m-row-wrap" style={{ marginTop: 6 }}>
          {failed.length ? <Button small variant="secondary" icon={<RefreshCw size={13} />} onClick={() => failed.forEach(retryPhoto)}>{t("punch.retryPhoto")}</Button> : null}
          {canAdd ? (
            <Button small variant={role === "after" && !photos.length ? "primary" : "secondary"} icon={<Camera size={13} />} onClick={() => (role === "before" ? beforeInput : afterInput).current?.click()}>
              {t(role === "before" ? "punch.addBefore" : "punch.addAfter")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <Drawer
      title={<><span className="m-mono m-muted">{p.number}</span> {p.title}</>}
      onClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>{t("punch.closePanel")}</Button>}
    >
      <input ref={beforeInput} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { addPhotos("before", e.target.files); e.target.value = ""; }} />
      <input ref={afterInput} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { addPhotos("after", e.target.files); e.target.value = ""; }} />

      <div className="m-row m-row-wrap" style={{ marginBottom: 12 }}>
        <StatusPill status={p.status} t={t} />
        <PriorityPill priority={p.priority} t={t} />
        <DueLabel due={p.dueDate} done={!isActive(p.status)} today={today} t={t} />
        {p.reopenCount ? <Badge tone="amber">{fmt(t("punch.sentBackN"), { count: p.reopenCount })}</Badge> : null}
      </div>

      {p.status === "inProgress" && p.lastRejectReason ? <div style={{ marginBottom: 12 }}><Note tone="warn"><b>{t("punch.sentBackBecause")}</b> {p.lastRejectReason}</Note></div> : null}
      {p.status === "void" && p.voidReason ? <div style={{ marginBottom: 12 }}><Note>{fmt(t("punch.voidedBecause"), { reason: p.voidReason })}</Note></div> : null}

      <div className="m-punch-stepper">
        {STEPS.map((s, i) => (
          <div key={s} className={cx("m-punch-step", p.status === "void" ? "m-punch-void" : i < at ? "m-punch-done" : i === at && "m-punch-now")}>
            {i < at && p.status !== "void" ? <CheckCircle2 size={13} /> : null}{t(`punch.status.${s}` as TranslationKey)}
          </div>
        ))}
        {p.status === "void" ? <div className="m-punch-step m-punch-now"><XCircle size={13} />{t("punch.status.void")}</div> : null}
      </div>

      <div className="m-punch-photos">
        {photoColumn("before", before)}
        {photoColumn("after", after)}
      </div>
      {d.pin ? <PinPreview pin={d.pin} t={t} onNavigate={onNavigate} /> : null}

      <div className="m-punch-actions">
        {can.start ? <Button icon={<Play size={15} />} disabled={busy} onClick={() => void run({ action: "start", itemId: p.ItemId }, fmt(t("punch.startedToast"), { number: p.number }))}>{t("punch.action.start")}</Button> : null}
        {can.markReady ? (
          <Button
            variant="success"
            icon={<CheckCircle2 size={15} />}
            disabled={busy || !can.hasAfterPhoto}
            title={can.hasAfterPhoto ? t("punch.markReadyHint") : t("punch.needAfterFirst")}
            onClick={() => void run({ action: "markReady", itemId: p.ItemId }, fmt(t("punch.readyToast"), { number: p.number }))}
          >
            {t("punch.action.markReady")}
          </Button>
        ) : null}
        {can.close ? (
          <Button
            icon={<ClipboardCheck size={15} />}
            disabled={busy || !can.hasAfterPhoto}
            title={can.hasAfterPhoto ? t("punch.closeHint") : t("punch.closeNeedsAfter")}
            onClick={() => void run({ action: "close", itemId: p.ItemId }, fmt(t("punch.closedToast"), { number: p.number }))}
          >
            {t("punch.action.close")}
          </Button>
        ) : null}
        {can.sendBack ? <Button variant="secondary" icon={<RotateCcw size={15} />} disabled={busy} onClick={() => setReason("sendBack")}>{t("punch.action.sendBack")}…</Button> : null}
        {can.reopen ? <Button variant="secondary" icon={<RotateCcw size={15} />} disabled={busy} onClick={() => setReason("reopen")}>{t("punch.action.reopen")}…</Button> : null}
        {can.void ? <Button variant="ghost" icon={<XCircle size={15} />} disabled={busy} onClick={() => setReason("void")}>{t("punch.action.void")}…</Button> : null}
        {busy ? <Loader2 size={16} className="spin" style={{ alignSelf: "center" }} /> : null}
        {!anything ? <span className="m-small m-muted" style={{ alignSelf: "center" }}><Lock size={12} /> {isActive(p.status) ? t("punch.viewOnly") : t("punch.nothingToDo")}</span> : null}
        {(can.markReady || can.close) && !can.hasAfterPhoto ? <span className="m-small m-muted" style={{ alignSelf: "center", flexBasis: "100%" }}>{t("punch.afterFirstNote")}</span> : null}
      </div>

      <KeyValue items={[
        [t("punch.location"), p.location || <span className="m-muted">—</span>],
        [t("punch.company"), p.assigneeCompanyName ? <CompanyChip name={p.assigneeCompanyName} color={colorFor(p.assigneeCompanyId)} /> : "—"],
        [t("punch.person"), p.assigneeName || <span className="m-muted">{t("punch.anyoneThere")}</span>],
        [t("rfi.ballInCourt"), isActive(p.status) && p.ballInCourtName ? <>{p.ballInCourtName} <span className="m-muted m-small">· {t(p.ballInCourtRole === "verifier" ? "punch.ball.verifier" : "punch.ball.assignee")}</span></> : <span className="m-muted">—</span>],
        [t("punch.trade"), p.trade || <span className="m-muted">—</span>],
        [t("punch.created"), `${fmtDate(p.createdAt)} · ${p.createdByName ?? ""}`],
        [t("punch.due"), <DueLabel key="d" due={p.dueDate} done={!isActive(p.status)} today={today} t={t} />],
        [t("punch.sheet"), p.sheetId ? <button key="s" type="button" className="m-link" onClick={() => onNavigate(sheetLink(p))}><MapPin size={13} /> {p.sheetNumber || t("punch.openSheet")}</button> : <span className="m-muted">{t("punch.noPin")}</span>]
      ]} />

      {p.description ? <p style={{ marginTop: 14, whiteSpace: "pre-wrap" }}>{p.description}</p> : null}

      {can.edit || can.reassign ? (
        <div className="m-punch-section">
          <h4><Pencil size={13} /> {t("punch.changeTitle")}</h4>
          <div className="m-row m-row-wrap">
            {can.edit ? <Button small variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>{t("punch.edit")}</Button> : null}
            {can.reassign ? <Button small variant="secondary" icon={<UserRoundCog size={13} />} onClick={() => setReassign(true)}>{t("punch.reassign")}</Button> : null}
          </div>
        </div>
      ) : null}

      <div className="m-punch-section">
        <h4><MessageSquare size={13} /> {fmt(t("punch.comments"), { count: d.comments.length })}</h4>
        <div className="m-thread">
          {d.comments.map((c) => (
            <div key={c.ItemId} className="m-msg">
              <div className="m-row" style={{ justifyContent: "space-between" }}><b>{c.authorName}</b><span className="m-small m-muted">{fmtDateTime(c.postedAt)}</span></div>
              <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{c.body}</p>
            </div>
          ))}
          {!d.comments.length ? <span className="m-muted m-small">{t("punch.noComments")}</span> : null}
        </div>
        {can.comment ? (
          <div className="m-row" style={{ marginTop: 10, alignItems: "flex-end" }}>
            <textarea className="m-input" style={{ minHeight: 44 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("punch.commentPh")} maxLength={2000} />
            <Button
              disabled={!comment.trim() || busy}
              onClick={() => void run({ action: "comment", itemId: p.ItemId, body: comment.trim() }, t("punch.commentPosted")).then((ok) => ok && setComment(""))}
            >
              {t("punch.post")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="m-punch-section">
        <h4>{t("punch.history")}</h4>
        <Timeline items={d.history.map((h) => ({
          who: h.actorName,
          when: fmtDateTime(h.at),
          title: h.summary ?? h.action,
          body: h.reason || undefined,
          tone: (h.toStatus === "closed" ? "green" : h.toStatus === "readyForReview" ? "purple" : h.toStatus === "void" ? "gray" : h.action === "sentBack" || h.action === "reopened" ? "amber" : "blue") as Tone
        }))} />
      </div>

      {reason ? (
        <ReasonDialog
          t={t}
          kind={reason}
          number={p.number}
          busy={busy}
          onClose={() => setReason(null)}
          onSave={(why) => {
            const kind = reason;
            void run({ action: kind, itemId: p.ItemId, reason: why }, fmt(t(kind === "void" ? "punch.voidedToast" : kind === "reopen" ? "punch.reopenedToast" : "punch.sentBackToast"), { number: p.number })).then((ok) => ok && setReason(null));
          }}
        />
      ) : null}
      {editing ? (
        <EditDialog
          t={t}
          item={p}
          today={today}
          busy={busy}
          locations={list?.suggestions.locations ?? []}
          onClose={() => setEditing(false)}
          onSave={(changes) => void run({ action: "edit", itemId: p.ItemId, version: p.version, changes }, fmt(t("punch.savedChanges"), { number: p.number })).then((ok) => ok && setEditing(false))}
        />
      ) : null}
      {reassign ? (
        <ReassignDialog
          t={t}
          item={p}
          companies={list?.companies ?? []}
          busy={busy}
          onClose={() => setReassign(false)}
          onSave={(companyId, userId) => void run({ action: "reassign", itemId: p.ItemId, assigneeCompanyId: companyId, assigneeUserId: userId || undefined }, fmt(t("punch.reassignedToast"), { number: p.number })).then((ok) => ok && setReassign(false))}
        />
      ) : null}
    </Drawer>
  );
}

function EditDialog({ t, item, today, busy, locations, onClose, onSave }: {
  t: T; item: PunchRow; today: string; busy: boolean; locations: string[]; onClose: () => void;
  onSave: (changes: { title?: string; description?: string; priority?: PunchPriority; location?: string; dueDate?: string }) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [priority, setPriority] = useState<PunchPriority>(item.priority);
  const [location, setLocation] = useState(item.location ?? "");
  const [due, setDue] = useState(item.dueDate ?? "");
  const changes = {
    ...(title.trim() !== item.title ? { title: title.trim() } : {}),
    ...(description.trim() !== (item.description ?? "") ? { description: description.trim() } : {}),
    ...(priority !== item.priority ? { priority } : {}),
    ...(location.trim() !== (item.location ?? "") ? { location: location.trim() } : {}),
    ...(due && due !== item.dueDate ? { dueDate: due } : {})
  };
  const changed = Object.keys(changes).length > 0;
  return (
    <Dialog
      title={fmt(t("punch.editTitle"), { number: item.number })}
      onClose={onClose}
      size="md"
      footer={<><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={() => onSave(changes)} disabled={!changed || title.trim().length < 3 || busy}>{t("common.save")}</Button></>}
    >
      <div className="m-form">
        <Field label={t("punch.whatsWrong")} wide><input className="m-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} /></Field>
        <Field label={t("punch.location")}>
          <input className="m-input" value={location} onChange={(e) => setLocation(e.target.value)} list="punch-edit-locations" maxLength={120} />
          <datalist id="punch-edit-locations">{locations.map((x) => <option key={x} value={x} />)}</datalist>
        </Field>
        <Field label={t("punch.due")}><input className="m-input" type="date" value={due} min={today} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label={t("punch.priority")} wide>
          <Segmented<PunchPriority> value={priority} onChange={setPriority} options={(["low", "normal", "high"] as PunchPriority[]).map((p) => ({ key: p, label: t(`punch.priority.${p}` as TranslationKey) }))} />
        </Field>
        <Field label={t("punch.descriptionOptional")} wide><textarea className="m-input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
      </div>
    </Dialog>
  );
}

function ReassignDialog({ t, item, companies, busy, onClose, onSave }: {
  t: T; item: PunchRow; companies: PunchList["companies"]; busy: boolean; onClose: () => void; onSave: (companyId: string, userId: string) => void;
}) {
  const [companyId, setCompanyId] = useState(item.assigneeCompanyId);
  const [userId, setUserId] = useState(item.assigneeUserId ?? "");
  const company = companies.find((c) => c.companyId === companyId);
  const same = companyId === item.assigneeCompanyId && userId === (item.assigneeUserId ?? "");
  return (
    <Dialog
      title={fmt(t("punch.reassignTitle"), { number: item.number })}
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button icon={<UserRoundCog size={15} />} onClick={() => onSave(companyId, userId)} disabled={!company || same || busy}>{t("punch.reassign")}</Button></>}
    >
      <div className="m-stack-v">
        <Field label={t("punch.company")}>
          <Select value={companyId} onChange={(v) => { setCompanyId(v); setUserId(""); }} options={companies.map((c) => ({ value: c.companyId, label: c.trade ? `${c.companyName} · ${c.trade}` : c.companyName }))} />
        </Field>
        <Field label={t("punch.person")} hint={t("punch.personHint")}>
          <Select value={userId} onChange={setUserId} placeholder={t("punch.anyoneThere")} options={(company?.people ?? []).map((p) => ({ value: p.userId, label: p.displayName }))} />
        </Field>
        {companyId !== item.assigneeCompanyId ? <Note>{t("punch.reassignNote")}</Note> : null}
      </div>
    </Dialog>
  );
}

function ReasonDialog({ t, kind, number, busy, onClose, onSave }: {
  t: T; kind: "void" | "sendBack" | "reopen"; number: string; busy: boolean; onClose: () => void; onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Dialog
      title={fmt(t(`punch.${kind}Title` as TranslationKey), { number })}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant={kind === "void" ? "danger" : "primary"} onClick={() => onSave(reason.trim())} disabled={!ok || busy} title={ok ? undefined : t("punch.reasonMin")}>
            {t(`punch.action.${kind}` as TranslationKey)}
          </Button>
        </>
      }
    >
      <div className="m-stack-v">
        <Note tone={kind === "void" ? "warn" : "info"}>{t(`punch.${kind}Text` as TranslationKey)}</Note>
        <Field label={`${t("rfi.reason")} *`}>
          <textarea className="m-input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder={kind === "void" ? undefined : t("punch.reasonPh")} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}

