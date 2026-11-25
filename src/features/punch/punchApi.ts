// Punch list: every read and write goes through the punch Function (functions/punch), because only
// the Function can check the person's project role (a subcontractor sees their company's items and
// the ones they created). Every change on one item answers with the item's full detail, which goes
// straight into the cache, so the screen updates without a second call.
//
// Quick create (≤ 15 s on site): Save closes the form at once. The item is sent in the background
// (a Function call can sit in the Blocks queue for a minute), shown in the list as "Sending…", and
// its photo goes into the app's photo queue (features/photos) once the item has its number. A
// failed send stays in the list with Retry; the same request id means a retry never makes two.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FUNCTIONS, FunctionRefused, callFunction } from "../../lib/blocks/functions";
import { enqueuePhotos, usePhotoQueue } from "../photos/photosApi";

export type PunchStatus = "open" | "inProgress" | "readyForReview" | "closed" | "void";
export type PunchPriority = "low" | "normal" | "high";

export const PUNCH_STATUSES: PunchStatus[] = ["open", "inProgress", "readyForReview", "closed", "void"];
export const PUNCH_ACTIVE: PunchStatus[] = ["open", "inProgress", "readyForReview"];
/** Items per bulk call (the Function's limit); the page sends up to BULK_MAX in several calls. */
export const BULK_PER_CALL = 50;
export const BULK_MAX = 200;

export type PunchRow = {
  ItemId: string;
  projectId: string;
  number: string;
  seq?: number;
  version?: number;
  title: string;
  description?: string;
  status: PunchStatus;
  priority: PunchPriority;
  trade?: string;
  location?: string;
  dueDate?: string;
  assigneeCompanyId: string;
  assigneeCompanyName?: string;
  assigneeUserId?: string;
  assigneeName?: string;
  ballInCourtUserId?: string;
  ballInCourtName?: string;
  ballInCourtRole?: "assignee" | "verifier" | "none";
  createdByUserId: string;
  createdByCompanyId?: string;
  createdByName?: string;
  createdAt: string;
  startedAt?: string;
  readyAt?: string;
  closedAt?: string;
  reopenCount: number;
  lastRejectReason?: string;
  photoExpected?: boolean;
  /** Its live pin on a drawing (moved or removed in the sheet viewer), else empty. */
  sheetId?: string;
  pinId?: string;
  sheetNumber?: string;
  isVoided?: boolean;
  voidReason?: string;
  // Worked out by the Function:
  overdue: boolean;
  beforePhotos: number;
  afterPhotos: number;
  /** Saved "with a photo", but the photo never arrived (and there is no pin either). */
  photoMissing: boolean;
  beforeThumbUrl?: string;
  afterThumbUrl?: string;
};

export type PunchCompany = { companyId: string; companyName: string; trade: string; people: { userId: string; displayName: string }[] };

export type PunchList = {
  role: string;
  archived: boolean;
  today: string;
  linksExpireAt: string;
  can: { create: boolean; bulk: boolean; void: boolean; seesAllCompanies: boolean };
  defaultDueDate: string;
  /** Companies an item can go to (only for the superintendent and the PM). */
  companies: PunchCompany[];
  suggestions: { titles: string[]; locations: string[]; lastCompanyId: string };
  items: PunchRow[];
};

export type PunchCan = {
  edit: boolean;
  reassign: boolean;
  start: boolean;
  markReady: boolean;
  close: boolean;
  sendBack: boolean;
  reopen: boolean;
  void: boolean;
  comment: boolean;
  addBeforePhoto: boolean;
  addAfterPhoto: boolean;
  hasAfterPhoto: boolean;
};

export type PunchPhoto = { ItemId: string; role: "before" | "after"; caption: string; takenAt?: string; uploadedAt: string; uploadedByName: string; thumbUrl?: string; previewUrl?: string };
export type PunchComment = { ItemId: string; body: string; authorUserId: string; authorName: string; postedAt: string };
export type PunchHistory = { ItemId: string; action: string; actorName?: string; at: string; summary?: string; reason?: string; fromStatus?: string; toStatus?: string };

/** Where the item is pinned: the sheet's current thumbnail and the spot on it (0..1). */
export type PunchPin = { pinId: string; sheetId: string; sheetNumber: string; sheetTitle: string; revisionLabel: string; x: number; y: number; thumbUrl?: string };

export type PunchDetail = {
  role: string;
  today: string;
  linksExpireAt: string;
  item: PunchRow;
  can: PunchCan;
  pin?: PunchPin | null;
  photos: PunchPhoto[];
  comments: PunchComment[];
  history: PunchHistory[];
};

/** What the quick-create form sends. */
export type PunchInput = {
  title: string;
  description?: string;
  priority: PunchPriority;
  location?: string;
  dueDate?: string;
  assigneeCompanyId: string;
  assigneeUserId?: string;
  /** "New punch item here" in the sheet viewer: the spot on the current revision. */
  pin?: { sheetId: string; revisionIndex: number; x: number; y: number };
};

