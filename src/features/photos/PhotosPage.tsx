// Photos (DOC-01), built from the demo app's Photos page (mock/src/mock/pages/PhotosPage.tsx): the
// gallery by day taken, by album (tag) and by location, filters, select with bulk tag, the
// lightbox (previous/next with the arrow keys, details, caption, tags, link to the RFI, download
// the original, remove and restore) and the upload dialog with the background queue.
// Every action goes through the photos Function, which decides who may do what; the buttons
// shown here follow its answer (can.upload, can.manage, photo.canEdit, photo.canRemove).
// Deep link: /photos/<photoId> opens the lightbox.
// Punch items link their before and after photos here (the punch page uploads them). Not real yet:
// sheet pins (Drawings step), links to daily logs (their step),
// linking an existing photo to another record (R2), download as a zip (R2), Draft RFI from a
// photo (R3), uploads that continue after the app is closed (R2, PWA).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera, ChevronLeft, ChevronRight, CloudUpload, Download, Image as ImageIcon, ImagePlus, Link2, Loader2, RotateCcw, Sparkles,
  Tag, Trash, Undo2, WifiOff, X
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { FUNCTIONS, FunctionRefused } from "../../lib/blocks/functions";
import {
  Badge, Button, Dialog, Empty, Field, KeyValue, Note, PageTitle, Panel, ProgressBar, ReleaseTag, SearchInput, Segmented, Select, Toasts, cx, fmt,
  useToasts
} from "../../shared/m/ui";
import type { ToastTone } from "../../shared/m/ui";
import { useProjects } from "../projects/projectsApi";
import { fmtDate, fmtShortDate } from "../projects/ProjectsPage";
import { fileSize } from "../files/files";
import { saveUrlAs } from "../files/FileViewer";
import {
  clearFinishedPhotos, dropPhoto, enqueuePhotos, mergePhotos, originalLink, photoLinks, photoRefusal, retryAllPhotos, retryPhoto,
  useMergeQueued, usePhotoAction, usePhotoQueue, usePhotos
} from "./photosApi";
import type { LinkableRfi, Photo, QueueItem } from "./photosApi";
import "./PhotosPage.css";

type Nav = { onNavigate: (path: string) => void; params?: string[] };
type T = (key: TranslationKey) => string;
type Toast = (text: string, tone?: ToastTone) => void;
type Mode = "timeline" | "albums" | "location";

const PAGE = 120; // photos drawn at a time; "Show more" adds the next ones
const errorText = (t: T, e: unknown) => (e instanceof FunctionRefused || e instanceof Error ? e.message : t("common.error"));
const count = (t: T, one: TranslationKey, many: TranslationKey, n: number) => fmt(t(n === 1 ? one : many), { count: n });

// The local day and time a photo was taken (the device's time zone).
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const titleOf = (p: Photo) => p.caption || p.fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
const splitTags = (text: string) => text.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

function Thumb({ photo, url, onClick, large }: { photo: Photo; url?: string; onClick?: () => void; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const label = titleOf(photo);
  const body = url && !failed ? (
    <img src={url} alt={label} loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className="m-pho-ph">
      {photo.hasPreview && !failed && !photo.removed ? <Loader2 className="spin" size={18} /> : <ImageIcon size={large ? 34 : 22} />}
      <span>{photo.hasPreview && !failed && !photo.removed ? "" : (photo.fileName.split(".").pop() ?? "").toUpperCase()}</span>
    </span>
  );
  return onClick ? (
    <button type="button" className={cx("m-pho-img", large && "m-pho-img-lg")} onClick={onClick} title={label}>{body}</button>
  ) : (
    <span className={cx("m-pho-img", large && "m-pho-img-lg")}>{body}</span>
  );
}

export function PhotosPage({ onNavigate, params = [] }: Nav) {
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
        <PageTitle title={t("photo.title")} />
        <Panel><Empty icon={<ImageIcon size={26} />} title={t("dir.noProject")}><Button small onClick={() => onNavigate("/projects")}>{t("prj.title")}</Button></Empty></Panel>
      </div>
    );
  }
  if (!FUNCTIONS.photos) {
    return (
      <div>
        <PageTitle title={t("photo.title")} />
        <Note tone="warn">{t("photo.notDeployed")}</Note>
      </div>
    );
  }
  return (
    <div>
      <PhotosView projectId={project.ItemId} openId={params[0]} onNavigate={onNavigate} toast={toast} t={t} />
      <Toasts items={toasts} />
    </div>
  );
}

