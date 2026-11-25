// Photos: every read and write goes through the photos Function (functions/photos), because only
// the Function can check the person's project role (a subcontractor sees their company's photos
// and photos on records they can open). Changes answer with just the photos that changed, which
// are merged into the cached gallery.
//
// Upload: the browser makes a 1600 px copy (viewing) and a 320 px copy (grid) and reads the date
// the photo was taken (EXIF), then uploads the original as it is plus both copies. Uploads run in a
// queue that lives as long as the app is open (not only the Photos page): batches of up to 10
// photos, two Function calls per batch, waits while the device is offline and can be retried.
import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import { MAX_FILE_BYTES, put } from "../files/files";

export type PhotoLink = { type: "rfi" | "punchItem"; id: string; number: string; label: string; role: string };

export type Photo = {
  ItemId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  version: number;
  takenAt: string;
  uploadedAt: string;
  yearMonth: string;
  caption: string;
  locationLabel: string;
  tags: string[];
  link?: PhotoLink;
  uploadedByUserId: string;
  uploadedByName: string;
  uploaderCompanyId: string;
  /** False for a type the browser couldn't draw (HEIC on most desktops): only the original exists. */
  hasPreview: boolean;
  removed: boolean;
  removedAt?: string;
  /** For removed photos: who removed it and why (empty when no reason was given). */
  removedByName?: string;
  removedReason?: string;
  canEdit: boolean;
  canRemove: boolean;
  /** 320 px copy and 1600 px copy, valid until the listing's linksExpireAt. */
  thumbUrl?: string;
  previewUrl?: string;
};

export type LinkableRfi = { ItemId: string; number: string; subject: string };

export type PhotoListing = {
  role: string;
  archived: boolean;
  companyId: string;
  can: { upload: boolean; manage: boolean; seeRemoved: boolean };
  removed: boolean;
  linksExpireAt: string;
  photos: Photo[];
  rfis: LinkableRfi[];
};

const key = (projectId?: string, removed = false) => ["photos", projectId ?? "", removed ? "removed" : "live"];
const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.photos, body);

export function usePhotos(projectId?: string, removed = false, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key(projectId, removed),
    queryFn: () => call<PhotoListing>({ action: "list", projectId, removed }),
    enabled: Boolean(enabled && projectId && FUNCTIONS.photos)
  });
  // The photo links run out after about an hour: load the gallery again just before.
  const expires = query.data?.linksExpireAt;
  useEffect(() => {
    if (!expires) return;
    const wait = Math.max(5_000, Date.parse(expires) - Date.now());
    const timer = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: key(projectId, removed) }), wait);
    return () => window.clearTimeout(timer);
  }, [expires, projectId, removed, queryClient]);
  return query;
}

/** Puts changed photos into the cached galleries: replaced, added, or moved between live and removed. */
export function mergePhotos(queryClient: QueryClient, projectId: string, photos: Photo[]) {
  if (!photos.length) return;
  for (const removed of [false, true]) {
    queryClient.setQueryData<PhotoListing>(key(projectId, removed), (old) => {
      if (!old) return old;
      const byId = new Map(photos.map((p) => [p.ItemId, p]));
      const kept = old.photos
        .map((p) => {
          const next = byId.get(p.ItemId);
          // Never an older copy over a newer one; an answer without links keeps the links it had.
          if (!next || next.version < p.version) return p;
          return { ...next, thumbUrl: next.thumbUrl ?? p.thumbUrl, previewUrl: next.previewUrl ?? p.previewUrl };
        })
        .filter((p) => p.removed === removed);
      const fresh = photos.filter((p) => p.removed === removed && !old.photos.some((o) => o.ItemId === p.ItemId));
      return { ...old, photos: [...fresh, ...kept] };
    });
  }
}

type ActionBody =
  | { action: "update"; photoId: string; version?: number; caption?: string; locationLabel?: string; tags?: string[] }
  | { action: "tag"; photoIds: string[]; add?: string[]; remove?: string[] }
  | { action: "remove"; photoId: string; reason?: string }
  | { action: "restore"; photoId: string };

export type ActionResult = { photos: Photo[]; skipped?: number };

