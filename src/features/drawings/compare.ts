// Revision impact: compares a new revision with the one before it, in the browser of someone who
// uploads drawings, and saves the changed areas on the revision (drawings Function, saveChanges).
// It runs right after publishing, and again when such a person opens a sheet whose newest revision
// was never compared (the uploader closed the tab, say). The first saved result wins.
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { FUNCTIONS, callFunction } from "../../lib/blocks/functions";
import { fetchBytes, pdfjs } from "../files/FileViewer";
import { compareMasks, inkMask, type CompareResult, type Mask } from "./compareCore";
import { refreshDrawings, type SheetDetail } from "./drawingsApi";

const RENDER_WIDTH = 1600;

/** Page 1 of a PDF as an ink mask, RENDER_WIDTH pixels wide. */
async function renderMask(data: Uint8Array): Promise<Mask> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: RENDER_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("No canvas");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = 0; // let the memory go
    return inkMask(img.data, img.width, img.height);
  } finally {
    void doc.destroy();
  }
}

export async function comparePdfs(older: Uint8Array, newer: Uint8Array): Promise<CompareResult> {
  const a = await renderMask(older);
  const b = await renderMask(newer);
  return compareMasks(a, b);
}

// ---------- one comparison at a time, shared by the upload dialog and the viewer ----------
const running = new Set<string>();
const tried = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let queue: Promise<unknown> = Promise.resolve();

/** True while this revision is being compared in this tab. */
export function useComparing(revisionId?: string) {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => Boolean(revisionId && running.has(revisionId))
  );
}

/** `detail`: the sheet as the viewer has it (saves a Function call, which can wait in the Blocks queue). */
type Job = { projectId: string; sheetId: string; revisionId: string; newFile?: Blob; detail?: SheetDetail; queryClient: QueryClient; force?: boolean };

/**
 * Compares the revision with the one before it and saves the result. Runs each revision once per
 * tab unless `force` (Compare again after a failure). Never throws: a failure is saved as "failed",
 * and a failed save leaves the revision pending for the next person.
 */
export function compareRevision(job: Job): Promise<void> {
  if (running.has(job.revisionId) || (tried.has(job.revisionId) && !job.force)) return Promise.resolve();
  running.add(job.revisionId);
  tried.add(job.revisionId);
  emit();
  const work = queue.then(() => run(job)).finally(() => {
    running.delete(job.revisionId);
    emit();
    refreshDrawings(job.queryClient, job.projectId, [job.sheetId]);
  });
  queue = work.catch(() => undefined);
  return work.catch(() => undefined);
}

async function run({ projectId, sheetId, revisionId, newFile, detail: known }: Job) {
  const call = <T,>(body: Record<string, unknown>) => callFunction<T>(FUNCTIONS.drawings, { ...body, projectId });
  const fresh = known && Date.parse(known.linksExpireAt) - Date.now() > 120_000 && known.impact?.revisionId === revisionId;
  const detail = fresh ? known : await call<SheetDetail>({ action: "sheet", sheetId });
  const impact = detail.impact;
  if (!impact || impact.revisionId !== revisionId || (impact.state !== "pending" && impact.state !== "failed")) return;
  const newer = detail.revisions.find((r) => r.ItemId === revisionId);
  const older = detail.revisions.find((r) => r.revisionIndex === impact.previousIndex);
  let result: CompareResult | { status: "failed"; areas: [] };
  try {
    if (!older?.pdfUrl || (!newFile && !newer?.pdfUrl)) throw new Error("No PDF link");
    const [a, b] = await Promise.all([
      fetchBytes(older.pdfUrl, () => undefined),
      newFile ? newFile.arrayBuffer().then((x) => new Uint8Array(x)) : fetchBytes(newer!.pdfUrl!, () => undefined)
    ]);
    result = await comparePdfs(a, b);
  } catch {
    result = { status: "failed", areas: [] };
  }
  if (result.status === "failed" && impact.state === "failed") return;
  await call({ action: "saveChanges", revisionId, status: result.status, areas: result.areas });
}
