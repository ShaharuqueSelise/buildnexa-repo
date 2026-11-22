// The file picker (New RFI, Edit, reply) and the file list (question, responses), from the demo
// app's AttachButton + FileChip (mock/src/mock/pages/RfisPage.tsx). Real now: upload with progress,
// photo previews, "Take photo" with the phone camera, open/download through short-lived links.
// Files can be removed before saving (and from a draft); a submitted record keeps its files.
import { Camera, FileText, Loader2, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Button, cx, fmt } from "../../shared/m/ui";
import type { ToastTone } from "../../shared/m/ui";
import { MAX_FILES, fileSize, isImage, prepare, refusal, upload } from "./files";
import type { Attachment, FileLinks, NewAttachment, UploadRequest, UploadSlot } from "./files";
import "./Attachments.css";

export type PickedFile = Attachment | NewAttachment;

type Pending = { key: string; name: string; progress: number; preview?: string; failed?: string };

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");

// Phones and tablets: offer the camera directly.
const touch = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function AttachmentPicker({ value, onChange, requestLinks, onBusyChange, lockedIds, toast, compact }: {
  value: PickedFile[];
  onChange: Dispatch<SetStateAction<PickedFile[]>>;
  requestLinks: (files: UploadRequest[]) => Promise<UploadSlot[]>;
  onBusyChange?: (busy: boolean) => void;
  /** Files that can't be removed any more (a submitted record's own files). */
  lockedIds?: string[];
  toast: (text: string, tone?: ToastTone) => void;
  compact?: boolean;
}) {
  const { t } = useT();
  const [pending, setPending] = useState<Pending[]>([]);
  // Local previews of photos just picked, so they show before any download link exists.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const busy = pending.some((p) => !p.failed);

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);
  useEffect(() => () => { for (const url of Object.values(previews)) URL.revokeObjectURL(url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const room = MAX_FILES - value.length - pending.filter((p) => !p.failed).length;
    const ok: File[] = [];
    for (const f of files) {
      const why = refusal(f);
      if (why === "type") toast(fmt(t("files.badType"), { name: f.name }), "warn");
      else if (why === "empty") toast(fmt(t("files.empty"), { name: f.name }), "warn");
      else if (why === "size") toast(fmt(t("files.tooBig"), { name: f.name, size: fileSize(f.size) }), "warn");
      else ok.push(f);
    }
    if (ok.length > room) toast(fmt(t("files.tooMany"), { count: MAX_FILES }), "warn");
    const chosen = ok.slice(0, Math.max(0, room));
    if (!chosen.length) return;

    const keys = chosen.map((f) => `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`);
    const local = chosen.map((f) => (isImage({ contentType: f.type, fileName: f.name }) && /^image\/(jpeg|png|webp|gif)$/.test(f.type) ? URL.createObjectURL(f) : undefined));
    setPending((p) => [...p, ...chosen.map((f, i) => ({ key: keys[i]!, name: f.name, progress: 0, preview: local[i] }))]);
    const mark = (key: string, patch: Partial<Pending>) => setPending((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));

    try {
      const prepared = await Promise.all(chosen.map(prepare));
      const results = await upload(prepared, requestLinks, (i, done) => mark(keys[i]!, { progress: done }));
      const added: PickedFile[] = [];
      results.forEach((r, i) => {
        const key = keys[i]!;
        if (r instanceof Error) {
          mark(key, { failed: t("files.failed") });
          return;
        }
        added.push(r);
        if (local[i]) setPreviews((p) => ({ ...p, [r.fileId]: local[i]! }));
        setPending((p) => p.filter((x) => x.key !== key));
      });
      if (added.length) onChange((prev) => [...prev, ...added]);
    } catch (error) {
      // The Function refused (too large, type, not allowed) or could not be reached.
      const message = error instanceof Error && error.message ? error.message : t("files.failed");
      for (const key of keys) mark(key, { failed: message });
      toast(message, "warn");
    }
  }

  const remove = (fileId: string) => onChange((prev) => prev.filter((a) => a.fileId !== fileId));
  const dropPending = (key: string) => setPending((p) => p.filter((x) => x.key !== key));
  const locked = new Set(lockedIds ?? []);

  return (
    <div className={cx("m-att-picker", compact && "m-att-compact")}>
      {value.length || pending.length ? (
        <div className="m-att-chips">
          {value.map((a) => (
            <span key={a.fileId} className="m-file" title={a.fileName}>
              {previews[a.fileId] ? <img className="m-att-mini" src={previews[a.fileId]} alt="" /> : <span className="m-file-ext">{ext(a.fileName)}</span>}
              <span className="m-att-name">{a.fileName}</span>
              <span className="m-muted">{fileSize(a.sizeBytes)}</span>
              {locked.has(a.fileId) ? null : (
                <button type="button" className="m-icon-btn" onClick={() => remove(a.fileId)} aria-label={fmt(t("files.remove"), { name: a.fileName })}><X size={12} /></button>
              )}
            </span>
          ))}
          {pending.map((p) => (
            <span key={p.key} className={cx("m-file", p.failed && "m-att-failed")} title={p.failed ?? p.name}>
              {p.preview ? <img className="m-att-mini" src={p.preview} alt="" /> : p.failed ? <span className="m-file-ext">{ext(p.name)}</span> : <Loader2 className="spin" size={13} />}
              <span className="m-att-name">{p.name}</span>
              <span className="m-muted">{p.failed ? t("files.failedShort") : fmt(t("files.uploading"), { pct: Math.round(p.progress * 100) })}</span>
              {p.failed ? <button type="button" className="m-icon-btn" onClick={() => dropPending(p.key)} aria-label={fmt(t("files.remove"), { name: p.name })}><X size={12} /></button> : null}
            </span>
          ))}
        </div>
      ) : null}
      <div className="m-row m-row-wrap">
        <Button type="button" variant="secondary" small icon={<Paperclip size={14} />} onClick={() => fileInput.current?.click()}>
          {compact ? t("rfi.attach") : t("files.add")}
        </Button>
        {touch() ? (
          <Button type="button" variant="secondary" small icon={<Camera size={14} />} onClick={() => cameraInput.current?.click()}>{t("files.takePhoto")}</Button>
        ) : null}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
      </div>
    </div>
  );
}

/** A record's files: photos as previews, everything else as chips; both open the file. */
export function AttachmentList({ items, links }: { items?: Attachment[]; links?: FileLinks }) {
  const { t } = useT();
  if (!items?.length) return null;
  const photos = items.filter((a) => isImage(a) && links?.[a.thumbnailFileId || a.fileId]);
  const others = items.filter((a) => !photos.includes(a));
  return (
    <div className="m-att-list">
      {photos.length ? (
        <div className="m-att-photos">
          {photos.map((a) => (
            <a key={a.fileId} className="m-att-photo" href={links?.[a.fileId]} target="_blank" rel="noopener noreferrer" title={fmt(t("files.open"), { name: a.fileName })}>
              <img src={links?.[a.thumbnailFileId || a.fileId]} alt={a.fileName} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {others.length ? (
        <div className="m-att-chips">
          {others.map((a) => {
            const href = links?.[a.fileId];
            const inner = (
              <>
                {isImage(a) ? <span className="m-file-ext">{ext(a.fileName)}</span> : a.contentType === "application/pdf" ? <span className="m-file-ext">PDF</span> : <FileText size={14} />}
                <span className="m-att-name">{a.fileName}</span>
                <span className="m-muted">{fileSize(a.sizeBytes)}</span>
              </>
            );
            return href ? (
              <a key={a.fileId} className="m-file m-att-link" href={href} target="_blank" rel="noopener noreferrer" title={fmt(t("files.open"), { name: a.fileName })}>{inner}</a>
            ) : (
              <span key={a.fileId} className="m-file" title={t("files.noLink")}>{inner}</span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
