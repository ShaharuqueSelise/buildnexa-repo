// Field app, part 2: the Punch tab, the 3-tap capture and the item screen (demo app: PunchTab,
// CaptureScreen, ItemScreen in mock/src/mock/pages/FieldPage.tsx). Everything runs on the punch
// Function through punchApi, with the same rules as the desktop:
// - only the superintendent and the PM create items and close them;
// - an after photo is needed before an item is marked ready or closed;
// - a subcontractor gets their own company's items only (the server sends no others).
// New items save in the background (punchApi's create queue: a failed one stays in the list with
// Retry) and their photo follows through the photo queue. The company hears about a new item when
// it's saved, so the demo's "Finish walk · notify N companies" button isn't needed.
// Desktop only: edit, reassign, void, bulk changes, the full history.
import { AlertTriangle, Camera, CheckCircle2, ClipboardCheck, ImageOff, Loader2, MapPin, Monitor, Play, Plus, RefreshCw, RotateCcw, Send, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { Badge, Empty, Note, Segmented, cx, fmt } from "../../shared/m/ui";
import { photoRefusal, retryPhoto } from "../photos/photosApi";
import { PUNCH_ACTIVE, addPunchPhoto, createPunch, dropCreate, refusalText, retryCreate, usePendingCreates, usePunchAction, usePunchItem, usePunchList } from "../punch/punchApi";
import type { PunchCompany, PunchPhoto } from "../punch/punchApi";
import { StatusPill } from "../punch/PunchPage";
import { DueLabel } from "../rfis/RfisPage";
import { fmtShortDate } from "../projects/ProjectsPage";
import { AppBar, PunchLine, fmtWhen, live, sortByDue, toVerify } from "./fieldUi";
import type { Ctx } from "./fieldUi";

// ---------- the list ----------

type Scope = "mine" | "ready" | "created" | "all";
const SCOPE_LABEL: Record<Scope, TranslationKey> = { mine: "fld.scope.mine", ready: "fld.scope.ready", created: "fld.scope.created", all: "fld.scope.all" };

export function PunchTab({ ctx }: { ctx: Ctx }) {
  const { t, project, isSub, isGc, myUserId } = ctx;
  const list = usePunchList(project.ItemId);
  const pending = usePendingCreates(project.ItemId);
  const queryClient = useQueryClient();
  const scopes: Scope[] = isSub ? ["mine", "ready", "all"] : isGc ? ["ready", "created", "all"] : ["all", "ready"];
  const [scope, setScope] = useState<Scope>(scopes[0]!);
  const active = live(list.data?.items);
  const rows = scope === "ready" ? toVerify(list.data?.items, myUserId)
    : sortByDue(scope === "mine" ? active.filter((p) => p.status === "open" || p.status === "inProgress")
      : scope === "created" ? active.filter((p) => p.createdByUserId === myUserId)
        : active);

  return (
    <>
      <AppBar title={t("fld.tab.punch")} sub={isSub && ctx.myCompanyName ? fmt(t("fld.punchOwnOnly"), { company: ctx.myCompanyName }) : undefined} right={list.data ? <Badge tone="gray">{rows.length}</Badge> : null} />
      <div className="fld-body fld-body-fab">
        <div className="fld-seg">
          <Segmented<Scope> value={scope} onChange={setScope} options={scopes.map((s) => ({ key: s, label: t(isSub && s === "ready" ? "fld.scope.readySub" : SCOPE_LABEL[s]) }))} />
        </div>

        {pending.length ? (
          <div className="fld-list">
            {pending.map((p) => (
              <div key={p.clientRequestId} className="fld-row fld-row-static">
                <span className="fld-thumb">{p.localUrl ? <img src={p.localUrl} alt="" /> : <Camera size={18} />}</span>
                <span className="fld-row-main">
                  <b>{p.input.title}</b>
                  <small>{p.companyName}</small>
                  {p.state === "failed"
                    ? <small className="fld-over"><AlertTriangle size={11} /> {p.error || t("punch.sendFailed")}</small>
                    : <small><Loader2 size={11} className="spin" /> {t("fld.saving")}</small>}
                </span>
                {p.state === "failed" ? (
                  <span className="fld-row-btns">
                    <button type="button" className="fld-icon-btn" aria-label={t("punch.retry")} onClick={() => void retryCreate(queryClient, p.clientRequestId)}><RefreshCw size={18} /></button>
                    <button type="button" className="fld-icon-btn" aria-label={t("fld.discard")} onClick={() => dropCreate(p.clientRequestId)}><X size={18} /></button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {list.isLoading ? <p className="fld-muted fld-center">{t("shell.loading")}</p>
          : list.isError ? <Note tone="warn">{refusalText(list.error, t("fld.couldNotLoad"))}</Note>
          : rows.length ? <div className="fld-list">{rows.slice(0, 60).map((p) => <PunchLine key={p.ItemId} p={p} ctx={ctx} />)}</div>
          : <p className="fld-muted fld-center">{t("fld.nothingHere")}</p>}
        {rows.length > 60 ? <p className="fld-muted fld-center">{fmt(t("fld.moreOnDesktop"), { count: rows.length - 60 })}</p> : null}
      </div>
      {list.data?.can.create ? (
        <button type="button" className="fld-fab" aria-label={t("fld.newPunch")} onClick={() => ctx.open({ kind: "capture" })}><Plus size={30} /></button>
      ) : null}
    </>
  );
}

// ---------- 3-tap capture ----------

export function CaptureScreen({ ctx }: { ctx: Ctx }) {
  const { t, project } = ctx;
  const queryClient = useQueryClient();
  const list = usePunchList(project.ItemId);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>();
  const [title, setTitle] = useState("");
  const [typed, setTyped] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const [editLocation, setEditLocation] = useState(false);
  const [taps, setTaps] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const data = list.data;

  const bar = (right?: ReactNode) => <AppBar title={t("fld.newPunch")} onBack={ctx.back} backLabel={t("common.cancel")} right={right} />;
  if (!data) {
    return <>{bar()}<div className="fld-body">{list.isError ? <Note tone="warn">{refusalText(list.error, t("fld.couldNotLoad"))}</Note> : <p className="fld-muted fld-center">{t("shell.loading")}</p>}</div></>;
  }
  if (!data.can.create) return <>{bar()}<div className="fld-body"><Note tone="warn">{t("punch.createWhy")}</Note></div></>;

  const step = !file ? 0 : !title ? 1 : 2;
  const place = location ?? data.suggestions.locations[0] ?? "";
  const companies: PunchCompany[] = [...data.companies].sort((a, b) => Number(b.companyId === data.suggestions.lastCompanyId) - Number(a.companyId === data.suggestions.lastCompanyId));

  const pick = (f?: File) => {
    if (!f) return;
    const why = photoRefusal(f);
    if (why) { ctx.toast(t(why === "type" ? "punch.notAPhoto" : why === "size" ? "punch.photoTooBig" : "punch.photoEmpty"), "warn"); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(/^image\/(jpeg|png|webp)$/.test(f.type) ? URL.createObjectURL(f) : undefined);
    if (!file) setTaps((n) => n + 1);
  };
  const chooseTitle = (value: string) => {
    if (value.trim().length < 3) return;
    setTitle(value.trim());
    setTaps((n) => n + 1);
  };
  const save = (c: PunchCompany) => {
    if (!file || !title) return;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    createPunch(queryClient, project.ItemId, { title, priority: "normal", location: place.trim() || undefined, dueDate: data.defaultDueDate || undefined, assigneeCompanyId: c.companyId }, c.companyName, file)
      .then((d) => ctx.toast(fmt(t("punch.savedToast"), { number: d.item.number, company: d.item.assigneeCompanyName ?? c.companyName })))
      .catch((e) => ctx.toast(refusalText(e, t("punch.sendFailed")), "warn"));
    ctx.toast(fmt(t("fld.savingIn"), { taps: taps + 1, secs }));
    ctx.leaveTo("punch");
  };

  return (
    <>
      {bar(<Badge tone={taps + (step === 2 ? 1 : 0) <= 3 ? "green" : "amber"}>{fmt(t("fld.taps"), { count: taps })}</Badge>)}
      <div className="fld-body">
        <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        <div className="fld-steps" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={cx(i <= step && "fld-step-on")} />)}</div>

        {step === 0 ? (
          <button type="button" className="fld-viewfinder" onClick={() => input.current?.click()}>
            <Camera size={34} />
            <b>{t("punch.takePhoto")}</b>
            <span>{t("punch.takePhotoHint")}</span>
            <i className="fld-shutter" />
          </button>
        ) : (
          <div className="fld-shot">
            {preview ? <img src={preview} alt="" /> : <span className="fld-shot-none"><Camera size={22} />{file?.name}</span>}
            <button type="button" className="fld-shot-retake" onClick={() => input.current?.click()}><RotateCcw size={14} /> {t("punch.retake")}</button>
          </div>
        )}

        {step === 1 ? (
          <div className="fld-step">
            <h3>{t("punch.whatsWrong")}</h3>
            {data.suggestions.titles.length ? <div className="fld-chips">{data.suggestions.titles.slice(0, 5).map((x) => <button key={x} type="button" className="fld-chip" onClick={() => chooseTitle(x)}>{x}</button>)}</div> : null}
            <form className="fld-inline" onSubmit={(e) => { e.preventDefault(); chooseTitle(typed); }}>
              <input className="m-input fld-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={data.suggestions.titles.length ? t("fld.orType") : t("punch.titlePh")} maxLength={140} enterKeyHint="next" />
              <button type="submit" className="fld-big fld-primary fld-big-sm" disabled={typed.trim().length < 3}>{t("fld.next")}</button>
            </form>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="fld-step">
            <button type="button" className="fld-card fld-summary" onClick={() => { setTitle(""); setTyped(title); }}>
              <b>{title}</b>
              <span className="fld-muted">{[place || t("fld.noLocation"), fmt(t("fld.dueOn"), { date: data.defaultDueDate ? fmtShortDate(data.defaultDueDate) : "—" }), t("punch.priority.normal")].join(" · ")}</span>
            </button>
            {editLocation ? (
              <input className="m-input fld-input" autoFocus value={place} onChange={(e) => setLocation(e.target.value)} placeholder={t("punch.locationPh")} list="fld-locations" maxLength={120} onBlur={() => setEditLocation(false)} />
            ) : (
              <button type="button" className="fld-link" onClick={() => setEditLocation(true)}><MapPin size={14} /> {t("fld.changeLocation")}</button>
            )}
            <datalist id="fld-locations">{data.suggestions.locations.map((x) => <option key={x} value={x} />)}</datalist>
            <h3>{t("fld.assignTo")}</h3>
            {companies.length ? (
              <div className="fld-chips">
                {companies.map((c) => (
                  <button key={c.companyId} type="button" className="fld-chip fld-chip-co" onClick={() => save(c)}>
                    <b>{c.companyName}</b>
                    {c.trade ? <span>{c.trade}</span> : null}
                  </button>
                ))}
              </div>
            ) : <Note tone="warn">{t("punch.noCompanies")}</Note>}
          </div>
        ) : null}
      </div>
    </>
  );
}

// ---------- one item ----------

export function ItemScreen({ ctx, id }: { ctx: Ctx; id: string }) {
  const { t, project, onNavigate } = ctx;
  const detail = usePunchItem(project.ItemId, id);
  const action = usePunchAction(project.ItemId);
  const [reason, setReason] = useState<null | "sendBack" | "reopen">(null);
  const [why, setWhy] = useState("");
  const [comment, setComment] = useState("");
  const beforeInput = useRef<HTMLInputElement>(null);
  const afterInput = useRef<HTMLInputElement>(null);
  const d = detail.data;
  const bar = (title: ReactNode, right?: ReactNode) => <AppBar title={title} onBack={ctx.back} backLabel={t("fld.back")} right={right} />;

  if (!d) {
    return (
      <>
        {bar(t("punch.item"))}
        <div className="fld-body">
          {detail.isError ? <Empty icon={<ImageOff size={28} />} title={t("punch.cantOpen")}>{refusalText(detail.error, t("common.error"))}</Empty> : <p className="fld-muted fld-center">{t("shell.loading")}</p>}
        </div>
      </>
    );
  }

  const p = d.item;
  const can = d.can;
  const q = ctx.photoQueue.get(p.ItemId);
  const before = d.photos.filter((x) => x.role === "before");
  const after = d.photos.filter((x) => x.role === "after");
  const busy = action.isPending;
  const afterGoingUp = Boolean(q && q.after > 0 && q.uploading > 0);
  const anything = can.start || can.markReady || can.close || can.sendBack || can.reopen || can.addAfterPhoto;

  const run = async (body: Parameters<typeof action.mutateAsync>[0], ok: string) => {
    try {
      await action.mutateAsync(body);
      ctx.toast(ok);
      return true;
    } catch (e) {
      ctx.toast(refusalText(e, t("common.error")), "warn");
      return false;
    }
  };
  const addPhotos = (role: "before" | "after", files: FileList | null) => {
    const good = [...(files ?? [])].filter((f) => !photoRefusal(f));
    if (good.length < (files?.length ?? 0)) ctx.toast(t("punch.notAPhoto"), "warn");
    if (!good.length) return;
    addPunchPhoto(project.ItemId, p.ItemId, role, good, p.location);
    ctx.toast(t(role === "after" ? "punch.afterUploading" : "punch.beforeUploading"));
  };

  const photo = (role: "before" | "after", photos: PunchPhoto[]) => {
    const last = photos[photos.length - 1];
    const going = Boolean(q && q[role] > 0 && q.uploading > 0);
    return (
      <div className="fld-photo">
        <small>{t(role === "before" ? "punch.before" : "punch.after")}{photos.length > 1 ? ` · ${photos.length}` : ""}</small>
        {last && (last.previewUrl || last.thumbUrl) ? (
          <button type="button" onClick={() => onNavigate(`/photos/${last.ItemId}`)} title={`${last.uploadedByName} · ${fmtWhen(last.uploadedAt)}`}><img src={last.previewUrl ?? last.thumbUrl} alt="" loading="lazy" /></button>
        ) : (
          <span className="fld-nophoto">
            {going ? <><Upload size={20} />{t("punch.photoUploading")}</>
              : role === "before" && p.pinId && !p.photoMissing ? <><MapPin size={20} />{t("punch.fromPin")}</>
              : role === "before" && p.photoMissing ? <><AlertTriangle size={20} />{t("punch.photoMissingLong")}</>
              : <><Camera size={20} />{t(role === "before" ? "punch.noBefore" : "punch.noAfter")}</>}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      {bar(p.number, <StatusPill status={p.status} t={t} />)}
      <div className="fld-body">
        <input ref={beforeInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addPhotos("before", e.target.files); e.target.value = ""; }} />
        <input ref={afterInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addPhotos("after", e.target.files); e.target.value = ""; }} />

        <h2 className="fld-item-title">{p.title}</h2>
        <div className="fld-muted fld-item-meta">
          {[p.location, p.assigneeCompanyName].filter(Boolean).join(" · ")}{p.location || p.assigneeCompanyName ? " · " : ""}
          <DueLabel due={p.dueDate} done={!PUNCH_ACTIVE.includes(p.status)} today={d.today} t={t} />
        </div>
        {p.status === "inProgress" && p.lastRejectReason ? <Note tone="warn"><b>{t("punch.sentBackBecause")}</b> {p.lastRejectReason}</Note> : null}

        <div className="fld-photos">
          {photo("before", before)}
          {photo("after", after)}
        </div>
        {q?.failed.length ? <button type="button" className="fld-big fld-secondary fld-big-sm" onClick={() => q.failed.forEach(retryPhoto)}><RefreshCw size={16} /> {t("punch.retryPhoto")}</button> : null}

        {d.pin ? (
          <button type="button" className="fld-row fld-row-card" onClick={() => onNavigate(`/drawings/${encodeURIComponent(d.pin!.sheetId)}?pin=${encodeURIComponent(d.pin!.pinId)}`)}>
            <MapPin size={20} />
            <span className="fld-row-main"><b>{d.pin.sheetNumber}{d.pin.sheetTitle ? ` · ${d.pin.sheetTitle}` : ""}</b><small>{t("punch.openSheet")}</small></span>
          </button>
        ) : null}

        <div className="fld-actions">
          {can.start ? <button type="button" className="fld-big fld-secondary" disabled={busy} onClick={() => void run({ action: "start", itemId: p.ItemId }, fmt(t("punch.startedToast"), { number: p.number }))}><Play size={20} /> {t("fld.startWork")}</button> : null}
          {can.addAfterPhoto ? <button type="button" className={cx("fld-big", after.length ? "fld-secondary" : "fld-primary")} disabled={busy} onClick={() => afterInput.current?.click()}><Camera size={20} /> {t(after.length ? "fld.anotherAfter" : "punch.addAfter")}</button> : null}
          {can.markReady ? <button type="button" className="fld-big fld-success" disabled={busy || !can.hasAfterPhoto} onClick={() => void run({ action: "markReady", itemId: p.ItemId }, fmt(t("punch.readyToast"), { number: p.number }))}><CheckCircle2 size={20} /> {t("punch.action.markReady")}</button> : null}
          {can.close ? <button type="button" className="fld-big fld-success" disabled={busy || !can.hasAfterPhoto} onClick={() => void run({ action: "close", itemId: p.ItemId }, fmt(t("punch.closedToast"), { number: p.number }))}><ClipboardCheck size={20} /> {t("punch.action.close")}</button> : null}
          {(can.markReady || can.close) && !can.hasAfterPhoto ? <p className="fld-muted fld-center">{afterGoingUp ? t("punch.afterUploading") : t("punch.afterFirstNote")}</p> : null}
          {(can.sendBack || can.reopen) && !reason ? (
            <button type="button" className="fld-big fld-secondary" disabled={busy} onClick={() => setReason(can.sendBack ? "sendBack" : "reopen")}><RotateCcw size={20} /> {t(can.sendBack ? "punch.action.sendBack" : "punch.action.reopen")}…</button>
          ) : null}
          {reason ? (
            <div className="fld-card">
              <b>{t(reason === "sendBack" ? "fld.sendBackWhy" : "fld.reopenWhy")}</b>
              <textarea className="m-input fld-input" autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder={t("punch.reasonPh")} maxLength={1000} />
              <div className="fld-two">
                <button type="button" className="fld-big fld-secondary fld-big-sm" onClick={() => { setReason(null); setWhy(""); }}>{t("common.cancel")}</button>
                <button type="button" className="fld-big fld-primary fld-big-sm" disabled={busy || why.trim().length < 3} onClick={() => void run({ action: reason, itemId: p.ItemId, reason: why.trim() }, fmt(t(reason === "reopen" ? "punch.reopenedToast" : "punch.sentBackToast"), { number: p.number })).then((ok) => { if (ok) { setReason(null); setWhy(""); } })}>
                  <RotateCcw size={16} /> {t(reason === "sendBack" ? "punch.action.sendBack" : "punch.action.reopen")}
                </button>
              </div>
            </div>
          ) : null}
          {can.addBeforePhoto && !before.length ? <button type="button" className="fld-big fld-secondary" onClick={() => beforeInput.current?.click()}><Camera size={20} /> {t("punch.addBefore")}</button> : null}
          {busy ? <p className="fld-muted fld-center"><Loader2 size={16} className="spin" /></p> : null}
          {!anything ? <Note>{PUNCH_ACTIVE.includes(p.status) ? (ctx.isSub && p.status === "readyForReview" ? t("fld.waitingGc") : t("punch.viewOnly")) : t("punch.nothingToDo")}</Note> : null}
        </div>

        {d.comments.length || can.comment ? (
          <div className="fld-card fld-comments">
            <b>{fmt(t("punch.comments"), { count: d.comments.length })}</b>
            {d.comments.slice(-2).map((c) => (
              <div key={c.ItemId} className="fld-comment"><small>{c.authorName} · {fmtWhen(c.postedAt)}</small><p>{c.body}</p></div>
            ))}
            {can.comment ? (
              <form className="fld-inline" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void run({ action: "comment", itemId: p.ItemId, body: comment.trim() }, t("punch.commentPosted")).then((ok) => ok && setComment("")); }}>
                <input className="m-input fld-input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("punch.commentPh")} maxLength={2000} enterKeyHint="send" />
                <button type="submit" className="fld-icon-btn fld-icon-primary" aria-label={t("punch.post")} disabled={busy || !comment.trim()}><Send size={18} /></button>
              </form>
            ) : null}
          </div>
        ) : null}

        <button type="button" className="fld-big fld-ghost" onClick={() => onNavigate(`/punch/${p.ItemId}`)}><Monitor size={18} /> {t("fld.openOnFullSite")}</button>
      </div>
    </>
  );
}
