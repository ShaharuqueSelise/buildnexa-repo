// Sheet viewer (DRW-03, DRW-04), built from the demo app's SheetViewer: the PDF drawn by pdf.js on a
// canvas with zoom and pan (wheel, buttons, drag, pinch, double click), pins of RFIs (blue) and punch
// items (orange) and daily log photos (teal, camera) on it, "Add pin" (New RFI here, New punch item here, or pin an existing RFI or punch
// item), move and remove pins, the revision switcher with the red "Superseded" banner, and the side
// panel (revisions, pins, info). ?placePhoto=<photoId> (from "Pin on a drawing" on a log photo) makes the next tap pin that photo.
// The page is drawn again at a higher resolution after zooming in, within a pixel budget that is
// smaller on phones. Pins sit in page coordinates (0..1), so they stay on the spot at any zoom.
// Not real yet: compare (R2), markups and offline sheets (R3).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  AlertTriangle, ArrowLeft, Ban, Camera, ClipboardCheck, Cloud, Columns2, Download, FileQuestion, Link2, Loader2, Lock, MapPin, Maximize2, Move,
  MoveUpRight, Pencil, Ruler, Trash, Type, Upload, WifiOff, ZoomIn, ZoomOut
} from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useQueryClient } from "@tanstack/react-query";
import { projectCan } from "../../lib/permissions";
import { todayIso } from "../../lib/workdays";
import {
  Badge, Button, Checkbox, Dialog, Field, KeyValue, Note, ReleaseTag, Select, Tabs, Timeline, cx, fmt
} from "../../shared/m/ui";
import type { Tone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { fileSize } from "../files/files";
import { fetchBytes, pdfjs, saveUrlAs } from "../files/FileViewer";
import { RfiFormDialog, makeRfiCtx } from "../rfis/RfisPage";
import { PunchHereDialog } from "../punch/PunchPage";
import { addPendingPin, refreshDrawings, showSavingPin, useDrawingAction, useSheet } from "./drawingsApi";
import type { Revision, SheetDetail, SheetPin } from "./drawingsApi";
import { DEFAULT_SET, UploadDialog, errorText } from "./DrawingsPage";
import type { T, Toast } from "./DrawingsPage";
import { SkeletonPage } from "../../shared/m/Skeleton";

const PAPER_W = 1200; // the page's width on the stage at 100 %; its height follows the page size
const RFI_TONE: Record<string, Tone> = { draft: "gray", open: "blue", answered: "amber", closed: "green" };
const PUNCH_TONE: Record<string, Tone> = { open: "blue", inProgress: "amber", readyForReview: "purple", closed: "green" };
const PIN_COLOR = { rfi: "#2563eb", punchItem: "#ea580c", photo: "#0d9488" } as const;
const isPunch = (p: SheetPin) => p.type === "punchItem";
const isPhoto = (p: SheetPin) => p.type === "photo";
const toneOf = (p: SheetPin): Tone => (isPhoto(p) ? "teal" : (isPunch(p) ? PUNCH_TONE : RFI_TONE)[p.status] ?? "gray");
const statusOf = (t: T, p: SheetPin) => (isPhoto(p) ? t("drw.photo.badge") : t((isPunch(p) ? `punch.status.${p.status}` : `rfi.status.${p.status}`) as never) || p.status);
const labelOf = (t: T, p: SheetPin) => (isPhoto(p) ? t("drw.photo.label") : p.number || t(isPunch(p) ? "drw.v.newPunch" : "drw.v.draftRfi"));
/** "a site photo" for photo pins in toasts, the record number for the rest. */
const nameOf = (t: T, p: SheetPin) => (isPhoto(p) ? t("drw.photo.aPhoto") : p.number);
const dayOf = (iso?: string) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "");
const whenOf = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

type View = { s: number; tx: number; ty: number };
type SideTab = "revisions" | "pins" | "info";

const query = () => new URLSearchParams(window.location.search);
const aspect = (r?: Revision) => (r && r.pageWidthPt > 0 ? r.pageHeightPt / r.pageWidthPt : 0);
const onRevision = (p: SheetPin, index: number) => p.fromRevisionIndex <= index && (!p.toRevisionIndex || index <= p.toRevisionIndex);
const digitsOf = (number: string) => number.replace(/^\D+-0*/, "") || "?";

// ---------- the PDF on a canvas ----------
function PdfSheet({ url, paperW, paperH, scale, t }: { url: string; paperW: number; paperH: number; scale: number; t: T }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [pct, setPct] = useState(0);
  const [failed, setFailed] = useState(false);
  const [want, setWant] = useState(0);
  const [drawn, setDrawn] = useState(false);
  const rendered = useRef(0);

  useEffect(() => {
    let live = true;
    let loaded: PDFDocumentProxy | undefined;
    setDoc(undefined);
    setFailed(false);
    setDrawn(false);
    setPct(0);
    rendered.current = 0;
    (async () => {
      const [lib, data] = await Promise.all([pdfjs(), fetchBytes(url, (p) => live && setPct(p))]);
      loaded = await lib.getDocument({ data, isEvalSupported: false }).promise;
      if (!live) return void loaded.destroy();
      setDoc(loaded);
    })().catch(() => live && setFailed(true));
    return () => {
      live = false;
      void loaded?.destroy();
    };
  }, [url]);

  // The resolution to draw at: enough for the zoom, within a pixel budget (smaller on phones).
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    const maxPixels = coarse ? 8_000_000 : 16_000_000;
    const maxW = Math.floor(Math.sqrt((maxPixels * paperW) / paperH));
    const target = Math.round(Math.min(maxW, Math.max(1200, paperW * scale * dpr)));
    const timer = window.setTimeout(() => {
      if (!rendered.current || Math.abs(target - rendered.current) / rendered.current > 0.25) setWant(target);
    }, rendered.current ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [scale, paperW, paperH]);

  useEffect(() => {
    if (!doc || !want) return;
    let live = true;
    let task: RenderTask | undefined;
    (async () => {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: want / base.width });
      const off = document.createElement("canvas");
      off.width = Math.round(vp.width);
      off.height = Math.round(vp.height);
      const g = off.getContext("2d");
      if (!g) throw new Error("no canvas");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, off.width, off.height);
      task = page.render({ canvasContext: g, viewport: vp });
      await task.promise;
      const c = canvasRef.current;
      if (!live || !c) return;
      c.width = off.width;
      c.height = off.height;
      c.getContext("2d")?.drawImage(off, 0, 0);
      off.width = 0;
      rendered.current = want;
      setDrawn(true);
    })().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, want]);

  return (
    <>
      <canvas ref={canvasRef} className="m-drw-sheet" style={{ width: paperW, height: paperH }} />
      {!drawn ? (
        <div className="m-drw-sheet-wait" style={{ width: paperW, height: paperH }}>
          {failed ? <><AlertTriangle size={30} /><span>{t("drw.v.failed")}</span></> : <><Loader2 className="spin" size={30} /><span>{pct ? fmt(t("drw.v.loadingPct"), { pct }) : t("drw.v.loading")}</span></>}
        </div>
      ) : null}
    </>
  );
}

