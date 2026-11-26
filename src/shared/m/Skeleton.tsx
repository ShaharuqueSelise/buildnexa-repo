// Skeletons: grey placeholders shaped like the screen that is loading, shown instead of a spinner
// and "Loading" text, so the page keeps its shape while Blocks answers. Styles are the `m-sk` rules
// in ./m.css. Screen readers hear the label once (role="status"); the grey blocks are hidden from them.
// Keep spinners for actions the user started (Saving…, Uploading…) and for real progress (sheet %).
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./ui";

type Size = number | string;

/** One grey block that pulses. Width and height in px (number) or any CSS length. */
export function Sk({ w, h = 12, r, className, style }: { w?: Size; h?: Size; r?: Size; className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={cx("m-sk", className)} style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Wraps skeletons: tells screen readers "Loading" once. */
export function SkStatus({ label = "Loading", className, style, children }: { label?: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={className} style={style} role="status" aria-busy="true">
      <span className="m-sr">{label}</span>
      {children}
    </div>
  );
}

// Fixed widths so rows look like text of different lengths without changing on every render.
const WIDTHS = ["72%", "54%", "86%", "40%", "64%", "78%", "48%", "60%"];
const w = (i: number) => WIDTHS[i % WIDTHS.length];

/** Lines of text, e.g. a panel body. */
export function SkLines({ lines = 3, gap = 10 }: { lines?: number; gap?: number }) {
  return (
    <div style={{ display: "grid", gap }}>
      {Array.from({ length: lines }, (_, i) => <Sk key={i} w={w(i)} />)}
    </div>
  );
}

/** A list of rows: optional round avatar, a title and a smaller second line, a short tag on the right. */
export function SkRows({ rows = 4, avatar, tag = true, label }: { rows?: number; avatar?: boolean; tag?: boolean; label?: string }) {
  const body = (
    <div className="m-sk-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div className="m-sk-row" key={i}>
          {avatar ? <Sk w={32} h={32} r={999} style={{ flex: "0 0 32px" }} /> : null}
          <div className="m-sk-row-text">
            <Sk w={w(i)} h={12} />
            <Sk w={w(i + 3)} h={10} style={{ maxWidth: "70%" }} />
          </div>
          {tag ? <Sk w={56} h={20} r={999} style={{ flex: "0 0 56px" }} /> : null}
        </div>
      ))}
    </div>
  );
  return label === undefined ? body : <SkStatus label={label}>{body}</SkStatus>;
}

/** A table inside a flush panel: a header band and rows of cells. Extra columns hide on phones. */
export function SkTable({ rows = 6, cols = 5, label }: { rows?: number; cols?: number; label?: string }) {
  const template = { gridTemplateColumns: `minmax(0, 2fr) repeat(${Math.max(cols - 1, 0)}, minmax(0, 1fr))` };
  const body = (
    <div className="m-panel m-panel-flush m-sk-table">
      <div className="m-sk-tr m-sk-th" style={template}>
        {Array.from({ length: cols }, (_, c) => <Sk key={c} w={c === 0 ? 90 : 60} h={10} />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="m-sk-tr" style={template} key={r}>
          {Array.from({ length: cols }, (_, c) => (
            c === 0
              ? <div key={c} className="m-sk-row-text"><Sk w={w(r)} h={12} /><Sk w={w(r + 4)} h={10} style={{ maxWidth: "60%" }} /></div>
              : <Sk key={c} w={c === cols - 1 ? 64 : w(r + c)} h={c === cols - 1 ? 20 : 12} r={c === cols - 1 ? 999 : undefined} />
          ))}
        </div>
      ))}
    </div>
  );
  return label === undefined ? body : <SkStatus label={label}>{body}</SkStatus>;
}

/** Stacked cards (title line + text line), e.g. the field app's cards: pass its card class. */
export function SkCardList({ count = 3, className = "m-panel", label }: { count?: number; className?: string; label?: string }) {
  const body = Array.from({ length: count }, (_, i) => (
    <div className={className} key={i}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><Sk w={w(i + 1)} h={15} style={{ maxWidth: "60%" }} /><Sk w={28} h={18} r={999} /></div>
      <Sk w={w(i + 4)} h={11} />
    </div>
  ));
  return label === undefined ? <>{body}</> : <SkStatus label={label}>{body}</SkStatus>;
}

/** Photo squares. */
export function SkGallery({ count = 12, label }: { count?: number; label?: string }) {
  const body = (
    <div className="m-sk-gallery">
      {Array.from({ length: count }, (_, i) => <Sk key={i} w="100%" h="auto" r={10} style={{ aspectRatio: "1 / 1" }} />)}
    </div>
  );
  return label === undefined ? body : <SkStatus label={label}>{body}</SkStatus>;
}

/** A panel with a title line and a few lines of text. */
export function SkPanel({ lines = 4, rows, title = true }: { lines?: number; rows?: number; title?: boolean }) {
  return (
    <div className="m-panel">
      {title ? <div className="m-panel-head"><Sk w={160} h={16} /></div> : null}
      {rows ? <SkRows rows={rows} avatar /> : <SkLines lines={lines} />}
    </div>
  );
}

