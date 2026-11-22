// Files on records (RFIs now; punch items, daily logs and submittals later), docs/architecture/13 §4.6.
// Every file belongs to the Buildnexa service identity, not to the person: the record's Function
// hands out the upload links (after checking the person may add files there), the browser PUTs the
// bytes straight to storage, and the record is saved with the signed upload "tickets". Downloads
// are short-lived links the Function hands out with the record, only to people who may open it.
//
// What happens in the browser before upload: size and type checks (the Function checks again),
// big photos shrunk to 2560 px (site uploads over mobile data), and a small preview for photos.

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 20;
// Same list as the Function (functions/_shared/blocks.js): files that would run or render as a page.
const BLOCKED = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|mjs|jar|sh|app|dll|html?|xhtml|svg|php|hta)$/i;
const RESIZABLE = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_SIDE = 2560;
const PREVIEW_SIDE = 480;

/** A file as a record stores it (the Attachment Dto). */
export type Attachment = {
  fileId: string;
  thumbnailFileId?: string;
  fileName: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedBy?: string;
  uploadedAt?: string;
};

/** A just-uploaded file, with the signed facts the record's save needs. */
export type NewAttachment = Attachment & { ticket: string; uploadedAt: string };

/** fileId -> download link (valid for a while; the record's read hands out fresh ones). */
export type FileLinks = Record<string, string>;

/** What the Function answers for each requested upload. */
export type UploadSlot = NewAttachment & { uploadUrl: string; thumbnailUploadUrl?: string };

export type UploadRequest = { name: string; contentType: string; sizeBytes: number; thumbnail?: { contentType: string; sizeBytes: number } };

export const isImage = (a: { contentType?: string; fileName?: string }) =>
  /^image\//.test(a.contentType ?? "") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(a.fileName ?? "");

export function fileSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

/** Why a file can't be added, or undefined when it can. */
export function refusal(file: File): "type" | "size" | "empty" | undefined {
  if (BLOCKED.test(file.name)) return "type";
  if (file.size === 0) return "empty";
  if (file.size > MAX_FILE_BYTES) return "size";
  return undefined;
}

async function scaled(file: Blob, maxSide: number, type: string, quality: number): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return undefined; // a format this browser can't draw (HEIC on most desktops): sent as it is
  }
  try {
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const g = canvas.getContext("2d");
    if (!g) return undefined;
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), type, quality));
  } finally {
    bitmap.close();
  }
}

export type Prepared = { original: File; body: Blob; request: UploadRequest; preview?: Blob };

/** Shrinks big photos and makes a preview; other files go as they are. */
export async function prepare(file: File): Promise<Prepared> {
  const type = file.type || "application/octet-stream";
  let body: Blob = file;
  let preview: Blob | undefined;
  if (RESIZABLE.includes(type)) {
    const out = type === "image/png" ? "image/png" : "image/jpeg";
    const big = await scaled(file, MAX_PHOTO_SIDE, out, 0.86);
    // Only when it really got smaller (a small PNG can grow when re-encoded).
    if (big && big.size < file.size) body = big;
    preview = await scaled(file, PREVIEW_SIDE, "image/jpeg", 0.8);
  }
  return {
    original: file,
    body,
    preview,
    request: {
      name: file.name,
      contentType: body.type || type,
      sizeBytes: body.size,
      thumbnail: preview ? { contentType: "image/jpeg", sizeBytes: preview.size } : undefined
    }
  };
}

/** PUTs bytes to a storage upload link, reporting progress 0..1. */
export function put(url: string, body: Blob, contentType: string, onProgress?: (done: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-ms-blob-type", "BlockBlob");
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("upload failed (network)"));
    xhr.send(body);
  });
}

/**
 * Uploads prepared files: asks the record's Function for links (one call for all of them), then
 * PUTs each file and its preview. Answers the attachments to save with the record, in order;
 * a file whose upload failed comes back as an Error in its place.
 */
export async function upload(
  prepared: Prepared[],
  requestLinks: (files: UploadRequest[]) => Promise<UploadSlot[]>,
  onProgress?: (index: number, done: number) => void
): Promise<(NewAttachment | Error)[]> {
  const slots = await requestLinks(prepared.map((p) => p.request));
  return Promise.all(
    prepared.map(async (p, i): Promise<NewAttachment | Error> => {
      const slot = slots[i];
      if (!slot) return new Error("no upload link");
      try {
        await put(slot.uploadUrl, p.body, p.request.contentType, (d) => onProgress?.(i, d));
        // The preview is a nice-to-have: if it fails, the page shows the full photo or a file chip
        // instead (its id stays, because the signed ticket covers it).
        if (slot.thumbnailUploadUrl && p.preview) await put(slot.thumbnailUploadUrl, p.preview, "image/jpeg").catch(() => undefined);
        const { uploadUrl: _u, thumbnailUploadUrl: _t, ...attachment } = slot;
        return attachment;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })
  );
}
