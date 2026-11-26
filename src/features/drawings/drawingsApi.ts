// Drawings: every read and write goes through the drawings Function (functions/drawings), which
// checks the person's project role (who uploads, who pins, which pins a subcontractor sees).
//
// Upload: the browser opens each PDF with pdf.js first: it must have exactly one page, and its
// page size and a small thumbnail come from that page. Then upload links (PDF + thumbnail), the
// two PUTs to storage, and one publish call for up to 10 sheets. The dialog stays open while that
// runs (no background queue: drawings are uploaded at a desk, not on site).
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import { MAX_FILE_BYTES, put } from "../files/files";
import { pdfjs } from "../files/FileViewer";

export type DrawingCan = { upload: boolean; manage: boolean; pin: boolean; createRfi: boolean; createPunch?: boolean };
export type Discipline = { code: string; name: string };

export type RevisionStatus = "current" | "superseded" | "void";

export type RevisionSummary = {
  ItemId: string;
  revisionIndex: number;
  revisionLabel: string;
  issuedDate: string;
  status: RevisionStatus;
  uploadedByName: string;
  uploadedAt: string;
  sizeBytes: number;
  note: string;
};

export type Revision = RevisionSummary & {
  fileName: string;
  pageWidthPt: number;
  pageHeightPt: number;
  uploadedByUserId: string;
  supersededAt?: string;
  voidReason?: string;
  voidedAt?: string;
  thumbUrl?: string;
  pdfUrl?: string;
};

export type SheetRow = {
  ItemId: string;
  sheetNumber: string;
  title: string;
  discipline: string;
  setName: string;
  sortKey: string;
  version: number;
  removed: boolean;
  current?: Revision;
  revisions: RevisionSummary[];
  /** Open pins the person can see on the current revision, all of them, and the ones hidden from them. */
  pins: number;
  pinsTotal: number;
  hiddenPins: number;
};

export type SheetPin = {
  ItemId: string;
  sheetId: string;
  x: number;
  y: number;
  fromRevisionIndex: number;
  /** 0 = still shown on the newest revision. */
  toRevisionIndex: number;
  version: number;
  type: "rfi" | "punchItem" | "photo";
  recordId: string;
  number: string;
  title: string;
  status: string;
  closed: boolean;
  dueDate: string;
  ballInCourtName: string;
  /** Punch pins: the company that fixes it. */
  companyName?: string;
  /** Photo pins (a daily log photo): the log, when and by whom it was taken, image links. */
  logId?: string;
  logDate?: string;
  takenAt?: string;
  takenByName?: string;
  thumbUrl?: string;
  previewUrl?: string;
  createdByName: string;
  createdAt: string;
  canMove: boolean;
  canRemove: boolean;
  /** Only in the page: saved here, the answer is on its way. */
  saving?: boolean;
};

export type PinnableRfi = { ItemId: string; number: string; subject: string; status: string };
/** Active punch items without a pin yet. */
export type PinnablePunch = { ItemId: string; number: string; title: string; status: string; companyName: string };

type Common = { role: string; archived: boolean; can: DrawingCan; today: string; disciplines: Discipline[]; linksExpireAt: string };
export type Register = Common & { sets: string[]; sheets: SheetRow[] };
export type SheetDetail = Common & { sheet: SheetRow; revisions: Revision[]; pins: SheetPin[]; hiddenPins: number; rfis: PinnableRfi[]; punchItems?: PinnablePunch[] };

const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.drawings, body);
const listKey = (projectId?: string) => ["drawings", projectId ?? "", "list"];
const sheetKey = (projectId?: string, sheetId?: string) => ["drawings", projectId ?? "", "sheet", sheetId ?? ""];

/** Loads again just before the storage links run out (about an hour). */
function useRefreshAt(expires: string | undefined, queryKey: unknown[]) {
  const queryClient = useQueryClient();
  const k = JSON.stringify(queryKey);
  useEffect(() => {
    if (!expires) return;
    const wait = Math.max(5_000, Date.parse(expires) - Date.now());
    const timer = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey }), wait);
    return () => window.clearTimeout(timer);
  }, [expires, k]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useDrawings(projectId?: string) {
  const query = useQuery({
    queryKey: listKey(projectId),
    queryFn: () => call<Register>({ action: "list", projectId }),
    enabled: Boolean(projectId && FUNCTIONS.drawings)
  });
  useRefreshAt(query.data?.linksExpireAt, listKey(projectId));
  return query;
}

