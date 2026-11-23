// In-app file viewer: PDFs page by page (pdf.js, loaded only when a PDF is opened), photos with
// fit/zoom, text and CSV files as text and a table. Other types (Word, Excel, drawings, archives)
// have no preview in the browser without sending the file to an outside service, so the viewer
// offers Download and Open in a new tab instead.
//
// The file is read with the short-lived storage link (`load`); nothing is kept after closing.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileQuestion, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Button, Dialog, Note, fmt } from "../../shared/m/ui";
import "./FileViewer.css";

export type ViewKind = "pdf" | "image" | "text" | "csv" | "none";

const IMAGE = ["jpg", "jpeg", "png", "gif", "webp"];
const TEXT = ["txt", "eml", "log", "md", "json"];

/** How a file of this type is shown in the app. */
export function viewKind(ext: string): ViewKind {
  const e = ext.toLowerCase();
  if (e === "pdf") return "pdf";
  if (IMAGE.includes(e)) return "image";
  if (e === "csv") return "csv";
  if (TEXT.includes(e)) return "text";
  return "none";
}

/**
 * Saves a file from a storage link under its real name (storage adds a code to the name it
 * keeps). Falls back to opening the link when the file can't be fetched from here.
 */
export async function saveUrlAs(url: string, fileName: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const href = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href, download: fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

const TEXT_LIMIT = 300_000; // characters shown of a text file
const CSV_ROWS = 500;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

type Props = {
  name: string;
  ext: string;
  /** Shown next to the name, e.g. the type label and version badge. */
  title?: ReactNode;
  /** Gives a fresh download link for the file. */
  load: () => Promise<string>;
  onDownload: () => void;
  onOpenTab: () => void;
  /** Extra footer buttons (e.g. Versions). */
  extra?: ReactNode;
  onClose: () => void;
};

export function FileViewer({ name, ext, title, load, onDownload, onOpenTab, extra, onClose }: Props) {
  const { t } = useT();
  const kind = viewKind(ext);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  // PDF paging and zoom live here so the controls can sit in the footer.
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(2); // index into ZOOMS; 1 = fit to width

  useEffect(() => {
    if (kind === "none") return;
    let live = true;
    load().then((u) => live && setUrl(u), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- one file per viewer

  let body: ReactNode;
  if (kind === "none") {
    body = (
      <div className="m-viewer-none">
        <FileQuestion size={36} />
        <p>{fmt(t("viewer.noPreview"), { ext: ext.toUpperCase() || "?" })}</p>
        <div className="m-row">
          <Button icon={<Download size={14} />} onClick={onDownload}>{t("doc.download")}</Button>
          <Button variant="secondary" icon={<ExternalLink size={14} />} onClick={onOpenTab}>{t("doc.open")}</Button>
        </div>
      </div>
    );
  } else if (failed) {
    body = <Note tone="warn">{t("viewer.failed")}</Note>;
  } else if (!url) {
    body = <Loading text={t("doc.opening")} />;
  } else if (kind === "pdf") {
    body = <PdfView url={url} page={page} zoom={ZOOMS[zoom]!} onPages={setPages} onFail={() => setFailed(true)} />;
  } else if (kind === "image") {
    body = <ImageView url={url} name={name} zoom={ZOOMS[zoom]!} onFail={() => setFailed(true)} />;
  } else {
    body = <TextView url={url} csv={kind === "csv"} onFail={() => setFailed(true)} />;
  }

  const zoomable = (kind === "pdf" || kind === "image") && url && !failed;
  return (
    <Dialog
      size="xl"
      title={title ?? name}
      onClose={onClose}
      footer={
        <>
          <span className="m-row m-viewer-tools">
            {kind === "pdf" && pages > 0 && !failed ? (
              <>
                <button type="button" className="m-icon-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label={t("viewer.prev")}><ChevronLeft size={16} /></button>
                <span className="m-small">{fmt(t("viewer.page"), { n: page, count: pages })}</span>
                <button type="button" className="m-icon-btn" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label={t("viewer.next")}><ChevronRight size={16} /></button>
              </>
            ) : null}
            {zoomable ? (
              <>
                <button type="button" className="m-icon-btn" onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom <= 0} aria-label={t("viewer.zoomOut")} title={t("viewer.zoomOut")}><ZoomOut size={16} /></button>
                <button type="button" className="m-link m-small" onClick={() => setZoom(2)} title={t("viewer.fit")}>{zoom === 2 ? t("viewer.fit") : `${Math.round(ZOOMS[zoom]! * 100)} %`}</button>
                <button type="button" className="m-icon-btn" onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom >= ZOOMS.length - 1} aria-label={t("viewer.zoomIn")} title={t("viewer.zoomIn")}><ZoomIn size={16} /></button>
              </>
            ) : null}
          </span>
          {extra}
          {kind !== "none" ? (
            <>
              <Button variant="secondary" icon={<ExternalLink size={14} />} onClick={onOpenTab}><span className="m-hide-mobile">{t("viewer.newTab")}</span></Button>
              <Button icon={<Download size={14} />} onClick={onDownload}>{t("doc.download")}</Button>
            </>
          ) : null}
        </>
      }
    >
      <div className={`m-viewer-stage m-viewer-${kind}`}>{body}</div>
    </Dialog>
  );
}

function Loading({ text }: { text: string }) {
  return <div className="m-viewer-loading"><Loader2 className="spin" size={22} /><span>{text}</span></div>;
}

/** Reads the whole file (with progress), so pdf.js needs no range requests to storage. */
async function fetchBytes(url: string, onProgress: (pct: number) => void) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(Math.round((got / total) * 100));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function pdfjs() {
  const lib = await import("pdfjs-dist");
  if (!lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  }
  return lib;
}

function PdfView({ url, page, zoom, onPages, onFail }: { url: string; page: number; zoom: number; onPages: (n: number) => void; onFail: () => void }) {
  const { t } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [pct, setPct] = useState(0);
  // Room inside the stage (the grey area), so "Fit" shows the whole page.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    let live = true;
    let loaded: PDFDocumentProxy | undefined;
    (async () => {
      const [lib, data] = await Promise.all([pdfjs(), fetchBytes(url, (p) => live && setPct(p))]);
      loaded = await lib.getDocument({ data, isEvalSupported: false }).promise;
      if (!live) return void loaded.destroy();
      setDoc(loaded);
      onPages(loaded.numPages);
    })().catch(() => live && onFail());
    return () => {
      live = false;
      void loaded?.destroy();
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const stage = wrap.current?.parentElement;
    if (!stage) return;
    const measure = () => {
      const cs = getComputedStyle(stage);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setBox({ w: stage.clientWidth - padX, h: stage.clientHeight - padY });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    measure();
    return () => ro.disconnect();
  }, [doc]);

  useEffect(() => {
    if (!doc || box.w <= 0 || box.h <= 0 || !canvas.current) return;
    let task: RenderTask | undefined;
    let live = true;
    setDrawing(true);
    (async () => {
      const p = await doc.getPage(Math.min(page, doc.numPages));
      if (!live || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      // Fit = the whole page in view (width and height); zoom enlarges from there.
      const fit = Math.max(0.1, Math.min(box.w / base.width, box.h / base.height));
      const viewport = p.getViewport({ scale: fit * zoom });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      task = p.render({ canvasContext: ctx, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await task.promise;
      if (live) setDrawing(false);
    })().catch((e: unknown) => {
      if ((e as { name?: string })?.name !== "RenderingCancelledException" && live) onFail();
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, page, zoom, box.w, box.h]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrap} className="m-viewer-pdf-wrap">
      {!doc ? <Loading text={pct ? fmt(t("viewer.loadingPct"), { pct }) : t("doc.opening")} /> : null}
      <canvas ref={canvas} className="m-viewer-page" style={{ display: doc ? "block" : "none", opacity: drawing ? 0.6 : 1 }} />
    </div>
  );
}

function ImageView({ url, name, zoom, onFail }: { url: string; name: string; zoom: number; onFail: () => void }) {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const fit = zoom === 1;
  return (
    <div className="m-viewer-img-wrap">
      {!ready ? <Loading text={t("doc.opening")} /> : null}
      <img
        src={url}
        alt={name}
        onLoad={() => setReady(true)}
        onError={onFail}
        className={fit ? "m-viewer-img-fit" : undefined}
        style={{ display: ready ? "block" : "none", ...(fit ? {} : { width: `${zoom * 100}%`, maxWidth: "none" }) }}
      />
    </div>
  );
}

/** Splits CSV text into rows, keeping quoted commas and line breaks. Semicolon files (German Excel) work too. */
export function parseCsv(text: string, maxRows: number) {
  const nl = text.search(/\r?\n/);
  const first = nl < 0 ? text.slice(0, 4000) : text.slice(0, nl);
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

function TextView({ url, csv, onFail }: { url: string; csv: boolean; onFail: () => void }) {
  const { t } = useT();
  const [text, setText] = useState<string>();
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((s) => live && setText(s.replace(/^﻿/, "")), () => live && onFail());
    return () => {
      live = false;
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  if (text === undefined) return <Loading text={t("doc.opening")} />;
  if (!csv) {
    return (
      <>
        <pre className="m-viewer-text">{text.slice(0, TEXT_LIMIT)}</pre>
        {text.length > TEXT_LIMIT ? <p className="m-small m-muted">{t("viewer.textCut")}</p> : null}
      </>
    );
  }
  const rows = parseCsv(text, CSV_ROWS + 1);
  const [head = [], ...rest] = rows;
  return (
    <>
      <div className="m-table-wrap m-viewer-csv">
        <table className="m-table">
          <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{rest.slice(0, CSV_ROWS).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {rest.length > CSV_ROWS ? <p className="m-small m-muted">{fmt(t("viewer.rowsCut"), { n: CSV_ROWS })}</p> : null}
    </>
  );
}
