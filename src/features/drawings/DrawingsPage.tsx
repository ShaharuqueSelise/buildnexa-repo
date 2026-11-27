// Drawings (DRW-01..04), built from the demo app's Drawings page (mock/src/mock/pages/DrawingsPage.tsx):
// the register (current sheets by discipline, thumbnails or table, search, set filter, all
// revisions, CSV), the upload dialog (single-sheet PDFs checked with pdf.js, sheet number and
// revision read from the file name, new sheet or next revision) and the sheet viewer
// (SheetViewer.tsx). Every action goes through the drawings Function, which decides who may do
// what; the buttons follow its answer (can.upload, can.manage, can.pin).
// Deep links: /drawings/<sheetId> opens the current revision, ?rev=<n> an older one, ?pin=<id> a pin.
// Not real yet: drawing sets up to 500 MB with automatic split (R2), the current set as a zip
// (R2), compare (R2), markups and offline sheets (R3), punch pins (Phase 3 step 3).
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileDown, FileText, FileUp, GitCompareArrows, LayoutGrid, List, Loader2, Map as MapIcon, MapPin, ScanText, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FUNCTIONS, FunctionRefused } from "../../lib/blocks/functions";
import {
  Badge, Button, Dialog, Empty, Field, Kpi, Note, PageTitle, Panel, ProgressBar, ReleaseTag, SearchInput, Segmented, Select, Toasts, Toggle, cx,
  downloadCsv, fmt, useToasts
} from "../../shared/m/ui";
import type { ToastTone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { fileSize } from "../files/files";
import {
  MAX_SHEET_BYTES, disciplineFor, guessFromName, nextLabel, publishSheets, readPdf, refreshDrawings, revisionLinks, sheetKeyOf, useDrawings
} from "./drawingsApi";
import type { Discipline, PdfFacts, PublishRow, Register, RevisionSummary, SheetRow } from "./drawingsApi";
import { SheetViewer } from "./SheetViewer";
import { compareRevision } from "./compare";
import "./DrawingsPage.css";
import { SkeletonPage } from "../../shared/m/Skeleton";

type Nav = { onNavigate: (path: string) => void; params?: string[] };
export type T = (key: TranslationKey) => string;
export type Toast = (text: string, tone?: ToastTone) => void;

export const errorText = (t: T, e: unknown) => (e instanceof FunctionRefused || e instanceof Error ? e.message : t("common.error"));
export const DEFAULT_SET = "Issued for Construction";

export function DrawingsPage({ onNavigate, params = [] }: Nav) {
  const { t } = useT();
  const { query, ws, project } = useProjects();
  const { items: toasts, toast } = useToasts();

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <SkeletonPage kind="table" label={t("common.loading")} />;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("drw.title")} />
        <Panel><Empty icon={<MapIcon size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }
  if (!FUNCTIONS.drawings) {
    return (
      <div>
        <PageTitle title={t("drw.title")} />
        <Note tone="warn">{t("drw.notDeployed")}</Note>
      </div>
    );
  }
  const sheetId = params[0];
  return (
    <div>
      {sheetId
        ? <SheetViewer key={sheetId} projectId={project.ItemId} sheetId={sheetId} onNavigate={onNavigate} toast={toast} t={t} />
        : <RegisterView projectId={project.ItemId} projectNumber={project.number ?? ""} onNavigate={onNavigate} toast={toast} t={t} />}
      <Toasts items={toasts} />
    </div>
  );
}

// ---------- register ----------
type Item = { sheet: SheetRow; rev: RevisionSummary; current: boolean };
type ViewMode = "grid" | "table";

export function SheetThumb({ url, alt, superseded }: { url?: string; alt: string; superseded?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <span className="m-drw-thumb">
      {url && !failed ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <span className="m-drw-thumb-none"><FileText size={26} /></span>}
      {superseded ? <Badge tone="red">Superseded</Badge> : null}
    </span>
  );
}