export function useSheet(projectId?: string, sheetId?: string) {
  const query = useQuery({
    queryKey: sheetKey(projectId, sheetId),
    queryFn: () => call<SheetDetail>({ action: "sheet", projectId, sheetId }),
    enabled: Boolean(projectId && sheetId && FUNCTIONS.drawings)
  });
  useRefreshAt(query.data?.linksExpireAt, sheetKey(projectId, sheetId));
  return query;
}

export function revisionLinks(projectId: string, revisionIds: string[]) {
  return call<{ links: Record<string, { thumb?: string }> }>({ action: "links", projectId, revisionIds });
}

type SheetAction =
  | { action: "updateSheet"; sheetId: string; version: number; sheetNumber?: string; title?: string; discipline?: string; setName?: string }
  | { action: "voidRevision"; sheetId: string; revisionId: string; reason: string }
  | { action: "pin"; sheetId: string; revisionIndex: number; x: number; y: number; recordType: "rfi" | "punchItem" | "photo"; recordId: string; temp: SheetPin }
  | { action: "movePin"; sheetId: string; pinId: string; revisionIndex: number; x: number; y: number }
  | { action: "removePin"; sheetId: string; pinId: string };

type ActionAnswer = Partial<SheetDetail> & { pin?: SheetPin; replacedPinId?: string; pinId?: string; sheetRemoved?: boolean };

/**
 * Changes on one sheet. Pins move, appear and disappear at once on screen (a call can wait up to
 * a minute in the Blocks queue); a refusal puts the sheet back as it was and loads it again.
 */
export function useDrawingAction(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ temp: _t, ...body }: SheetAction & { temp?: SheetPin }) => call<ActionAnswer>({ ...body, projectId }),
    onMutate: async (body) => {
      const k = sheetKey(projectId, body.sheetId);
      await queryClient.cancelQueries({ queryKey: k });
      const before = queryClient.getQueryData<SheetDetail>(k);
      queryClient.setQueryData<SheetDetail>(k, (old) => {
        if (!old) return old;
        if (body.action === "pin") return { ...old, pins: [...old.pins, { ...body.temp, saving: true }] };
        if (body.action === "movePin") {
          return {
            ...old,
            pins: old.pins.flatMap((p) => {
              if (p.ItemId !== body.pinId) return [p];
              // Placed on an older revision: it stays there, and a copy starts on this one.
              if (p.fromRevisionIndex < body.revisionIndex) {
                return [{ ...p, toRevisionIndex: body.revisionIndex - 1 }, { ...p, ItemId: `moving-${p.ItemId}`, fromRevisionIndex: body.revisionIndex, toRevisionIndex: 0, x: body.x, y: body.y, saving: true }];
              }
              return [{ ...p, x: body.x, y: body.y, saving: true }];
            })
          };
        }
        if (body.action === "removePin") return { ...old, pins: old.pins.filter((p) => p.ItemId !== body.pinId) };
        return old;
      });
      return { before };
    },
    onSuccess: (answer, body) => {
      const k = sheetKey(projectId, body.sheetId);
      if (answer.sheet && answer.revisions) {
        queryClient.setQueryData<SheetDetail>(k, (old) => (old ? { ...old, ...answer } as SheetDetail : old));
      } else if (answer.pin) {
        const saved = answer.pin;
        queryClient.setQueryData<SheetDetail>(k, (old) => {
          if (!old) return old;
          const tempId = body.action === "pin" ? body.temp.ItemId : body.action === "movePin" ? `moving-${body.pinId}` : "";
          const rest = old.pins.filter((p) => p.ItemId !== tempId && p.ItemId !== saved.ItemId);
          return { ...old, pins: [...rest, saved] };
        });
      }
      if (body.action !== "pin" && body.action !== "movePin" && body.action !== "removePin") void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
    },
    onError: (_error, body, context) => {
      const k = sheetKey(projectId, body.sheetId);
      if (context?.before) queryClient.setQueryData(k, context.before);
      void queryClient.invalidateQueries({ queryKey: k });
    },
    onSettled: (_a, _e, body) => {
      if (body.action === "pin" || body.action === "movePin" || body.action === "removePin") {
        void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
        // A punch item shows where it is pinned, and the sheet offers only unpinned items to link.
        void queryClient.invalidateQueries({ queryKey: ["punch", projectId ?? ""] });
        void queryClient.invalidateQueries({ queryKey: ["punchItem", projectId ?? ""] });
        // A log photo shows "Pinned on A-101".
        void queryClient.invalidateQueries({ queryKey: photoPinsKey(projectId) });
        if (body.action !== "movePin") void queryClient.invalidateQueries({ queryKey: sheetKey(projectId, body.sheetId) });
      }
    }
  });
}