export type PunchBulkOp = "reassign" | "setDue" | "start" | "markReady" | "close" | "void";

const listKey = (projectId?: string) => ["punch", projectId ?? ""];
const detailKey = (projectId?: string, itemId?: string) => ["punchItem", projectId ?? "", itemId ?? ""];
const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.punch, body);

export function usePunchList(projectId?: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: listKey(projectId),
    queryFn: () => call<PunchList>({ action: "list", projectId }),
    enabled: Boolean(projectId && FUNCTIONS.punch)
  });
  // Photo links run out after about an hour: read the list again just before.
  const expires = query.data?.linksExpireAt;
  useEffect(() => {
    if (!expires) return;
    const wait = Math.max(5_000, Date.parse(expires) - Date.now());
    const timer = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: listKey(projectId) }), wait);
    return () => window.clearTimeout(timer);
  }, [expires, projectId, queryClient]);
  return query;
}

export function usePunchItem(projectId?: string, itemId?: string) {
  return useQuery({
    queryKey: detailKey(projectId, itemId),
    queryFn: () => call<PunchDetail>({ action: "get", projectId, itemId }),
    enabled: Boolean(projectId && itemId && FUNCTIONS.punch),
    retry: false,
    refetchInterval: 40 * 60_000 // photo links last an hour
  });
}

/** The item's detail into both caches: its own, and its row in the list. */
function putDetail(queryClient: QueryClient, projectId: string, detail: PunchDetail) {
  queryClient.setQueryData(detailKey(projectId, detail.item.ItemId), detail);
  queryClient.setQueryData<PunchList>(listKey(projectId), (old) => {
    if (!old) return old;
    const at = old.items.findIndex((i) => i.ItemId === detail.item.ItemId);
    // An answer without photo links keeps the links the row had.
    const row = at >= 0 ? { ...detail.item, beforeThumbUrl: detail.item.beforeThumbUrl ?? old.items[at]!.beforeThumbUrl, afterThumbUrl: detail.item.afterThumbUrl ?? old.items[at]!.afterThumbUrl } : detail.item;
    const items = at >= 0 ? old.items.map((i, n) => (n === at ? row : i)) : [row, ...old.items];
    return { ...old, items };
  });
}

type ActionBody =
  | { action: "edit"; itemId: string; version?: number; changes: Partial<Omit<PunchInput, "assigneeCompanyId" | "assigneeUserId">> }
  | { action: "reassign"; itemId: string; assigneeCompanyId: string; assigneeUserId?: string }
  | { action: "start" | "markReady" | "close"; itemId: string }
  | { action: "sendBack" | "reopen" | "void"; itemId: string; reason: string }
  | { action: "comment"; itemId: string; body: string };

/** Runs one action on one item; the answer (the item's full detail) replaces the cached copies. */
export function usePunchAction(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ActionBody) => call<PunchDetail>({ ...body, projectId }),
    onSuccess: (detail) => projectId && putDetail(queryClient, projectId, detail),
    onError: (_error, body) => {
      // Someone else changed it meanwhile (STATE_CHANGED) or it is gone: show the current state.
      void queryClient.invalidateQueries({ queryKey: detailKey(projectId, body.itemId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
    }
  });
}

export type BulkResult = { updated: string[]; rejected: { itemId: string; number: string; code: string; error: string }[] };

/** One change on many items, BULK_PER_CALL per call. Items another call refused are listed, not lost. */
export async function runBulk(queryClient: QueryClient, projectId: string, op: PunchBulkOp, itemIds: string[], extra: { assigneeCompanyId?: string; assigneeUserId?: string; dueDate?: string; reason?: string }): Promise<BulkResult> {
  const out: BulkResult = { updated: [], rejected: [] };
  try {
    for (let i = 0; i < itemIds.length; i += BULK_PER_CALL) {
      const r = await call<BulkResult>({ action: "bulk", projectId, op, itemIds: itemIds.slice(i, i + BULK_PER_CALL), ...extra });
      out.updated.push(...r.updated);
      out.rejected.push(...r.rejected);
    }
  } finally {
    await queryClient.invalidateQueries({ queryKey: listKey(projectId) });
    for (const id of itemIds) queryClient.removeQueries({ queryKey: detailKey(projectId, id) });
  }
  return out;
}

// ---------- quick create in the background ----------
export type PendingCreate = {
  clientRequestId: string;
  projectId: string;
  input: PunchInput;
  companyName: string;
  file?: File;
  /** Local picture of the photo, for the row while it is sending. */
  localUrl?: string;
  state: "sending" | "failed";
  error?: string;
  startedAt: number;
};