function PinMarker({ pin, selected, scale, paperW, paperH, warn, onSelect }: {
  pin: SheetPin; selected: boolean; scale: number; paperW: number; paperH: number; warn: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cx("m-drw-pin", isPhoto(pin) ? "m-drw-pin-photo" : isPunch(pin) ? "m-drw-pin-punch" : "m-drw-pin-rfi", pin.closed && "m-drw-pin-closed", selected && "m-drw-pin-sel", pin.saving && "m-drw-pin-saving")}
      style={{ left: pin.x * paperW, top: pin.y * paperH, transform: `translate(-50%, -100%) scale(${1 / scale})` }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      title={isPhoto(pin) ? `${pin.title || "Photo"} · ${dayOf(pin.logDate)}` : `${pin.number} · ${pin.title}`}
      aria-label={isPhoto(pin) ? `Photo ${pin.title}` : `${pin.number} ${pin.title}`}
    >
      <svg width={28} height={34} viewBox="0 0 28 34"><path d="M14 33 C14 33 2 20 2 12 A12 12 0 0 1 26 12 C26 20 14 33 14 33 Z" fill="currentColor" stroke="#fff" strokeWidth={2} /></svg>
      {isPhoto(pin) ? <Camera size={12} className="m-drw-pin-icon" /> : <b>{digitsOf(pin.number)}</b>}
      {warn ? <i className="m-drw-pin-warn">!</i> : null}
    </button>
  );
}

// ---------- the viewer ----------
export function SheetViewer({ projectId, sheetId, onNavigate, toast, t }: { projectId: string; sheetId: string; onNavigate: (path: string) => void; toast: Toast; t: T }) {
  const sheetQuery = useSheet(projectId, sheetId);
  const data = sheetQuery.data;
  if (!data) {
    if (sheetQuery.error) {
      return (
        <div>
          <Button variant="ghost" small icon={<ArrowLeft size={15} />} onClick={() => onNavigate("/drawings")}>{t("drw.title")}</Button>
          <Note tone="danger">{errorText(t, sheetQuery.error)}</Note>
        </div>
      );
    }
    return <SkeletonPage kind="sheet" label={t("common.loading")} />;
  }
  return <Viewer projectId={projectId} data={data} onNavigate={onNavigate} toast={toast} t={t} />;
}