/** After "New RFI here": shows the new pin at once; the sheet then loads again with the real one. */
export function addPendingPin(queryClient: ReturnType<typeof useQueryClient>, projectId: string, pin: SheetPin) {
  queryClient.setQueryData<SheetDetail>(sheetKey(projectId, pin.sheetId), (old) => (old ? { ...old, pins: [...old.pins, { ...pin, saving: true }] } : old));
  void queryClient.invalidateQueries({ queryKey: sheetKey(projectId, pin.sheetId) });
  void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
}

/** A pin whose record is still being saved (New punch item here): shown at once, replaced on the next read. */
export function showSavingPin(queryClient: ReturnType<typeof useQueryClient>, projectId: string, pin: SheetPin) {
  queryClient.setQueryData<SheetDetail>(sheetKey(projectId, pin.sheetId), (old) => (old ? { ...old, pins: [...old.pins, { ...pin, saving: true }] } : old));
}

/** Where a daily log photo is pinned now: the sheet and the pin, for the "Pinned on A-101" chip. */
export type PhotoPinPlace = { pinId: string; sheetId: string; sheetNumber: string };
const photoPinsKey = (projectId?: string, ids?: string[]) => ["drawings", projectId ?? "", "photoPins", ...(ids ? [ids.join(",")] : [])];

export function usePhotoPins(projectId: string | undefined, photoIds: string[]) {
  const ids = [...new Set(photoIds)].sort();
  return useQuery({
    queryKey: photoPinsKey(projectId, ids),
    queryFn: () => call<{ pins: Record<string, PhotoPinPlace> }>({ action: "photoPins", projectId, photoIds: ids }).then((r) => r.pins ?? {}),
    enabled: Boolean(projectId && ids.length && FUNCTIONS.drawings),
    staleTime: 60_000
  });
}

export function refreshDrawings(queryClient: ReturnType<typeof useQueryClient>, projectId: string, sheetIds: string[] = []) {
  void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
  for (const id of sheetIds) void queryClient.invalidateQueries({ queryKey: sheetKey(projectId, id) });
}

// ---------- reading a PDF in the browser ----------
export type PdfFacts = { pages: number; widthPt: number; heightPt: number; thumb?: Blob };

const THUMB_WIDTH = 400;
const MAX_THUMB_BYTES = 400 * 1024;

/** Page count, page size (after rotation) and a 400 px thumbnail of page 1. */
export async function readPdf(file: File): Promise<PdfFacts> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    let thumb: Blob | undefined;
    try {
      const vp = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const g = canvas.getContext("2d");
      if (g) {
        g.fillStyle = "#fff";
        g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        thumb = await new Promise<Blob | undefined>((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), "image/jpeg", 0.82));
        if (thumb && thumb.size > MAX_THUMB_BYTES) thumb = undefined;
      }
    } catch {
      thumb = undefined; // the register shows a placeholder
    }
    return { pages: doc.numPages, widthPt: base.width, heightPt: base.height, thumb };
  } finally {
    void doc.destroy();
  }
}

/** Guesses from a file name like "A-101_RevB_Ground_floor_plan.pdf". */
export function guessFromName(fileName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const num = /(?:^|[^A-Za-z0-9])([A-Za-z]{1,3})[-_ .]?(\d{1,4}(?:\.\d{1,2})?)(?=$|[^0-9])/.exec(` ${stem}`);
  const rev = /(?:^|[^A-Za-z])rev(?:ision)?[ _.-]?([A-Za-z0-9]{1,3})(?=$|[^A-Za-z0-9])/i.exec(stem);
  const letters = num?.[1] ?? "";
  const digits = num?.[2] ?? "";
  const sheetNumber = num ? `${letters.toUpperCase()}-${digits}` : "";
  let title = stem;
  if (num) title = title.replace(new RegExp(`${letters}[-_ .]?${digits.replace(".", "\\.")}`, "i"), " ");
  if (rev) title = title.replace(rev[0], " ");
  title = title.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return { sheetNumber, revisionLabel: (rev?.[1] ?? "").toUpperCase(), title: title ? title.charAt(0).toUpperCase() + title.slice(1) : "" };
}

