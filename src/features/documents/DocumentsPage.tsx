// Documents (DOC-02), built from the demo app's Documents page (mock/src/mock/pages/DocumentsPage.tsx):
// the folder tree with per-folder rules, upload (button or drag and drop), a same-name upload as the
// next version, the versions drawer (download any version, make an older one current, upload a new
// one), rename, move (also by dragging a row onto a folder), trash and restore, name search and CSV.
// Every action goes through the documents Function, which decides who may do what; the buttons
// shown here follow its answer (folder.canUpload, can.manage, can.folderAccess).
// Phones: read-only (browse, search, open, versions), as the spec says (DocumentsPage.css).
// Not real yet, from later releases: preview inside the app (files open in a new tab, where the
// browser shows PDFs and photos), search inside documents (R2) and OCR of scans (R3), emptying the
// trash (never, by decision: trash stays restorable), folder rename and sub-folders.
import { useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import {
  Clock, Download, Eye, FileDown, Folder, FolderInput, FolderOpen, FolderPlus, Loader2, Lock, Pencil, RotateCcw, ShieldCheck,
  Trash, Undo2, Upload
} from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FUNCTIONS, FunctionRefused } from "../../lib/blocks/functions";
import { PROJECT_ROLES, ROLE_LABEL } from "../../lib/roles";
import type { ProjectRole } from "../../lib/roles";
import { projectCan } from "../../lib/permissions";
import { Badge, Button, Checkbox, Dialog, Drawer, Empty, Field, Note, PageTitle, Panel, SearchInput, Select, Toasts, cx, downloadCsv, fmt, useToasts } from "../../shared/m/ui";
import type { ToastTone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { fileSize } from "../files/files";
import type { NewAttachment } from "../files/files";
import { DOC_EXTENSIONS, docLink, docRefusal, extOf, uploadDocs, useDocAction, useDocuments } from "./documentsApi";
import { FileViewer, saveUrlAs } from "../files/FileViewer";
import type { DocFolder, DocListing, DocRow, DocVersion } from "./documentsApi";
import "./DocumentsPage.css";

type Nav = { onNavigate: (path: string) => void; params?: string[] };
type T = (key: TranslationKey) => string;
type Toast = (text: string, tone?: ToastTone) => void;

const ALL = "__all";
const TRASH = "__trash";
const MANAGERS = ["project-manager", "document-controller"];
const BATCH = 10;
const DRAG_TYPE = "text/x-buildnexa-doc";

const errorText = (t: T, e: unknown) => (e instanceof FunctionRefused || e instanceof Error ? e.message : t("common.error"));
const roleShort = (t: T, r: string) => (PROJECT_ROLES as readonly string[]).includes(r) ? t(ROLE_LABEL[r as ProjectRole].short) : r;

function Ext({ ext }: { ext: string }) {
  return <span className={`m-doc-ext m-doc-ext-${ext}`}>{(ext || "file").toUpperCase().slice(0, 4)}</span>;
}

// The link that came with the list, when it is for the version wanted and still valid. Asking the
// Function instead can wait half a minute in the Blocks queue.
function listedLink(doc: DocRow, expires: string | undefined, versionNo?: number) {
  const current = versionNo === undefined || versionNo === doc.currentVersion;
  const fresh = expires ? Date.parse(expires) > Date.now() : false;
  return current && fresh && doc.url ? { url: doc.url, fileName: doc.name } : undefined;
}

// A link for the viewer: the listed one when it fits, otherwise asked from the Function.
const linkFor = (projectId: string, doc: DocRow, expires: string | undefined, versionNo?: number) =>
  listedLink(doc, expires, versionNo)?.url ?? docLink(projectId, doc.ItemId, versionNo).then((l) => l.url);

// Opens a file in a new tab: straight away with the listed link; otherwise the tab is opened at the
// click (so no popup blocker stops it), says it is getting the file, and moves on once the link comes.
async function openFile(projectId: string, doc: DocRow, expires: string | undefined, toast: Toast, t: T, versionNo?: number) {
  const ready = listedLink(doc, expires, versionNo);
  if (ready) {
    window.open(ready.url, "_blank", "noopener");
    return;
  }
  const tab = window.open("", "_blank");
  if (tab) {
    tab.document.title = doc.name;
    tab.document.body.style.cssText = "font:15px system-ui,sans-serif;color:#475569;display:grid;place-items:center;height:90vh";
    tab.document.body.textContent = t("doc.opening");
  } else toast(t("doc.opening"));
  try {
    const { url } = await docLink(projectId, doc.ItemId, versionNo);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else window.location.assign(url);
  } catch (e) {
    tab?.close();
    toast(errorText(t, e), "warn");
  }
}

// Saves one version under its real name ("Main contract_v1.pdf"). Storage keeps files under a
// name with a code added, so the file is fetched and saved from here; if that fails, it opens.
async function saveFile(projectId: string, doc: DocRow, expires: string | undefined, toast: Toast, t: T, versionNo?: number) {
  try {
    const ready = listedLink(doc, expires, versionNo);
    if (!ready) toast(t("doc.opening"));
    const { url, fileName } = ready ?? (await docLink(projectId, doc.ItemId, versionNo));
    await saveUrlAs(url, fileName || doc.name);
  } catch (e) {
    toast(errorText(t, e), "warn");
  }
}

export function DocumentsPage({ onNavigate }: Nav) {
  const { t } = useT();
  const { query, ws, project } = useProjects();
  const { items: toasts, toast } = useToasts();

  if (query.isLoading || !ws) {
    if (query.error) return <Note tone="danger">{t("common.error")}: {(query.error as Error).message}</Note>;
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  if (!project) {
    return (
      <div>
        <PageTitle title={t("doc.title")} />
        <Panel><Empty icon={<FolderOpen size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }
  if (!FUNCTIONS.documents) {
    return (
      <div>
        <PageTitle title={t("doc.title")} />
        <Note tone="warn">{t("doc.notDeployed")}</Note>
      </div>
    );
  }
  return (
    <div>
      <DocumentsView projectId={project.ItemId} projectNumber={project.number} toast={toast} t={t} />
      <Toasts items={toasts} />
    </div>
  );
}

type Dlg =
  | { k: "folder" }
  | { k: "access"; folder: DocFolder }
  | { k: "rename"; doc: DocRow }
  | { k: "move"; doc: DocRow }
  | { k: "versions"; docId: string }
  | { k: "view"; docId: string; versionNo?: number }
  | null;

type Pending = { key: string; name: string; progress: number };

function DocumentsView({ projectId, projectNumber, toast, t }: { projectId: string; projectNumber: string; toast: Toast; t: T }) {
  const list = useDocuments(projectId);
  const action = useDocAction(projectId);
  const [folder, setFolder] = useState<string>(ALL);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: "name" | "updated" | "size"; dir: 1 | -1 }>({ key: "updated", dir: -1 });
  const [dragOver, setDragOver] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const data = list.data;
  const folderById = useMemo(() => new Map((data?.folders ?? []).map((f) => [f.ItemId, f])), [data]);

  if (list.isLoading) return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  if (list.error || !data) return <Note tone="danger">{t("common.error")}: {errorText(t, list.error)}</Note>;

  const { can } = data;
  const live = data.documents.filter((d) => !d.trashed);
  const trashed = data.documents.filter((d) => d.trashed);
  const inTrash = folder === TRASH && can.manage;
  const current = folderById.get(folder);
  const inFolder = Boolean(current);
  const canUploadHere = Boolean(current?.canUpload);
  const busy = pending.length > 0 || action.isPending;

  const needle = q.trim().toLowerCase();
  const base = inTrash ? trashed : current ? live.filter((d) => d.folderId === current.ItemId) : live;
  const rows = base
    .filter((d) => !needle || d.name.toLowerCase().includes(needle) || (folderById.get(d.folderId)?.name ?? "").toLowerCase().includes(needle))
    .sort((a, b) => {
      const k = sort.key;
      const va = k === "name" ? a.name.toLowerCase() : k === "size" ? a.sizeBytes ?? 0 : a.updatedAt;
      const vb = k === "name" ? b.name.toLowerCase() : k === "size" ? b.sizeBytes ?? 0 : b.updatedAt;
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  const sortBy = (key: "name" | "updated" | "size") => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1 }));
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "");

  const run = async (body: Parameters<typeof action.mutateAsync>[0], done?: string) => {
    try {
      const r = await action.mutateAsync(body);
      if (done) toast(done);
      return r;
    } catch (e) {
      toast(errorText(t, e), "warn");
      return undefined;
    }
  };

  // ----- upload -----
  async function upload(files: File[], target: DocFolder | undefined) {
    if (!files.length) return;
    if (!target) { toast(t("doc.openFolderFirst"), "warn"); return; }
    if (!target.canUpload) { toast(fmt(t("doc.cantUploadHere"), { folder: target.name }), "warn"); return; }
    const okFiles: File[] = [];
    for (const f of files) {
      const why = docRefusal(f);
      if (why === "type") toast(fmt(t("doc.badType"), { name: f.name, types: DOC_EXTENSIONS.join(", ") }), "warn");
      else if (why === "empty") toast(fmt(t("files.empty"), { name: f.name }), "warn");
      else if (why === "size") toast(fmt(t("files.tooBig"), { name: f.name, size: fileSize(f.size) }), "warn");
      else okFiles.push(f);
    }
    for (let start = 0; start < okFiles.length; start += BATCH) {
      const batch = okFiles.slice(start, start + BATCH);
      const keys = batch.map((f, i) => `${Date.now()}-${start + i}-${f.name}`);
      setPending((p) => [...p, ...batch.map((f, i) => ({ key: keys[i] as string, name: f.name, progress: 0 }))]);
      try {
        const results = await uploadDocs(projectId, target.ItemId, batch, (i, done) =>
          setPending((p) => p.map((x) => (x.key === keys[i] ? { ...x, progress: done } : x)))
        );
        const uploaded = results.filter((r): r is NewAttachment => !(r instanceof Error));
        results.forEach((r, i) => { if (r instanceof Error) toast(fmt(t("doc.uploadFailed"), { name: batch[i]?.name ?? "" }), "warn"); });
        if (uploaded.length) {
          const r = await run({ action: "addFiles", folderId: target.ItemId, files: uploaded });
          for (const a of r?.added ?? []) {
            toast(a.versionNo > 1 ? fmt(t("doc.addedVersion"), { name: a.name, v: a.versionNo }) : fmt(t("doc.added"), { name: a.name, folder: target.name }));
          }
        }
      } catch (e) {
        toast(errorText(t, e), "warn");
      } finally {
        setPending((p) => p.filter((x) => !keys.includes(x.key)));
      }
    }
  }

  // ----- drag and drop -----
  const mayEdit = (d: DocRow) => !d.trashed && Boolean(folderById.get(d.folderId)?.canUpload);
  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOver(false);
    setDropFolder(null);
    const target = folderById.get(targetId);
    const docId = e.dataTransfer.getData(DRAG_TYPE);
    if (docId) {
      const doc = data.documents.find((d) => d.ItemId === docId);
      if (!doc || !target || target.ItemId === doc.folderId) return;
      if (!target.canUpload) { toast(fmt(t("doc.cantUploadHere"), { folder: target.name }), "warn"); return; }
      void run({ action: "move", documentId: doc.ItemId, folderId: target.ItemId }, fmt(t("doc.moved"), { name: doc.name, folder: target.name }));
      return;
    }
    void upload(Array.from(e.dataTransfer.files), target);
  };

  const node = (key: string, label: string, icon: ReactNode, count: number, extra?: ReactNode, droppable = false) => (
    <button
      key={key}
      type="button"
      className={cx("m-doc-node", folder === key && "m-doc-node-on", dropFolder === key && "m-doc-drop-target")}
      onClick={() => setFolder(key)}
      onDragOver={droppable ? (e) => { e.preventDefault(); setDropFolder(key); } : undefined}
      onDragLeave={() => setDropFolder((f) => (f === key ? null : f))}
      onDrop={droppable ? (e) => onDrop(e, key) : undefined}
    >
      {icon}<span>{label}</span>{extra}<em>{count}</em>
    </button>
  );

  const restricted = (f: DocFolder) => f.viewRoles.length < PROJECT_ROLES.length;
  const title = inTrash ? t("doc.trash") : current ? current.name : t("doc.allFiles");
  const folderName = (id: string) => folderById.get(id)?.name ?? "";

  const exportCsv = () => {
    downloadCsv(
      `${projectNumber}-documents.csv`,
      rows.map((d) => ({
        folder: folderName(d.folderId), name: d.name, type: d.ext, version: d.currentVersion, size: fileSize(d.sizeBytes),
        updated: d.updatedAt.slice(0, 10), by: d.updatedByName ?? "", uploadedBy: d.createdByName ?? "", trashed: d.trashed ? "yes" : "no"
      })),
      ["Folder", "Name", "Type", "Version", "Size", "Updated", "Updated by", "First uploaded by", "In trash"]
    );
    toast(fmt(t("doc.csvDone"), { count: rows.length }));
  };

  const versionsDoc = dlg?.k === "versions" ? data.documents.find((d) => d.ItemId === dlg.docId) : undefined;
  const viewDoc = dlg?.k === "view" ? data.documents.find((d) => d.ItemId === dlg.docId) : undefined;
  const viewVersion = dlg?.k === "view" && dlg.versionNo !== undefined ? viewDoc?.versions.find((v) => v.versionNo === dlg.versionNo) : undefined;
  const viewExt = viewVersion ? extOf(viewVersion.fileName) || viewDoc?.ext || "" : viewDoc?.ext ?? "";

  return (
    <div>
      <PageTitle
        title={t("doc.title")}
        subtitle={t("doc.subtitle")}
        actions={<>
          <Button variant="secondary" icon={<FileDown size={15} />} onClick={exportCsv} disabled={rows.length === 0} title={fmt(t("doc.csvTitle"), { count: rows.length })}>{t("doc.exportCsv")}</Button>
          <span className="m-doc-edit">
            <Button icon={<Upload size={15} />} disabled={!canUploadHere || busy} onClick={() => fileInput.current?.click()} title={canUploadHere ? fmt(t("doc.uploadInto"), { folder: current?.name ?? "" }) : inFolder ? fmt(t("doc.cantUploadHere"), { folder: current?.name ?? "" }) : t("doc.openFolderFirst")}>{t("doc.upload")}</Button>
          </span>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? []), current); e.target.value = ""; }} />
        </>}
      />
      {data.archived ? <Note tone="info">{t("doc.archived")}</Note> : null}

      <div className="m-doc-layout">
        <nav className="m-doc-tree" aria-label={t("doc.folders")}>
          <div className="m-doc-tree-title">{t("doc.folders")}</div>
          {node(ALL, t("doc.allFiles"), <FolderOpen size={16} />, live.length)}
          {data.folders.map((f) =>
            node(f.ItemId, f.name, <Folder size={16} />, live.filter((d) => d.folderId === f.ItemId).length,
              restricted(f) ? <Lock size={12} aria-label={t("doc.restricted")} /> : undefined, true))}
          {can.manage ? node(TRASH, t("doc.trash"), <Trash size={16} />, trashed.length) : null}
          {can.manage ? <span className="m-doc-edit"><Button variant="ghost" small icon={<FolderPlus size={14} />} onClick={() => setDlg({ k: "folder" })}>{t("doc.newFolder")}</Button></span> : null}
          {data.hiddenFolders > 0 ? <span className="m-small m-muted" style={{ padding: "6px 8px" }}>{fmt(t(data.hiddenFolders === 1 ? "doc.hiddenOne" : "doc.hiddenMany"), { count: data.hiddenFolders })}</span> : null}
        </nav>

        <div style={{ minWidth: 0 }}>
          <div className="m-toolbar">
            <h2 style={{ fontSize: 17, margin: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {title}
              {current && restricted(current) ? <Badge tone="amber" title={t("doc.seenBy")}><Lock size={11} /> {current.viewRoles.map((r) => roleShort(t, r)).join(", ")}</Badge> : null}
              {current ? <Badge tone="gray" title={t("doc.uploadedBy")}><Upload size={11} /> {[...MANAGERS, ...current.uploadRoles].map((r) => roleShort(t, r)).join(", ")}</Badge> : null}
            </h2>
            <span style={{ flex: 1 }} />
            {current && can.folderAccess ? <span className="m-doc-edit"><Button variant="secondary" small icon={<ShieldCheck size={14} />} onClick={() => setDlg({ k: "access", folder: current })}>{t("doc.access")}</Button></span> : null}
          </div>
          <div className="m-toolbar">
            <SearchInput value={q} onChange={setQ} placeholder={t("doc.search")} />
          </div>

          {inTrash ? (
            <Note tone="warn">{t("doc.trashNote")}</Note>
          ) : (
            <label
              className={cx("m-doc-drop", "m-doc-edit", dragOver && "m-doc-drop-on")}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => onDrop(e, folder)}
            >
              <Upload size={18} />
              <span>
                {canUploadHere
                  ? <>{fmt(t("doc.dropHere"), { folder: current?.name ?? "" })} <span className="m-link">{t("doc.browse")}</span>. {t("doc.dropHint")}</>
                  : current ? fmt(t("doc.cantUploadHere"), { folder: current.name }) : t("doc.dropPickFolder")}
              </span>
              <input type="file" multiple disabled={!canUploadHere || busy} onChange={(e) => { void upload(Array.from(e.target.files ?? []), current); e.target.value = ""; }} />
            </label>
          )}

          {pending.length ? (
            <div className="m-doc-pending">
              {pending.map((p) => (
                <div key={p.key} className="m-doc-pending-row"><Loader2 className="spin" size={14} /><span>{p.name}</span><em>{fmt(t("files.uploading"), { pct: Math.round(p.progress * 100) })}</em></div>
              ))}
            </div>
          ) : null}

          <div className="m-table-wrap">
            <table className="m-table">
              <thead>
                <tr>
                  <th><button type="button" className="m-doc-th" onClick={() => sortBy("name")}>{t("doc.col.name")}{arrow("name")}</button></th>
                  {!inFolder ? <th className="m-hide-mobile">{t("doc.col.folder")}</th> : null}
                  <th>{t("doc.col.version")}</th>
                  <th className="m-num m-hide-mobile"><button type="button" className="m-doc-th" onClick={() => sortBy("size")}>{t("doc.col.size")}{arrow("size")}</button></th>
                  <th><button type="button" className="m-doc-th" onClick={() => sortBy("updated")}>{inTrash ? t("doc.col.trashed") : t("doc.col.updated")}{arrow("updated")}</button></th>
                  <th className="m-hide-mobile">{t("doc.col.by")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const editable = mayEdit(d);
                  return (
                    <tr key={d.ItemId} className="m-clickable" draggable={editable} onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, d.ItemId)} onClick={() => setDlg(d.trashed ? { k: "versions", docId: d.ItemId } : { k: "view", docId: d.ItemId })}>
                      <td><div className="m-doc-name"><Ext ext={d.ext} /><b title={d.name}>{d.name}</b></div></td>
                      {!inFolder ? <td className="m-hide-mobile">{folderName(d.folderId)}</td> : null}
                      <td><button type="button" className="m-link" onClick={(e) => { e.stopPropagation(); setDlg({ k: "versions", docId: d.ItemId }); }}>v{d.currentVersion}</button></td>
                      <td className="m-num m-hide-mobile">{fileSize(d.sizeBytes)}</td>
                      <td title={fmtDate(inTrash ? d.trashedAt : d.updatedAt)}>{fmtShortDate(inTrash ? d.trashedAt : d.updatedAt)}</td>
                      <td className="m-hide-mobile">{inTrash ? d.trashedByName : d.updatedByName}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="m-doc-acts">
                          {d.trashed ? (
                            <Button small variant="secondary" icon={<Undo2 size={14} />} disabled={busy} onClick={() => void run({ action: "restore", documentId: d.ItemId }, fmt(t("doc.restored"), { name: d.name, folder: folderName(d.folderId) }))}>{t("doc.restore")}</Button>
                          ) : (
                            <>
                              <button type="button" className="m-icon-btn" title={t("doc.view")} onClick={() => setDlg({ k: "view", docId: d.ItemId })}><Eye size={15} /></button>
                              <button type="button" className="m-icon-btn" title={t("doc.download")} onClick={() => void saveFile(projectId, d, data.linksExpireAt, toast, t)}><Download size={15} /></button>
                              <button type="button" className="m-icon-btn" title={t("doc.versions")} onClick={() => setDlg({ k: "versions", docId: d.ItemId })}><Clock size={15} /></button>
                              {editable ? <button type="button" className="m-icon-btn m-doc-edit" title={t("doc.rename")} disabled={busy} onClick={() => setDlg({ k: "rename", doc: d })}><Pencil size={15} /></button> : null}
                              {editable ? <button type="button" className="m-icon-btn m-doc-edit" title={t("doc.move")} disabled={busy} onClick={() => setDlg({ k: "move", doc: d })}><FolderInput size={15} /></button> : null}
                              {can.manage ? <button type="button" className="m-icon-btn m-doc-edit" title={t("doc.toTrash")} disabled={busy} onClick={() => void run({ action: "trash", documentId: d.ItemId }, fmt(t("doc.trashed"), { name: d.name }))}><Trash size={15} /></button> : null}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? (
              <Empty title={inTrash ? t("doc.trashEmpty") : needle ? t("doc.noMatch") : t("doc.emptyFolder")}>
                {inTrash ? t("doc.trashEmptyHint") : !needle && canUploadHere ? t("doc.emptyHint") : ""}
              </Empty>
            ) : null}
          </div>
          <p className="m-small m-muted" style={{ marginTop: 10 }}>{t("doc.later")}</p>
        </div>
      </div>

      {dlg?.k === "folder" ? (
        <FolderDialog t={t} title={t("doc.newFolder")} existing={data.folders.map((f) => f.name)} busy={action.isPending} onClose={() => setDlg(null)}
          onSave={async (name, viewRoles, uploadRoles) => {
            const r = await run({ action: "createFolder", name, viewRoles, uploadRoles }, fmt(t("doc.folderCreated"), { name }));
            if (r) { setDlg(null); if (r.folderId) setFolder(r.folderId); }
          }} />
      ) : null}
      {dlg?.k === "access" ? (
        <FolderDialog t={t} title={fmt(t("doc.accessTitle"), { folder: dlg.folder.name })} folder={dlg.folder} busy={action.isPending} onClose={() => setDlg(null)}
          onSave={async (_name, viewRoles, uploadRoles) => {
            const r = await run({ action: "setFolderAccess", folderId: dlg.folder.ItemId, viewRoles, uploadRoles }, fmt(t("doc.accessSaved"), { folder: dlg.folder.name }));
            if (r) setDlg(null);
          }} />
      ) : null}
      {dlg?.k === "rename" ? (
        <RenameDialog t={t} doc={dlg.doc} busy={action.isPending} onClose={() => setDlg(null)} onSave={async (name) => {
          const r = await run({ action: "rename", documentId: dlg.doc.ItemId, name }, t("doc.renamed"));
          if (r) setDlg(null);
        }} />
      ) : null}
      {dlg?.k === "move" ? (
        <MoveDialog t={t} doc={dlg.doc} folders={data.folders.filter((f) => f.canUpload)} busy={action.isPending} onClose={() => setDlg(null)} onMove={async (to) => {
          const r = await run({ action: "move", documentId: dlg.doc.ItemId, folderId: to }, fmt(t("doc.moved"), { name: dlg.doc.name, folder: folderName(to) }));
          if (r) setDlg(null);
        }} />
      ) : null}
      {dlg?.k === "view" && viewDoc ? (
        <FileViewer
          key={`${viewDoc.ItemId}-${dlg.versionNo ?? "cur"}`}
          name={viewDoc.name}
          ext={viewExt}
          title={<><Ext ext={viewExt} /> <span className="m-viewer-name">{viewDoc.name}</span> <Badge tone="gray">v{dlg.versionNo ?? viewDoc.currentVersion}</Badge></>}
          load={() => Promise.resolve(linkFor(projectId, viewDoc, data.linksExpireAt, dlg.versionNo))}
          onDownload={() => void saveFile(projectId, viewDoc, data.linksExpireAt, toast, t, dlg.versionNo)}
          onOpenTab={() => void openFile(projectId, viewDoc, data.linksExpireAt, toast, t, dlg.versionNo)}
          extra={<Button variant="secondary" icon={<Clock size={14} />} onClick={() => setDlg({ k: "versions", docId: viewDoc.ItemId })}><span className="m-hide-mobile">{t("doc.versions")}</span></Button>}
          onClose={() => setDlg(null)}
        />
      ) : null}
      {dlg?.k === "versions" && versionsDoc ? (
        <VersionsDrawer t={t} projectId={projectId} doc={versionsDoc} folder={folderById.get(versionsDoc.folderId)} data={data} toast={toast} busy={busy}
          onClose={() => setDlg(null)}
          onView={(v) => setDlg({ k: "view", docId: versionsDoc.ItemId, versionNo: v === versionsDoc.currentVersion ? undefined : v })}
          onRestore={(v) => void run({ action: "restoreVersion", documentId: versionsDoc.ItemId, versionNo: v }, fmt(t("doc.versionRestored"), { v }))}
          onUpload={async (file, note) => {
            const why = docRefusal(file);
            if (why) { toast(why === "type" ? fmt(t("doc.badType"), { name: file.name, types: DOC_EXTENSIONS.join(", ") }) : why === "size" ? fmt(t("files.tooBig"), { name: file.name, size: fileSize(file.size) }) : fmt(t("files.empty"), { name: file.name }), "warn"); return; }
            const key = `${Date.now()}-v-${file.name}`;
            setPending((p) => [...p, { key, name: file.name, progress: 0 }]);
            try {
              const [res] = await uploadDocs(projectId, versionsDoc.folderId, [file], (_i, done) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: done } : x))));
              if (!res || res instanceof Error) { toast(fmt(t("doc.uploadFailed"), { name: file.name }), "warn"); return; }
              await run({ action: "newVersion", documentId: versionsDoc.ItemId, file: res, note }, fmt(t("doc.newVersionDone"), { name: versionsDoc.name, v: versionsDoc.currentVersion + 1 }));
            } catch (e) {
              toast(errorText(t, e), "warn");
            } finally {
              setPending((p) => p.filter((x) => x.key !== key));
            }
          }} />
      ) : null}
    </div>
  );
}