function Viewer({ projectId, data, onNavigate, toast, t }: { projectId: string; data: SheetDetail; onNavigate: (path: string) => void; toast: Toast; t: T }) {
  const queryClient = useQueryClient();
  const action = useDrawingAction(projectId);
  const { ws, project, myUserId, myRole } = useProjects();
  const { sheet, revisions, can } = data;
  const current = revisions.find((r) => r.status === "current");
  const [revIndex, setRevIndex] = useState<number | undefined>(() => {
    const n = Number(query().get("rev"));
    return Number.isInteger(n) && n > 0 ? n : undefined;
  });
  const viewed = revisions.find((r) => r.revisionIndex === (revIndex ?? current?.revisionIndex)) ?? current ?? revisions[0];
  const isCurrent = viewed?.status === "current";
  const R = viewed?.revisionIndex ?? 0;
  const paperH = Math.round(PAPER_W * (aspect(viewed) || 0.7071));

  const [view, setView] = useState<View>({ s: 0.5, tx: 0, ty: 0 });
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [addMode, setAddMode] = useState(false);
  const [moving, setMoving] = useState<string>();
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [selPin, setSelPin] = useState<string | null>(() => query().get("pin"));
  const [tab, setTab] = useState<SideTab>(() => (query().get("pin") ? "pins" : "revisions"));
  const [showClosed, setShowClosed] = useState(true);
  const [showRfi, setShowRfi] = useState(true);
  const [showPunch, setShowPunch] = useState(true);
  const [showPhoto, setShowPhoto] = useState(true);
  // "Pin on a drawing" from a daily log photo: the next tap on the sheet pins that photo.
  const [placePhoto, setPlacePhoto] = useState<string | null>(() => query().get("placePhoto"));
  const [linkWhat, setLinkWhat] = useState(""); // "rfi:<id>" | "punchItem:<id>"
  const [rfiDialog, setRfiDialog] = useState<{ x: number; y: number } | null>(null);
  const [punchDialog, setPunchDialog] = useState<{ x: number; y: number } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [voiding, setVoiding] = useState<Revision>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: 0, dist: 0 });
  const touched = useRef(false); // the user zoomed or panned: keep their view when the canvas resizes
  const popRef = useRef<HTMLDivElement>(null);
  const [popMeasured, setPopMeasured] = useState(0); // the pin menu's real height (notes make it taller)

  // Keeps the address shareable without a reload: /drawings/<id>[?rev=n].
  useEffect(() => {
    const q = revIndex && revIndex !== current?.revisionIndex ? `?rev=${revIndex}` : "";
    const path = `/drawings/${encodeURIComponent(sheet.ItemId)}${q}`;
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.replaceState(null, "", path);
  }, [revIndex, current?.revisionIndex, sheet.ItemId]);

  // ----- pins on the revision in view -----
  // A voided revision shows no file, so no pins either (they live on the revisions that are still valid).
  const onThis = viewed?.status === "void" ? [] : data.pins.filter((p) => onRevision(p, R));
  const shown = onThis.filter((p) => (showClosed || !p.closed) && (isPhoto(p) ? showPhoto : isPunch(p) ? showPunch : showRfi));
  const punchCount = onThis.filter(isPunch).length;
  const photoCount = onThis.filter(isPhoto).length;
  const rfiCount = onThis.length - punchCount - photoCount;
  const fromAspect = (p: SheetPin) => aspect(revisions.find((r) => r.revisionIndex === p.fromRevisionIndex));
  const outOfPlace = (p: SheetPin) => {
    const a = fromAspect(p);
    const b = aspect(viewed);
    return Boolean(a && b && Math.abs(a - b) / b > 0.01);
  };
  const misplaced = onThis.filter(outOfPlace).length;
  const pinnedIds = new Set(data.pins.filter((p) => onRevision(p, current?.revisionIndex ?? 0)).map((p) => p.recordId));
  // Only open RFIs and active punch items without a pin are offered; a closed one keeps the pins it has.
  const linkable = [
    ...data.rfis.filter((r) => r.status !== "closed" && !pinnedIds.has(r.ItemId)).map((r) => ({ value: `rfi:${r.ItemId}`, label: `${r.number} · ${r.subject}` })),
    ...(data.punchItems ?? []).filter((i) => !pinnedIds.has(i.ItemId)).map((i) => ({ value: `punchItem:${i.ItemId}`, label: `${i.number} · ${i.title}${i.companyName ? ` · ${i.companyName}` : ""}` }))
  ];

  // ----- view maths -----
  const fit = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const s = Math.min(cw / PAPER_W, ch / paperH) * 0.95;
    setView({ s, tx: (cw - PAPER_W * s) / 2, ty: (ch - paperH * s) / 2 });
  }, [paperH]);

  const zoomAt = useCallback((px: number, py: number, f: number) => {
    touched.current = true;
    setView((v) => {
      const s = Math.max(0.08, Math.min(12, v.s * f));
      const k = s / v.s;
      return { s, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
    });
  }, []);

  const focusOn = useCallback((x: number, y: number) => {
    const el = canvasRef.current;
    if (!el) return;
    touched.current = true;
    setView((v) => {
      const s = Math.max(v.s, 1.2);
      return { s, tx: el.clientWidth / 2 - x * PAPER_W * s, ty: el.clientHeight / 2 - y * paperH * s };
    });
  }, [paperH]);

  useLayoutEffect(() => {
    touched.current = false;
    fit();
    const el = canvasRef.current;
    if (el) setSize({ w: el.clientWidth, h: el.clientHeight });
    const p = selPin ? data.pins.find((x) => x.ItemId === selPin) : undefined;
    if (p) focusOn(p.x, p.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.ItemId, R, paperH]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      if (!touched.current) fit();
    });
    ro.observe(el);
    return () => { el.removeEventListener("wheel", onWheel); ro.disconnect(); };
  }, [zoomAt, fit]);

  useEffect(() => {
    if (!addMode && !draft && !moving && !selPin && !placePhoto) return;
    // Esc backs out of whatever is open on the sheet: add mode, a draft pin, a move, placing a photo, or an open pin menu.
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setAddMode(false); setDraft(null); setMoving(undefined); setSelPin(null); setConfirmRemove(false); setPlacePhoto(null); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [addMode, draft, moving, selPin, placePhoto]);

  const zoomCenter = (f: number) => zoomAt(size.w / 2, size.h / 2, f);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* released already */ }
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 1) gesture.current.moved = 0;
    if (ptrs.current.size === 2) {
      const [a, b] = Array.from(ptrs.current.values());
      if (a && b) gesture.current.dist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = ptrs.current.get(e.pointerId);
    if (!prev) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      gesture.current.moved += Math.abs(dx) + Math.abs(dy);
      if (gesture.current.moved > 5) touched.current = true;
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    } else if (ptrs.current.size === 2) {
      const [a, b] = Array.from(ptrs.current.values());
      const el = canvasRef.current;
      if (!a || !b || !el) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const r = el.getBoundingClientRect();
      if (gesture.current.dist > 0) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, dist / gesture.current.dist);
      gesture.current.dist = dist;
      gesture.current.moved += 10;
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const single = ptrs.current.size === 1;
    ptrs.current.delete(e.pointerId);
    if (!single || gesture.current.moved > 5) return;
    // a tap
    const st = stageRef.current?.getBoundingClientRect();
    const x = st ? (e.clientX - st.left) / st.width : -1;
    const y = st ? (e.clientY - st.top) / st.height : -1;
    const onSheet = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (moving) {
      if (!onSheet) { toast(t("drw.v.onSheet"), "warn"); return; }
      const pin = data.pins.find((p) => p.ItemId === moving);
      setMoving(undefined);
      if (!pin || !current) return;
      action.mutateAsync({ action: "movePin", sheetId: sheet.ItemId, pinId: pin.ItemId, revisionIndex: current.revisionIndex, x, y })
        .then(() => toast(fmt(t("drw.v.moved"), { number: nameOf(t, pin) })))
        .catch((error) => toast(errorText(t, error), "warn"));
      return;
    }
    if (placePhoto) {
      if (!onSheet) { toast(t("drw.v.onSheet"), "warn"); return; }
      if (!current || !can.pin || !isCurrent) return;
      const photoId = placePhoto;
      setPlacePhoto(null);
      const temp: SheetPin = {
        ItemId: `temp-${Date.now().toString(36)}`, sheetId: sheet.ItemId, x, y, fromRevisionIndex: current.revisionIndex, toRevisionIndex: 0, version: 0,
        type: "photo", recordId: photoId, number: "", title: "", status: "", closed: false, dueDate: "", ballInCourtName: "",
        createdByName: "", createdAt: new Date().toISOString(), canMove: false, canRemove: false
      };
      action.mutateAsync({ action: "pin", sheetId: sheet.ItemId, revisionIndex: current.revisionIndex, x, y, recordType: "photo", recordId: photoId, temp })
        .then((answer) => {
          toast(fmt(t("drw.photo.pinned"), { sheet: sheet.sheetNumber }));
          if (answer.pin) { setSelPin(answer.pin.ItemId); setTab("pins"); }
        })
        .catch((error) => toast(errorText(t, error), "warn"));
      return;
    }
    if (addMode) {
      if (!onSheet) { toast(t("drw.v.onSheet"), "warn"); return; }
      setSelPin(null);
      setLinkWhat("");
      setDraft({ x, y });
      return;
    }
    setSelPin(null);
    setDraft(null);
    setConfirmRemove(false);
  };

  // ----- popover anchor -----
  const selected = shown.find((p) => p.ItemId === selPin) ?? onThis.find((p) => p.ItemId === selPin);
  const anchor = selected ? { x: selected.x, y: selected.y } : draft;
  let popStyle: CSSProperties | undefined;
  if (anchor) {
    const ax = view.tx + anchor.x * PAPER_W * view.s;
    const ay = view.ty + anchor.y * paperH * view.s;
    const popW = size.w < 520 ? 250 : 300;
    const left = Math.max(8, Math.min(size.w - popW - 8, ax - popW / 2));
    // Below the pin when it fits, else above it, else beside it (left or right) so it never covers the pin.
    const popH = popMeasured || (selected ? 230 : 250);
    const beside = ax + 24 + popW <= size.w - 8 ? ax + 24 : Math.max(8, ax - 24 - popW);
    popStyle = ay + 10 + popH <= size.h - 8 ? { left, top: ay + 10 }
      : ay - 40 - popH >= 8 ? { left, bottom: size.h - ay + 40 }
      : { left: beside, top: Math.max(8, Math.min(size.h - popH - 8, ay - popH / 2)) };
  }
  // After each render, read the menu's full height so the placement above uses it instead of a guess.
  useLayoutEffect(() => {
    const h = popRef.current?.scrollHeight ?? 0;
    if (Math.abs(h - popMeasured) > 2) setPopMeasured(h);
  });

  const pinExisting = () => {
    if (!draft || !current || !linkWhat) return;
    const [kind, id] = linkWhat.split(":") as ["rfi" | "punchItem", string];
    const rfi = kind === "rfi" ? data.rfis.find((r) => r.ItemId === id) : undefined;
    const item = kind === "punchItem" ? data.punchItems?.find((i) => i.ItemId === id) : undefined;
    const rec = rfi ? { number: rfi.number, title: rfi.subject, status: rfi.status } : item ? { number: item.number, title: item.title, status: item.status } : undefined;
    if (!rec) return;
    const temp: SheetPin = {
      ItemId: `temp-${Date.now().toString(36)}`, sheetId: sheet.ItemId, x: draft.x, y: draft.y, fromRevisionIndex: current.revisionIndex, toRevisionIndex: 0, version: 0,
      type: kind, recordId: id, ...rec, closed: rec.status === "closed", dueDate: "", ballInCourtName: "", companyName: item?.companyName,
      createdByName: "", createdAt: new Date().toISOString(), canMove: false, canRemove: false
    };
    setDraft(null);
    setAddMode(false);
    action.mutateAsync({ action: "pin", sheetId: sheet.ItemId, revisionIndex: current.revisionIndex, x: temp.x, y: temp.y, recordType: kind, recordId: id, temp })
      .then(() => toast(fmt(t("drw.v.pinned"), { number: rec.number, sheet: sheet.sheetNumber })))
      .catch((error) => toast(errorText(t, error), "warn"));
  };

  // New punch item here: the pin shows at once while the item saves in the background.
  const punchSaving = (at: { x: number; y: number }, saving: Promise<unknown>, title: string) => {
    if (!current) return;
    showSavingPin(queryClient, projectId, {
      ItemId: `saving-${Date.now().toString(36)}`, sheetId: sheet.ItemId, x: at.x, y: at.y, fromRevisionIndex: current.revisionIndex, toRevisionIndex: 0, version: 0,
      type: "punchItem", recordId: "", number: "", title, status: "open", closed: false, dueDate: "", ballInCourtName: "", createdByName: "",
      createdAt: new Date().toISOString(), canMove: false, canRemove: false
    });
    setTab("pins");
    void saving.then(() => undefined, () => undefined).then(() => refreshDrawings(queryClient, projectId, [sheet.ItemId]));
  };

  const removePin = (pin: SheetPin) => {
    setSelPin(null);
    setConfirmRemove(false);
    action.mutateAsync({ action: "removePin", sheetId: sheet.ItemId, pinId: pin.ItemId })
      .then(() => toast(fmt(t("drw.v.unpinned"), { number: nameOf(t, pin) })))
      .catch((error) => toast(errorText(t, error), "warn"));
  };

  const download = (r?: Revision) => {
    if (!r?.pdfUrl) return;
    void saveUrlAs(r.pdfUrl, `${sheet.sheetNumber}_rev${r.revisionLabel}.pdf`).catch(() => toast(t("drw.v.downloadFailed"), "warn"));
  };

  // RFI form (New RFI here) needs the projects workspace.
  const rfiCtx = useMemo(() => {
    if (!ws || !project) return undefined;
    const team = ws.team.filter((r) => r.projectId === project.ItemId && r.status === "active");
    return makeRfiCtx({ t, ws, project, team, myUserId, myRole, today: todayIso(), toast, onNavigate });
  }, [ws, project, myUserId, myRole, t, toast, onNavigate]);

  const pinReason = !can.pin
    ? data.archived ? t("drw.archived") : t("drw.v.pinWho")
    : !isCurrent ? t("drw.v.pinCurrentOnly") : "";

  const revOptions = revisions.map((r) => ({
    value: String(r.revisionIndex),
    label: `${fmt(t("drw.rev"), { label: r.revisionLabel })} · ${fmtShortDate(r.issuedDate)}${r.status === "current" ? ` (${t("drw.current")})` : r.status === "void" ? ` (${t("drw.void")})` : ""}`
  }));
  const viewRev = (index: number) => {
    setRevIndex(index === current?.revisionIndex ? undefined : index);
    setDraft(null);
    setAddMode(false);
    setMoving(undefined);
    setSelPin(null);
  };

  const sideNote = myRole === "project-manager" || myRole === "document-controller"
    ? t("drw.v.roleManager")
    : can.upload ? t("drw.v.roleDesigner") : can.pin ? t("drw.v.rolePinner") : t("drw.v.roleViewer");

  return (
    <div className="m-drw-page">
      <div className="m-drw-viewer-head">
        <button type="button" className="m-link m-small" onClick={() => onNavigate("/drawings")}><ArrowLeft size={14} style={{ display: "inline", verticalAlign: -2 }} /> {t("drw.title")}</button>
        <h1><span className="m-mono">{sheet.sheetNumber}</span> · {sheet.title}</h1>
        <Badge tone="gray">{sheet.discipline}</Badge>
        <Badge tone="blue">{sheet.setName || DEFAULT_SET}</Badge>
        {viewed?.status === "void" ? <Badge tone="red">{t("drw.void")}</Badge> : isCurrent ? <Badge tone="green">{t("drw.current")}</Badge> : <Badge tone="red">{t("drw.superseded")}</Badge>}
        <span className="m-drw-spacer" />
        <span style={{ minWidth: 200 }}><Select value={String(R)} onChange={(v) => viewRev(Number(v))} options={revOptions} /></span>
        <Button variant="secondary" small icon={<Download size={14} />} onClick={() => download(viewed)} disabled={!viewed?.pdfUrl}>PDF</Button>
        {can.upload ? <Button small icon={<Upload size={14} />} onClick={() => setUploadOpen(true)}>{t("drw.v.newRevision")}</Button> : null}
      </div>

      {viewed && viewed.status === "superseded" && current ? (
        <div className="m-drw-banner" role="alert">
          <span>{fmt(t("drw.v.banner"), { current: current.revisionLabel, date: fmtDate(current.issuedDate), viewing: viewed.revisionLabel })}</span>
          <button type="button" onClick={() => viewRev(current.revisionIndex)}>{fmt(t("drw.v.openCurrent"), { label: current.revisionLabel })}</button>
        </div>
      ) : null}
      {viewed?.status === "void" ? (
        <div className="m-drw-banner" role="alert">
          <span>{fmt(t("drw.v.voidBanner"), { label: viewed.revisionLabel, reason: viewed.voidReason || "—" })}</span>
          {current ? <button type="button" onClick={() => viewRev(current.revisionIndex)}>{fmt(t("drw.v.openCurrent"), { label: current.revisionLabel })}</button> : null}
        </div>
      ) : null}

      <div className="m-drw-viewer">
        <div className="m-drw-main">
          <div className="m-drw-toolbar">
            <button type="button" className="m-drw-tool" onClick={() => zoomCenter(1 / 1.25)} aria-label={t("drw.v.zoomOut")}><ZoomOut size={16} /></button>
            <span className="m-drw-zoom">{Math.round(view.s * 100)} %</span>
            <button type="button" className="m-drw-tool" onClick={() => zoomCenter(1.25)} aria-label={t("drw.v.zoomIn")}><ZoomIn size={16} /></button>
            <button type="button" className="m-drw-tool" onClick={fit}><Maximize2 size={15} /> {t("drw.v.fit")}</button>
            <button
              type="button"
              className={cx("m-drw-tool", addMode && "m-drw-tool-on")}
              disabled={Boolean(pinReason)}
              title={pinReason || t("drw.v.addPinHint")}
              onClick={() => { setAddMode((v) => !v); setDraft(null); setSelPin(null); setMoving(undefined); }}
            ><MapPin size={15} /> {addMode ? t("drw.v.tapSheet") : t("drw.v.addPin")}</button>
            <button type="button" className="m-drw-tool" disabled title={t("drw.v.compareHint")}><Columns2 size={15} /> {t("drw.v.compare")} <ReleaseTag release="R2" /></button>
            <span className="m-drw-markup" title={t("drw.v.markupHint")}>
              <button type="button" className="m-drw-tool" disabled aria-label="Cloud"><Cloud size={15} /></button>
              <button type="button" className="m-drw-tool" disabled aria-label="Arrow"><MoveUpRight size={15} /></button>
              <button type="button" className="m-drw-tool" disabled aria-label="Text"><Type size={15} /></button>
              <button type="button" className="m-drw-tool" disabled aria-label="Measure"><Ruler size={15} /></button>
              <button type="button" className="m-drw-tool" disabled><Lock size={13} /> {t("drw.v.private")}</button>
              <ReleaseTag release="R3" />
            </span>
            <span className="m-drw-spacer" />
            <button type="button" className="m-drw-tool" disabled title={t("drw.v.offlineHint")}><WifiOff size={15} /> {t("drw.v.offline")} <ReleaseTag release="R3" /></button>
          </div>

          <div
            ref={canvasRef}
            className={cx("m-drw-canvas", (addMode || moving || placePhoto) && "m-drw-adding")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={(e) => ptrs.current.delete(e.pointerId)}
            onDoubleClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, 1.6); }}
          >
            <div ref={stageRef} className="m-drw-stage" style={{ width: PAPER_W, height: paperH, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
              {viewed?.pdfUrl ? <PdfSheet key={viewed.ItemId} url={viewed.pdfUrl} paperW={PAPER_W} paperH={paperH} scale={view.s} t={t} /> : (
                <div className="m-drw-sheet-wait" style={{ width: PAPER_W, height: paperH }}><Ban size={30} /><span>{t(viewed?.status === "void" ? "drw.v.voidNoPdf" : "drw.v.noPdf")}</span></div>
              )}
              {shown.map((p) => (
                <PinMarker key={p.ItemId} pin={p} scale={view.s} paperW={PAPER_W} paperH={paperH} warn={outOfPlace(p)} selected={p.ItemId === selPin}
                  onSelect={() => { setDraft(null); setConfirmRemove(false); setSelPin(p.ItemId); setTab("pins"); }} />
              ))}
              {draft ? (
                <span className="m-drw-pin m-drw-pin-rfi" style={{ left: draft.x * PAPER_W, top: draft.y * paperH, transform: `translate(-50%, -100%) scale(${1 / view.s})`, opacity: 0.75 }}>
                  <svg width={28} height={34} viewBox="0 0 28 34"><path d="M14 33 C14 33 2 20 2 12 A12 12 0 0 1 26 12 C26 20 14 33 14 33 Z" fill="currentColor" stroke="#fff" strokeWidth={2} strokeDasharray="3 2" /></svg>
                  <b>+</b>
                </span>
              ) : null}
            </div>
            {addMode && !draft ? <div className="m-drw-hint">{t("drw.v.tapHint")}</div> : null}
            {moving ? <div className="m-drw-hint">{t("drw.v.moveHint")}</div> : null}
            {placePhoto ? (
              <div className="m-drw-hint m-drw-hint-photo" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
                <Camera size={15} />
                <span>{!can.pin ? t("drw.v.pinWho") : !isCurrent ? t("drw.v.pinCurrentOnly") : t("drw.photo.tapHint")}</span>
                <button type="button" className="m-link m-small" onClick={() => setPlacePhoto(null)}>{t("common.cancel")}</button>
              </div>
            ) : null}
            <div className="m-drw-legend">
              <Badge tone="blue">{rfiCount === 1 ? t("drw.v.rfiPin1") : fmt(t("drw.v.rfiPins"), { count: rfiCount })}</Badge>
              <Badge tone="amber">{punchCount === 1 ? t("drw.v.punchPin1") : fmt(t("drw.v.punchPins"), { count: punchCount })}</Badge>
              {photoCount ? <Badge tone="teal">{photoCount === 1 ? t("drw.photo.pin1") : fmt(t("drw.photo.pins"), { count: photoCount })}</Badge> : null}
              {data.hiddenPins ? <Badge tone="gray">{fmt(t("drw.v.hiddenBadge"), { count: data.hiddenPins })}</Badge> : null}
            </div>
            {anchor && popStyle ? (
              <div ref={popRef} className="m-drw-pop" style={popStyle}onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
                {selected && isPhoto(selected) ? (
                  <>
                    <div className="m-drw-pop-head">
                      <span className="m-row"><Camera size={16} color={PIN_COLOR.photo} /><b>{labelOf(t, selected)}</b></span>
                      <Badge tone="teal">{dayOf(selected.logDate)}</Badge>
                    </div>
                    {selected.thumbUrl || selected.previewUrl ? (
                      <button type="button" className="m-drw-pop-photo" onClick={() => onNavigate(`/photos/${encodeURIComponent(selected.recordId)}`)} aria-label={t("drw.photo.open")}>
                        <img src={selected.previewUrl ?? selected.thumbUrl} alt={selected.title} />
                      </button>
                    ) : selected.saving ? null : <span className="m-muted m-small">{t("drw.photo.noImage")}</span>}
                    {selected.title ? <div className="m-strong">{selected.title}</div> : null}
                    <KeyValue items={[
                      [t("drw.photo.takenBy"), selected.takenByName ? `${selected.takenByName}${selected.takenAt ? ` · ${whenOf(selected.takenAt)}` : ""}` : <span className="m-muted">—</span>],
                      [t("drw.v.placedBy"), selected.createdByName ? `${selected.createdByName} · ${fmt(t("drw.rev"), { label: revisions.find((r) => r.revisionIndex === selected.fromRevisionIndex)?.revisionLabel ?? "?" })}` : <span className="m-muted">—</span>]
                    ]} />
                    {outOfPlace(selected) ? <Note tone="warn">{t("drw.v.misplacedOne")}</Note> : null}
                    {selected.saving ? <span className="m-small m-muted"><Loader2 className="spin" size={12} /> {t("drw.v.saving")}</span> : null}
                    {confirmRemove ? (
                      <div className="m-drw-pop-confirm">
                        <span className="m-small">{t("drw.photo.removeAsk")}</span>
                        <div className="m-row" style={{ justifyContent: "flex-end" }}>
                          <Button variant="ghost" small onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</Button>
                          <Button variant="danger" small icon={<Trash size={13} />} onClick={() => removePin(selected)}>{t("drw.v.remove")}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="m-row m-row-wrap" style={{ justifyContent: "flex-end" }}>
                        {selected.canRemove && !selected.saving ? <Button variant="ghost" small icon={<Trash size={13} />} onClick={() => setConfirmRemove(true)}>{t("drw.v.remove")}</Button> : null}
                        {selected.canMove && isCurrent && !selected.saving && onRevision(selected, R) ? (
                          <Button variant="secondary" small icon={<Move size={13} />} onClick={() => { setMoving(selected.ItemId); setSelPin(null); }}>{t("drw.v.move")}</Button>
                        ) : null}
                        {selected.logDate && !selected.saving ? <Button variant="secondary" small onClick={() => onNavigate(`/daily-logs/${encodeURIComponent(selected.logDate!)}`)}>{t("drw.photo.openLog")}</Button> : null}
                        {!selected.saving ? <Button small onClick={() => onNavigate(`/photos/${encodeURIComponent(selected.recordId)}`)}>{t("drw.photo.open")}</Button> : null}
                      </div>
                    )}
                  </>
                ) : selected ? (
                  <>
                    <div className="m-drw-pop-head">
                      <span className="m-row">{isPunch(selected) ? <ClipboardCheck size={16} color={PIN_COLOR.punchItem} /> : <FileQuestion size={16} color={PIN_COLOR.rfi} />}<b>{labelOf(t, selected)}</b></span>
                      <Badge tone={toneOf(selected)}>{statusOf(t, selected)}</Badge>
                    </div>
                    <div className="m-strong">{selected.title}</div>
                    <KeyValue items={[
                      ...(isPunch(selected) ? [[t("drw.v.company"), selected.companyName || <span className="m-muted">—</span>] as [string, ReactNode]] : []),
                      [t("drw.v.ball"), selected.ballInCourtName || <span className="m-muted">—</span>],
                      [t("drw.v.due"), selected.dueDate ? fmtDate(selected.dueDate) : <span className="m-muted">—</span>],
                      [t("drw.v.placedBy"), selected.createdByName ? `${selected.createdByName} · ${fmt(t("drw.rev"), { label: revisions.find((r) => r.revisionIndex === selected.fromRevisionIndex)?.revisionLabel ?? "?" })}` : <span className="m-muted">—</span>]
                    ]} />
                    {outOfPlace(selected) ? <Note tone="warn">{t("drw.v.misplacedOne")}</Note> : null}
                    {selected.saving ? <span className="m-small m-muted"><Loader2 className="spin" size={12} /> {t("drw.v.saving")}</span> : null}
                    {confirmRemove ? (
                      <div className="m-drw-pop-confirm">
                        <span className="m-small">{fmt(t("drw.v.removeAsk"), { number: selected.number })}</span>
                        <div className="m-row" style={{ justifyContent: "flex-end" }}>
                          <Button variant="ghost" small onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</Button>
                          <Button variant="danger" small icon={<Trash size={13} />} onClick={() => removePin(selected)}>{t("drw.v.remove")}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="m-row m-row-wrap" style={{ justifyContent: "flex-end" }}>
                        {selected.canRemove && !selected.saving ? <Button variant="ghost" small icon={<Trash size={13} />} onClick={() => setConfirmRemove(true)}>{t("drw.v.remove")}</Button> : null}
                        {selected.canMove && isCurrent && !selected.saving && onRevision(selected, R) ? (
                          <Button variant="secondary" small icon={<Move size={13} />} onClick={() => { setMoving(selected.ItemId); setSelPin(null); }}>{t("drw.v.move")}</Button>
                        ) : null}
                        {selected.recordId ? (
                          <Button small onClick={() => onNavigate(isPunch(selected) ? `/punch/${selected.recordId}` : `/rfis/${selected.recordId}`)}>{t(isPunch(selected) ? "drw.v.openPunch" : "drw.v.openRfi")}</Button>
                        ) : null}
                      </div>
                    )}
                  </>
                ) : draft ? (
                  <>
                    <div className="m-drw-pop-head"><b>{t("drw.v.newPin")}</b><button type="button" className="m-link m-small" onClick={() => setDraft(null)}>{t("common.cancel")}</button></div>
                    <div className="m-row m-row-wrap">
                      {can.createPunch ? (
                        <Button small icon={<ClipboardCheck size={14} />} onClick={() => { setPunchDialog(draft); setDraft(null); setAddMode(false); }}>{t("drw.v.newPunchHere")}</Button>
                      ) : null}
                      {can.createRfi ? (
                        <Button small variant={can.createPunch ? "secondary" : "primary"} icon={<FileQuestion size={14} />} onClick={() => { setRfiDialog(draft); setDraft(null); setAddMode(false); }} disabled={!rfiCtx}>{t("drw.v.newRfiHere")}</Button>
                      ) : null}
                    </div>
                    <Field label={t("drw.v.linkExisting")}>
                      <Select value={linkWhat} onChange={setLinkWhat} placeholder={linkable.length ? t("drw.v.chooseRfi") : t("drw.v.noRfis")} options={linkable} disabled={!linkable.length} />
                    </Field>
                    <div className="m-row" style={{ justifyContent: "flex-end" }}>
                      <Button small variant="secondary" icon={<Link2 size={13} />} onClick={pinExisting} disabled={!linkWhat}>{t("drw.v.pinIt")}</Button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="m-drw-side">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "revisions", label: t("drw.v.tab.revisions"), count: revisions.filter((r) => r.status !== "void").length },
              { key: "pins", label: t("drw.v.tab.pins"), count: onThis.length },
              { key: "info", label: t("drw.v.tab.info") }
            ]}
          />
          <div className="m-drw-side-body">
            {tab === "revisions" ? (
              <div className="m-stack-v">
                {can.upload ? <Button small icon={<Upload size={14} />} onClick={() => setUploadOpen(true)}>{t("drw.v.uploadRevision")}</Button> : <span className="m-muted m-small">{t("drw.v.revisionWho")}</span>}
                <Timeline items={revisions.map((r) => ({
                  who: r.uploadedByName,
                  when: fmtDate(r.issuedDate),
                  tone: r.status === "current" ? "green" : r.status === "void" ? "red" : "gray",
                  title: (
                    <span className="m-row m-row-wrap">
                      <b>{fmt(t("drw.rev"), { label: r.revisionLabel })}</b>
                      {r.status === "current" ? <Badge tone="green">{t("drw.current")}</Badge> : r.status === "void" ? <Badge tone="red">{t("drw.void")}</Badge> : <Badge tone="red">{t("drw.superseded")}</Badge>}
                      {r.revisionIndex === R ? <Badge tone="blue">{t("drw.v.viewing")}</Badge> : null}
                    </span>
                  ),
                  body: (
                    <span className="m-stack-v" style={{ gap: 6 }}>
                      <span>{r.note || <span className="m-muted">{t("drw.v.noNote")}</span>} · {fileSize(r.sizeBytes)}</span>
                      {r.status === "void" ? <span className="m-small" style={{ color: "hsl(var(--m-red-fg))" }}>{fmt(t("drw.v.voidReason"), { reason: r.voidReason || "—" })}</span> : null}
                      <span className="m-row">
                        {r.revisionIndex !== R ? <button type="button" className="m-link m-small" onClick={() => viewRev(r.revisionIndex)}>{t("drw.v.view")}</button> : null}
                        {r.pdfUrl ? <button type="button" className="m-link m-small" onClick={() => download(r)}>{t("drw.v.download")}</button> : null}
                        {can.manage && r.status !== "void" ? <button type="button" className="m-link m-small" onClick={() => setVoiding(r)}>{t("drw.v.void")}</button> : null}
                      </span>
                    </span>
                  )
                }))} />
              </div>
            ) : null}

            {tab === "pins" ? (
              <div className="m-stack-v">
                <div className="m-row m-row-wrap">
                  <Checkbox checked={showRfi} onChange={setShowRfi} label={<span className="m-small">{t("drw.v.showRfis")}</span>} />
                  <Checkbox checked={showPunch} onChange={setShowPunch} label={<span className="m-small">{t("drw.v.showPunch")}</span>} />
                  {photoCount ? <Checkbox checked={showPhoto} onChange={setShowPhoto} label={<span className="m-small">{t("drw.photo.show")}</span>} /> : null}
                  <Checkbox checked={showClosed} onChange={setShowClosed} label={<span className="m-small">{t("drw.v.showClosed")}</span>} />
                </div>
                {data.hiddenPins > 0 ? <Note tone="info">{fmt(t(data.hiddenPins === 1 ? "drw.v.hiddenOne" : "drw.v.hidden"), { count: data.hiddenPins })}</Note> : null}
                {misplaced > 0 ? <Note tone="warn"><AlertTriangle size={14} style={{ display: "inline", verticalAlign: -2 }} /> {fmt(t(misplaced === 1 ? "drw.v.misplacedCountOne" : "drw.v.misplaced"), { count: misplaced })}</Note> : null}
                <Note tone="info">{t("drw.v.carryNote")}</Note>
                <div className="m-drw-list">
                  {shown.map((p) => (
                    <button key={p.ItemId} type="button" className={cx("m-drw-item", p.ItemId === selPin && "m-drw-item-on")} onClick={() => { setDraft(null); setSelPin(p.ItemId); focusOn(p.x, p.y); }}>
                      <span className="m-drw-dotpin" style={{ background: PIN_COLOR[p.type], opacity: p.closed ? 0.5 : 1 }} />
                      <span style={{ minWidth: 0 }}>
                        <span className="m-drw-item-title">{labelOf(t, p)}{p.title ? ` · ${p.title}` : ""}</span>
                        <span className="m-small m-muted">
                          {p.saving ? t("drw.v.saving")
                            : isPhoto(p) ? [fmt(t("drw.photo.logOf"), { date: dayOf(p.logDate) }), p.takenByName ?? ""].filter(Boolean).join(" · ")
                            : [p.dueDate ? fmt(t("drw.v.dueOn"), { date: fmtShortDate(p.dueDate) }) : "", isPunch(p) ? p.companyName ?? "" : p.dueDate ? "" : p.ballInCourtName].filter(Boolean).join(" · ")}
                          {outOfPlace(p) ? ` · ${t("drw.v.checkSpot")}` : ""}
                        </span>
                      </span>
                      <Badge tone={toneOf(p)}>{statusOf(t, p)}</Badge>
                    </button>
                  ))}
                  {shown.length === 0 ? <span className="m-muted m-small">{onThis.length ? t("drw.v.noPinsMatch") : t("drw.v.noPins")}</span> : null}
                </div>
              </div>
            ) : null}

            {tab === "info" ? (
              <div className="m-stack-v">
                <KeyValue items={[
                  [t("drw.f.number"), <span className="m-mono">{sheet.sheetNumber}</span>],
                  [t("drw.f.title"), sheet.title],
                  [t("drw.f.discipline"), sheet.discipline],
                  [t("drw.f.set"), sheet.setName],
                  [t("drw.v.currentRev"), current ? `${current.revisionLabel} · ${fmtDate(current.issuedDate)}` : "—"],
                  [t("drw.v.fileSize"), current ? `${fileSize(current.sizeBytes)} (${t("drw.v.limit")})` : "—"],
                  [t("drw.v.uploadedBy"), current?.uploadedByName || "—"],
                  [t("drw.v.pageSize"), current ? `${Math.round(current.pageWidthPt / 72 * 25.4)} × ${Math.round(current.pageHeightPt / 72 * 25.4)} mm` : "—"],
                  [t("drw.v.tab.pins"), fmt(t("drw.v.pinsCount"), { count: onThis.length, open: onThis.filter((p) => !p.closed && !isPhoto(p)).length })]
                ]} />
                <hr className="m-sep" />
                <div className="m-row m-row-wrap">
                  {can.manage ? <Button variant="secondary" small icon={<Pencil size={14} />} onClick={() => setEditOpen(true)}>{t("drw.v.editDetails")}</Button> : null}
                  <Button variant="secondary" small icon={<Link2 size={14} />} onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/drawings/${sheet.ItemId}`); toast(t("drw.v.linkCopied")); }}>{t("drw.v.copyLink")}</Button>
                  <Button variant="secondary" small icon={<WifiOff size={14} />} disabled title={t("drw.v.offlineHint")}>{t("drw.v.offlineSheet")}</Button>
                  <ReleaseTag release="R3" />
                </div>
                <Note tone="info">{sideNote}</Note>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {rfiDialog && rfiCtx && current ? (
        <RfiFormDialog
          ctx={rfiCtx}
          seesCost={projectCan(myRole, "rfi.see_cost")}
          seesInternal={projectCan(myRole, "rfi.see_internal")}
          prefill={{ location: `${sheet.sheetNumber} ${sheet.title}`.slice(0, 120), discipline: ["Architectural", "Structural", "Mechanical", "Electrical", "Plumbing", "Fire protection", "Civil", "Landscape"].includes(sheet.discipline) ? sheet.discipline : "" }}
          pin={{ sheetId: sheet.ItemId, revisionIndex: current.revisionIndex, x: rfiDialog.x, y: rfiDialog.y }}
          pinLabel={fmt(t("drw.v.pinLabel"), { sheet: sheet.sheetNumber, label: current.revisionLabel })}
          onClose={() => setRfiDialog(null)}
          onDone={(rfiId, detail) => {
            const at = rfiDialog;
            setRfiDialog(null);
            addPendingPin(queryClient, projectId, {
              ItemId: `new-${rfiId}`, sheetId: sheet.ItemId, x: at.x, y: at.y, fromRevisionIndex: current.revisionIndex, toRevisionIndex: 0, version: 0, type: "rfi", recordId: rfiId,
              number: detail?.rfi.number ?? "", title: detail?.rfi.subject ?? "", status: detail?.rfi.status ?? "open", closed: false, dueDate: detail?.rfi.dueDate ?? "",
              ballInCourtName: detail?.rfi.ballInCourtName ?? "", createdByName: "", createdAt: new Date().toISOString(), canMove: false, canRemove: false
            });
            setTab("pins");
          }}
        />
      ) : null}

      {punchDialog && current ? (
        <PunchHereDialog
          projectId={projectId}
          pin={{ sheetId: sheet.ItemId, revisionIndex: current.revisionIndex, x: punchDialog.x, y: punchDialog.y, label: fmt(t("drw.v.pinLabel"), { sheet: sheet.sheetNumber, label: current.revisionLabel }) }}
          toast={toast}
          onNavigate={onNavigate}
          onClose={() => setPunchDialog(null)}
          onSaving={(saving, title) => punchSaving(punchDialog, saving, title)}
        />
      ) : null}

      {uploadOpen ? (
        <UploadDialog
          projectId={projectId}
          register={{ sheets: [sheet], disciplines: data.disciplines, sets: [sheet.setName], can, today: data.today }}
          presetSheetId={sheet.ItemId}
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); setRevIndex(undefined); }}
          toast={toast}
          t={t}
        />
      ) : null}

      {editOpen ? <EditSheetDialog data={data} busy={action.isPending} t={t} onClose={() => setEditOpen(false)}
        onSave={(changes) => action.mutateAsync({ action: "updateSheet", sheetId: sheet.ItemId, version: sheet.version, ...changes })
          .then(() => { setEditOpen(false); toast(t("drw.v.saved")); })
          .catch((error) => toast(errorText(t, error), "warn"))} /> : null}

      {voiding ? <VoidDialog revision={voiding} sheetNumber={sheet.sheetNumber} isCurrent={voiding.status === "current"} busy={action.isPending} t={t} onClose={() => setVoiding(undefined)}
        onSave={(reason) => action.mutateAsync({ action: "voidRevision", sheetId: sheet.ItemId, revisionId: voiding.ItemId, reason })
          .then((answer) => {
            setVoiding(undefined);
            if (answer.sheetRemoved) {
              toast(fmt(t("drw.v.sheetRemoved"), { number: sheet.sheetNumber }));
              onNavigate("/drawings");
              return;
            }
            setRevIndex(undefined);
            toast(fmt(t("drw.v.voided"), { label: voiding.revisionLabel }));
          })
          .catch((error) => toast(errorText(t, error), "warn"))} /> : null}
    </div>
  );
}

function EditSheetDialog({ data, busy, t, onClose, onSave }: {
  data: SheetDetail; busy: boolean; t: T; onClose: () => void; onSave: (changes: { sheetNumber?: string; title?: string; discipline?: string; setName?: string }) => void;
}) {
  const s = data.sheet;
  const [number, setNumber] = useState(s.sheetNumber);
  const [title, setTitle] = useState(s.title);
  const [discipline, setDiscipline] = useState(s.discipline);
  const [setName, setSetName] = useState(s.setName);
  const changes = {
    ...(number.trim() !== s.sheetNumber ? { sheetNumber: number.trim() } : {}),
    ...(title.trim() !== s.title ? { title: title.trim() } : {}),
    ...(discipline !== s.discipline ? { discipline } : {}),
    ...(setName.trim() !== s.setName ? { setName: setName.trim() } : {})
  };
  const empty = Object.keys(changes).length === 0;
  return (
    <Dialog title={<span className="m-row"><Pencil size={17} /> {fmt(t("drw.v.editTitle"), { number: s.sheetNumber })}</span>} onClose={onClose} size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button onClick={() => onSave(changes)} disabled={empty || busy || !number.trim() || !title.trim()} icon={busy ? <Loader2 className="spin" size={15} /> : undefined}>{t("common.save")}</Button>
      </>}
    >
      <div className="m-form">
        <Field label={t("drw.f.number")}><input className="m-input" value={number} maxLength={30} onChange={(e) => setNumber(e.target.value.toUpperCase())} /></Field>
        <Field label={t("drw.f.discipline")}><Select value={discipline} onChange={setDiscipline} options={data.disciplines.map((d) => d.name)} /></Field>
        <Field label={t("drw.f.title")} wide><input className="m-input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label={t("drw.f.set")} wide><input className="m-input" value={setName} maxLength={60} onChange={(e) => setSetName(e.target.value)} /></Field>
      </div>
      <p className="m-small m-muted">{t("drw.v.editNote")}</p>
    </Dialog>
  );
}

function VoidDialog({ revision, sheetNumber, isCurrent, busy, t, onClose, onSave }: {
  revision: Revision; sheetNumber: string; isCurrent: boolean; busy: boolean; t: T; onClose: () => void; onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title={fmt(t("drw.v.voidTitle"), { number: sheetNumber, label: revision.revisionLabel })} onClose={onClose} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" onClick={() => onSave(reason.trim())} disabled={!reason.trim() || busy} icon={busy ? <Loader2 className="spin" size={15} /> : <Ban size={15} />}>{t("drw.v.void")}</Button>
      </>}
    >
      <div className="m-stack-v">
        <Note tone="warn">{isCurrent ? t("drw.v.voidCurrent") : t("drw.v.voidOld")}</Note>
        <Field label={t("drw.v.reason")}><input className="m-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={t("drw.v.reasonPh")} autoFocus /></Field>
      </div>
    </Dialog>
  );
}