// What the change will look like, shown at once: a Function call can wait a minute in the Blocks
// queue. The server's answer then replaces it (higher version); a refusal puts the old state back.
function expected(body: ActionBody, p: Photo): Photo {
  switch (body.action) {
    case "update":
      return {
        ...p,
        ...(body.caption !== undefined ? { caption: body.caption } : {}),
        ...(body.locationLabel !== undefined ? { locationLabel: body.locationLabel } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {})
      };
    case "tag": {
      if (!p.canEdit) return p;
      const tags = [...p.tags.filter((t) => !(body.remove ?? []).includes(t)), ...(body.add ?? []).filter((t) => !p.tags.includes(t))];
      return { ...p, tags };
    }
    case "remove":
      return { ...p, removed: true, removedAt: new Date().toISOString(), removedReason: body.reason ?? "", canEdit: false, canRemove: false };
    case "restore":
      return { ...p, removed: false, removedByName: undefined, removedReason: undefined };
  }
}

const targets = (body: ActionBody) => (body.action === "tag" ? body.photoIds : [body.photoId]);

export function usePhotoAction(projectId?: string) {
  const queryClient = useQueryClient();
  const keys = [key(projectId, false), key(projectId, true)];
  return useMutation({
    mutationFn: (body: ActionBody) => call<ActionResult>({ ...body, projectId }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: ["photos", projectId ?? ""] });
      const before = keys.map((k) => [k, queryClient.getQueryData<PhotoListing>(k)] as const);
      const ids = new Set(targets(body));
      const changed = before.flatMap(([, l]) => l?.photos ?? []).filter((p) => ids.has(p.ItemId)).map((p) => expected(body, p));
      for (const [k, l] of before) {
        if (!l) continue;
        const moved = changed.filter((p) => p.removed === l.removed && !l.photos.some((o) => o.ItemId === p.ItemId));
        const photos = l.photos.map((p) => changed.find((c) => c.ItemId === p.ItemId) ?? p).filter((p) => p.removed === l.removed);
        queryClient.setQueryData<PhotoListing>(k, { ...l, photos: [...moved, ...photos] });
      }
      return { before };
    },
    onSuccess: (r) => projectId && mergePhotos(queryClient, projectId, r.photos),
    // Someone else changed it meanwhile (STATE_CHANGED), or it is gone: back to before, then reload.
    onError: (_e, _body, context) => {
      for (const [k, l] of context?.before ?? []) queryClient.setQueryData(k, l);
      void queryClient.invalidateQueries({ queryKey: ["photos", projectId ?? ""] });
    }
  });
}

/** Links for photos that came without them (beyond the newest ones in the list). */
export function photoLinks(projectId: string, photoIds: string[]) {
  return call<{ links: Record<string, { thumb?: string; preview?: string }>; linksExpireAt: string }>({ action: "links", projectId, photoIds });
}

/** A link to the original file, valid about an hour. */
export function originalLink(projectId: string, photoId: string) {
  return call<{ url: string; fileName: string; contentType: string }>({ action: "originalLink", projectId, photoId });
}

