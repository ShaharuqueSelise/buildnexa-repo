// The demo app's building blocks (mock/src/mock/ui.tsx), ported so real screens match the approved
// demo. Same names, props and "m-" classes (styles in ./m.css), so a screen copies over from mock/
// with only its data swapped. Differences: Avatar and CompanyChip take a name and colour instead of
// looking up the demo's sample data, and Drawer uses a <div> (the app's global `aside` rule is the
// sidebar's).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import "./m.css";

export type Tone = "blue" | "green" | "amber" | "red" | "gray" | "purple" | "teal";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Badge({ tone = "gray", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`m-badge m-tone-${tone}`} title={title}>{children}</span>;
}

/** One colour per workflow status, used by every module. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "Open": case "With reviewer": case "Pending": case "Pricing": case "Executed": return "blue";
    case "In progress": case "With GC": case "Draft": case "Invited": return "amber";
    case "Answered": case "Ready for review": case "Approved as noted": return "purple";
    case "Closed": case "Approved": case "Submitted": case "Active": case "Converted": return "green";
    case "Rejected": case "Revise and resubmit": case "Overdue": case "Deactivated": case "Down": return "red";
    default: return "gray";
  }
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={statusTone(status)}>{label ?? status}</Badge>;
}

export type Release = "MVP" | "R2" | "R3";

/** Marks a control or section that belongs to a later release. */
export function ReleaseTag({ release }: { release: Release }) {
  if (release === "MVP") return null;
  return <span className={`m-release m-release-${release.toLowerCase()}`} title={`Planned for ${release}`}>{release}</span>;
}

export function initials(name: string): string {
  return name
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

/** A stable colour for a name, for companies without a brand colour. */
export function colorFor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}

export function Avatar({ name, color, size = 28, title }: { name: string; color: string; size?: number; title?: string }) {
  return (
    <span className="m-avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: color }} title={title ?? name}>
      {initials(name)}
    </span>
  );
}

export function PersonChip({ name, sub, color }: { name?: string; sub?: ReactNode; color?: string }) {
  if (!name) return <span className="m-muted">—</span>;
  return (
    <span className="m-person">
      <Avatar name={name} color={color ?? colorFor(name)} size={24} />
      <span>
        <span className="m-person-name">{name}</span>
        {sub ? <span className="m-person-sub">{sub}</span> : null}
      </span>
    </span>
  );
}