export const sheetKeyOf = (n: string) => n.toUpperCase().replace(/\s+/g, "");

/** The discipline whose code starts the sheet number (FP-101 -> Fire protection before F…). */
export function disciplineFor(sheetNumber: string, disciplines: Discipline[]) {
  const prefix = (/^[A-Za-z]+/.exec(sheetNumber.trim())?.[0] ?? "").toUpperCase();
  const hit = [...disciplines].filter((d) => d.code).sort((a, b) => b.code.length - a.code.length).find((d) => prefix === d.code.toUpperCase());
  return hit?.name ?? "";
}

/** The label after "0" / "A" / "P2" / "03": a guess the uploader can change. */
export function nextLabel(label?: string) {
  if (!label) return "0";
  if (label === "0") return "A";
  const m = /^([A-Z]*)(\d+)$/.exec(label);
  if (m) return `${m[1] ?? ""}${String(Number(m[2]) + 1).padStart((m[2] ?? "").length, "0")}`;
  if (/^[A-Y]$/.test(label)) return String.fromCharCode(label.charCodeAt(0) + 1);
  return "";
}

// ---------- publishing ----------
export type PublishRow = {
  key: string;
  file: File;
  facts: PdfFacts;
  sheetNumber: string;
  title: string;
  discipline: string;
  setName: string;
  revisionLabel: string;
  issuedDate: string;
  note: string;
};

export type PublishResult = { key: string; ok: boolean; sheetId?: string; error?: string };

type Upload = { fileId: string; thumbFileId: string; fileName: string; sizeBytes: number; uploadedAt: string; uploadUrl: string; thumbUploadUrl?: string; ticket: string };
type PublishAnswer = { results: { fileId: string; ok: boolean; sheetId?: string; code?: string; error?: string }[] };

export const MAX_SHEET_BYTES = MAX_FILE_BYTES;
const BATCH = 10;

/** Uploads and publishes; `onProgress(key, 0..1)` per row. Each batch of 10 is one publish call. */
export async function publishSheets(projectId: string, rows: PublishRow[], onProgress: (key: string, done: number) => void): Promise<PublishResult[]> {
  const out: PublishResult[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { uploads } = await call<{ uploads: Upload[] }>({
      action: "uploadLinks",
      projectId,
      files: batch.map((r) => ({ name: r.file.name, sizeBytes: r.file.size, ...(r.facts.thumb ? { thumb: { contentType: r.facts.thumb.type, sizeBytes: r.facts.thumb.size } } : {}) }))
    });
    const slot = (j: number) => {
      const u = uploads[j];
      if (!u) throw new Error("The upload could not be prepared. Please try again.");
      return u;
    };
    await Promise.all(batch.map(async (r, j) => {
      const u = slot(j);
      await put(u.uploadUrl, r.file, "application/pdf", (d) => onProgress(r.key, d * 0.9));
      if (u.thumbUploadUrl && r.facts.thumb) await put(u.thumbUploadUrl, r.facts.thumb, r.facts.thumb.type).catch(() => undefined);
      onProgress(r.key, 0.92);
    }));
    const answer = await call<PublishAnswer>({
      action: "publish",
      projectId,
      sheets: batch.map((r, j) => {
        const { uploadUrl: _u, thumbUploadUrl: _t, ...u } = slot(j);
        return {
          ...u,
          sheetNumber: r.sheetNumber,
          title: r.title,
          discipline: r.discipline,
          setName: r.setName,
          revisionLabel: r.revisionLabel,
          issuedDate: r.issuedDate,
          note: r.note,
          pageWidthPt: r.facts.widthPt,
          pageHeightPt: r.facts.heightPt
        };
      })
    });
    batch.forEach((r, j) => {
      const res = answer.results.find((x) => x.fileId === slot(j).fileId);
      onProgress(r.key, 1);
      out.push({ key: r.key, ok: Boolean(res?.ok), sheetId: res?.sheetId, error: res?.ok ? undefined : res?.error ?? "Not published." });
    });
  }
  return out;
}