// ---------- before upload: checks, copies and the date taken ----------
export const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
const extOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").toLowerCase();
const TYPE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
export const photoType = (f: File) => (f.type && /^image\//.test(f.type) ? f.type.toLowerCase() : TYPE_BY_EXT[extOf(f.name)] ?? "");

/** Why a file can't be added as a photo, or undefined when it can. */
export function photoRefusal(file: File): "type" | "size" | "empty" | undefined {
  if (!PHOTO_EXTENSIONS.includes(extOf(file.name)) || !Object.values(TYPE_BY_EXT).includes(photoType(file))) return "type";
  if (file.size === 0) return "empty";
  if (file.size > MAX_FILE_BYTES) return "size";
  return undefined;
}

const PREVIEW_SIDE = 1600;
const THUMB_SIDE = 320;

type Copies = { preview?: Blob; thumb?: Blob; width?: number; height?: number };

async function makeCopies(file: File): Promise<Copies> {
  if (typeof createImageBitmap !== "function") return {};
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return {}; // HEIC on most desktops: only the original goes up
  }
  try {
    const draw = (side: number, quality: number) => {
      const ratio = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const g = canvas.getContext("2d");
      if (!g) return Promise.resolve(undefined);
      g.fillStyle = "#fff"; // transparent PNGs get a white background in the JPEG copies
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise<Blob | undefined>((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), "image/jpeg", quality));
    };
    const [preview, thumb] = await Promise.all([draw(PREVIEW_SIDE, 0.82), draw(THUMB_SIDE, 0.74)]);
    return { preview, thumb, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** The EXIF date the photo was taken (JPEG only), as an ISO date in the device's time zone. */
export async function exifTakenAt(file: File): Promise<string | undefined> {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return undefined;
  try {
    const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return undefined;
    let at = 2;
    while (at + 4 < view.byteLength) {
      const marker = view.getUint16(at);
      const size = view.getUint16(at + 2);
      if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966) return readExifDate(view, at + 10);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return undefined;
      at += 2 + size;
    }
  } catch {
    // an unreadable header just means no EXIF date
  }
  return undefined;
}

function readExifDate(view: DataView, tiff: number): string | undefined {
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => view.getUint16(tiff + o, little);
  const u32 = (o: number) => view.getUint32(tiff + o, little);
  const entries = (ifd: number) => {
    const out: { tag: number; count: number; value: number }[] = [];
    const n = u16(ifd);
    for (let i = 0; i < n; i += 1) {
      const e = ifd + 2 + i * 12;
      out.push({ tag: u16(e), count: u32(e + 4), value: u32(e + 8) });
    }
    return out;
  };
  const ascii = (offset: number, count: number) => {
    let s = "";
    for (let i = 0; i < count - 1; i += 1) s += String.fromCharCode(view.getUint8(tiff + offset + i));
    return s;
  };
  const ifd0 = entries(u32(4));
  const exifPtr = ifd0.find((e) => e.tag === 0x8769)?.value;
  const exif = exifPtr ? entries(exifPtr) : [];
  const date = exif.find((e) => e.tag === 0x9003) ?? exif.find((e) => e.tag === 0x9004) ?? ifd0.find((e) => e.tag === 0x0132);
  if (!date || date.count < 19) return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(ascii(date.value, date.count));
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------- the upload queue (lives while the app is open) ----------
/** A photo for a record: an RFI, or a punch item's before or after photo (functions/photos add). */
export type UploadLink = { type: "rfi"; id: string } | { type: "punchItem"; id: string; role: "before" | "after" };
export type UploadOptions = { locationLabel?: string; tags?: string[]; link?: UploadLink };

type Slot = {
  fileId: string;
  previewFileId: string;
  thumbFileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  ticket: string;
  uploadUrl: string;
  previewUploadUrl?: string;
  thumbUploadUrl?: string;
};

export type QueueItem = {
  id: string;
  projectId: string;
  file: File;
  /** Local picture for the queue panel, while the upload runs. */
  localUrl?: string;
  options: UploadOptions;
  state: "waiting" | "uploading" | "saving" | "done" | "failed";
  progress: number;
  error?: string;
  slot?: Slot;
  put?: boolean;
  takenAt?: string;
  copies?: Copies;
  photo?: Photo;
};

let items: QueueItem[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  items = [...items];
  for (const l of listeners) l();
};
const patch = (id: string, change: Partial<QueueItem>) => {
  items = items.map((x) => (x.id === id ? { ...x, ...change } : x));
  emit();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
let running = false;
const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void run());
  window.addEventListener("offline", emit);
  // Leaving the app with uploads still running: the browser asks first.
  window.addEventListener("beforeunload", (e) => {
    if (items.some((x) => x.state === "waiting" || x.state === "uploading" || x.state === "saving")) e.preventDefault();
  });
}

export function usePhotoQueue() {
  const list = useSyncExternalStore(subscribe, () => items);
  return { items: list, offline: !online() };
}

export function enqueuePhotos(projectId: string, files: File[], options: UploadOptions) {
  const stamp = Date.now().toString(36);
  const added = files.map((file, i): QueueItem => ({
    id: `${stamp}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    projectId,
    file,
    localUrl: /^image\/(jpeg|png|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined,
    options,
    state: "waiting",
    progress: 0
  }));
  items = [...items, ...added];
  emit();
  void run();
}

export function retryPhoto(id: string) {
  items = items.map((x) => (x.id === id && x.state === "failed" ? { ...x, state: "waiting", error: undefined } : x));
  emit();
  void run();
}

export function retryAllPhotos() {
  for (const x of items.filter((i) => i.state === "failed")) retryPhoto(x.id);
}

export function clearFinishedPhotos() {
  for (const x of items) if (x.state === "done" && x.localUrl) URL.revokeObjectURL(x.localUrl);
  items = items.filter((x) => x.state !== "done");
  emit();
}

export function dropPhoto(id: string) {
  const x = items.find((i) => i.id === id);
  if (!x || (x.state !== "failed" && x.state !== "waiting")) return;
  if (x.localUrl) URL.revokeObjectURL(x.localUrl);
  items = items.filter((i) => i.id !== id);
  emit();
}

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : "The upload failed.");
const sameOptions = (a: UploadOptions, b: UploadOptions) => JSON.stringify(a) === JSON.stringify(b);

// Takes waiting photos in batches (same project and options, at most 10) until none is left.
async function run() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (!online()) {
        emit();
        return; // the "online" event starts the queue again
      }
      const first = items.find((x) => x.state === "waiting");
      if (!first) return;
      const batch = items
        .filter((x) => x.state === "waiting" && x.projectId === first.projectId && sameOptions(x.options, first.options))
        .slice(0, 10);
      await runBatch(batch);
    }
  } finally {
    running = false;
  }
}

async function runBatch(batch: QueueItem[]) {
  const projectId = batch[0]!.projectId;
  for (const x of batch) patch(x.id, { state: "uploading" });
  const current = () => batch.map((x) => items.find((i) => i.id === x.id)).filter((x): x is QueueItem => Boolean(x));

  // 1. Copies, date taken and upload links for the photos that have none yet (a ticket lasts a day).
  const fresh = current().filter((x) => !x.slot);
  if (fresh.length) {
    try {
      const prepared = await Promise.all(fresh.map(async (x) => {
        const [copies, exif] = await Promise.all([makeCopies(x.file), exifTakenAt(x.file)]);
        const takenAt = exif ?? (x.file.lastModified ? new Date(x.file.lastModified).toISOString() : undefined);
        patch(x.id, { copies, takenAt });
        return { x, copies };
      }));
      const { uploads } = await call<{ uploads: Slot[] }>({
        action: "uploadLinks",
        projectId,
        files: prepared.map(({ x, copies }) => ({
          name: x.file.name,
          contentType: photoType(x.file),
          sizeBytes: x.file.size,
          preview: copies.preview ? { contentType: "image/jpeg", sizeBytes: copies.preview.size } : undefined,
          thumb: copies.thumb ? { contentType: "image/jpeg", sizeBytes: copies.thumb.size } : undefined
        }))
      });
      prepared.forEach(({ x }, i) => patch(x.id, { slot: uploads[i] }));
    } catch (e) {
      for (const x of fresh) patch(x.id, { state: "failed", error: message(e) });
    }
  }

  // 2. The bytes: original, then both copies (a copy that fails is dropped: the ticket covers its
  //    id, and the gallery shows the original or a placeholder instead).
  await Promise.all(current().filter((x) => x.state === "uploading" && x.slot && !x.put).map(async (x) => {
    const slot = x.slot!;
    try {
      await put(slot.uploadUrl, x.file, slot.contentType, (d) => patch(x.id, { progress: d * 0.9 }));
      const copies = items.find((i) => i.id === x.id)?.copies ?? {};
      if (slot.previewUploadUrl && copies.preview) await put(slot.previewUploadUrl, copies.preview, "image/jpeg").catch(() => undefined);
      if (slot.thumbUploadUrl && copies.thumb) await put(slot.thumbUploadUrl, copies.thumb, "image/jpeg").catch(() => undefined);
      patch(x.id, { put: true, progress: 0.95 });
    } catch (e) {
      // No signal: back in the queue; it starts again when the device is online.
      patch(x.id, online() ? { state: "failed", error: message(e) } : { state: "waiting", progress: 0 });
    }
  }));

  // 3. Save the photo records, in one call.
  const ready = current().filter((x) => x.state === "uploading" && x.put && x.slot);
  if (!ready.length) return;
  for (const x of ready) patch(x.id, { state: "saving" });
  try {
    const r = await call<{ photos: Photo[] }>({
      action: "add",
      projectId,
      ...ready[0]!.options,
      photos: ready.map((x) => {
        const { uploadUrl: _u, previewUploadUrl: _p, thumbUploadUrl: _t, ...slot } = x.slot!;
        return { ...slot, takenAt: x.takenAt, width: x.copies?.width, height: x.copies?.height };
      })
    });
    ready.forEach((x, i) => patch(x.id, { state: "done", progress: 1, photo: r.photos[i], copies: undefined }));
  } catch (e) {
    for (const x of ready) patch(x.id, { state: "failed", error: message(e) });
  }
}

/** Puts photos the queue saved into the cached gallery (safe to call again). */
export function useMergeQueued(projectId?: string) {
  const queryClient = useQueryClient();
  const { items: list } = usePhotoQueue();
  useEffect(() => {
    if (!projectId) return;
    const saved = list.filter((x) => x.projectId === projectId && x.photo).map((x) => x.photo!);
    mergePhotos(queryClient, projectId, saved);
  }, [list, projectId, queryClient]);
}