/** Timeline of events (audit, history, review chain). */
export function Timeline({ items }: { items: { who?: string; when: string; title: ReactNode; body?: ReactNode; tone?: Tone }[] }) {
  return (
    <ol className="m-timeline">
      {items.map((it, i) => (
        <li key={i} style={{ "--tl": `var(--m-${it.tone ?? "gray"}-fg)` } as CSSProperties}>
          <span className="m-timeline-dot" />
          <div className="m-timeline-card">
            <div className="m-timeline-head">{it.who ? <PersonChip name={it.who} /> : null}<span className="m-muted">{it.when}</span></div>
            <div className="m-timeline-title">{it.title}</div>
            {it.body ? <div className="m-timeline-body">{it.body}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CompanyChip({ name, color }: { name: string; color: string }) {
  return <span className="m-company"><span className="m-dot" style={{ background: color }} />{name}</span>;
}

export function PageTitle({ title, subtitle, actions, release }: { title: string; subtitle?: ReactNode; actions?: ReactNode; release?: Release }) {
  return (
    <div className="m-page-title">
      <div>
        <h1>{title} {release ? <ReleaseTag release={release} /> : null}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="m-actions">{actions}</div> : null}
    </div>
  );
}

export function Panel({ title, actions, children, className, release }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; release?: Release }) {
  return (
    <div className={cx("m-panel", className)}>
      {title || actions ? (
        <div className="m-panel-head">
          <h3>{title} {release ? <ReleaseTag release={release} /> : null}</h3>
          {actions ? <div className="m-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Kpi({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; onClick?: () => void }) {
  return (
    <button type="button" className={cx("m-kpi", tone && `m-kpi-${tone}`, !onClick && "m-kpi-static")} onClick={onClick} disabled={!onClick}>
      <span className="m-kpi-label">{label}</span>
      <strong>{value}</strong>
      {hint ? <span className="m-kpi-hint">{hint}</span> : null}
    </button>
  );
}

export function Button({ children, onClick, variant = "primary", icon, disabled, title, type = "button", small }: {
  children?: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost" | "danger" | "success"; icon?: ReactNode;
  disabled?: boolean; title?: string; type?: "button" | "submit"; small?: boolean;
}) {
  return (
    <button type={type} className={cx("m-btn", `m-btn-${variant}`, small && "m-btn-sm")} onClick={onClick} disabled={disabled} title={title}>
      {icon}{children}
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode; count?: number }[]; value: T; onChange: (key: T) => void }) {
  return (
    <div className="m-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} className={cx("m-tab", t.key === value && "m-tab-active")} onClick={() => onChange(t.key)}>
          {t.label}{t.count !== undefined ? <span className="m-tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Pill-style single-choice filter. */
export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: ReactNode }[]; value: T; onChange: (key: T) => void }) {
  return (
    <div className="m-seg">
      {options.map((o) => (
        <button key={o.key} type="button" className={cx(o.key === value && "m-seg-on")} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint, wide }: { label: string; children: ReactNode; hint?: ReactNode; wide?: boolean }) {
  return (
    <label className={cx("m-field", wide && "m-field-wide")}>
      <span className="m-field-label">{label}</span>
      {children}
      {hint ? <span className="m-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Select({ value, onChange, options, placeholder, disabled, className }: {
  value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[]; placeholder?: string; disabled?: boolean; className?: string;
}) {
  return (
    <select className={cx("m-input", className)} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function SearchInput({ value, onChange, placeholder = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="m-input m-search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type="search" />;
}

export function Dialog({ title, onClose, children, footer, size = "md" }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="m-overlay" onClick={onClose} role="presentation">
      <div className={`m-dialog m-dialog-${size}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="m-dialog-head">
          <h2>{title}</h2>
          <button className="m-icon-btn" onClick={onClose} aria-label="Close" type="button"><X size={18} /></button>
        </div>
        <div className="m-dialog-body">{children}</div>
        {footer ? <div className="m-dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Right-hand slide-over for record details. */
export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="m-overlay m-overlay-drawer" onClick={onClose} role="presentation">
      <div className="m-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="m-dialog-head">
          <h2>{title}</h2>
          <button className="m-icon-btn" onClick={onClose} aria-label="Close" type="button"><X size={18} /></button>
        </div>
        <div className="m-drawer-body">{children}</div>
        {footer ? <div className="m-dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone = "blue", label }: { value: number; tone?: Tone; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="m-progress" title={label ?? `${Math.round(v)} %`}>
      <div className={`m-progress-fill m-fill-${tone}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="m-empty">
      {icon}
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** Small note that explains a rule or a platform constraint inline. */
export function Note({ tone = "info", children }: { tone?: "info" | "warn" | "danger" | "good"; children: ReactNode }) {
  return <div className={`m-note m-note-${tone}`}>{children}</div>;
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="m-kv">
      {items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="m-check" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="m-toggle" style={disabled ? { opacity: 0.55, cursor: "not-allowed" } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="m-toggle-track"><span /></span>
      {label}
    </label>
  );
}

/** Builds and downloads a CSV from rows (the first row's keys are the headers).
 * UTF-8 with a byte-order mark and CRLF line ends, so Excel shows accents (Müller, Lindqvist).
 * Text that Excel would run as a formula (starting with = + - @ or a tab) gets a leading ' so a
 * subject typed as "=HYPERLINK(…)" stays text; numbers are written as they are. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[], headers?: string[]) {
  if (rows.length === 0) return;
  const cols = headers ?? Object.keys(rows[0] as Record<string, unknown>);
  const keys = Object.keys(rows[0] as Record<string, unknown>);
  const cell = (v: unknown) => {
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.map(cell).join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Bottom-right toasts, as in the demo. */
export function Toasts({ items }: { items: { id: number; text: string; tone?: "good" | "warn" }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="m-toasts" role="status">
      {items.map((t) => <div key={t.id} className={cx("m-toast", t.tone === "warn" && "m-toast-warn")}>{t.text}</div>)}
    </div>
  );
}

export type ToastTone = "good" | "warn";

/** Toasts for one page: `toast(text)` shows one for about 3 seconds; render <Toasts items={items} />. */
export function useToasts() {
  const [items, setItems] = useState<{ id: number; text: string; tone?: ToastTone }[]>([]);
  const toast = useCallback((text: string, tone?: ToastTone) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text, tone }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);
  return { items, toast };
}

/** Fills `{name}` placeholders in a translated text. */
export function fmt(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}