// ---------- dialogs ----------
function RoleMatrix({ t, view, upload, onChange }: { t: T; view: string[]; upload: string[]; onChange: (view: string[], upload: string[]) => void }) {
  return (
    <div className="m-table-wrap">
      <table className="m-table m-doc-matrix">
        <thead><tr><th>{t("doc.role")}</th><th>{t("doc.canView")}</th><th>{t("doc.canUpload")}</th></tr></thead>
        <tbody>
          {PROJECT_ROLES.map((r) => {
            const always = MANAGERS.includes(r);
            const uploads = projectCan(r, "document.upload");
            return (
              <tr key={r}>
                <td>{t(ROLE_LABEL[r].label)}</td>
                <td>{always ? <span className="m-small m-muted">{t("doc.always")}</span> : (
                  <Checkbox checked={view.includes(r)} onChange={(on) => onChange(on ? [...view, r] : view.filter((x) => x !== r), on ? upload : upload.filter((x) => x !== r))} />
                )}</td>
                <td>{always ? <span className="m-small m-muted">{t("doc.always")}</span> : !uploads ? <span className="m-small m-muted">{t("doc.readOnlyRole")}</span> : (
                  <Checkbox checked={upload.includes(r)} onChange={(on) => onChange(on && !view.includes(r) ? [...view, r] : view, on ? [...upload, r] : upload.filter((x) => x !== r))} />
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FolderDialog({ t, title, folder, existing, busy, onClose, onSave }: {
  t: T; title: string; folder?: DocFolder; existing?: string[]; busy: boolean; onClose: () => void;
  onSave: (name: string, viewRoles: string[], uploadRoles: string[]) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [view, setView] = useState<string[]>(folder ? folder.viewRoles.filter((r) => !MANAGERS.includes(r)) : ["superintendent", "design-reviewer", "owner-viewer"]);
  const [upload, setUpload] = useState<string[]>(folder ? folder.uploadRoles : []);
  const n = name.trim();
  const err = folder || !n ? "" : existing?.some((f) => f.toLowerCase() === n.toLowerCase()) ? t("doc.folderExists") : /[\\/]/.test(n) ? t("doc.folderSlash") : "";
  return (
    <Dialog title={<>{folder ? <ShieldCheck size={18} /> : <FolderPlus size={18} />} {title}</>} size="md" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
      <Button onClick={() => onSave(n, view, upload)} disabled={busy || (!folder && (!n || Boolean(err)))}>{folder ? t("common.save") : t("doc.createFolder")}</Button>
    </>}>
      <div className="m-stack-v">
        {folder ? null : (
          <Field label={t("doc.folderName")} hint={err || undefined}>
            <input className="m-input" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("doc.folderPlaceholder")} />
          </Field>
        )}
        <RoleMatrix t={t} view={view} upload={upload} onChange={(v, u) => { setView(v); setUpload(u); }} />
        <Note tone="info">{t("doc.accessNote")}</Note>
      </div>
    </Dialog>
  );
}

function RenameDialog({ t, doc, busy, onClose, onSave }: { t: T; doc: DocRow; busy: boolean; onClose: () => void; onSave: (name: string) => void }) {
  const stem = doc.name.replace(/\.[^.]+$/, "");
  const [name, setName] = useState(stem);
  const changed = Boolean(name.trim()) && name.trim() !== stem;
  return (
    <Dialog title={<><Pencil size={17} /> {t("doc.rename")}</>} size="sm" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
      <Button onClick={() => onSave(name.trim())} disabled={busy || !changed}>{t("doc.rename")}</Button>
    </>}>
      <Field label={t("doc.fileName")} hint={fmt(t("doc.renameHint"), { ext: doc.ext })}>
        <input className="m-input" autoFocus maxLength={110} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && changed && !busy) onSave(name.trim()); }} />
      </Field>
    </Dialog>
  );
}

function MoveDialog({ t, doc, folders, busy, onClose, onMove }: { t: T; doc: DocRow; folders: DocFolder[]; busy: boolean; onClose: () => void; onMove: (to: string) => void }) {
  const options = folders.filter((f) => f.ItemId !== doc.folderId);
  const [to, setTo] = useState(options[0]?.ItemId ?? "");
  return (
    <Dialog title={<><FolderInput size={17} /> {fmt(t("doc.moveTitle"), { name: doc.name })}</>} size="sm" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
      <Button onClick={() => onMove(to)} disabled={busy || !to}>{t("doc.move")}</Button>
    </>}>
      {options.length ? (
        <Field label={t("doc.moveTo")} hint={t("doc.moveHint")}>
          <Select value={to} onChange={setTo} options={options.map((f) => ({ value: f.ItemId, label: f.name }))} />
        </Field>
      ) : <Note tone="info">{t("doc.moveNowhere")}</Note>}
    </Dialog>
  );
}

function VersionsDrawer({ t, projectId, doc, folder, data, toast, busy, onClose, onRestore, onUpload, onView }: {
  t: T; projectId: string; doc: DocRow; folder?: DocFolder; data: DocListing; toast: Toast; busy: boolean; onClose: () => void;
  onRestore: (versionNo: number) => void; onUpload: (file: File, note: string) => void; onView: (versionNo: number) => void;
}) {
  const editable = !doc.trashed && Boolean(folder?.canUpload);
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const restoredLabel = (v: DocVersion) => (v.restoredFrom ? fmt(t("doc.restoredFrom"), { v: v.restoredFrom }) : "");
  return (
    <Drawer title={<><Clock size={17} /> {doc.name}</>} onClose={onClose} footer={editable ? (
      <div className="m-doc-edit m-doc-newversion">
        <input className="m-input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t("doc.versionNote")} />
        <Button icon={<Upload size={15} />} disabled={busy} onClick={() => input.current?.click()}>{t("doc.uploadVersion")}</Button>
        <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { onUpload(f, note.trim()); setNote(""); } e.target.value = ""; }} />
      </div>
    ) : <span className="m-muted m-small">{doc.trashed ? t("doc.inTrashNoVersions") : data.archived ? t("doc.archived") : t("doc.versionsReadOnly")}</span>}>
      <div className="m-stack-v">
        <div className="m-small m-muted">
          {folder?.name} · {fmt(t("doc.firstBy"), { name: doc.createdByName ?? "", date: fmtDate(doc.createdAt) })}
          {doc.trashed ? <> · <Badge tone="red">{t("doc.inTrash")}</Badge></> : null}
        </div>
        <Note tone="info">{t("doc.versionsNote")}</Note>
        <div className="m-table-wrap">
          <table className="m-table">
            <thead><tr><th>{t("doc.col.version")}</th><th>{t("doc.col.date")}</th><th className="m-hide-mobile">{t("doc.col.by")}</th><th className="m-num">{t("doc.col.size")}</th><th /></tr></thead>
            <tbody>
              {doc.versions.map((v) => {
                const isCurrent = v.versionNo === doc.currentVersion;
                return (
                  <tr key={v.versionNo}>
                    <td>
                      <span className="m-row"><b>v{v.versionNo}</b>{isCurrent ? <Badge tone="green">{t("doc.current")}</Badge> : null}</span>
                      {v.note || v.restoredFrom ? <div className="m-small m-muted">{v.restoredFrom ? restoredLabel(v) : v.note}</div> : null}
                      {v.fileName !== doc.name ? <div className="m-small m-muted" title={v.fileName}>{v.fileName}</div> : null}
                    </td>
                    <td>{fmtDate(v.uploadedAt)}</td>
                    <td className="m-hide-mobile">{v.uploadedByName}</td>
                    <td className="m-num">{fileSize(v.sizeBytes)}</td>
                    <td>
                      <div className="m-doc-acts">
                        {!doc.trashed ? <button type="button" className="m-icon-btn" title={fmt(t("doc.viewVersion"), { v: v.versionNo })} onClick={() => onView(v.versionNo)}><Eye size={15} /></button> : null}
                        <button type="button" className="m-icon-btn" title={fmt(t("doc.openVersion"), { v: v.versionNo })} onClick={() => void saveFile(projectId, doc, data.linksExpireAt, toast, t, v.versionNo)}><Download size={15} /></button>
                        {!isCurrent && editable ? <button type="button" className="m-icon-btn m-doc-edit" title={fmt(t("doc.makeCurrent"), { v: v.versionNo })} disabled={busy} onClick={() => onRestore(v.versionNo)}><RotateCcw size={15} /></button> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <span className="m-small m-muted">{fmt(t("doc.typeHint"), { types: DOC_EXTENSIONS.join(", ") })}</span>
      </div>
    </Drawer>
  );
}