function PhotosView({ projectId, openId, onNavigate, toast, t }: { projectId: string; openId?: string; onNavigate: (path: string) => void; toast: Toast; t: T }) {
  const [showRemoved, setShowRemoved] = useState(false);
  const live = usePhotos(projectId);
  // Managers get the removed list in the background as soon as the gallery is in, so
  // "Removed photos" opens at once (a call can wait up to a minute in the Blocks queue).
  const removedQuery = usePhotos(projectId, true, Boolean(live.data?.can.seeRemoved));
  const listing = showRemoved ? removedQuery.data : live.data;
  const removedPending = showRemoved && !removedQuery.data;
  const action = usePhotoAction(projectId);
  const queryClient = useQueryClient();
  const { items: queue, offline } = usePhotoQueue();
  useMergeQueued(projectId);

  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loc, setLoc] = useState("");
  const [tag, setTag] = useState("");
  const [author, setAuthor] = useState("");
  const [linkKind, setLinkKind] = useState("");
  const [mode, setMode] = useState<Mode>("timeline");
  const [sel, setSel] = useState<string[]>([]);
  const [bulkTag, setBulkTag] = useState("");
  const [light, setLight] = useState<string | undefined>(openId);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // Links for photos that came without them (beyond the newest in the list).
  const [extra, setExtra] = useState<Record<string, { thumb?: string; preview?: string }>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => setLight(openId), [openId]);
  useEffect(() => {
    setSel([]);
    setLimit(PAGE);
  }, [showRemoved]);

  const photos = listing?.photos ?? [];
  const allTags = useMemo(() => Array.from(new Set(photos.flatMap((p) => p.tags))).sort(), [photos]);
  const authors = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of photos) m.set(p.uploadedByUserId, p.uploadedByName || "—");
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [photos]);
  const locations = useMemo(() => Array.from(new Set(photos.map((p) => p.locationLabel).filter(Boolean))).sort(), [photos]);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => photos.filter((p) => {
    const day = dayOf(p.takenAt);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (loc && p.locationLabel !== loc) return false;
    if (tag && !p.tags.includes(tag)) return false;
    if (author && p.uploadedByUserId !== author) return false;
    if (linkKind === "none" && p.link) return false;
    if (linkKind === "rfi" && p.link?.type !== "rfi") return false;
    if (linkKind === "punchItem" && p.link?.type !== "punchItem") return false;
    if (linkKind === "dailyLog" && p.link?.type !== "dailyLog") return false;
    if (needle) {
      const hay = `${p.caption} ${p.fileName} ${p.locationLabel} ${p.tags.join(" ")} ${p.uploadedByName} ${p.link ? `${p.link.number} ${p.link.label}` : ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }).sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.ItemId.localeCompare(a.ItemId)), [photos, from, to, loc, tag, author, linkKind, needle]);
  const activeFilters = [from, to, loc, tag, author, linkKind, needle].filter(Boolean).length;
  const shown = filtered.slice(0, limit);

  const urlOf = (p: Photo, which: "thumb" | "preview") => (which === "thumb" ? p.thumbUrl ?? extra[p.ItemId]?.thumb : p.previewUrl ?? extra[p.ItemId]?.preview);

  // Ask for links of drawn photos that have none yet (one call for up to 240).
  const lightPhoto = light ? photos.find((p) => p.ItemId === light) : undefined;
  useEffect(() => {
    const wanted = [...shown, ...(lightPhoto ? [lightPhoto] : [])]
      .filter((p) => p.hasPreview && !p.thumbUrl && !extra[p.ItemId] && !asked.current.has(p.ItemId))
      .map((p) => p.ItemId)
      .slice(0, 240);
    if (!wanted.length) return;
    for (const id of wanted) asked.current.add(id);
    photoLinks(projectId, wanted).then((r) => setExtra((old) => ({ ...old, ...r.links }))).catch(() => undefined);
  }, [shown, lightPhoto, extra, projectId]);

  // ----- grouping -----
  const groups = useMemo(() => {
    const out: { key: string; title: string; items: Photo[] }[] = [];
    if (mode === "timeline") {
      const today = dayOf(new Date().toISOString());
      for (const p of shown) {
        const day = dayOf(p.takenAt);
        const g = out.find((x) => x.key === day);
        if (g) g.items.push(p);
        else {
          const label = `${new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long" })} · ${fmtDate(`${day}T12:00:00`)}`;
          out.push({ key: day, title: day === today ? `${label} · ${t("photo.today")}` : label, items: [p] });
        }
      }
    } else if (mode === "location") {
      for (const l of [...locations, ""]) {
        const items = shown.filter((p) => p.locationLabel === l);
        if (items.length) out.push({ key: l || "__none", title: l || t("photo.noLocation"), items });
      }
    }
    return out;
  }, [mode, shown, locations, t]);
  const albums = useMemo(() => allTags
    .map((x) => ({ tag: x, items: filtered.filter((p) => p.tags.includes(x)) }))
    .filter((a) => a.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length), [allTags, filtered]);

  // ----- selection + bulk tag -----
  const toggleSel = (id: string) => setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const applyBulkTag = () => {
    const tags = splitTags(bulkTag);
    if (!tags.length) return;
    setBulkTag("");
    action.mutate({ action: "tag", photoIds: sel, add: tags }, {
      onSuccess: (r) => {
        toast(fmt(t("photo.tagged"), { count: r.photos.length, tag: tags.map((x) => `#${x}`).join(" ") }));
        if (r.skipped) toast(fmt(t("photo.taggedSkipped"), { count: r.skipped }), "warn");
      },
      onError: (e) => toast(errorText(t, e), "warn")
    });
  };

  const lightIdx = light ? filtered.findIndex((p) => p.ItemId === light) : -1;
  const openLight = (id: string | undefined) => {
    setLight(id);
    // Keeps the address shareable (/photos/<id>) without a reload.
    const path = id ? `/photos/${encodeURIComponent(id)}` : "/photos";
    if (window.location.pathname !== path) window.history.replaceState(null, "", `${path}${window.location.search}`);
  };

  if (!live.data) {
    if (live.error) return <Note tone="danger">{errorText(t, live.error)}</Note>;
    return <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("common.loading")}</strong></div>;
  }
  const base = live.data;
  const sub = !base.can.manage && base.role === "field-user";
  const can = base.can;
  const myQueue = queue.filter((x) => x.projectId === projectId);

  const tile = (p: Photo) => {
    const on = sel.includes(p.ItemId);
    return (
      <div key={p.ItemId} className={cx("m-pho-tile", on && "m-pho-on")}>
        {!showRemoved ? (
          <label className="m-pho-check" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={on} onChange={() => toggleSel(p.ItemId)} aria-label={fmt(t("photo.selectOne"), { name: titleOf(p) })} />
          </label>
        ) : null}
        <span className="m-pho-badges">
          {p.link ? <span title={`${p.link.number} · ${p.link.label}`}><Link2 size={10} />{p.link.number}</span> : null}
        </span>
        <Thumb photo={p} url={urlOf(p, "thumb")} onClick={() => (sel.length > 0 ? toggleSel(p.ItemId) : openLight(p.ItemId))} />
        <span className="m-pho-cap"><b>{titleOf(p)}</b><span>{timeOf(p.takenAt)}</span></span>
        <span className="m-pho-cap"><span>{p.uploadedByName}</span><span>{p.locationLabel}</span></span>
      </div>
    );
  };

  return (
    <div>
      <PageTitle
        title={t("photo.title")}
        subtitle={<>
          {count(t, "photo.countOne", "photo.countMany", live.data?.photos.length ?? 0)} · {t("photo.subtitle")}
          {sub ? ` · ${t("photo.subNote")}` : ""}
        </>}
        actions={<>
          <Button variant="secondary" icon={<Sparkles size={15} />} disabled title={t("photo.draftRfiHint")}>{t("photo.draftRfi")} <ReleaseTag release="R3" /></Button>
          <Button icon={<ImagePlus size={15} />} onClick={() => setUploadOpen(true)} disabled={!can.upload} title={can.upload ? undefined : base.archived ? t("photo.archived") : t("photo.ownerNoUpload")}>{t("photo.upload")}</Button>
        </>}
      />
      {base.archived ? <Note tone="warn">{t("photo.archived")}</Note> : null}

      {myQueue.length ? <QueuePanel items={myQueue} offline={offline} t={t} /> : null}

      <div className="m-pho-filters">
        <SearchInput value={q} onChange={setQ} placeholder={t("photo.search")} />
        <input className="m-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("photo.from")} title={t("photo.from")} />
        <input className="m-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("photo.to")} title={t("photo.to")} />
        <Select value={loc} onChange={setLoc} options={locations} placeholder={t("photo.allLocations")} />
        <Select value={tag} onChange={setTag} options={allTags.map((x) => ({ value: x, label: `#${x}` }))} placeholder={t("photo.allTags")} />
        <Select value={author} onChange={setAuthor} options={authors} placeholder={t("photo.allAuthors")} />
        <Select value={linkKind} onChange={setLinkKind} options={[{ value: "rfi", label: t("photo.linkedRfi") }, { value: "punchItem", label: t("photo.linkedPunch") }, { value: "dailyLog", label: t("photo.linkedLog") }, { value: "none", label: t("photo.notLinked") }]} placeholder={t("photo.anyRecord")} />
      </div>
      <div className="m-toolbar">
        <Segmented value={mode} onChange={setMode} options={[{ key: "timeline", label: t("photo.mode.timeline") }, { key: "albums", label: t("photo.mode.albums") }, { key: "location", label: t("photo.mode.location") }]} />
        <span className="m-muted m-small">
          {fmt(t("photo.shown"), { count: filtered.length })}
          {activeFilters ? ` · ${count(t, "photo.filterOne", "photo.filterMany", activeFilters)}` : ""}
        </span>
        {activeFilters ? <button type="button" className="m-link m-small" onClick={() => { setQ(""); setFrom(""); setTo(""); setLoc(""); setTag(""); setAuthor(""); setLinkKind(""); }}>{t("photo.clearFilters")}</button> : null}
        <span style={{ flex: 1 }} />
        {mode !== "albums" && filtered.length > 0 && !showRemoved ? (
          <button type="button" className="m-link m-small" onClick={() => setSel(sel.length === shown.length ? [] : shown.map((p) => p.ItemId))}>{sel.length === shown.length ? t("photo.selectNone") : t("photo.selectAll")}</button>
        ) : null}
        {can.seeRemoved ? (
          <Button small variant={showRemoved ? "primary" : "secondary"} icon={showRemoved ? <Undo2 size={14} /> : <Trash size={14} />} onClick={() => setShowRemoved((v) => !v)}>
            {showRemoved ? t("photo.liveView") : t("photo.removedView")}
          </Button>
        ) : null}
      </div>
      {showRemoved ? <Note>{t("photo.removedNote")}</Note> : null}

      {sel.length > 0 ? (
        <div className="m-pho-bulk">
          <b>{fmt(t("photo.selected"), { count: sel.length })}</b>
          <span style={{ flex: 1 }} />
          <Tag size={15} />
          <input className="m-input" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder={t("photo.addTagBulk")} list="m-pho-taglist" onKeyDown={(e) => { if (e.key === "Enter") applyBulkTag(); }} disabled={!can.upload} />
          <datalist id="m-pho-taglist">{allTags.map((x) => <option key={x} value={x} />)}</datalist>
          <Button small onClick={applyBulkTag} disabled={!bulkTag.trim() || !can.upload || action.isPending} title={can.upload ? undefined : t("photo.ownerNoTag")}>{t("photo.tag")}</Button>
          <Button small variant="secondary" icon={<Download size={14} />} disabled title={t("photo.zipLater")}>{t("photo.download")} <ReleaseTag release="R2" /></Button>
          <Button small variant="secondary" icon={<X size={14} />} onClick={() => setSel([])}>{t("photo.clear")}</Button>
        </div>
      ) : null}

      {removedPending ? (
        removedQuery.error
          ? <Note tone="danger">{errorText(t, removedQuery.error)}</Note>
          : <div className="m-empty"><Loader2 className="spin" size={22} /><strong>{t("photo.loadingRemoved")}</strong></div>
      ) : photos.length === 0 ? (
        <Panel><Empty icon={<ImageIcon size={26} />} title={showRemoved ? t("photo.noneRemoved") : t("photo.noneTitle")}>{showRemoved ? null : t("photo.noneText")}</Empty></Panel>
      ) : filtered.length === 0 ? (
        <Panel><Empty title={t("photo.noMatch")}>{t("photo.noMatchText")}</Empty></Panel>
      ) : null}

      {mode === "albums" ? (
        albums.length === 0 && filtered.length > 0 ? <Panel><Empty icon={<Tag size={24} />} title={t("photo.noAlbums")} /></Panel> : (
          <div className="m-pho-albums">
            {albums.map((a) => (
              <button key={a.tag} type="button" className="m-pho-album" onClick={() => { setTag(a.tag); setMode("timeline"); }}>
                <span className="m-pho-album-cover">
                  {a.items.slice(0, 3).map((p) => <span key={p.ItemId}>{urlOf(p, "thumb") ? <img src={urlOf(p, "thumb")} alt="" loading="lazy" /> : null}</span>)}
                </span>
                <span className="m-pho-album-body"><b>#{a.tag}</b><span className="m-muted m-small">{fmt(t("photo.albumMeta"), { count: a.items.length, date: fmtShortDate(a.items[0]?.takenAt) })}</span></span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className={cx(sel.length > 0 && "m-pho-selecting")}>
          {groups.map((g) => {
            const allOn = g.items.every((p) => sel.includes(p.ItemId));
            return (
              <section key={g.key} className="m-pho-day">
                <div className="m-pho-day-head">
                  <h3>{g.title}</h3>
                  <Badge tone="gray">{g.items.length}</Badge>
                  {!showRemoved ? (
                    <button type="button" className="m-link m-small" onClick={() => setSel((prev) => (allOn ? prev.filter((id) => !g.items.some((p) => p.ItemId === id)) : Array.from(new Set([...prev, ...g.items.map((p) => p.ItemId)]))))}>
                      {mode === "timeline" ? (allOn ? t("photo.unselectDay") : t("photo.selectDay")) : (allOn ? t("photo.unselectGroup") : t("photo.selectGroup"))}
                    </button>
                  ) : null}
                </div>
                <div className="m-pho-grid">{g.items.map(tile)}</div>
              </section>
            );
          })}
          {filtered.length > shown.length ? (
            <div className="m-pho-more"><Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>{fmt(t("photo.showMore"), { count: Math.min(PAGE, filtered.length - shown.length), left: filtered.length - shown.length })}</Button></div>
          ) : null}
        </div>
      )}

      {light && lightPhoto ? (
        <Lightbox
          key={lightPhoto.ItemId}
          projectId={projectId}
          photo={lightPhoto}
          previewUrl={urlOf(lightPhoto, "preview")}
          index={lightIdx}
          total={filtered.length}
          myCompanyId={base.companyId}
          allTags={allTags}
          t={t}
          toast={toast}
          onNavigate={onNavigate}
          onPrev={() => { const p = filtered[lightIdx - 1]; if (p) openLight(p.ItemId); }}
          onNext={() => { const p = filtered[lightIdx + 1]; if (p) openLight(p.ItemId); }}
          onClose={() => openLight(undefined)}
          onChanged={(p) => mergePhotos(queryClient, projectId, [p])}
        />
      ) : light && !lightPhoto && !showRemoved ? (
        <Dialog title={t("photo.title")} onClose={() => openLight(undefined)} size="sm">
          <Note tone="warn">{t("photo.notFound")}</Note>
        </Dialog>
      ) : null}

      {uploadOpen ? (
        <UploadPhotosDialog
          t={t}
          rfis={base.rfis}
          locations={locations}
          allTags={allTags}
          onClose={() => setUploadOpen(false)}
          onStart={(files, options) => {
            enqueuePhotos(projectId, files, options);
            toast(count(t, "photo.queuedOne", "photo.queuedMany", files.length));
            setUploadOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function QueuePanel({ items, offline, t }: { items: QueueItem[]; offline: boolean; t: T }) {
  const done = items.filter((x) => x.state === "done").length;
  const failed = items.filter((x) => x.state === "failed").length;
  return (
    <Panel
      title={<><CloudUpload size={16} /> {fmt(t("photo.queueTitle"), { done, total: items.length })}</>}
      actions={<>
        {failed ? <Button variant="secondary" small icon={<RotateCcw size={14} />} onClick={retryAllPhotos}>{t("photo.retryAll")}</Button> : null}
        <Button variant="ghost" small onClick={clearFinishedPhotos} disabled={!done}>{t("photo.clearFinished")}</Button>
      </>}
    >
      <div className="m-pho-tray">
        {offline ? <Note tone="warn"><WifiOff size={14} /> {t("photo.offline")}</Note> : <p className="m-muted m-small" style={{ margin: 0 }}>{t("photo.keepOpen")}</p>}
        {items.map((u) => (
          <div key={u.id} className="m-pho-up">
            {u.localUrl ? <img className="m-pho-up-sw" src={u.localUrl} alt="" /> : <span className="m-pho-up-sw"><ImageIcon size={16} /></span>}
            <div>
              <div className="m-small m-strong m-pho-up-name">
                {u.file.name} <span className="m-muted">· {fileSize(u.file.size)}{u.options.locationLabel ? ` · ${u.options.locationLabel}` : ""}</span>
              </div>
              <ProgressBar value={Math.round(u.progress * 100)} tone={u.state === "done" ? "green" : u.state === "failed" ? "red" : u.state === "waiting" ? "amber" : "blue"} />
              {u.error ? <div className="m-small m-pho-up-err">{u.error}</div> : null}
            </div>
            <span className="m-small m-pho-up-state">
              {u.state === "done" ? <Badge tone="green">{t("photo.state.done")}</Badge>
                : u.state === "failed" ? <>
                  <Button small variant="secondary" icon={<RotateCcw size={13} />} onClick={() => retryPhoto(u.id)}>{t("photo.retry")}</Button>
                  <button type="button" className="m-icon-btn" onClick={() => dropPhoto(u.id)} aria-label={t("photo.dropOne")} title={t("photo.dropOne")}><X size={13} /></button>
                </>
                : u.state === "waiting" ? <Badge tone="amber">{offline ? t("photo.state.noSignal") : t("photo.state.waiting")}</Badge>
                : u.state === "saving" ? <span className="m-num">{t("photo.state.saving")}</span>
                : <span className="m-num">{Math.round(u.progress * 100)} %</span>}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Lightbox({ projectId, photo, previewUrl, index, total, myCompanyId, allTags, t, toast, onNavigate, onPrev, onNext, onClose, onChanged }: {
  projectId: string;
  photo: Photo;
  previewUrl?: string;
  index: number;
  total: number;
  myCompanyId: string;
  allTags: string[];
  t: T;
  toast: Toast;
  onNavigate: (path: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onChanged: (p: Photo) => void;
}) {
  const action = usePhotoAction(projectId);
  const [newTag, setNewTag] = useState("");
  const [caption, setCaption] = useState(photo.caption);
  const [location, setLocation] = useState(photo.locationLabel);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const prevRef = useRef(onPrev);
  const nextRef = useRef(onNext);
  prevRef.current = onPrev;
  nextRef.current = onNext;
  const editable = photo.canEdit;
  // The server may tidy the text (spaces): show what it saved.
  useEffect(() => setCaption(photo.caption), [photo.caption]);
  useEffect(() => setLocation(photo.locationLabel), [photo.locationLabel]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tagName = (e.target as HTMLElement | null)?.tagName;
      if (tagName === "INPUT" || tagName === "SELECT" || tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") prevRef.current();
      if (e.key === "ArrowRight") nextRef.current();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const save = (body: { caption?: string; locationLabel?: string; tags?: string[] }, done?: string) =>
    action.mutate({ action: "update", photoId: photo.ItemId, version: photo.version, ...body }, {
      onSuccess: (r) => {
        if (r.photos[0]) onChanged(r.photos[0]);
        if (done) toast(done);
      },
      onError: (e) => toast(errorText(t, e), "warn")
    });
  const addTag = () => {
    const tags = splitTags(newTag).filter((x) => !photo.tags.includes(x));
    setNewTag("");
    if (tags.length) save({ tags: [...photo.tags, ...tags] });
  };
  const removeTag = (x: string) => save({ tags: photo.tags.filter((y) => y !== x) });

  const download = async () => {
    setSaving(true);
    try {
      const { url, fileName } = await originalLink(projectId, photo.ItemId);
      await saveUrlAs(url, fileName || photo.fileName);
    } catch (e) {
      toast(errorText(t, e), "warn");
    } finally {
      setSaving(false);
    }
  };

  // Shown as done at once (the gallery changes straight away); a refusal comes back as a warning.
  const remove = () => {
    action.mutateAsync({ action: "remove", photoId: photo.ItemId, reason: reason.trim() || undefined }).catch((e: unknown) => toast(errorText(t, e), "warn"));
    toast(t("photo.removedDone"));
    onClose();
  };
  const restore = () => {
    action.mutateAsync({ action: "restore", photoId: photo.ItemId }).catch((e: unknown) => toast(errorText(t, e), "warn"));
    toast(t("photo.restored"));
    onClose();
  };

  const dims = photo.width && photo.height ? ` · ${photo.width} × ${photo.height}` : "";
  const captionChanged = caption.trim() !== photo.caption;
  const locationChanged = location.trim() !== photo.locationLabel;

  return (
    <Dialog
      title={<span className="m-pho-light-title">{titleOf(photo)} <span className="m-muted m-small">{index >= 0 ? `${index + 1} / ${total}` : ""}</span></span>}
      onClose={onClose}
      size="xl"
    >
      <div className="m-pho-light">
        <div className="m-pho-stage">
          <button type="button" className="m-pho-nav m-pho-nav-prev" onClick={onPrev} disabled={index <= 0} aria-label={t("photo.prev")}><ChevronLeft size={20} /></button>
          {previewUrl && !imgFailed ? (
            <img src={previewUrl} alt={titleOf(photo)} onError={() => setImgFailed(true)} />
          ) : (
            <div className="m-pho-stage-none">
              {photo.hasPreview && !photo.removed && !imgFailed ? <Loader2 className="spin" size={26} /> : <ImageIcon size={40} />}
              <span>{photo.removed ? t("photo.removedNoView") : photo.hasPreview && !imgFailed ? "" : t("photo.noPreviewImg")}</span>
            </div>
          )}
          <button type="button" className="m-pho-nav m-pho-nav-next" onClick={onNext} disabled={index < 0 || index >= total - 1} aria-label={t("photo.next")}><ChevronRight size={20} /></button>
          <span className="m-pho-stamp">{fmtDate(photo.takenAt)} {timeOf(photo.takenAt)} · {photo.uploadedByName}{photo.locationLabel ? ` · ${photo.locationLabel}` : ""}</span>
        </div>
        <div className="m-stack-v">
          {photo.removed ? (
            <Note tone="warn">
              <strong>{photo.removedAt ? fmt(t(photo.removedByName ? "photo.removedByOn" : "photo.removedOn"), { name: photo.removedByName ?? "", date: `${fmtDate(photo.removedAt)} · ${timeOf(photo.removedAt)}` }) : t("photo.removedTitle")}</strong>
              <br />
              {photo.removedReason ? fmt(t("photo.removedReason"), { reason: photo.removedReason }) : <span className="m-muted">{t("photo.noRemovedReason")}</span>}
            </Note>
          ) : null}
          <KeyValue items={[
            [t("photo.taken"), `${fmtDate(photo.takenAt)} · ${timeOf(photo.takenAt)}`],
            [t("photo.by"), <>{photo.uploadedByName}{photo.uploaderCompanyId === myCompanyId ? <span className="m-muted"> · {t("photo.yourCompany")}</span> : null}</>],
            [t("photo.location"), photo.locationLabel || <span className="m-muted">—</span>],
            [t("photo.linked"), photo.link ? (
              <button type="button" className="m-link" onClick={() => onNavigate(photo.link!.type === "dailyLog" ? `/daily-logs/${encodeURIComponent(photo.link!.number)}` : `/${photo.link!.type === "punchItem" ? "punch" : "rfis"}/${encodeURIComponent(photo.link!.id)}`)}>
                {photo.link.number} · {photo.link.label}{photo.link.role === "before" || photo.link.role === "after" ? ` · ${t(photo.link.role === "before" ? "photo.roleBefore" : "photo.roleAfter")}` : ""}
              </button>
            ) : <span className="m-muted">{t("photo.notLinked")}</span>],
            [t("photo.sheet"), <span className="m-muted">{t("photo.sheetLater")}</span>],
            [t("photo.file"), <span className="m-small">{photo.fileName} · {fileSize(photo.sizeBytes)}{dims}</span>]
          ]} />
          <hr className="m-sep" />
          {editable ? (
            <>
              <Field label={t("photo.caption")}>
                <textarea className="m-input" rows={2} maxLength={300} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t("photo.captionPlaceholder")} />
              </Field>
              <Field label={t("photo.location")}>
                <input className="m-input" maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t("photo.locationPlaceholder")} />
              </Field>
              {captionChanged || locationChanged ? (
                <div className="m-row" style={{ justifyContent: "flex-end" }}>
                  <Button small variant="secondary" onClick={() => { setCaption(photo.caption); setLocation(photo.locationLabel); }}>{t("common.cancel")}</Button>
                  <Button small disabled={action.isPending} onClick={() => save({ ...(captionChanged ? { caption: caption.trim() } : {}), ...(locationChanged ? { locationLabel: location.trim() } : {}) }, t("photo.saved"))}>{t("common.save")}</Button>
                </div>
              ) : null}
            </>
          ) : photo.caption ? <p className="m-small" style={{ margin: 0 }}>{photo.caption}</p> : null}
          <div className="m-field-label">{t("photo.tags")}{action.isPending ? <span className="m-muted m-pho-saving"><Loader2 className="spin" size={12} /> {t("photo.state.saving")}</span> : null}</div>
          <div className="m-pho-tags">
            {photo.tags.map((x) => (
              <span key={x} className="m-pho-tag">#{x}{editable ? <button type="button" onClick={() => removeTag(x)} disabled={action.isPending} aria-label={fmt(t("photo.removeTag"), { tag: x })}><X size={12} /></button> : null}</span>
            ))}
            {photo.tags.length === 0 ? <span className="m-muted m-small">{t("photo.noTags")}</span> : null}
          </div>
          {editable ? (
            <div className="m-row">
              <input className="m-input" value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder={t("photo.addTag")} list="m-pho-taglist-light" onKeyDown={(e) => { if (e.key === "Enter") addTag(); }} />
              <datalist id="m-pho-taglist-light">{allTags.filter((x) => !photo.tags.includes(x)).map((x) => <option key={x} value={x} />)}</datalist>
              <Button small onClick={addTag} disabled={!newTag.trim() || action.isPending}>{t("photo.add")}</Button>
            </div>
          ) : !photo.removed ? <span className="m-muted m-small">{t("photo.viewOnly")}</span> : null}
          <hr className="m-sep" />
          {confirmRemove ? (
            <div className="m-pho-confirm">
              <Note tone="warn">{t("photo.removeText")}</Note>
              <Field label={t("photo.reason")}><input className="m-input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="m-row" style={{ justifyContent: "flex-end" }}>
                <Button small variant="secondary" onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</Button>
                <Button small variant="danger" icon={<Trash size={14} />} onClick={remove} disabled={action.isPending}>{t("photo.remove")}</Button>
              </div>
            </div>
          ) : (
            <div className="m-row m-row-wrap">
              {!photo.removed ? <Button variant="secondary" small icon={saving ? <Loader2 className="spin" size={14} /> : <Download size={14} />} onClick={() => void download()} disabled={saving}>{t("photo.downloadOriginal")}</Button> : null}
              {photo.canRemove ? <Button variant="secondary" small icon={<Trash size={14} />} onClick={() => setConfirmRemove(true)}>{t("photo.remove")}</Button> : null}
              {photo.removed ? <Button small icon={<Undo2 size={14} />} onClick={restore} disabled={action.isPending}>{t("photo.restore")}</Button> : null}
              {!photo.removed ? <Button variant="secondary" small icon={<Sparkles size={14} />} disabled title={t("photo.draftRfiHint")}>{t("photo.draftRfiShort")} <ReleaseTag release="R3" /></Button> : null}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const touch = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

function UploadPhotosDialog({ t, rfis, locations, allTags, onClose, onStart }: {
  t: T;
  rfis: LinkableRfi[];
  locations: string[];
  allTags: string[];
  onClose: () => void;
  onStart: (files: File[], options: { locationLabel?: string; tags?: string[]; link?: { type: "rfi"; id: string } }) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [tags, setTags] = useState("");
  const [linkRfi, setLinkRfi] = useState("");
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => (/^image\/(jpeg|png|webp)$/.test(f.type) ? URL.createObjectURL(f) : undefined)), [files]);
  useEffect(() => () => { for (const u of previews) if (u) URL.revokeObjectURL(u); }, [previews]);

  const add = (list: File[]) => {
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of list) {
      const why = photoRefusal(f);
      if (why === "type") bad.push(fmt(t("photo.badType"), { name: f.name }));
      else if (why === "empty") bad.push(fmt(t("files.empty"), { name: f.name }));
      else if (why === "size") bad.push(fmt(t("photo.tooBig"), { name: f.name, size: fileSize(f.size) }));
      else ok.push(f);
    }
    setFiles((prev) => [...prev, ...ok.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size && p.lastModified === f.lastModified))]);
    setRefused(bad);
  };

  const start = () => {
    const tagList = Array.from(new Set(splitTags(tags)));
    onStart(files, {
      locationLabel: location.trim() || undefined,
      tags: tagList.length ? tagList : undefined,
      link: linkRfi ? { type: "rfi", id: linkRfi } : undefined
    });
  };

  return (
    <Dialog title={<><ImagePlus size={18} /> {t("photo.uploadTitle")}</>} onClose={onClose} size="lg" footer={<>
      <span className="m-muted m-small" style={{ marginRight: "auto" }}>{t("photo.stamped")}</span>
      <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
      <Button icon={<CloudUpload size={15} />} onClick={start} disabled={files.length === 0}>{fmt(t("photo.start"), { count: files.length || "" })}</Button>
    </>}>
      <div className="m-stack-v">
        <div
          className={cx("m-pho-drop", drag && "m-pho-drop-on")}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(Array.from(e.dataTransfer.files)); }}
        >
          <ImagePlus size={26} />
          <strong>{t("photo.choose")}</strong>
          <span className="m-small">{t("photo.chooseHint")}</span>
          <span className="m-row">
            <Button small variant="secondary" onClick={() => fileInput.current?.click()}>{t("photo.browse")}</Button>
            {touch() ? <Button small variant="secondary" icon={<Camera size={14} />} onClick={() => cameraInput.current?.click()}>{t("files.takePhoto")}</Button> : null}
          </span>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        </div>
        {refused.map((r, i) => <Note key={`${r}${i}`} tone="danger">{r}</Note>)}
        {files.length ? (
          <div className="m-pho-picked">
            {files.map((f, i) => (
              <span key={`${f.name}-${f.size}-${f.lastModified}`} className="m-pho-pick" title={f.name}>
                {previews[i] ? <img src={previews[i]} alt="" /> : <span className="m-pho-pick-ph"><ImageIcon size={16} /></span>}
                <span className="m-pho-pick-name">{f.name}</span>
                <span className="m-muted">{fileSize(f.size)}</span>
                <button type="button" className="m-icon-btn" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} aria-label={fmt(t("files.remove"), { name: f.name })}><X size={12} /></button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="m-form">
          <Field label={t("photo.location")}>
            <input className="m-input" maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t("photo.locationPlaceholder")} list="m-pho-loclist" />
            <datalist id="m-pho-loclist">{locations.map((x) => <option key={x} value={x} />)}</datalist>
          </Field>
          <Field label={t("photo.tags")} hint={t("photo.tagsHint")}>
            <input className="m-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={allTags.slice(0, 3).join(", ") || t("photo.tagsPlaceholder")} />
          </Field>
          <Field label={t("photo.linkRfi")}>
            <Select value={linkRfi} onChange={setLinkRfi} options={rfis.map((r) => ({ value: r.ItemId, label: `${r.number} · ${r.subject}` }))} placeholder={t("photo.notLinked")} />
          </Field>
          <Field label={t("photo.pinSheet")} hint={t("photo.sheetLater")}>
            <Select value="" onChange={() => undefined} options={[]} placeholder={t("photo.noSheet")} disabled />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