function RegisterView({ projectId, projectNumber, onNavigate, toast, t }: { projectId: string; projectNumber: string; onNavigate: (path: string) => void; toast: Toast; t: T }) {
  const list = useDrawings(projectId);
  const [disc, setDisc] = useState("");
  const [q, setQ] = useState("");
  const [set, setSet] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [mode, setMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem("bnx.drawings.mode") as ViewMode) || "grid"; } catch { return "grid"; }
  });
  const [upload, setUpload] = useState(false);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    try { localStorage.setItem("bnx.drawings.mode", mode); } catch { /* private window */ }
  }, [mode]);

  const data = list.data;
  const sheets = useMemo(() => data?.sheets ?? [], [data]);
  const order = useMemo(() => {
    const known = (data?.disciplines ?? []).map((d) => d.name);
    return [...known, ...Array.from(new Set(sheets.map((s) => s.discipline))).filter((d) => !known.includes(d))];
  }, [data, sheets]);

  const needle = q.trim().toLowerCase();
  const filtered = sheets.filter((s) =>
    (!disc || s.discipline === disc) &&
    (!set || s.setName === set) &&
    (!needle || s.sheetNumber.toLowerCase().includes(needle) || s.title.toLowerCase().includes(needle))
  );
  const items: Item[] = filtered.flatMap((sheet) => {
    if (!showAll) {
      const cur = sheet.revisions.find((r) => r.status === "current") ?? sheet.revisions[0];
      return cur ? [{ sheet, rev: cur, current: true }] : [];
    }
    return sheet.revisions.map((rev) => ({ sheet, rev, current: rev.status === "current" }));
  });
  const groups = order.map((d) => ({ d, items: items.filter((it) => it.sheet.discipline === d) })).filter((g) => g.items.length > 0);

  // Thumbnails of older revisions (only the current ones come with the register).
  const missing = showAll ? items.filter((it) => !it.current && !extra[it.rev.ItemId] && !asked.current.has(it.rev.ItemId)).map((it) => it.rev.ItemId) : [];
  const missingKey = missing.join();
  useEffect(() => {
    if (!missing.length) return;
    const ids = missing.slice(0, 240);
    for (const id of ids) asked.current.add(id);
    revisionLinks(projectId, ids).then((r) => setExtra((old) => ({ ...old, ...Object.fromEntries(Object.entries(r.links).map(([k, v]) => [k, v.thumb ?? ""])) }))).catch(() => undefined);
  }, [missingKey, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) {
    if (list.error) return <Note tone="danger">{errorText(t, list.error)}</Note>;
    return <SkeletonPage kind="table" label={t("common.loading")} />;
  }

  const can = data.can;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const recent = sheets.reduce((n, s) => n + s.revisions.filter((r) => r.revisionIndex > 1 && r.uploadedAt >= since).length, 0);
  const superseded = sheets.reduce((n, s) => n + s.revisions.filter((r) => r.status === "superseded").length, 0);
  const openPins = sheets.reduce((n, s) => n + s.pins, 0);
  const hidden = sheets.reduce((n, s) => n + s.hiddenPins, 0);
  const thumbOf = (it: Item) => (it.current ? it.sheet.current?.thumbUrl : extra[it.rev.ItemId]);
  const open = (it: Item) => onNavigate(it.current ? `/drawings/${it.sheet.ItemId}` : `/drawings/${it.sheet.ItemId}?rev=${it.rev.revisionIndex}`);

  const exportCsv = () => downloadCsv(`${projectNumber || "project"}-drawing-register.csv`, items.map((it) => ({
    number: it.sheet.sheetNumber,
    title: it.sheet.title,
    discipline: it.sheet.discipline,
    set: it.sheet.setName,
    revision: it.rev.revisionLabel,
    status: it.current ? "Current" : "Superseded",
    issued: it.rev.issuedDate,
    uploaded_by: it.rev.uploadedByName,
    size_mb: Math.round((it.rev.sizeBytes / 1048576) * 10) / 10,
    note: it.rev.note,
    pins: it.current ? it.sheet.pinsTotal : ""
  })));

  return (
    <div>
      <PageTitle
        title={t("drw.title")}
        subtitle={fmt(t(sheets.length === 1 ? "drw.subtitleOne" : "drw.subtitle"), { count: sheets.length })}
        actions={<>
          <Button variant="secondary" icon={<FileDown size={15} />} onClick={exportCsv} disabled={items.length === 0}>{t("drw.exportCsv")}</Button>
          <Button variant="secondary" icon={<Download size={15} />} disabled title={t("drw.zipHint")}>{t("drw.zip")} <ReleaseTag release="R2" /></Button>
          <Button variant="secondary" icon={<ScanText size={15} />} disabled title={t("drw.setHint")}>{t("drw.uploadSet")} <ReleaseTag release="R2" /></Button>
          <Button icon={<FileUp size={15} />} onClick={() => setUpload(true)} disabled={!can.upload} title={can.upload ? undefined : data.archived ? t("drw.archived") : t("drw.uploadWho")}>{t("drw.upload")}</Button>
        </>}
      />
      {data.archived ? <Note tone="warn">{t("drw.archived")}</Note> : null}

      <div className="m-kpis">
        <Kpi label={t("drw.kpi.sheets")} value={sheets.length} hint={fmt(t("drw.kpi.disciplines"), { count: new Set(sheets.map((s) => s.discipline)).size })} />
        <Kpi label={t("drw.kpi.recent")} value={recent} tone="blue" onClick={() => setShowAll(true)} hint={t("drw.kpi.recentHint")} />
        <Kpi label={t("drw.kpi.superseded")} value={superseded} hint={t("drw.kpi.supersededHint")} />
        <Kpi label={t("drw.kpi.pins")} value={openPins} tone="amber" hint={hidden ? fmt(t("drw.kpi.pinsHidden"), { count: hidden }) : t("drw.kpi.pinsHint")} />
      </div>

      <RecentRevisions sheets={sheets} can={can} t={t} onOpen={(s) => onNavigate(`/drawings/${s.ItemId}?tab=changes`)} />

      {sheets.length ? (
        <div className="m-drw-chips">
          {["", ...order.filter((d) => sheets.some((s) => s.discipline === d))].map((d) => (
            <button key={d || "all"} type="button" className={cx("m-drw-chip", disc === d && "m-drw-chip-on")} onClick={() => setDisc(d)}>
              {d || t("drw.all")} <em>{d ? sheets.filter((s) => s.discipline === d).length : sheets.length}</em>
            </button>
          ))}
        </div>
      ) : null}

      <div className="m-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={t("drw.search")} />
        <Select value={set} onChange={setSet} options={data.sets} placeholder={t("drw.allSets")} />
        <Toggle checked={showAll} onChange={setShowAll} label={showAll ? t("drw.showingAll") : t("drw.currentOnly")} />
        <span style={{ flex: 1 }} />
        <Segmented value={mode} onChange={setMode} options={[
          { key: "grid", label: <span className="m-row"><LayoutGrid size={14} /> {t("drw.thumbnails")}</span> },
          { key: "table", label: <span className="m-row"><List size={14} /> {t("drw.table")}</span> }
        ]} />
      </div>

      {sheets.length === 0 ? (
        <Panel><Empty icon={<MapIcon size={26} />} title={t("drw.noneTitle")}>{can.upload ? t("drw.noneUpload") : t("drw.noneText")}</Empty></Panel>
      ) : groups.length === 0 ? (
        <Panel><Empty title={t("drw.noMatch")}>{t("drw.noMatchText")}</Empty></Panel>
      ) : mode === "grid" ? groups.map((g) => (
        <section key={g.d} className="m-drw-group">
          <div className="m-drw-group-head"><h3>{g.d}</h3><Badge tone="gray">{g.items.length}</Badge></div>
          <div className="m-drw-cards">
            {g.items.map((it) => (
              <button key={it.rev.ItemId} type="button" className={cx("m-drw-card", !it.current && "m-drw-card-old")} onClick={() => open(it)}>
                <SheetThumb url={thumbOf(it)} alt={`${it.sheet.sheetNumber} ${it.sheet.title}`} superseded={!it.current} />
                <span className="m-drw-card-body">
                  <span className="m-drw-card-top"><b className="m-mono">{it.sheet.sheetNumber}</b><Badge tone={it.current ? "green" : "gray"}>{fmt(t("drw.rev"), { label: it.rev.revisionLabel })}</Badge></span>
                  <span className="m-drw-card-title" title={it.sheet.title}>{it.sheet.title}</span>
                  <span className="m-drw-meta">
                    <span title={fmtDate(it.rev.issuedDate)}>{fmtShortDate(it.rev.issuedDate)}</span>
                    {it.current ? <span title={t("drw.pinsOpen")}><MapPin size={12} /> {it.sheet.pins}</span> : null}
                    {it.current && it.sheet.revisions.length > 1 ? <span>{fmt(t("drw.revs"), { count: it.sheet.revisions.length })}</span> : null}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )) : (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th />
                <th>{t("drw.col.number")}</th>
                <th>{t("drw.col.title")}</th>
                <th className="m-hide-mobile">{t("drw.col.discipline")}</th>
                <th>{t("drw.col.rev")}</th>
                <th>{t("drw.col.issued")}</th>
                <th className="m-hide-mobile">{t("drw.col.by")}</th>
                <th className="m-num">{t("drw.col.pins")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                <tr key={`g-${g.d}`} className="m-group-row"><td colSpan={8}>{g.d} · {g.items.length}</td></tr>,
                ...g.items.map((it) => (
                  <tr key={it.rev.ItemId} className="m-clickable" onClick={() => open(it)} style={it.current ? undefined : { opacity: 0.75 }}>
                    <td><span className="m-drw-mini">{thumbOf(it) ? <img src={thumbOf(it)} alt="" loading="lazy" /> : <FileText size={14} />}</span></td>
                    <td className="m-mono m-strong">{it.sheet.sheetNumber}</td>
                    <td>{it.sheet.title}<div className="m-small m-muted">{it.sheet.setName}</div></td>
                    <td className="m-hide-mobile">{it.sheet.discipline}</td>
                    <td><span className="m-row"><Badge tone={it.current ? "green" : "gray"}>{it.rev.revisionLabel}</Badge>{!it.current ? <Badge tone="red">{t("drw.superseded")}</Badge> : null}</span></td>
                    <td title={fmtDate(it.rev.issuedDate)}>{fmtShortDate(it.rev.issuedDate)}</td>
                    <td className="m-hide-mobile">{it.rev.uploadedByName}</td>
                    <td className="m-num">{it.current ? it.sheet.pinsTotal : ""}</td>
                  </tr>
                ))
              ])}
            </tbody>
          </table>
        </div>
      )}

      {upload ? (
        <UploadDialog
          projectId={projectId}
          register={data}
          onClose={() => setUpload(false)}
          onDone={(ids) => { setUpload(false); if (ids.length === 1 && ids[0]) onNavigate(`/drawings/${ids[0]}`); }}
          toast={toast}
          t={t}
        />
      ) : null}
    </div>
  );
}

// ---------- revision impact: the newest revisions and what is still open on them ----------
const RECENT = 4;

function RecentRevisions({ sheets, can, t, onOpen }: { sheets: SheetRow[]; can: Register["can"]; t: T; onOpen: (s: SheetRow) => void }) {
  const recent = sheets
    .filter((s) => s.impact && s.impact.state !== "first" && s.current)
    .sort((a, b) => (b.current?.uploadedAt ?? "").localeCompare(a.current?.uploadedAt ?? ""))
    .slice(0, RECENT);
  if (!recent.length) return null;
  return (
    <section className="m-drw-recent">
      <div className="m-drw-group-head"><GitCompareArrows size={16} /><h3>{t("drw.recent.title")}</h3></div>
      <div className="m-drw-recent-cards">
        {recent.map((s) => {
          const i = s.impact!;
          const L = i.revisionLabel;
          const changes = i.state === "pending" ? t("drw.recent.comparing")
            : i.state === "compared" ? (i.changes === 1 ? t("drw.recent.change") : fmt(t("drw.recent.changes"), { count: i.changes }))
            : i.state === "failed" ? t("drw.recent.notCompared") : t("drw.recent.checkAll");
          return (
            <button key={s.ItemId} type="button" className="m-drw-recent-card" onClick={() => onOpen(s)}>
              <span className="m-drw-recent-top">
                <b className="m-mono">{s.sheetNumber}</b>
                <Badge tone="green">{fmt(t("drw.rev"), { label: L })}</Badge>
                <span className="m-small m-muted">{fmtShortDate(s.current?.issuedDate)}</span>
              </span>
              <span className="m-drw-card-title" title={s.title}>{s.title}</span>
              <span className="m-drw-recent-stats">
                <span>{changes}</span>
                {i.state !== "pending" ? (
                  <span className={cx(i.toCheck > 0 && "m-imp-warn")}>{i.toCheck > 0 ? fmt(t("drw.recent.toCheck"), { count: i.toCheck }) : t("drw.recent.allChecked")}</span>
                ) : null}
              </span>
              {can.followUp && i.total > 0 ? (
                <>
                  <ProgressBar value={(i.confirmed / i.total) * 100} tone={i.confirmed === i.total ? "green" : "amber"} />
                  <span className="m-small m-muted">{fmt(t("drw.recent.confirmed"), { done: i.confirmed, total: i.total })}</span>
                </>
              ) : null}
              {can.confirm && i.mine ? (
                i.mine === "confirmed"
                  ? <span className="m-small"><Badge tone="green"><CheckCircle2 size={11} /> {fmt(t("drw.recent.youConfirmed"), { label: L })}</Badge></span>
                  : <span className="m-small"><Badge tone="amber">{fmt(t("drw.recent.confirm"), { label: L })}</Badge></span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------- upload ----------
type Row = Omit<PublishRow, "facts"> & { facts?: PdfFacts; state: "reading" | "ready" | "sending" | "done" | "failed"; progress: number; error?: string };
type Refusal = { name: string; text: string };

const NUMBER_OK = /^[A-Za-z0-9][A-Za-z0-9 .\-_/]{0,29}$/;
const LABEL_OK = /^[A-Z0-9.\-]{1,8}$/;

export function UploadDialog({ projectId, register, presetSheetId, onClose, onDone, toast, t }: {
  projectId: string;
  register: Pick<Register, "sheets" | "disciplines" | "sets" | "can" | "today">;
  /** "New revision" from the viewer: a single file becomes the next revision of this sheet. */
  presetSheetId?: string;
  onClose: () => void;
  onDone: (sheetIds: string[]) => void;
  toast: Toast;
  t: T;
}) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [refused, setRefused] = useState<Refusal[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const disciplines: Discipline[] = register.disciplines;
  const preset = presetSheetId ? register.sheets.find((s) => s.ItemId === presetSheetId) : undefined;
  const byKey = useMemo(() => new Map(register.sheets.map((s) => [sheetKeyOf(s.sheetNumber), s])), [register.sheets]);
  const sets = useMemo(() => Array.from(new Set([DEFAULT_SET, ...register.sets])).sort(), [register.sets]);

  const fillFrom = (r: Row, number: string): Row => {
    const existing = byKey.get(sheetKeyOf(number));
    if (existing) {
      const cur = existing.revisions.find((x) => x.status === "current");
      return { ...r, sheetNumber: existing.sheetNumber, title: existing.title, discipline: existing.discipline, setName: existing.setName, revisionLabel: r.revisionLabel && r.revisionLabel !== cur?.revisionLabel ? r.revisionLabel : nextLabel(cur?.revisionLabel) };
    }
    return { ...r, sheetNumber: number, discipline: r.discipline || disciplineFor(number, disciplines) };
  };

  const addFiles = (files: File[]) => {
    const bad: Refusal[] = [];
    const fresh: Row[] = [];
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { bad.push({ name: file.name, text: t("drw.up.notPdf") }); continue; }
      if (file.size === 0) { bad.push({ name: file.name, text: t("drw.up.empty") }); continue; }
      if (file.size > MAX_SHEET_BYTES) { bad.push({ name: file.name, text: fmt(t("drw.up.tooBig"), { size: fileSize(file.size) }) }); continue; }
      const g = guessFromName(file.name);
      const base: Row = {
        key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        sheetNumber: "",
        title: g.title,
        discipline: "",
        setName: DEFAULT_SET,
        revisionLabel: g.revisionLabel,
        issuedDate: register.today,
        note: "",
        state: "reading",
        progress: 0
      };
      const number = preset && files.length === 1 ? preset.sheetNumber : g.sheetNumber;
      fresh.push(number ? fillFrom(base, number) : { ...base, revisionLabel: base.revisionLabel || "0" });
    }
    if (bad.length) setRefused((old) => [...old, ...bad]);
    if (!fresh.length) return;
    setRows((old) => [...old, ...fresh]);
    for (const r of fresh) {
      readPdf(r.file)
        .then((facts) => {
          if (facts.pages !== 1) {
            setRows((old) => old.filter((x) => x.key !== r.key));
            setRefused((old) => [...old, { name: r.file.name, text: fmt(t("drw.up.pages"), { count: facts.pages }) }]);
            return;
          }
          setRows((old) => old.map((x) => (x.key === r.key ? { ...x, facts, state: "ready" } : x)));
        })
        .catch(() => {
          setRows((old) => old.filter((x) => x.key !== r.key));
          setRefused((old) => [...old, { name: r.file.name, text: t("drw.up.unreadable") }]);
        });
    }
  };

  const onPick = (list: FileList | null) => {
    if (list) addFiles(Array.from(list));
    if (inputRef.current) inputRef.current.value = "";
  };

  const update = (key: string, patch: Partial<Row>) => setRows((old) => old.map((r) => {
    if (r.key !== key) return r;
    const next = { ...r, ...patch };
    return patch.sheetNumber !== undefined ? fillFrom({ ...next, revisionLabel: byKey.has(sheetKeyOf(patch.sheetNumber)) ? "" : next.revisionLabel || "0" }, patch.sheetNumber) : next;
  }));

  const problem = (r: Row): string | undefined => {
    if (r.state === "reading") return undefined;
    if (!NUMBER_OK.test(r.sheetNumber.trim())) return t("drw.up.badNumber");
    if (!r.title.trim()) return t("drw.up.noTitle");
    if (!disciplines.some((d) => d.name === r.discipline)) return t("drw.up.noDiscipline");
    if (!LABEL_OK.test(r.revisionLabel)) return t("drw.up.badLabel");
    if (!r.issuedDate || r.issuedDate > register.today) return t("drw.up.badDate");
    const existing = byKey.get(sheetKeyOf(r.sheetNumber));
    if (existing?.revisions.some((x) => x.revisionLabel.toUpperCase() === r.revisionLabel)) return fmt(t("drw.up.labelTaken"), { label: r.revisionLabel, number: existing.sheetNumber });
    if (rows.filter((x) => x.state !== "done" && sheetKeyOf(x.sheetNumber) === sheetKeyOf(r.sheetNumber)).length > 1) return t("drw.up.twice");
    return undefined;
  };
  const pending = rows.filter((r) => r.state !== "done");
  const ready = pending.length > 0 && pending.every((r) => r.state !== "reading" && !problem(r));

  async function publish() {
    const todo = pending.filter((r): r is Row & { facts: PdfFacts } => Boolean(r.facts));
    if (!todo.length) return;
    setBusy(true);
    setRows((old) => old.map((r) => (todo.some((x) => x.key === r.key) ? { ...r, state: "sending", progress: 0, error: undefined } : r)));
    try {
      const results = await publishSheets(projectId, todo.map((r) => ({ ...r, sheetNumber: r.sheetNumber.trim(), title: r.title.trim(), note: r.note.trim() })), (key, done) =>
        setRows((old) => old.map((r) => (r.key === key ? { ...r, progress: done } : r))));
      setRows((old) => old.map((r) => {
        const res = results.find((x) => x.key === r.key);
        return res ? { ...r, state: res.ok ? "done" : "failed", error: res.error, progress: 1 } : r;
      }));
      const okIds = results.filter((x) => x.ok).map((x) => x.sheetId ?? "");
      refreshDrawings(queryClient, projectId, okIds.filter(Boolean));
      // Revision impact: compare each new revision with the one before, from the file still in hand.
      // It goes on after the dialog closes; the sheet shows "Comparing…" meanwhile.
      for (const res of results) {
        const row = todo.find((r) => r.key === res.key);
        if (res.ok && res.sheetId && res.revisionId && res.previous && row) {
          void compareRevision({ projectId, sheetId: res.sheetId, revisionId: res.revisionId, newFile: row.file, queryClient });
        }
      }
      const failedCount = results.filter((x) => !x.ok).length;
      if (okIds.length) toast(fmt(t(okIds.length === 1 ? "drw.up.doneOne" : "drw.up.done"), { count: okIds.length }));
      if (!failedCount) onDone(okIds);
      else toast(fmt(t("drw.up.someFailed"), { count: failedCount }), "warn");
    } catch (error) {
      setRows((old) => old.map((r) => (r.state === "sending" ? { ...r, state: "failed", error: errorText(t, error) } : r)));
      toast(errorText(t, error), "warn");
    } finally {
      setBusy(false);
    }
  }

  const designerOnly = !register.can.manage;

  return (
    <Dialog
      title={<span className="m-row"><FileUp size={18} /> {preset ? fmt(t("drw.up.titleRev"), { number: preset.sheetNumber }) : t("drw.up.title")}</span>}
      onClose={() => { if (!busy) onClose(); }}
      size="xl"
      footer={<>
        <span className="m-muted m-small" style={{ marginRight: "auto" }}>{t("drw.up.footer")}</span>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
        <Button onClick={() => void publish()} disabled={!ready || busy} icon={busy ? <Loader2 className="spin" size={15} /> : undefined}>
          {fmt(t(pending.length === 1 ? "drw.up.publishOne" : "drw.up.publish"), { count: pending.length })}
        </Button>
      </>}
    >
      <div className="m-stack-v">
        <label
          className={cx("m-drw-drop", over && "m-drw-drop-on")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) addFiles(Array.from(e.dataTransfer.files)); }}
        >
          <FileUp size={26} />
          <strong>{t("drw.up.drop")}</strong>
          <span className="m-small">{preset ? fmt(t("drw.up.dropRev"), { number: preset.sheetNumber }) : t("drw.up.dropHint")}</span>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple={!preset} onChange={(e) => onPick(e.target.files)} disabled={busy} />
          <span className="m-btn m-btn-secondary m-btn-sm">{t("drw.up.browse")}</span>
        </label>

        {refused.map((f, i) => (
          <Note key={`${f.name}-${i}`} tone="danger"><AlertTriangle size={14} style={{ display: "inline", verticalAlign: -2 }} /> <b>{f.name}</b>: {f.text}</Note>
        ))}

        {rows.map((r) => {
          const existing = r.sheetNumber ? byKey.get(sheetKeyOf(r.sheetNumber)) : undefined;
          const cur = existing?.revisions.find((x) => x.status === "current");
          const err = problem(r);
          const locked = r.state === "sending" || r.state === "done" || busy;
          const infoLocked = locked || (designerOnly && Boolean(existing));
          return (
            <div key={r.key} className={cx("m-drw-upload-row", r.state === "done" && "m-drw-upload-done")}>
              <div className="m-row m-row-wrap" style={{ justifyContent: "space-between" }}>
                <span className="m-row">
                  <FileText size={16} />
                  <b className="m-small">{r.file.name}</b>
                  <span className="m-muted m-small">{fileSize(r.file.size)}</span>
                  {r.state === "reading" ? <span className="m-muted m-small"><Loader2 className="spin" size={12} /> {t("drw.up.reading")}</span> : null}
                  {!locked ? <button type="button" className="m-link m-small" onClick={() => setRows((old) => old.filter((x) => x.key !== r.key))} aria-label={t("drw.up.removeFile")}><X size={14} /></button> : null}
                </span>
                {r.state === "done" ? <Badge tone="green"><CheckCircle2 size={12} /> {t("drw.up.published")}</Badge>
                  : existing ? <Badge tone="amber">{fmt(t("drw.up.isRevision"), { label: r.revisionLabel || "?", number: existing.sheetNumber, prev: cur?.revisionLabel ?? "?" })}</Badge>
                  : r.sheetNumber ? <Badge tone="green">{t("drw.up.newSheet")}</Badge> : null}
              </div>
              <div className="m-drw-upload-grid">
                <Field label={t("drw.f.number")}><input className="m-input" value={r.sheetNumber} placeholder="A-101" maxLength={30} disabled={locked || Boolean(preset)} onChange={(e) => update(r.key, { sheetNumber: e.target.value.toUpperCase() })} /></Field>
                <Field label={t("drw.f.title")}><input className="m-input" value={r.title} maxLength={120} disabled={infoLocked} onChange={(e) => update(r.key, { title: e.target.value })} /></Field>
                <Field label={t("drw.f.discipline")}><Select value={r.discipline} onChange={(v) => update(r.key, { discipline: v })} options={disciplines.map((d) => d.name)} placeholder={t("drw.f.choose")} disabled={infoLocked} /></Field>
                <Field label={t("drw.f.set")}>
                  <input className="m-input" value={r.setName} maxLength={60} list="m-drw-sets" disabled={infoLocked} onChange={(e) => update(r.key, { setName: e.target.value })} />
                </Field>
                <Field label={t("drw.f.rev")}><input className="m-input" value={r.revisionLabel} maxLength={8} disabled={locked} onChange={(e) => update(r.key, { revisionLabel: e.target.value.toUpperCase().replace(/\s+/g, "") })} /></Field>
                <Field label={t("drw.f.issued")}><input className="m-input" type="date" value={r.issuedDate} max={register.today} disabled={locked} onChange={(e) => update(r.key, { issuedDate: e.target.value })} /></Field>
              </div>
              <Field label={t("drw.f.note")}><input className="m-input" value={r.note} maxLength={300} disabled={locked} onChange={(e) => update(r.key, { note: e.target.value })} placeholder={t("drw.f.notePh")} /></Field>
              {designerOnly && existing && r.state !== "done" ? <span className="m-small m-muted">{t("drw.up.designerInfo")}</span> : null}
              {r.state === "sending" ? <ProgressBar value={r.progress * 100} /> : null}
              {r.error ? <span className="m-small" style={{ color: "hsl(var(--m-red-fg))", fontWeight: 600 }}>{r.error}</span> : err ? <span className="m-small" style={{ color: "hsl(var(--m-red-fg))", fontWeight: 600 }}>{err}</span> : null}
            </div>
          );
        })}
        <datalist id="m-drw-sets">{sets.map((s) => <option key={s} value={s} />)}</datalist>
        {rows.length === 0 && !refused.length ? <Note tone="info">{t("drw.up.rules")}</Note> : null}
      </div>
    </Dialog>
  );
}