let pending: PendingCreate[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  pending = [...pending];
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

if (typeof window !== "undefined") {
  // Leaving the app while an item is still sending: the browser asks first.
  window.addEventListener("beforeunload", (e) => {
    if (pending.some((p) => p.state === "sending")) e.preventDefault();
  });
}

export function usePendingCreates(projectId?: string) {
  const list = useSyncExternalStore(subscribe, () => pending);
  return list.filter((p) => p.projectId === projectId);
}

const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function send(queryClient: QueryClient, p: PendingCreate) {
  try {
    const detail = await call<PunchDetail & { created: boolean }>({ action: "create", projectId: p.projectId, clientRequestId: p.clientRequestId, withPhoto: Boolean(p.file), ...p.input });
    putDetail(queryClient, p.projectId, detail);
    // The photo follows through the photo queue, linked as the item's before photo.
    if (p.file && detail.created !== false && detail.item.beforePhotos === 0) {
      enqueuePhotos(p.projectId, [p.file], { locationLabel: p.input.location || undefined, tags: ["punch"], link: { type: "punchItem", id: detail.item.ItemId, role: "before" } });
    }
    if (p.localUrl) URL.revokeObjectURL(p.localUrl);
    pending = pending.filter((x) => x.clientRequestId !== p.clientRequestId);
    emit();
    return detail;
  } catch (e) {
    pending = pending.map((x) => (x.clientRequestId === p.clientRequestId ? { ...x, state: "failed", error: e instanceof Error ? e.message : "Sending failed." } : x));
    emit();
    throw e;
  }
}

/** Saves a new item in the background; resolves with its detail (or rejects; the row then shows Retry). */
export function createPunch(queryClient: QueryClient, projectId: string, input: PunchInput, companyName: string, file?: File) {
  const p: PendingCreate = {
    clientRequestId: newRequestId(),
    projectId,
    input,
    companyName,
    file,
    localUrl: file && /^image\/(jpeg|png|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined,
    state: "sending",
    startedAt: Date.now()
  };
  pending = [p, ...pending];
  emit();
  return send(queryClient, p);
}

export function retryCreate(queryClient: QueryClient, clientRequestId: string) {
  const p = pending.find((x) => x.clientRequestId === clientRequestId);
  if (!p || p.state !== "failed") return Promise.resolve(undefined);
  const again = { ...p, state: "sending" as const, error: undefined };
  pending = pending.map((x) => (x.clientRequestId === clientRequestId ? again : x));
  emit();
  return send(queryClient, again).catch(() => undefined);
}

export function dropCreate(clientRequestId: string) {
  const p = pending.find((x) => x.clientRequestId === clientRequestId);
  if (!p || p.state !== "failed") return;
  if (p.localUrl) URL.revokeObjectURL(p.localUrl);
  pending = pending.filter((x) => x.clientRequestId !== clientRequestId);
  emit();
}

/** A before or after photo for an item that already exists (the detail panel). */
export function addPunchPhoto(projectId: string, itemId: string, role: "before" | "after", files: File[], locationLabel?: string) {
  enqueuePhotos(projectId, files, { locationLabel: locationLabel || undefined, tags: ["punch", role], link: { type: "punchItem", id: itemId, role } });
}

/**
 * Punch photos in the app's photo queue: per item, whether one is still going up or failed. When
 * one is saved, the item and the list are read again so its thumbnail and "after photo" show.
 */
export function usePunchPhotoQueue(projectId?: string) {
  const queryClient = useQueryClient();
  const { items } = usePhotoQueue();
  const seen = useRef(new Set<string>());
  // Uploads that finished but whose item hasn't been re-read yet. Until the re-read lands, the
  // row and the panel still say "no photo", so these count as "uploading" to avoid a false
  // "photo missing" flash.
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const mine = items.filter((x) => x.projectId === projectId && x.options.link?.type === "punchItem");
  useEffect(() => {
    if (!projectId) return;
    for (const x of mine) {
      if (x.state !== "done" || seen.current.has(x.id) || !x.options.link) continue;
      seen.current.add(x.id);
      const id = x.id;
      setSettling((s) => new Set(s).add(id));
      void Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: detailKey(projectId, x.options.link.id) }),
        queryClient.invalidateQueries({ queryKey: listKey(projectId) }),
      ]).then(() =>
        setSettling((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      );
    }
  }, [mine, projectId, queryClient]);
  const byItem = new Map<string, { uploading: number; failed: string[]; before: number; after: number }>();
  for (const x of mine) {
    if (x.state === "done" && !settling.has(x.id)) continue;
    const id = x.options.link!.id;
    const role = x.options.link!.type === "punchItem" ? x.options.link!.role : "before";
    const s = byItem.get(id) ?? { uploading: 0, failed: [], before: 0, after: 0 };
    if (x.state === "failed") s.failed.push(x.id);
    else s.uploading += 1;
    s[role] += 1;
    byItem.set(id, s);
  }
  return byItem;
}

export const refusalText = (error: unknown, fallback: string) => (error instanceof FunctionRefused ? error.message : fallback);