function SkTitle({ action = true }: { action?: boolean }) {
  return (
    <div className="m-page-title">
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        <Sk w={220} h={26} />
        <Sk w={320} h={13} />
      </div>
      {action ? <Sk w={130} h={36} r={10} /> : null}
    </div>
  );
}

function SkKpis({ count = 4 }: { count?: number }) {
  return (
    <div className="m-kpis">
      {Array.from({ length: count }, (_, i) => (
        <div className="m-kpi" key={i}>
          <Sk w={96} h={11} />
          <Sk w={56} h={24} />
        </div>
      ))}
    </div>
  );
}

function SkToolbar() {
  return (
    <div className="m-toolbar">
      <Sk w={260} h={36} r={10} />
      <Sk w={320} h={36} r={10} />
    </div>
  );
}

function SkCards({ count = 6 }: { count?: number }) {
  return (
    <div className="m-cards">
      {Array.from({ length: count }, (_, i) => (
        <div className="m-card" key={i}>
          <Sk w="100%" h={6} r={0} />
          <div style={{ display: "grid", gap: 10, padding: 18 }}>
            <Sk w={70} h={10} />
            <Sk w={w(i)} h={16} />
            <Sk w={w(i + 2)} h={11} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}><Sk w={64} h={20} r={999} /><Sk w={80} h={20} r={999} /></div>
          </div>
        </div>
      ))}
    </div>
  );
}

export type SkeletonKind = "table" | "cards" | "home" | "split" | "gallery" | "calendar" | "sheet" | "detail" | "list";

/**
 * A whole page while its data loads, shaped like the page:
 * table = title, tiles, filters, table (RFIs, punch, drawings, directory, company admin);
 * cards = title, filters, project cards; home = tiles and two columns of panels;
 * split = folder tree beside a table (documents); gallery = photo squares;
 * calendar = month beside the day (daily logs); sheet = the drawing viewer;
 * detail = one record (RFI); list = title and a list panel (inbox, platform admin).
 */
export function SkeletonPage({ kind = "table", label = "Loading", kpis = true }: { kind?: SkeletonKind; label?: string; kpis?: boolean }) {
  let body: ReactNode;
  switch (kind) {
    case "cards":
      body = <><SkTitle /><SkToolbar /><SkCards /></>;
      break;
    case "home":
      body = (
        <>
          <Sk w="100%" h={150} r={16} style={{ marginBottom: 24 }} />
          <SkKpis />
          <div className="m-grid m-grid-main"><SkPanel rows={5} /><SkPanel lines={5} /></div>
        </>
      );
      break;
    case "split":
      body = (
        <>
          <SkTitle />
          <div className="m-sk-split">
            <div className="m-panel" style={{ display: "grid", gap: 14, alignContent: "start" }}>
              {Array.from({ length: 7 }, (_, i) => <Sk key={i} w={w(i)} h={14} style={{ marginLeft: i % 3 ? 18 : 0 }} />)}
            </div>
            <div><SkToolbar /><SkTable rows={6} cols={4} /></div>
          </div>
        </>
      );
      break;
    case "gallery":
      body = (
        <>
          <SkTitle />
          <SkToolbar />
          <SkGallery />
        </>
      );
      break;
    case "calendar":
      body = (
        <>
          <SkTitle />
          <div className="m-sk-cal">
            <div className="m-panel">
              <div className="m-panel-head"><Sk w={120} h={16} /><Sk w={60} h={24} r={8} /></div>
              <div className="m-sk-cal-days">
                {Array.from({ length: 35 }, (_, i) => <Sk key={i} w="100%" h="auto" r={8} style={{ aspectRatio: "1 / 1" }} />)}
              </div>
            </div>
            <div>
              <SkPanel lines={4} />
              <SkPanel rows={3} />
            </div>
          </div>
        </>
      );
      break;
    case "sheet":
      body = (
        <>
          <div className="m-toolbar"><Sk w={90} h={32} r={8} /><Sk w={220} h={22} /><span style={{ flex: 1 }} /><Sk w={160} h={32} r={8} /></div>
          <div className="m-sk-sheet">
            <Sk w="100%" h="100%" r={12} style={{ minHeight: "62vh" }} />
            <SkPanel rows={4} />
          </div>
        </>
      );
      break;
    case "detail":
      body = (
        <>
          <Sk w={110} h={14} style={{ marginBottom: 18 }} />
          <SkTitle />
          <div className="m-grid m-grid-main">
            <div><SkPanel lines={6} /><SkPanel rows={3} /></div>
            <div><SkPanel lines={5} /></div>
          </div>
        </>
      );
      break;
    case "list":
      body = <><SkTitle action={false} /><div className="m-panel"><SkRows rows={7} avatar /></div></>;
      break;
    default:
      body = <><SkTitle />{kpis ? <SkKpis /> : null}<SkToolbar /><SkTable /></>;
  }
  return <SkStatus label={label}>{body}</SkStatus>;
}
