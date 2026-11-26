// Drawings (DRW-01..04; docs/architecture/02-drawings.md, Phase 3 step 2): the project's drawing
// register, one row per sheet number with every revision kept, and pins that tie RFIs (and,
// from step 3, punch items) to a spot on a sheet. Sheet, SheetRevision and Pin are written only
// by this Function, after checking the caller's role on the project. Each revision is one
// single-page PDF (up to 50 MB) plus a small PNG/JPEG thumbnail made in the browser with pdf.js,
// both owned by the Buildnexa service identity.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list", projectId }                                    -> register
//   { action: "links", projectId, revisionIds }                      -> { links: { [revisionId]: { thumb } }, linksExpireAt }
//   { action: "sheet", projectId, sheetId }                          -> { sheet, revisions, pins, hiddenPins, rfis, punchItems, can, linksExpireAt }
//   { action: "uploadLinks", projectId, files: [{ name, sizeBytes, thumb?: { contentType, sizeBytes } }] }
//                                                                    -> { uploads: [{ fileId, thumbFileId, …, ticket }] }
//   { action: "publish", projectId, sheets: [upload + ticket + { sheetNumber, title, discipline,
//     setName, revisionLabel, issuedDate, note?, pageWidthPt, pageHeightPt }] }
//                                                                    -> { results: [{ fileId, ok, sheetId?, code?, error? }], notified }
//   { action: "updateSheet", projectId, sheetId, version, sheetNumber?, title?, discipline?, setName? } -> { sheet }
//   { action: "voidRevision", projectId, revisionId, reason }        -> { sheet }
//   { action: "pin", projectId, sheetId, revisionIndex, x, y, recordType: "rfi" | "punchItem" | "photo", recordId } -> { pin }
//   { action: "movePin", projectId, pinId, revisionIndex, x, y }    -> { pin }
//   { action: "removePin", projectId, pinId }                        -> { pinId }
//   { action: "photoPins", projectId, photoIds }                     -> { pins: { [photoId]: { pinId, sheetId, sheetNumber } } }
//
// Rules (Phase 3 decisions, 24 Nov 2026):
// - The caller must be an active member of the project. Everyone on the team sees the register
//   and every sheet (drawing.view, and drawing.view_relevant for subcontractors).
// - drawing.upload (PM, document controller, designer) publishes new sheets and revisions. A new
//   upload against a sheet number becomes its current revision; the older one is "superseded"
//   and stays viewable. Revision labels are unique per sheet.
// - drawing.manage_versions (PM, document controller) edits sheet details, voids a wrong
//   revision (the previous one becomes current again) and removes any pin.
// - drawing.pin (PM, superintendent, document controller, subcontractor) places pins on the CURRENT revision only, for
//   a record they can open. A pin shows on every later revision until it is moved; moving it on
//   a newer revision keeps it where it was on the older ones. People move and remove their own pins.
// - Subcontractors don't see pins of records they can't open; they get a count ("2 pins hidden").
// - Punch items (Phase 3 step 3): a new item is pinned by the punch Function's create ("New punch
//   item here"); an existing active item without a pin is pinned here. An item has at most one live
//   pin. Its history shows when it is pinned, moved or unpinned. A subcontractor sees the pins of
//   items assigned to their company or created by them (punch_item.view_assigned).
// - Daily log photos (Phase 3 small gap, 2026-11-26): a photo on a daily log can be pinned where it
//   was taken, one live pin per photo, by anyone who places pins AND sees the photo (a subcontractor
//   their own company's). Also after the log is submitted: the pin is on the drawing, the log's
//   content doesn't change; its history gets a line. A photo pin is seen by whoever sees the photo
//   (the daily log rules: PM, superintendent, document controller all; a subcontractor their own
//   company's; the owner once the log is submitted; designers none). Pins the caller can't see are
//   left out without a count, and photo pins are not counted as open pins (they are not issues)
//   and never trigger "sheet revised" notices.
// - Every sheet change matches the row's `version` (compare-and-set); revisions are never
//   overwritten, nothing is deleted.
// Never returns or logs a token; download links only go to people who may open the sheet.

// >>> shared: functions/_shared/blocks.js (copied by tools/sync-functions.mjs, do not edit here)
// Shared code for every Buildnexa Function. Blocks uploads only index.js + package.json per
// Function, so `node tools/sync-functions.mjs` copies this file into each Function's index.js
// between the "shared" markers (with `export ` removed). Edit it here, never in a Function.
//
// What is here:
// - Refused: an expected refusal; handle() turns it into { ok:false, code, error }.
// - serviceToken / client: the Buildnexa service identity (cpm-service) and its Data Gateway +
//   IAM calls. Every read is filtered to one company, every update is matched by id AND company.
// - caller: who is calling and which company they belong to (from THEIR token).
// - allocateNumber: gap-free per-project numbers (RFI-001…) on the Sequence entity
//   (docs/architecture/13 §4.1), compare-and-set as proven by spike M1b.
// - handle: the common handler shell (errors, logging, never a token in the answer).
// - client().notify / mail: the bell and email, sent only by the service identity.
// - client().presignUpload / downloadUrls / sign + issueUploads / acceptAttachments: files on
//   records, owned by the service identity, attached with a signed upload ticket.

// - permissions.js (next to this file) is copied in after it: PROJECT_ROLES, projectCan, accountCan.

const API = "https://blocksapi.slsblx.com";

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function serviceToken(ctx) {
  const res = await fetch(`${API}/iam/v4/oidc/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-blocks-key": ctx.context.tenantId },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: ctx.env.CLIENT_ID ?? "",
      client_secret: ctx.env.CLIENT_SECRET ?? ""
    })
  });
  const json = await res.json().catch(() => undefined);
  const token = json?.accessToken ?? json?.access_token;
  if (!token) throw new Error(`service token refused (${res.status})`);
  return token;
}

function client(ctx, token) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-blocks-key": ctx.context.tenantId };
  async function iam(path, body) {
    const res = await fetch(`${API}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.isSuccess === false) {
      const detail = json?.errors ? JSON.stringify(json.errors).slice(0, 200) : json?.message ?? res.status;
      throw new Error(`IAM ${path.split("?")[0]} failed: ${detail}`);
    }
    return json;
  }
  // An error is `uncertain` when the write may still have happened: no answer at all, or a 5xx.
  // A 4xx or a GraphQL error means the gateway refused it (giveBackNumber relies on this).
  async function gql(query, variables) {
    const res = await fetch(`${API}/data/v4/gateway`, { method: "POST", headers, body: JSON.stringify({ query, variables }) }).catch((error) => {
      error.uncertain = true;
      throw error;
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) {
      const error = new Error(`gateway ${res.status}: ${JSON.stringify(body.errors?.map((e) => e.message) ?? body).slice(0, 200)}`);
      error.uncertain = res.status >= 500;
      throw error;
    }
    return body.data;
  }
  // Every company's rows: only for platform work (counts per company), never sent to a company.
  async function listAll(schema, fields) {
    const q = `get${schema}s`;
    const data = await gql(`query q($input: DynamicQueryInput) { ${q}(input: $input) { items { tenantRole ${fields} } } }`, { input: { pageNo: 1, pageSize: 1000 } });
    return data?.[q]?.items ?? [];
  }
  // The service reads every tenant, so every read names the caller's company: the gateway filters
  // on the server (DynamicQueryInput.filter, a JSON string) and the result is checked again here.
  // `where` adds equality filters, e.g. { projectId }.
  // The fields filtered on are always fetched too: the result is checked against them below.
  async function list(schema, fields, tenantRole, where = {}) {
    const q = `get${schema}s`;
    const filter = JSON.stringify({ ...where, tenantRole });
    // Nested selections ("attachments { fileId … }") stay as written; only top-level names count.
    const top = new Set(fields.replace(/\{[^{}]*\}/g, " ").split(/\s+/).filter(Boolean));
    const selected = [fields.trim(), ...Object.keys(where).filter((k) => !top.has(k))].join(" ");
    const data = await gql(`query q($input: DynamicQueryInput) { ${q}(input: $input) { items { tenantRole ${selected} } } }`, { input: { pageNo: 1, pageSize: 1000, filter } });
    const items = data?.[q]?.items ?? [];
    return items.filter((r) => r.tenantRole === tenantRole && Object.entries(where).every(([k, v]) => r[k] === v));
  }
  // Activity history (audit trail): who did what, when. Never blocks the action it records.
  async function audit(me, entry) {
    try {
      await insert("ActivityEvent", {
        tenantRole: me.tenantRole,
        projectId: entry.projectId,
        recordType: entry.recordType,
        recordId: entry.recordId,
        recordNumber: entry.recordNumber,
        action: entry.action,
        actorUserId: me.userId,
        actorName: entry.actorName,
        at: new Date().toISOString(),
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        reason: entry.reason,
        changedFields: entry.changedFields,
        beforeJson: entry.before === undefined ? undefined : JSON.stringify(entry.before),
        afterJson: entry.after === undefined ? undefined : JSON.stringify(entry.after),
        summary: entry.summary,
        source: "app"
      });
    } catch {
      // The change itself succeeded; a missing history line must not turn it into an error.
    }
  }
  async function insert(schema, input) {
    const data = await gql(`mutation m($input: ${schema}InsertInput!) { insert${schema}(input: $input) { acknowledged itemId } }`, { input });
    const r = data?.[`insert${schema}`];
    if (!r?.acknowledged) throw new Error(`insert${schema} not acknowledged`);
    return r.itemId;
  }
  // Updates rows matching `where` (always AND the company); returns how many changed. Used as
  // compare-and-set: put the expected old value in `where` and check for 1. When nothing matches,
  // Blocks answers { acknowledged: false, totalImpactedData: 0 } (spike M1b), which is "0" here,
  // not an error.
  async function updateWhere(schema, where, tenantRole, input) {
    const data = await gql(
      `mutation m($where: ${schema}FilterInput, $input: ${schema}UpdateInput) { update${schema}(where: $where, input: $input) { acknowledged totalImpactedData } }`,
      { where: { ...where, tenantRole: { eq: tenantRole } }, input }
    );
    const r = data?.[`update${schema}`];
    if (!r) throw new Error(`update${schema} gave no answer`);
    return r.acknowledged ? Number(r.totalImpactedData ?? 0) : 0;
  }
  // Updates one row, matched by id AND company, so a wrong id can never touch another company.
  async function update(schema, itemId, tenantRole, input) {
    const changed = await updateWhere(schema, { ItemId: { eq: itemId } }, tenantRole, input);
    if (changed === 0) throw new Error(`update${schema} matched no row`);
  }
  // ---------- telling people: the bell (Notifier) and email (Mail) ----------
  // The service identity's role holds blocks-logic::notifier::send and the mail send permission;
  // no browser can push to someone else's bell. Both answer { isSuccess, errors } like IAM.
  async function logic(path, body) {
    const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.isSuccess === false) {
      const detail = json?.errors ? JSON.stringify(json.errors).slice(0, 200) : json?.message ?? res.status;
      throw new Error(`${path} failed: ${detail}`);
    }
    return json;
  }
  // One bell notification to several people. `payload` is what the bell shows:
  // { title, body?, link?, projectId?, kind? } (no cost figures, no internal notes).
  async function notify(userIds, payload) {
    if (!userIds.length) return;
    await logic("/logic/v4/Notifier/Notify", {
      configurationName: NOTIFIER_CONFIGURATION,
      userIds,
      denormalizedPayload: JSON.stringify(payload),
      connectionId: "server",
      responseKey: "notification",
      responseValue: "notification"
    });
  }
  // One email to one person (never a shared "to" list, so addresses stay private), through the
  // Buildnexa template. `data` fills its {{Placeholders}}.
  async function mail(to, subject, data) {
    await logic("/logic/v4/Mail/Send", {
      to: [to],
      purpose: MAIL_TEMPLATE,
      language: MAIL_LANGUAGE,
      projectKey: ctx.context.tenantId,
      subjectDataContext: { Subject: subject },
      bodyDataContext: data
    });
  }
  // Where links in emails point: the app's address in this environment.
  const appUrl = String(ctx.env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");

  // ---------- files (Blocks Storage) ----------
  // Every file belongs to the service identity: people hold no Storage permission at all (a
  // person asking Storage directly gets 403), so a file can only be uploaded through a link a
  // Function handed out, and only downloaded through a short-lived link a Function handed out
  // after checking that the person may see the record it belongs to.
  async function storage(path, body) {
    const res = await fetch(`${API}/data/v4/files/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.isSuccess === false) {
      const detail = json?.errors ? JSON.stringify(json.errors).slice(0, 200) : json?.message ?? res.status;
      throw new Error(`storage ${path} failed: ${detail}`);
    }
    return json;
  }
  // A new private file and the link the browser PUTs its bytes to (valid for 10 minutes).
  async function presignUpload(name, props) {
    const json = await storage("get-pre-signed-url-for-upload", { Name: name, AccessModifier: "Private", AdditionalProperties: props });
    const d = json?.data && typeof json.data === "object" ? json.data : json;
    const fileId = d.fileId ?? d.FileId;
    const uploadUrl = d.uploadUrl ?? d.UploadUrl;
    if (!fileId || !uploadUrl) throw new Error(`storage gave no upload link (answer had ${Object.keys(d).join(", ")})`);
    return { fileId: String(fileId), uploadUrl: String(uploadUrl) };
  }
  // fileId -> a download link that works for a few minutes.
  async function downloadUrls(fileIds) {
    const ids = [...new Set(fileIds.filter(Boolean).map(String))];
    if (!ids.length) return {};
    const json = await storage("get-files", { FileIds: ids });
    const d = json?.data ?? json?.files ?? json?.items ?? json;
    const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.files) ? d.files : [];
    const out = {};
    for (const it of items) {
      const id = it?.fileId ?? it?.FileId ?? it?.itemId ?? it?.ItemId ?? it?.id;
      const url = it?.url ?? it?.Url ?? it?.downloadUrl ?? it?.DownloadUrl ?? Object.values(it ?? {}).find((v) => typeof v === "string" && /^https:\/\//.test(v));
      if (id && url && ids.includes(String(id))) out[String(id)] = String(url);
    }
    if (!Object.keys(out).length) ctx.log?.warn?.("storage get-files: no links found", { shape: JSON.stringify(json).slice(0, 300).replace(/https:\/\/[^"]+/g, "<url>") });
    return out;
  }
  // A signature over an upload's facts, made with this Function's own secret: the browser hands
  // it back when it attaches the file, so nobody can attach a file they did not upload, to a
  // project they did not upload it for, or change its name, size or type on the way.
  async function sign(parts) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(`files:${ctx.env.CLIENT_SECRET ?? ""}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(parts.map(String).join("\n"))));
    let s = "";
    for (const b of mac) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return { iam, gql, insert, list, listAll, update, updateWhere, audit, notify, mail, appUrl, presignUpload, downloadUrls, sign };
}

// ---------- attachments (docs/architecture/13 §4.6, XC-03) ----------
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 20;
// Files that would run or render as a page when opened: never stored.
const BLOCKED_FILE = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|mjs|jar|sh|app|dll|html?|xhtml|svg|php|hta)$/i;
const THUMB_TYPES = ["image/jpeg", "image/webp", "image/png"];
const TICKET_HOURS = 24;

// A file name people can read, safe for any storage: no folders, no control characters.
function safeFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  return (base || "file").slice(-120);
}

const ticketParts = (a, me, projectId) => ["v1", a.fileId, a.thumbnailFileId || "", me.userId, me.tenantRole, projectId, a.fileName, a.contentType, a.sizeBytes, a.uploadedAt];

// Upload links for up to 10 files. `files`: [{ name, contentType, sizeBytes, thumbnail?: { contentType, sizeBytes } }].
// Answers what the browser needs: where to PUT the file (and its preview), and the signed facts
// it sends back when it attaches them.
async function issueUploads(db, me, projectId, files, record) {
  if (!Array.isArray(files) || !files.length) throw new Refused("NO_FILES", "Choose a file first.");
  if (files.length > 10) throw new Refused("TOO_MANY_FILES", "Add at most 10 files at a time.");
  const now = new Date().toISOString();
  const props = { app: "buildnexa", tenantRole: me.tenantRole, projectId, uploadedBy: me.userId, record };
  const out = [];
  for (const f of files) {
    const fileName = safeFileName(f?.name);
    const sizeBytes = Number(f?.sizeBytes);
    const contentType = String(f?.contentType || "application/octet-stream").slice(0, 100);
    if (BLOCKED_FILE.test(fileName)) throw new Refused("FILE_TYPE_NOT_ALLOWED", `${fileName}: this type of file can't be attached.`);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Refused("EMPTY_FILE", `${fileName} is empty.`);
    if (sizeBytes > MAX_FILE_BYTES) throw new Refused("FILE_TOO_LARGE", `${fileName} is ${Math.round(sizeBytes / 1048576)} MB. The limit is 50 MB per file.`);
    // Storage wants unique names; a short tag keeps "photo.jpg" from clashing with another one.
    const tag = crypto.randomUUID().slice(0, 8);
    const dot = fileName.lastIndexOf(".");
    const stored = dot > 0 ? `${fileName.slice(0, dot)}-${tag}${fileName.slice(dot)}` : `${fileName}-${tag}`;
    const main = await db.presignUpload(stored, props);
    let thumb;
    const t = f.thumbnail;
    if (t && THUMB_TYPES.includes(String(t.contentType)) && Number(t.sizeBytes) > 0 && Number(t.sizeBytes) <= MAX_THUMB_BYTES) {
      thumb = await db.presignUpload(`preview-${tag}.${String(t.contentType).split("/")[1]}`, { ...props, previewOf: main.fileId });
    }
    const a = { fileId: main.fileId, thumbnailFileId: thumb?.fileId ?? "", fileName, contentType, sizeBytes, uploadedAt: now };
    out.push({ ...a, uploadUrl: main.uploadUrl, thumbnailUploadUrl: thumb?.uploadUrl, ticket: await db.sign(ticketParts(a, me, projectId)) });
  }
  return out;
}

// What a record stores for each file: from the signed facts, after checking the signature.
// `kept`: attachments the record already has (they need no new signature).
async function acceptAttachments(db, me, projectId, list, kept = []) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Refused("BAD_FILES", "The attachments could not be read. Add them again.");
  const keptById = new Map(kept.map((a) => [a.fileId, a]));
  const out = [];
  for (const x of list) {
    const id = String(x?.fileId ?? "");
    if (out.some((a) => a.fileId === id)) continue;
    if (keptById.has(id)) {
      out.push(keptById.get(id));
      continue;
    }
    const a = {
      fileId: id,
      thumbnailFileId: String(x?.thumbnailFileId ?? ""),
      fileName: safeFileName(x?.fileName),
      contentType: String(x?.contentType ?? ""),
      sizeBytes: Number(x?.sizeBytes),
      uploadedAt: String(x?.uploadedAt ?? "")
    };
    const age = Date.now() - Date.parse(a.uploadedAt);
    const expected = await db.sign(ticketParts(a, me, projectId));
    if (!id || x?.ticket !== expected || !(age >= -60_000 && age <= TICKET_HOURS * 3600_000)) {
      throw new Refused("BAD_FILE_TICKET", `${a.fileName}: the upload could not be confirmed. Remove it and add it again.`);
    }
    out.push({ ...a, uploadedBy: me.userId });
  }
  if (out.length > MAX_ATTACHMENTS) throw new Refused("TOO_MANY_FILES", `At most ${MAX_ATTACHMENTS} files per RFI or response.`);
  return out;
}

const fileCount = (n) => (n ? ` · ${n} file${n === 1 ? "" : "s"}` : "");

// The Notifier configuration that keeps the bell inbox (user-specific, persistence on), and the
// one email template every notice uses (`blocks mail template`, language en-US: Blocks Mail has no
// language fallback, and the app is English only).
const NOTIFIER_CONFIGURATION = "cpm-inbox";
const MAIL_TEMPLATE = "BuildnexaNotice";
const MAIL_LANGUAGE = "en-US";
// Development until the app is released (then the Function variable APP_URL says where it runs).
const DEFAULT_APP_URL = "https://dbldiu.slsblx.com:5173";

// A company's tag (its tenant role): "company-<short name>", or "co-<short name>" for companies
// set up before 21 Nov 2026. "company-admin" is a job role, not a tag.
const isCompanyTag = (r) => typeof r === "string" && (r.startsWith("co-") || (r.startsWith("company-") && r !== "company-admin"));

function caller(ctx) {
  const roles = ctx.context.roles ?? [];
  const companyRoles = roles.filter(isCompanyTag);
  if (companyRoles.length !== 1) throw new Refused("NO_COMPANY", "Your account is not linked to exactly one company in this organization.");
  return {
    userId: ctx.context.userId,
    organizationId: ctx.context.organizationId,
    tenantRole: companyRoles[0],
    isAdmin: roles.includes("company-admin"),
    isStaff: roles.includes("staff") || roles.includes("company-admin"),
    // A person from a partner company (subcontractor, design firm, owner): sees only their projects.
    isPartner: roles.includes("external") && !roles.includes("staff") && !roles.includes("company-admin"),
    // IAM account roles, for accountCan() (company and platform permissions).
    roles
  };
}

function personName(m) {
  return m.displayName || [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email;
}

// ---------- numbering (docs/architecture/13 §4.1) ----------
const SEQUENCES = {
  rfi: { prefix: "RFI", targetSchema: "Rfi" },
  submittal: { prefix: "SUB", targetSchema: "Submittal" },
  punchItem: { prefix: "PI", targetSchema: "PunchItem" },
  changeEvent: { prefix: "CE", targetSchema: "ChangeEvent" },
  changeOrder: { prefix: "CO", targetSchema: "ChangeOrder" }
};
const formatNumber = (prefix, n, padWidth = 3) => `${prefix}-${String(n).padStart(padWidth, "0")}`;
const SEQ_FIELDS = "ItemId projectId key prefix padWidth lastValue claimRef claimedAt";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A project's counter row; projects create all of them when the project is created.
function sequenceRow(me, projectId, key) {
  const def = SEQUENCES[key];
  return { tenantRole: me.tenantRole, projectId, key, prefix: def.prefix, padWidth: 3, targetSchema: def.targetSchema, lastValue: 0 };
}

// Has the record that claimed number `n` (with claim ref `ref`) been written with it? The ref is the
// record's clientRequestId (create) or its ItemId (RFI submit). Only text filters: a number filter
// on the gateway is unproven, and a list of all records stops at 1000.
async function numberWritten(db, me, projectId, def, ref, n) {
  const [byRequest, byId] = await Promise.all([
    db.list(def.targetSchema, "ItemId seq", me.tenantRole, { projectId, clientRequestId: ref }),
    db.list(def.targetSchema, "ItemId seq", me.tenantRole, { projectId, ItemId: ref })
  ]);
  return [...byRequest, ...byId].some((r) => Number(r.seq) === n);
}

// A claim older than this can no longer be written: every Buildnexa Function stops after 45 s
// (timeoutSeconds in its settings; docs/architecture/13 §4.1 said 35 s for the old 30 s limit).
// Raise this if a Function's timeout is raised.
const STALE_CLAIM_MS = 60_000;

// Next number for `key` in one project. A project created before numbering existed gets its
// counter on first use (two first callers at once can each create one; everyone then uses the
// same one, sorted by id, and the others stay unused).
// Repair (docs/architecture/13 §4.1): when the last number was claimed over 60 s ago and its record
// was never written (the Function crashed or timed out), the next caller gets that number again.
// Gaps lower down are not repaired: a newer number already exists above them.
async function allocateNumber(db, me, projectId, key, claimRef) {
  const def = SEQUENCES[key];
  if (!def) throw new Error(`unknown sequence ${key}`);
  const ref = claimRef || crypto.randomUUID();
  // Spike M1b: 20 callers at once on one counter gave 17 numbers in 9 s and 3 gave up after 8
  // tries; real projects see a few creates at once, so 10 tries with a growing pause is plenty.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const rows = (await db.list("Sequence", SEQ_FIELDS, me.tenantRole, { projectId, key }))
      .sort((a, b) => String(a.ItemId).localeCompare(String(b.ItemId)));
    let seq = rows[0];
    if (!seq) {
      await db.insert("Sequence", sequenceRow(me, projectId, key));
      continue;
    }
    const last = Number(seq.lastValue ?? 0);
    const numbered = (n) => ({ seq: n, number: formatNumber(seq.prefix || def.prefix, n, seq.padWidth || 3), claimRef: ref, sequenceId: seq.ItemId });
    const claimedAt = Date.parse(seq.claimedAt ?? "");
    if (last > 0 && seq.claimRef && claimedAt && Date.now() - claimedAt > STALE_CLAIM_MS && !(await numberWritten(db, me, projectId, def, seq.claimRef, last))) {
      // Take the stale claim over; only one caller can, because the old claim ref must still be there.
      const healed = await db.updateWhere("Sequence", { ItemId: { eq: seq.ItemId }, lastValue: { eq: last }, claimRef: { eq: seq.claimRef } }, me.tenantRole, {
        claimRef: ref,
        claimedAt: new Date().toISOString()
      });
      if (healed === 1) return numbered(last);
      continue; // someone else moved the counter: read it again
    }
    const n = last + 1;
    const won = await db.updateWhere("Sequence", { ItemId: { eq: seq.ItemId }, lastValue: { eq: last } }, me.tenantRole, {
      lastValue: n,
      claimRef: ref,
      claimedAt: new Date().toISOString()
    });
    if (won === 1) return numbered(n);
    await pause(attempt * 40 + Math.floor(Math.random() * 80));
  }
  throw new Refused("SEQUENCE_CONTENDED", "Too many people are creating records right now. Please try again.");
}

// The record that took number `n` failed to save: hand the number back so the next one gets it,
// then rethrow `error`. Only when the gateway refused the write (not when it may have happened),
// no record holds the number, and nobody took a newer one since. The claim ref is cleared, so the
// repair in allocateNumber leaves the counter alone afterwards. `n` may be undefined (no number).
async function giveBackNumber(db, me, projectId, key, n, error) {
  if (n && !error?.uncertain) {
    try {
      if (!(await numberWritten(db, me, projectId, SEQUENCES[key], n.claimRef, n.seq))) {
        await db.updateWhere("Sequence", { ItemId: { eq: n.sequenceId }, lastValue: { eq: n.seq }, claimRef: { eq: n.claimRef } }, me.tenantRole, {
          lastValue: n.seq - 1,
          claimRef: "",
          claimedAt: new Date().toISOString()
        });
      }
    } catch {
      // The save error is what the caller needs to see; a number left taken is repaired later.
    }
  }
  throw error;
}

// ---------- handler shell ----------
// actions: { name: async (args, env) => result }, env = { ctx, me, db }. `db` is created only when
// an action needs it (service token costs one IAM call).
// A platform admin (Buildnexa operations). They belong to no company.
function platformCaller(ctx) {
  const roles = ctx.context.roles ?? [];
  if (!roles.includes("platform-admin")) throw new Refused("NOT_PLATFORM_ADMIN", "Only a platform admin can do this.");
  return { userId: ctx.context.userId, organizationId: ctx.context.organizationId, isPlatformAdmin: true };
}

// `who` says who may call: company people (default) or platform admins (platformCaller).
async function handle(input, ctx, label, actions, who = caller) {
  const args = (input && input.method ? input.body : input) ?? {};
  try {
    const action = actions[args.action];
    if (!action) return { ok: false, code: "BAD_ACTION", error: "Unknown action." };
    const me = who(ctx);
    const db = client(ctx, await serviceToken(ctx));
    return await action(args, { ctx, me, db });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, error: error.message };
    ctx.log.error(`${label} failed`, { action: args.action, message: error.message });
    return { ok: false, code: "FAILED", error: "Something went wrong. Please try again." };
  }
}

// Who may do what: the ONE permission table for the Functions and the screens.
// Source: the client's spec (docs/permissions/Buildnexa_RBAC_Role_and_Permission_Specification.pdf),
// agreed adjustments in docs/permissions/PERMISSIONS.md.
// - Functions: tools/sync-functions.mjs copies this file into every Function's shared block.
// - Screens: src/lib/permissions.ts imports it, so a button and the server never disagree.
//
// Roles are bundles of permission keys. Code checks keys (`projectCan(role, "rfi.close")`), never
// role names, so a custom role later is one more entry here.
// Keys ending in _assigned, _own, _involved or _relevant are the spec's "Limited": the key is
// granted, and the module's Function also checks that the record belongs to the person or their
// company. Keys for modules not built yet are refined when the module is built.
//
// Company Admins and Platform Admins get NO project content from their company or platform role:
// RFIs, documents, logs and budgets need a project role (spec §6, "Company Admin access").

const PROJECT_ROLES = ["project-manager", "superintendent", "document-controller", "field-user", "design-reviewer", "owner-viewer"];
// People from partner companies (subcontractor, design firm, owner) work in these roles only.
const PARTNER_PROJECT_ROLES = ["field-user", "design-reviewer", "owner-viewer"];

const PM = "project-manager";
const SUPT = "superintendent";
const DC = "document-controller";
const SUB = "field-user";
const DESIGN = "design-reviewer";
const OWNER = "owner-viewer";
const ALL = PROJECT_ROLES;

// permission key -> project roles that hold it
const PROJECT_PERMISSIONS = {
  // Project
  "project.view": ALL,
  "project.update": [PM],
  "project.manage_members": [PM],
  // RFIs
  "rfi.view": [PM, SUPT, DC, DESIGN, OWNER],
  "rfi.view_involved": [SUB], // created by me or my company, or involving me
  "rfi.create": [PM, SUPT, DC, SUB],
  "rfi.respond": [PM, SUPT, DC],
  "rfi.respond_assigned": [SUB, DESIGN], // only when assigned or holding the ball
  "rfi.edit": [PM], // subject, question, due date and people after submit (drafts: the creator too)
  "rfi.reassign": [PM], // the GC creator may also pass the ball on their own RFI
  "rfi.mark_official": [PM],
  "rfi.mark_official_own": [DESIGN], // their own response only
  "rfi.close": [PM], // the creator may also close their own RFI (checked per record)
  "rfi.void": [PM], // the creator may also void their own draft
  "rfi.reopen": [PM],
  "rfi.see_cost": [PM, SUPT, DC, OWNER],
  "rfi.see_internal": [PM, SUPT, DC],
  // Drawings
  "drawing.view": [PM, SUPT, DC, DESIGN, OWNER],
  "drawing.view_relevant": [SUB],
  "drawing.pin": [PM, SUPT, DC, SUB], // DC added 2026-11-25 (P8, client agreed)
  "drawing.upload": [PM, DC, DESIGN], // design: revisions of their own discipline
  "drawing.manage_versions": [PM, DC], // supersede, void, register
  // Documents and photos
  "document.view": [PM, SUPT, DC, OWNER],
  "document.view_relevant": [SUB, DESIGN],
  "document.upload": [PM, SUPT, DC, SUB, DESIGN],
  "document.manage": [PM, DC], // every folder: upload, version, move, rename, trash, restore, new folders
  "document.folder_access": [PM], // who views and who uploads, per folder
  "photo.view": [PM, SUPT, DC, DESIGN, OWNER],
  "photo.view_company": [SUB], // own company's photos, and photos on records they can open
  "photo.upload": [PM, SUPT, DC, SUB, DESIGN],
  "photo.manage": [PM, DC], // edit, tag and remove any photo, see and restore removed ones
  // Submittals
  "submittal.view": [PM, SUPT, DC, DESIGN, OWNER],
  "submittal.view_own": [SUB],
  "submittal.manage": [PM, DC],
  "submittal.upload_own": [SUB],
  "submittal.review": [PM, DESIGN],
  // Daily logs
  "daily_log.view": [PM, SUPT, DC], // every section, drafts included
  "daily_log.view_submitted": [OWNER], // submitted logs only; designers get none (decided 2026-11-26)
  "daily_log.create": [PM, SUPT], // open a day, fill the sections and every company's crew, submit
  "daily_log.crew_own": [SUB], // the day's header and their own company's crew and notes
  "daily_log.correct": [PM], // audited correction after submit, reason required
  // Punch list
  "punch_item.view": [PM, SUPT, DC, DESIGN, OWNER],
  "punch_item.view_assigned": [SUB],
  "punch_item.create": [PM, SUPT],
  "punch_item.assign": [PM, SUPT],
  "punch_item.close": [PM, SUPT],
  "punch_item.update_assigned": [SUB],
  "punch_item.void": [PM], // the creator may also void their own item while it is still open
  // Budget
  "budget.view": [PM],
  "budget.manage": [PM],
  "budget.view_summary": [OWNER],
  // Change orders
  "change_order.view": [PM, SUPT, DC, DESIGN, OWNER],
  "change_order.create": [PM],
  "change_order.approve": [PM], // within thresholds, never their own (comes with change orders)
  "change_order.approve_assigned": [OWNER],
  // Reports
  "report.view": [PM, OWNER],
  "report.view_relevant": [SUPT, DC, SUB, DESIGN],
  "report.export": [PM]
};

// Company and platform permissions, from the IAM account roles.
const ACCOUNT_PERMISSIONS = {
  "company.manage_people": ["company-admin"],
  "company.manage_partners": ["company-admin"],
  "company.settings": ["company-admin"],
  "project.create": ["company-admin"],
  "project.create_when_allowed": ["staff"], // staff whose admin ticked "can create projects"
  "project.list_all": ["company-admin"], // project list and teams, not their content
  "project.manage_members_any": ["company-admin"],
  "platform.manage_companies": ["platform-admin"],
  "platform.manage_admins": ["platform-admin"]
};

/** Does this project role (the person's role on ONE project) hold the permission? */
function projectCan(projectRole, key) {
  return Boolean(projectRole) && (PROJECT_PERMISSIONS[key] ?? []).includes(projectRole);
}

/** Does any of these IAM account roles hold the company or platform permission? */
function accountCan(accountRoles, key) {
  const holders = ACCOUNT_PERMISSIONS[key] ?? [];
  return (accountRoles ?? []).some((r) => holders.includes(r));
}

/** Every permission key of a project role, in table order (the Company admin › Roles tab). */
function projectPermissionsOf(projectRole) {
  return Object.keys(PROJECT_PERMISSIONS).filter((key) => PROJECT_PERMISSIONS[key].includes(projectRole));
}

/**
 * May a person hold this project role? `companyRelation` is their company's relation to the
 * customer: "self" for the customer's own staff, otherwise sub | design | owner | supplier.
 * People from partner companies only get the partner roles (never PM, Superintendent, DC).
 */
function mayHoldProjectRole(companyRelation, projectRole) {
  if (!PROJECT_ROLES.includes(projectRole)) return false;
  const isPartner = Boolean(companyRelation) && companyRelation !== "self";
  return !isPartner || PARTNER_PROJECT_ROLES.includes(projectRole);
}
// <<< shared

// ---------- limits ----------
const PDF_TYPE = "application/pdf";
// THUMB_TYPES (jpeg, webp, png) comes from the shared code.
const MAX_THUMB_BYTES_SHEET = 400 * 1024;
const MAX_PER_CALL = 10;
const LINKED_IN_LIST = 300; // current sheets whose thumbnails come with the register
const LINKS_PER_CALL = 240;
const LINK_MINUTES = 50; // storage links last an hour; the page asks again before they run out
const TICKET_HOURS_SHEET = 24;
const DEFAULT_SET = "Issued for Construction";
const DEFAULT_DISCIPLINES = [
  { code: "A", name: "Architectural" },
  { code: "S", name: "Structural" },
  { code: "M", name: "Mechanical" },
  { code: "E", name: "Electrical" },
  { code: "P", name: "Plumbing" },
  { code: "FP", name: "Fire protection" },
  { code: "C", name: "Civil" },
  { code: "L", name: "Landscape" },
  { code: "G", name: "General" }
];

const SHEET_FIELDS =
  "ItemId projectId sheetNumber sheetNumberKey sortKey title discipline setName version revisionCount currentRevisionId currentFileId " +
  "currentThumbFileId currentRevisionLabel lastIssuedDate currentRevisionIndex createdByUserId createdAt updatedAt isVoided voidReason";
const REV_FIELDS =
  "ItemId projectId sheetId sheetNumber revisionLabel issuedDate note status revisionIndex sizeBytes fileId thumbFileId fileName " +
  "pageWidthPt pageHeightPt uploadedByUserId uploadedByCompanyId uploadedByName uploadedAt supersededAt voidedAt voidedByUserId isVoided voidReason";
const PIN_FIELDS =
  "ItemId projectId sheetId fromRevisionIndex toRevisionIndex version x y linkedRecordType linkedRecordNumber linkedRecordId " +
  "createdByUserId createdByCompanyId movedFromPinId createdByName createdAt voidedAt voidedByUserId isVoided";
const TEAM_FIELDS = "ItemId userId displayName email companyId companyName role status";
const RFI_FIELDS =
  "ItemId number subject status isVoided dueDate ballInCourtUserId ballInCourtName createdByUserId createdByCompanyId assigneeUserIds distributionUserIds";
const PREF_FIELDS = "ItemId userId emailEnabled";
const PUNCH_FIELDS = "ItemId number title status isVoided dueDate assigneeCompanyId assigneeCompanyName ballInCourtUserId ballInCourtName createdByUserId";
const PUNCH_ACTIVE = ["open", "inProgress", "readyForReview"];
const PHOTO_FIELDS =
  "ItemId thumbFileId previewFileId fileName caption takenAt uploadedAt uploadedByUserId uploadedByName uploaderCompanyId " +
  "linkedRecordType linkedRecordId linkedRecordNumber isVoided";
const LOG_FIELDS = "ItemId logDate status duplicateOf";

// ---------- small helpers ----------
const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const expiry = () => new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
const actorName = (c) => c.mine.displayName || "Someone";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const html = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));

/** "A-101 " -> "A-101" as typed; key "A-101"; sort key with zero-padded numbers ("A-000101"). */
function sheetNumberOf(v) {
  const n = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
  if (!/^[A-Za-z0-9][A-Za-z0-9 .\-_/]*$/.test(n)) throw new Refused("BAD_SHEET_NUMBER", "A sheet number uses letters, digits, '-', '.', '_' or '/', for example A-101.");
  return n;
}
const keyOf = (n) => String(n).toUpperCase().replace(/\s+/g, "");
const sortKeyOf = (n) => keyOf(n).replace(/\d+/g, (d) => d.padStart(6, "0"));

function labelOf(v) {
  const l = String(v ?? "").trim().toUpperCase().slice(0, 8);
  if (!l || !/^[A-Z0-9.\-]+$/.test(l)) throw new Refused("BAD_REVISION", "Enter a revision label as printed in the title block, for example 0, A or P2.");
  return l;
}

function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------- who is asking, on which project ----------
async function projectContext(db, me, projectId, { write = false } = {}) {
  const id = String(projectId ?? "");
  if (!id) throw new Refused("NOT_FOUND", "Choose a project first.");
  const [projects, team] = await Promise.all([
    db.list("Project", "ItemId number name status timezone settings { disciplines { code name sheetPrefix } }", me.tenantRole, { ItemId: id }),
    db.list("ProjectMember", TEAM_FIELDS, me.tenantRole, { projectId: id })
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  const active = team.filter((r) => r.status === "active");
  const mine = active.find((r) => r.userId === me.userId);
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. Drawings are open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const role = mine.role;
  if (!projectCan(role, "drawing.view") && !projectCan(role, "drawing.view_relevant")) throw new Refused("NOT_ALLOWED", "Your project role doesn't include drawings.");
  const fromSettings = (project.settings?.disciplines ?? []).filter((d) => d?.name).map((d) => ({ code: d.code || d.sheetPrefix || "", name: d.name }));
  return {
    me,
    project,
    projectId: id,
    active,
    mine,
    role,
    archived,
    today: todayIn(project.timezone),
    disciplines: fromSettings.length ? fromSettings : DEFAULT_DISCIPLINES,
    upload: projectCan(role, "drawing.upload"),
    manager: projectCan(role, "drawing.manage_versions"),
    pinner: projectCan(role, "drawing.pin")
  };
}

const can = (c) => ({
  upload: c.upload && !c.archived,
  manage: c.manager && !c.archived,
  pin: c.pinner && !c.archived,
  createRfi: projectCan(c.role, "rfi.create") && c.pinner && !c.archived,
  createPunch: projectCan(c.role, "punch_item.create") && c.pinner && !c.archived
});

// ---------- RFIs the caller can open (same rules as functions/rfis canSee) ----------
function involvedIn(r, c) {
  const u = c.me.userId;
  return r.createdByUserId === u || r.ballInCourtUserId === u || (r.assigneeUserIds ?? []).includes(u) || (r.distributionUserIds ?? []).includes(u);
}
function canSeeRfi(r, c) {
  if (r.status === "draft") return r.createdByUserId === c.me.userId || projectCan(c.role, "rfi.edit");
  if (projectCan(c.role, "rfi.view")) return true;
  if (projectCan(c.role, "rfi.view_involved")) {
    return involvedIn(r, c) || (Boolean(r.createdByCompanyId) && r.createdByCompanyId === c.mine.companyId) || Boolean(c.answered?.has(r.ItemId));
  }
  return false;
}
async function loadRfis(db, c) {
  if (c.allRfis) return c.allRfis;
  const [rows, answers] = await Promise.all([
    db.list("Rfi", RFI_FIELDS, c.me.tenantRole, { projectId: c.projectId }),
    projectCan(c.role, "rfi.view") || !projectCan(c.role, "rfi.view_involved")
      ? Promise.resolve([])
      : db.list("RfiResponse", "rfiId authorUserId authorCompanyId isVoided", c.me.tenantRole, { projectId: c.projectId })
  ]);
  const company = c.mine.companyId;
  c.answered = new Set(answers.filter((x) => !x.isVoided && (x.authorUserId === c.me.userId || (company && x.authorCompanyId === company))).map((x) => x.rfiId));
  c.allRfis = rows;
  c.rfiById = new Map(rows.map((r) => [r.ItemId, r]));
  return rows;
}
// RFIs a pin can be placed for: open to the caller, numbered, not a draft or voided.
const pinnable = (r, c) => r && !r.isVoided && r.status !== "draft" && r.status !== "void" && r.number && canSeeRfi(r, c);

// ---------- punch items the caller can open (same rules as functions/punch canSee) ----------
function canSeePunch(i, c) {
  if (projectCan(c.role, "punch_item.view")) return true;
  if (projectCan(c.role, "punch_item.view_assigned")) {
    return (Boolean(i.assigneeCompanyId) && i.assigneeCompanyId === c.mine.companyId) || i.createdByUserId === c.me.userId;
  }
  return false;
}
async function loadPunch(db, c) {
  if (c.allPunch) return c.allPunch;
  const rows = await db.list("PunchItem", PUNCH_FIELDS, c.me.tenantRole, { projectId: c.projectId }).catch(() => []);
  c.allPunch = rows;
  c.punchById = new Map(rows.map((i) => [i.ItemId, i]));
  return rows;
}
const punchPinnable = (i, c) => i && !i.isVoided && PUNCH_ACTIVE.includes(i.status) && i.number && canSeePunch(i, c);

// ---------- daily log photos the caller can see (same rules as functions/photos seesLogPhoto) ----------
function canSeeLogPhoto(ph, c) {
  if (!ph || ph.isVoided || ph.linkedRecordType !== "dailyLog") return false;
  const log = c.logById?.get(ph.linkedRecordId);
  if (!log) return false;
  if (projectCan(c.role, "daily_log.view") || projectCan(c.role, "daily_log.create")) return true;
  if (projectCan(c.role, "daily_log.crew_own")) return Boolean(ph.uploaderCompanyId) && ph.uploaderCompanyId === c.mine.companyId;
  if (projectCan(c.role, "daily_log.view_submitted")) return log.status === "submitted";
  return false;
}
async function loadLogPhotos(db, c) {
  if (c.photoById) return;
  const [photos, logs] = await Promise.all([
    db.list("Photo", PHOTO_FIELDS, c.me.tenantRole, { projectId: c.projectId, linkedRecordType: "dailyLog" }).catch(() => []),
    db.list("DailyLog", LOG_FIELDS, c.me.tenantRole, { projectId: c.projectId }).catch(() => [])
  ]);
  c.photoById = new Map(photos.map((p) => [p.ItemId, p]));
  c.logById = new Map(logs.filter((l) => !l.duplicateOf).map((l) => [l.ItemId, l]));
}
const shortDay = (iso) => (isDay(iso) ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
/** How a pin's record is named in history lines: "RFI-002", or "a photo (log 26 Nov)". */
const pinLabel = (p) => (p.linkedRecordType === "photo" ? `a photo (log ${shortDay(p.linkedRecordNumber)})` : p.linkedRecordNumber);
/** The log a photo pin belongs to, for the log's own history. */
const photoLogOf = (p, c) => c.logById?.get(c.photoById?.get(p.linkedRecordId)?.linkedRecordId);
// The pin that shows an item on the current revision of its sheet (at most one per item).
const livePin = (p) => !p.isVoided && !Number(p.toRevisionIndex);

// ---------- reading ----------
async function loadSheets(db, c, where = {}) {
  return db.list("Sheet", SHEET_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where });
}
async function loadRevisions(db, c, where = {}) {
  return db.list("SheetRevision", REV_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where });
}
async function loadPins(db, c, where = {}) {
  return db.list("Pin", PIN_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where });
}
async function loadSheet(db, c, sheetId) {
  const [s] = await loadSheets(db, c, { ItemId: String(sheetId ?? "") });
  if (!s || (s.isVoided && !c.manager)) throw new Refused("NOT_FOUND", "This sheet doesn't exist in this project.");
  return s;
}

// Download links for many files: storage answers in batches.
async function linksFor(db, fileIds) {
  const ids = [...new Set(fileIds.filter(Boolean))];
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    try {
      Object.assign(out, await db.downloadUrls(ids.slice(i, i + 100)));
    } catch {
      // the page shows a placeholder and asks again
    }
  }
  return out;
}

/** What a pin shows to this caller, or null when they may not see it. `hidden` counts the rest. */
function pinView(p, c) {
  if (p.isVoided) return null;
  if (p.linkedRecordType === "punchItem") return punchPinView(p, c);
  if (p.linkedRecordType === "photo") return photoPinView(p, c);
  if (p.linkedRecordType !== "rfi") return null;
  const r = c.rfiById.get(p.linkedRecordId);
  if (!r || r.isVoided || r.status === "void") return null;
  if (!canSeeRfi(r, c)) return r.status === "draft" ? null : "hidden";
  const mineToo = p.createdByUserId === c.me.userId;
  return {
    ItemId: p.ItemId,
    sheetId: p.sheetId,
    x: Number(p.x),
    y: Number(p.y),
    fromRevisionIndex: Number(p.fromRevisionIndex ?? 1),
    toRevisionIndex: Number(p.toRevisionIndex ?? 0),
    version: Number(p.version ?? 0),
    type: "rfi",
    recordId: r.ItemId,
    number: r.number || "",
    title: r.subject ?? "",
    status: r.status,
    closed: r.status === "closed",
    dueDate: r.dueDate ?? "",
    ballInCourtName: r.ballInCourtName ?? "",
    createdByName: p.createdByName ?? "",
    createdAt: p.createdAt,
    canMove: !c.archived && (c.manager || (c.pinner && mineToo)),
    canRemove: !c.archived && (c.manager || (c.pinner && mineToo))
  };
}

function punchPinView(p, c) {
  const i = c.punchById?.get(p.linkedRecordId);
  if (!i || i.isVoided || i.status === "void") return null;
  if (!canSeePunch(i, c)) return "hidden";
  const mineToo = p.createdByUserId === c.me.userId;
  return {
    ItemId: p.ItemId,
    sheetId: p.sheetId,
    x: Number(p.x),
    y: Number(p.y),
    fromRevisionIndex: Number(p.fromRevisionIndex ?? 1),
    toRevisionIndex: Number(p.toRevisionIndex ?? 0),
    version: Number(p.version ?? 0),
    type: "punchItem",
    recordId: i.ItemId,
    number: i.number || "",
    title: i.title ?? "",
    status: i.status,
    closed: i.status === "closed",
    dueDate: i.dueDate ?? "",
    ballInCourtName: i.ballInCourtName ?? "",
    companyName: i.assigneeCompanyName ?? "",
    createdByName: p.createdByName ?? "",
    createdAt: p.createdAt,
    canMove: !c.archived && (c.manager || (c.pinner && mineToo)),
    canRemove: !c.archived && (c.manager || (c.pinner && mineToo))
  };
}

// A photo pin: null (left out, no count) when the caller can't see the photo or the photos weren't loaded.
function photoPinView(p, c) {
  const ph = c.photoById?.get(p.linkedRecordId);
  if (!canSeeLogPhoto(ph, c)) return null;
  const log = c.logById.get(ph.linkedRecordId);
  const mineToo = p.createdByUserId === c.me.userId;
  return {
    ItemId: p.ItemId,
    sheetId: p.sheetId,
    x: Number(p.x),
    y: Number(p.y),
    fromRevisionIndex: Number(p.fromRevisionIndex ?? 1),
    toRevisionIndex: Number(p.toRevisionIndex ?? 0),
    version: Number(p.version ?? 0),
    type: "photo",
    recordId: ph.ItemId,
    number: "",
    title: ph.caption || ph.fileName || "",
    logId: log.ItemId,
    logDate: log.logDate,
    takenAt: ph.takenAt || ph.uploadedAt,
    takenByName: ph.uploadedByName ?? "",
    closed: false,
    createdByName: p.createdByName ?? "",
    createdAt: p.createdAt,
    canMove: !c.archived && (c.manager || (c.pinner && mineToo)),
    canRemove: !c.archived && (c.manager || (c.pinner && mineToo))
  };
}
// Thumbnail and preview links for the photo pins in a list of pin views (changed in place).
async function photoLinks(db, c, views) {
  const ph = views.filter((v) => v.type === "photo").map((v) => c.photoById.get(v.recordId)).filter(Boolean);
  if (!ph.length) return;
  const urls = await linksFor(db, ph.flatMap((x) => [x.thumbFileId, x.previewFileId]));
  for (const v of views) {
    if (v.type !== "photo") continue;
    const x = c.photoById.get(v.recordId);
    if (urls[x?.thumbFileId]) v.thumbUrl = urls[x.thumbFileId];
    if (urls[x?.previewFileId]) v.previewUrl = urls[x.previewFileId];
  }
}
const isIssue = (p) => p.linkedRecordType !== "photo";

function pinsFor(pins, c) {
  const shown = [];
  let hidden = 0;
  for (const p of pins) {
    const v = pinView(p, c);
    if (v === "hidden") hidden += 1;
    else if (v) shown.push(v);
  }
  return { shown, hidden };
}

function presentRevision(r, c, links = {}) {
  const out = {
    ItemId: r.ItemId,
    revisionIndex: Number(r.revisionIndex ?? 0),
    revisionLabel: r.revisionLabel ?? "",
    issuedDate: r.issuedDate ?? "",
    note: r.note ?? "",
    status: r.isVoided ? "void" : r.status,
    sizeBytes: Number(r.sizeBytes ?? 0),
    fileName: r.fileName ?? "",
    pageWidthPt: Number(r.pageWidthPt ?? 0),
    pageHeightPt: Number(r.pageHeightPt ?? 0),
    uploadedByName: r.uploadedByName ?? "",
    uploadedByUserId: r.uploadedByUserId ?? "",
    uploadedAt: r.uploadedAt,
    supersededAt: r.supersededAt ?? undefined
  };
  if (r.isVoided) Object.assign(out, { voidReason: r.voidReason ?? "", voidedAt: r.voidedAt ?? undefined });
  if (links[r.thumbFileId]) out.thumbUrl = links[r.thumbFileId];
  if (links[r.fileId] && !r.isVoided) out.pdfUrl = links[r.fileId];
  return out;
}

function presentSheet(s, c, revs, pinInfo, links = {}) {
  const live = revs.filter((r) => !r.isVoided).sort((a, b) => b.revisionIndex - a.revisionIndex);
  const cur = live.find((r) => r.ItemId === s.currentRevisionId) ?? live[0];
  return {
    ItemId: s.ItemId,
    sheetNumber: s.sheetNumber,
    title: s.title ?? "",
    discipline: s.discipline ?? "",
    setName: s.setName ?? "",
    sortKey: s.sortKey ?? "",
    version: Number(s.version ?? 0),
    removed: Boolean(s.isVoided),
    current: cur ? presentRevision(cur, c, links) : undefined,
    revisions: live.map((r) => ({
      ItemId: r.ItemId,
      revisionIndex: Number(r.revisionIndex),
      revisionLabel: r.revisionLabel,
      issuedDate: r.issuedDate,
      status: r.status,
      uploadedByName: r.uploadedByName ?? "",
      uploadedAt: r.uploadedAt,
      sizeBytes: Number(r.sizeBytes ?? 0),
      note: r.note ?? ""
    })),
    pins: pinInfo?.open ?? 0,
    pinsTotal: pinInfo?.total ?? 0,
    hiddenPins: pinInfo?.hidden ?? 0
  };
}

const bySheet = (rows) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.sheetId)) m.set(r.sheetId, []);
    m.get(r.sheetId).push(r);
  }
  return m;
};

// ---------- actions: reading ----------
async function list(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const [sheets, revisions, pins] = await Promise.all([loadSheets(db, c), loadRevisions(db, c), loadPins(db, c), loadRfis(db, c), loadPunch(db, c)]);
  const live = sheets.filter((s) => !s.isVoided).sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));
  const revsBy = bySheet(revisions);
  const pinsBy = bySheet(pins);
  const head = live.slice(0, LINKED_IN_LIST);
  const curIds = new Set(head.map((s) => s.currentRevisionId));
  const links = await linksFor(db, revisions.filter((r) => curIds.has(r.ItemId)).map((r) => r.thumbFileId));
  const rows = live.map((s) => {
    const cur = Number(s.currentRevisionIndex ?? 0);
    const { shown, hidden } = pinsFor((pinsBy.get(s.ItemId) ?? []).filter((p) => isIssue(p) && Number(p.fromRevisionIndex) <= cur && (!Number(p.toRevisionIndex) || Number(p.toRevisionIndex) >= cur)), c);
    return presentSheet(s, c, revsBy.get(s.ItemId) ?? [], { open: shown.filter((p) => !p.closed).length, total: shown.length, hidden }, links);
  });
  return {
    ok: true,
    role: c.role,
    archived: c.archived,
    can: can(c),
    today: c.today,
    disciplines: c.disciplines,
    sets: [...new Set([DEFAULT_SET, ...live.map((s) => s.setName).filter(Boolean)])].sort(),
    linksExpireAt: expiry(),
    sheets: rows
  };
}

async function links(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const ids = Array.isArray(args.revisionIds) ? [...new Set(args.revisionIds.map(String))].slice(0, LINKS_PER_CALL) : [];
  if (!ids.length) return { ok: true, links: {}, linksExpireAt: expiry() };
  const wanted = new Set(ids);
  const rows = (await loadRevisions(db, c)).filter((r) => wanted.has(r.ItemId) && !r.isVoided);
  const urls = await linksFor(db, rows.map((r) => r.thumbFileId));
  const out = {};
  for (const r of rows) if (urls[r.thumbFileId]) out[r.ItemId] = { thumb: urls[r.thumbFileId] };
  return { ok: true, links: out, linksExpireAt: expiry() };
}

async function sheetDetail(db, c, sheetId) {
  const s = await loadSheet(db, c, sheetId);
  const [revisions, pins, punchPins] = await Promise.all([
    loadRevisions(db, c, { sheetId: s.ItemId }),
    loadPins(db, c, { sheetId: s.ItemId }),
    loadPins(db, c, { linkedRecordType: "punchItem" }),
    loadRfis(db, c),
    loadPunch(db, c),
    loadLogPhotos(db, c)
  ]);
  const pinnedPunch = new Set(punchPins.filter(livePin).map((p) => p.linkedRecordId));
  const visibleRevs = revisions.filter((r) => !r.isVoided || c.manager).sort((a, b) => b.revisionIndex - a.revisionIndex);
  const urls = await linksFor(db, visibleRevs.filter((r) => !r.isVoided).flatMap((r) => [r.fileId, r.thumbFileId]));
  const { shown, hidden } = pinsFor(pins, c);
  await photoLinks(db, c, shown);
  const cur = Number(s.currentRevisionIndex ?? 0);
  const live = (p) => p.type !== "photo" && p.fromRevisionIndex <= cur && (!p.toRevisionIndex || p.toRevisionIndex >= cur);
  return {
    ok: true,
    role: c.role,
    archived: c.archived,
    can: can(c),
    today: c.today,
    disciplines: c.disciplines,
    linksExpireAt: expiry(),
    sheet: presentSheet(s, c, revisions, { open: shown.filter((p) => live(p) && !p.closed).length, total: shown.filter(live).length, hidden }),
    revisions: visibleRevs.map((r) => presentRevision(r, c, urls)),
    pins: shown,
    hiddenPins: hidden,
    rfis: c.allRfis
      .filter((r) => pinnable(r, c))
      .map((r) => ({ ItemId: r.ItemId, number: r.number, subject: r.subject ?? "", status: r.status }))
      .sort((a, b) => String(b.number).localeCompare(String(a.number), undefined, { numeric: true })),
    // Active punch items without a pin yet, for "Link existing".
    punchItems: c.allPunch
      .filter((i) => punchPinnable(i, c) && !pinnedPunch.has(i.ItemId))
      .map((i) => ({ ItemId: i.ItemId, number: i.number, title: i.title ?? "", status: i.status, companyName: i.assigneeCompanyName ?? "" }))
      .sort((a, b) => String(b.number).localeCompare(String(a.number), undefined, { numeric: true }))
  };
}

async function sheet(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  return sheetDetail(db, c, args.sheetId);
}

// ---------- upload tickets (the PDF and its thumbnail) ----------
const sheetTicket = (a, me, projectId) =>
  ["d1", a.fileId, a.thumbFileId || "", me.userId, me.tenantRole, projectId, a.fileName, a.sizeBytes, a.uploadedAt];

async function uploadLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.upload) throw new Refused("NOT_ALLOWED", "Only the project manager, the document controller or a designer uploads drawings.");
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) throw new Refused("NO_FILES", "Choose a PDF first.");
  if (files.length > MAX_PER_CALL) throw new Refused("TOO_MANY_FILES", `Publish at most ${MAX_PER_CALL} sheets at a time.`);
  const now = new Date().toISOString();
  const props = { app: "buildnexa", tenantRole: me.tenantRole, projectId: c.projectId, uploadedBy: me.userId, record: "drawing" };
  const uploads = await Promise.all(files.map(async (f) => {
    const fileName = safeFileName(f?.name);
    const sizeBytes = Number(f?.sizeBytes);
    if (!/\.pdf$/i.test(fileName)) throw new Refused("FILE_TYPE_NOT_ALLOWED", `${fileName} isn't a PDF. Drawings are single-sheet PDFs.`);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Refused("EMPTY_FILE", `${fileName} is empty.`);
    if (sizeBytes > MAX_FILE_BYTES) throw new Refused("FILE_TOO_LARGE", `${fileName} is ${Math.round(sizeBytes / 1048576)} MB. A sheet can be at most 50 MB; split the set into one PDF per sheet.`);
    const tag = crypto.randomUUID().slice(0, 8);
    const stored = `${fileName.replace(/\.pdf$/i, "")}-${tag}.pdf`;
    const t = f?.thumb;
    const wantThumb = t && THUMB_TYPES.includes(String(t.contentType)) && Number(t.sizeBytes) > 0 && Number(t.sizeBytes) <= MAX_THUMB_BYTES_SHEET;
    const [main, thumb] = await Promise.all([
      db.presignUpload(stored, props),
      wantThumb ? db.presignUpload(`sheet-thumb-${tag}.${String(t.contentType).split("/")[1]}`, { ...props, copy: "thumb" }) : undefined
    ]);
    const a = { fileId: main.fileId, thumbFileId: thumb?.fileId ?? "", fileName, sizeBytes, uploadedAt: now };
    return { ...a, uploadUrl: main.uploadUrl, thumbUploadUrl: thumb?.uploadUrl, ticket: await db.sign(sheetTicket(a, me, c.projectId)) };
  }));
  return { ok: true, uploads };
}

// ---------- writing ----------
async function saveSheet(db, c, s, changes, kind, extra = {}) {
  const version = Number(s.version ?? 0);
  const lastChange = { kind, nonce: crypto.randomUUID(), actorUserId: c.me.userId, reason: extra.reason ?? "", before: extra.before ?? "", after: extra.after ?? "" };
  const next = { ...s, ...changes, lastChange, updatedAt: new Date().toISOString() };
  if (changes.sheetNumber !== undefined || changes.title !== undefined) next.searchText = `${next.sheetNumber} ${next.title}`.toLowerCase();
  const n = await db.updateWhere("Sheet", { ItemId: { eq: s.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    ...(next.searchText !== s.searchText ? { searchText: next.searchText } : {}),
    updatedAt: next.updatedAt,
    version: version + 1,
    lastChange
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just changed this sheet. It has been reloaded; please try again.");
  return { ...next, version: version + 1 };
}

function history(db, c, recordType, recordId, recordNumber, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType,
    recordId,
    recordNumber,
    action,
    actorName: actorName(c),
    summary,
    reason: extra.reason,
    before: extra.before,
    after: extra.after
  });
}

function disciplineOf(c, v) {
  const name = text(v, 60);
  const hit = c.disciplines.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Refused("BAD_DISCIPLINE", `Choose a discipline from the list (${c.disciplines.map((d) => d.name).join(", ")}).`);
  return hit.name;
}

function pageSize(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 10 && n < 30000 ? Math.round(n * 100) / 100 : undefined;
}

/** Checks one row of a publish call before anything is written. */
async function checkPublishRow(db, c, x) {
  const a = {
    fileId: String(x?.fileId ?? ""),
    thumbFileId: String(x?.thumbFileId ?? ""),
    fileName: safeFileName(x?.fileName),
    sizeBytes: Number(x?.sizeBytes),
    uploadedAt: String(x?.uploadedAt ?? "")
  };
  const age = Date.now() - Date.parse(a.uploadedAt);
  const expected = await db.sign(sheetTicket(a, c.me, c.projectId));
  if (!a.fileId || x?.ticket !== expected || !(age >= -60_000 && age <= TICKET_HOURS_SHEET * 3600_000)) {
    throw new Refused("BAD_FILE_TICKET", `${a.fileName}: the upload could not be confirmed. Remove it and add it again.`);
  }
  const sheetNumber = sheetNumberOf(x?.sheetNumber);
  const title = text(x?.title, 120);
  if (!title) throw new Refused("NO_TITLE", `${sheetNumber}: enter the sheet title.`);
  const issuedDate = isDay(x?.issuedDate) ? String(x.issuedDate) : c.today;
  if (issuedDate > c.today) throw new Refused("BAD_DATE", `${sheetNumber}: the issue date can't be in the future.`);
  const w = pageSize(x?.pageWidthPt);
  const h = pageSize(x?.pageHeightPt);
  if (!w || !h) throw new Refused("BAD_PAGE", `${a.fileName}: the page size couldn't be read. Open the PDF to check it, then add it again.`);
  return {
    ...a,
    sheetNumber,
    key: keyOf(sheetNumber),
    title,
    discipline: disciplineOf(c, x?.discipline),
    setName: text(x?.setName, 60) || DEFAULT_SET,
    revisionLabel: labelOf(x?.revisionLabel),
    issuedDate,
    note: text(x?.note, 300),
    pageWidthPt: w,
    pageHeightPt: h
  };
}

/** Finds the sheet for a number, or makes it. Two first uploads at once fold into the oldest row. */
async function sheetFor(db, c, row, sheets) {
  const found = sheets.filter((s) => s.sheetNumberKey === row.key && !s.isVoided).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.ItemId).localeCompare(String(b.ItemId)));
  if (found[0]) return { sheet: found[0], created: false };
  const now = new Date().toISOString();
  const fresh = {
    tenantRole: c.me.tenantRole,
    projectId: c.projectId,
    sheetNumber: row.sheetNumber,
    sheetNumberKey: row.key,
    sortKey: sortKeyOf(row.sheetNumber),
    title: row.title,
    discipline: row.discipline,
    setName: row.setName,
    version: 0,
    revisionCount: 0,
    currentRevisionIndex: 0,
    createdByUserId: c.me.userId,
    createdAt: now,
    updatedAt: now,
    isVoided: false,
    searchText: `${row.sheetNumber} ${row.title}`.toLowerCase(),
    lastChange: { kind: "created", nonce: crypto.randomUUID(), actorUserId: c.me.userId }
  };
  const itemId = await db.insert("Sheet", fresh);
  const again = (await loadSheets(db, c, { sheetNumberKey: row.key }))
    .filter((s) => !s.isVoided)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.ItemId).localeCompare(String(b.ItemId)));
  const winner = again[0] ?? { ...fresh, ItemId: itemId };
  if (winner.ItemId !== itemId) {
    await db.updateWhere("Sheet", { ItemId: { eq: itemId } }, c.me.tenantRole, { isVoided: true, voidReason: "duplicate of a sheet made at the same moment" }).catch(() => undefined);
  }
  sheets.push(winner);
  return { sheet: winner, created: winner.ItemId === itemId };
}

async function publishOne(db, c, row, sheets, existingByFile) {
  const again = existingByFile.get(row.fileId);
  if (again) return { fileId: row.fileId, ok: true, sheetId: again.sheetId, revisionId: again.ItemId, repeated: true };
  const { sheet: first, created } = await sheetFor(db, c, row, sheets);
  let s = first;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const revs = await loadRevisions(db, c, { sheetId: s.ItemId });
    const live = revs.filter((r) => !r.isVoided);
    if (live.some((r) => String(r.revisionLabel).toUpperCase() === row.revisionLabel)) {
      throw new Refused("DUPLICATE_LABEL", `${s.sheetNumber} already has revision ${row.revisionLabel}. Use the next label (as printed on the sheet).`);
    }
    const n = Math.max(Number(s.currentRevisionIndex ?? 0), ...revs.map((r) => Number(r.revisionIndex ?? 0)), 0);
    const index = n + 1;
    // Claim the next revision number on the sheet (compare-and-set); the loser reads again.
    const keepInfo = !created && !c.manager; // designers publish revisions but don't rename sheets
    const info = keepInfo ? {} : { title: row.title, discipline: row.discipline, setName: row.setName };
    const claimed = await db.updateWhere("Sheet", { ItemId: { eq: s.ItemId }, version: { eq: Number(s.version ?? 0) } }, c.me.tenantRole, {
      ...info,
      currentRevisionIndex: index,
      revisionCount: live.length + 1,
      version: Number(s.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      lastChange: { kind: "revisionClaimed", nonce: crypto.randomUUID(), actorUserId: c.me.userId }
    });
    if (claimed !== 1) {
      [s] = await loadSheets(db, c, { ItemId: s.ItemId });
      if (!s) throw new Refused("NOT_FOUND", `${row.sheetNumber} was removed while uploading.`);
      continue;
    }
    s = { ...s, ...info, currentRevisionIndex: index, version: Number(s.version ?? 0) + 1 };
    const now = new Date().toISOString();
    const rev = {
      tenantRole: c.me.tenantRole,
      projectId: c.projectId,
      sheetId: s.ItemId,
      sheetNumber: s.sheetNumber,
      revisionIndex: index,
      revisionLabel: row.revisionLabel,
      issuedDate: row.issuedDate,
      note: row.note,
      status: "current",
      fileId: row.fileId,
      thumbFileId: row.thumbFileId,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      pageWidthPt: row.pageWidthPt,
      pageHeightPt: row.pageHeightPt,
      uploadedByUserId: c.me.userId,
      uploadedByCompanyId: c.mine.companyId ?? "",
      uploadedByName: actorName(c),
      uploadedAt: now,
      isVoided: false,
      lastChange: { kind: "published", nonce: row.fileId, actorUserId: c.me.userId }
    };
    const revId = await db.insert("SheetRevision", rev);
    const older = live.filter((r) => r.status === "current");
    await Promise.all(older.map((r) => db.updateWhere("SheetRevision", { ItemId: { eq: r.ItemId } }, c.me.tenantRole, {
      status: "superseded",
      supersededAt: now,
      lastChange: { kind: "superseded", nonce: crypto.randomUUID(), actorUserId: c.me.userId }
    })));
    // Point the sheet at the new revision, unless an even newer one was published meanwhile.
    await db.updateWhere("Sheet", { ItemId: { eq: s.ItemId }, currentRevisionIndex: { eq: index } }, c.me.tenantRole, {
      currentRevisionId: revId,
      currentRevisionLabel: row.revisionLabel,
      currentFileId: row.fileId,
      currentThumbFileId: row.thumbFileId,
      lastIssuedDate: row.issuedDate
    });
    const prev = older.sort((a, b) => b.revisionIndex - a.revisionIndex)[0];
    await history(db, c, "sheet", s.ItemId, s.sheetNumber, created ? "created" : "revised",
      created
        ? `${actorName(c)} issued ${s.sheetNumber} ${row.title} rev ${row.revisionLabel}`
        : `${actorName(c)} issued ${s.sheetNumber} rev ${row.revisionLabel}${prev ? ` (supersedes rev ${prev.revisionLabel})` : ""}`);
    return { fileId: row.fileId, ok: true, sheetId: s.ItemId, revisionId: revId, sheetNumber: s.sheetNumber, title: s.title, label: row.revisionLabel, previous: prev?.revisionLabel ?? "", created };
  }
  throw new Refused("CONTENDED", `${row.sheetNumber} is being changed by someone else right now. Please try again.`);
}

async function publish(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.upload) throw new Refused("NOT_ALLOWED", "Only the project manager, the document controller or a designer uploads drawings.");
  const list = Array.isArray(args.sheets) ? args.sheets : [];
  if (!list.length) throw new Refused("NO_FILES", "Choose a PDF first.");
  if (list.length > MAX_PER_CALL) throw new Refused("TOO_MANY_FILES", `Publish at most ${MAX_PER_CALL} sheets at a time.`);
  // Check every row (and its upload ticket) before writing anything.
  const rows = [];
  for (const x of list) rows.push(await checkPublishRow(db, c, x));
  const keys = rows.map((r) => r.key);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw new Refused("SAME_SHEET_TWICE", `${twice} is in this upload twice. Publish one revision of a sheet at a time.`);

  const [sheets, revisions] = await Promise.all([loadSheets(db, c), loadRevisions(db, c)]);
  const existingByFile = new Map(revisions.map((r) => [r.fileId, r]));
  const results = [];
  for (const row of rows) {
    try {
      results.push(await publishOne(db, c, row, sheets, existingByFile));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      results.push({ fileId: row.fileId, ok: false, code: error.code, error: error.message });
    }
  }
  const issued = results.filter((r) => r.ok && !r.repeated);
  const notified = issued.length ? await tellIssued(db, c, issued) : { bell: 0, email: 0, failed: [] };
  return { ok: true, results, notified };
}

// The team hears about new sheets and revisions: a bell for everyone, an email when a revision
// replaces an older one ("don't build from the old sheet"). People holding the ball on an RFI or a
// punch item pinned to a revised sheet are told to check their pin.
async function tellIssued(db, c, issued) {
  const result = { bell: 0, email: 0, failed: [] };
  try {
    const others = c.active.filter((m) => m.userId !== c.me.userId);
    if (!others.length) return result;
    const revised = issued.filter((r) => !r.created);
    const line = (r) => (r.created ? `${r.sheetNumber} ${r.title} rev ${r.label} (new sheet)` : `${r.sheetNumber} rev ${r.label} supersedes rev ${r.previous}`);
    const one = issued.length === 1;
    const title = one
      ? issued[0].created ? `New sheet ${issued[0].sheetNumber} rev ${issued[0].label}` : `${issued[0].sheetNumber} revised to rev ${issued[0].label}`
      : `${issued.length} drawing revisions issued`;
    const body = `${issued.map(line).join("; ").slice(0, 400)} · by ${actorName(c)}`;
    const link = one ? `/drawings/${issued[0].sheetId}?project=${c.projectId}` : `/drawings?project=${c.projectId}`;
    const tasks = [db.notify(others.map((m) => m.userId), { title, body, link, projectId: c.projectId, kind: "drawing.revision_published" }).then(() => { result.bell += others.length; })];

    if (revised.length) {
      const prefs = await db.list("NotificationPreference", PREF_FIELDS, c.me.tenantRole).catch(() => []);
      const firstPref = new Map();
      for (const p of [...prefs].sort((x, y) => String(x.ItemId).localeCompare(String(y.ItemId)))) if (!firstPref.has(p.userId)) firstPref.set(p.userId, p);
      const emailOff = new Set([...firstPref.values()].filter((p) => p.emailEnabled === false).map((p) => p.userId));
      const subject = `${c.project.number ? `[${c.project.number}] ` : ""}${revised.length === 1 ? `${revised[0].sheetNumber} revised to rev ${revised[0].label}` : `${revised.length} drawings revised`}`;
      for (const m of others) {
        if (!m.email || emailOff.has(m.userId)) continue;
        tasks.push(db.mail(m.email, subject, {
          DisplayName: html(m.displayName || ""),
          Heading: html(subject.replace(/^\[[^\]]*\] /, "")),
          Text: html(`${revised.map(line).join("; ")}. Older revisions stay viewable but are marked superseded: build from the current one.`),
          ProjectName: html(c.project.name || ""),
          ButtonLabel: "Open the drawing",
          ButtonUrl: `${db.appUrl}${revised.length === 1 ? `/drawings/${revised[0].sheetId}?project=${c.projectId}` : `/drawings?project=${c.projectId}`}`,
          SettingsUrl: `${db.appUrl}/inbox?tab=settings`
        }).then(() => { result.email += 1; }));
      }
      // Ball holders of open RFIs and active punch items pinned on a revised sheet: check the pin still fits.
      const sheetIds = new Set(revised.map((r) => r.sheetId));
      const pins = (await loadPins(db, c)).filter((p) => sheetIds.has(p.sheetId) && !p.isVoided && !Number(p.toRevisionIndex) && (p.linkedRecordType === "rfi" || p.linkedRecordType === "punchItem"));
      if (pins.length) {
        await Promise.all([loadRfis(db, c), loadPunch(db, c)]);
        const ask = new Map();
        for (const p of pins) {
          const punch = p.linkedRecordType === "punchItem";
          const r = punch ? c.punchById.get(p.linkedRecordId) : c.rfiById.get(p.linkedRecordId);
          if (!r || r.isVoided) continue;
          if (punch ? !PUNCH_ACTIVE.includes(r.status) : r.status === "closed" || r.status === "void" || r.status === "draft") continue;
          const u = r.ballInCourtUserId;
          if (!u || u === c.me.userId || !c.active.some((m) => m.userId === u)) continue;
          const s = revised.find((x) => x.sheetId === p.sheetId);
          if (!ask.has(u)) ask.set(u, []);
          ask.get(u).push(`${r.number} on ${s.sheetNumber}`);
        }
        for (const [u, items] of ask) {
          tasks.push(db.notify([u], {
            title: "A sheet with your pin was revised",
            body: `Check that ${items.join(", ")} still ${items.length === 1 ? "points" : "point"} at the right spot.`,
            link: `/drawings/${revised[0].sheetId}?project=${c.projectId}`,
            projectId: c.projectId,
            kind: "drawing.pinned_sheet_revised"
          }).then(() => { result.bell += 1; }));
        }
      }
    }
    for (const x of await Promise.allSettled(tasks)) if (x.status === "rejected") result.failed.push(String(x.reason?.message ?? x.reason).slice(0, 200));
  } catch (error) {
    result.failed.push(String(error?.message ?? error).slice(0, 200));
  }
  return result;
}

async function updateSheet(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller changes sheet details.");
  const s = await loadSheet(db, c, args.sheetId);
  if (s.isVoided) throw new Refused("NOT_FOUND", "This sheet was removed.");
  if (args.version !== undefined && Number(args.version) !== Number(s.version ?? 0)) {
    throw new Refused("STATE_CHANGED", "Someone else just changed this sheet. It has been reloaded; please try again.");
  }
  const changes = {};
  if (args.title !== undefined) {
    changes.title = text(args.title, 120);
    if (!changes.title) throw new Refused("NO_TITLE", "Enter the sheet title.");
  }
  if (args.discipline !== undefined) changes.discipline = disciplineOf(c, args.discipline);
  if (args.setName !== undefined) changes.setName = text(args.setName, 60) || DEFAULT_SET;
  if (args.sheetNumber !== undefined) {
    const n = sheetNumberOf(args.sheetNumber);
    if (keyOf(n) !== s.sheetNumberKey) {
      const taken = (await loadSheets(db, c, { sheetNumberKey: keyOf(n) })).some((x) => !x.isVoided && x.ItemId !== s.ItemId);
      if (taken) throw new Refused("SHEET_NUMBER_TAKEN", `${n} is already a sheet in this project.`);
    }
    Object.assign(changes, { sheetNumber: n, sheetNumberKey: keyOf(n), sortKey: sortKeyOf(n) });
  }
  const changed = Object.keys(changes).filter((k) => changes[k] !== (s[k] ?? ""));
  if (!changed.length) return { ok: true, ...(await sheetDetail(db, c, s.ItemId)) };
  const names = { title: "title", discipline: "discipline", setName: "set", sheetNumber: "number" };
  const shown = changed.filter((k) => names[k]);
  const before = shown.map((k) => `${names[k]}: ${s[k] ?? ""}`).join("; ");
  const after = shown.map((k) => `${names[k]}: ${changes[k]}`).join("; ");
  await saveSheet(db, c, s, changes, "edit", { before, after });
  await history(db, c, "sheet", s.ItemId, changes.sheetNumber ?? s.sheetNumber, "edited", `${actorName(c)} changed the ${shown.map((k) => names[k]).join(", ")} of ${s.sheetNumber}`, { before, after });
  return { ok: true, ...(await sheetDetail(db, c, s.ItemId)) };
}

async function voidRevision(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller voids a revision.");
  const reason = text(args.reason, 300);
  if (!reason) throw new Refused("NO_REASON", "Say why this revision is void (for example: uploaded to the wrong sheet).");
  const [r] = await loadRevisions(db, c, { ItemId: String(args.revisionId ?? "") });
  if (!r) throw new Refused("NOT_FOUND", "This revision doesn't exist in this project.");
  const s = await loadSheet(db, c, r.sheetId);
  if (r.isVoided) return { ok: true, ...(await sheetDetail(db, c, s.ItemId)) };
  const now = new Date().toISOString();
  // The sheet first (compare-and-set): two voids or a publish at the same time can't both win.
  const live = (await loadRevisions(db, c, { sheetId: s.ItemId })).filter((x) => !x.isVoided && x.ItemId !== r.ItemId).sort((a, b) => b.revisionIndex - a.revisionIndex);
  const next = live[0];
  const wasCurrent = s.currentRevisionId === r.ItemId || r.status === "current";
  const sheetChanges = wasCurrent
    ? next
      ? { currentRevisionId: next.ItemId, currentRevisionLabel: next.revisionLabel, currentFileId: next.fileId, currentThumbFileId: next.thumbFileId, lastIssuedDate: next.issuedDate, currentRevisionIndex: Number(next.revisionIndex), revisionCount: live.length }
      : { currentRevisionId: "", currentRevisionLabel: "", currentFileId: "", currentThumbFileId: "", currentRevisionIndex: 0, revisionCount: 0, isVoided: true, voidReason: reason }
    : { revisionCount: live.length };
  await saveSheet(db, c, s, sheetChanges, "revisionVoided", { reason });
  await db.updateWhere("SheetRevision", { ItemId: { eq: r.ItemId } }, c.me.tenantRole, {
    status: "void",
    isVoided: true,
    voidReason: reason,
    voidedAt: now,
    voidedByUserId: me.userId,
    lastChange: { kind: "voided", nonce: crypto.randomUUID(), actorUserId: me.userId, reason }
  });
  if (wasCurrent && next) {
    await db.updateWhere("SheetRevision", { ItemId: { eq: next.ItemId } }, c.me.tenantRole, {
      status: "current",
      lastChange: { kind: "currentAgain", nonce: crypto.randomUUID(), actorUserId: me.userId, reason }
    });
  }
  await history(db, c, "sheet", s.ItemId, s.sheetNumber, "revisionVoided",
    `${actorName(c)} voided ${s.sheetNumber} rev ${r.revisionLabel}: ${reason}${wasCurrent ? next ? ` (rev ${next.revisionLabel} is current again)` : " (the sheet has no revision left and was removed)" : ""}`, { reason });
  if (wasCurrent && !next) return { ok: true, sheetRemoved: true, sheetId: s.ItemId };
  return { ok: true, ...(await sheetDetail(db, c, s.ItemId)) };
}

// ---------- pins ----------
function point(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Refused("BAD_POINT", "Place the pin on the sheet.");
  return Math.round(n * 100000) / 100000;
}

async function loadPin(db, c, pinId) {
  const [p] = await loadPins(db, c, { ItemId: String(pinId ?? "") });
  if (!p || p.isVoided) throw new Refused("NOT_FOUND", "This pin doesn't exist any more.");
  await Promise.all([loadRfis(db, c), loadPunch(db, c), p.linkedRecordType === "photo" ? loadLogPhotos(db, c) : null]);
  const v = pinView(p, c);
  if (!v || v === "hidden") throw new Refused("NOT_FOUND", "This pin doesn't exist any more.");
  return { p, v };
}

function onCurrent(s, revisionIndex) {
  if (Number(revisionIndex) !== Number(s.currentRevisionIndex ?? 0)) {
    throw new Refused("NOT_CURRENT", `Pins go on the current revision (rev ${s.currentRevisionLabel}). The sheet has been reloaded.`);
  }
}

async function pin(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.pinner) throw new Refused("NOT_ALLOWED", "Your role views drawings but doesn't place pins.");
  const s = await loadSheet(db, c, args.sheetId);
  if (s.isVoided) throw new Refused("NOT_FOUND", "This sheet was removed.");
  onCurrent(s, args.revisionIndex);
  if (args.recordType === "punchItem") return pinPunch(db, me, c, s, args);
  if (args.recordType === "photo") return pinPhoto(db, me, c, s, args);
  if (args.recordType !== "rfi") throw new Refused("BAD_LINK", "A pin links to an RFI, a punch item or a daily log photo.");
  await loadRfis(db, c);
  const r = c.rfiById.get(String(args.recordId ?? ""));
  if (!pinnable(r, c)) throw new Refused("NOT_FOUND", "That RFI doesn't exist, or you can't open it.");
  const x = point(args.x);
  const y = point(args.y);
  const already = (await loadPins(db, c, { sheetId: s.ItemId, linkedRecordId: r.ItemId })).find((p) => !p.isVoided && !Number(p.toRevisionIndex));
  if (already) throw new Refused("ALREADY_PINNED", `${r.number} is already pinned on ${s.sheetNumber}. Move that pin instead.`);
  const row = {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    sheetId: s.ItemId,
    fromRevisionIndex: Number(s.currentRevisionIndex),
    toRevisionIndex: 0,
    version: 0,
    x,
    y,
    linkedRecordType: "rfi",
    linkedRecordId: r.ItemId,
    linkedRecordNumber: r.number,
    createdByUserId: me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: actorName(c),
    createdAt: new Date().toISOString(),
    isVoided: false,
    lastChange: { kind: "created", nonce: crypto.randomUUID(), actorUserId: me.userId }
  };
  const itemId = await db.insert("Pin", row);
  await history(db, c, "sheet", s.ItemId, s.sheetNumber, "pinned", `${actorName(c)} pinned ${r.number} on ${s.sheetNumber} rev ${s.currentRevisionLabel}`);
  return { ok: true, pin: pinView({ ...row, ItemId: itemId }, c) };
}

// Pins an existing punch item that has no pin yet (a new one is pinned by the punch Function's create).
async function pinPunch(db, me, c, s, args) {
  await loadPunch(db, c);
  const i = c.punchById.get(String(args.recordId ?? ""));
  if (!i || i.isVoided || !canSeePunch(i, c)) throw new Refused("NOT_FOUND", "That punch item doesn't exist, or you can't open it.");
  if (!PUNCH_ACTIVE.includes(i.status)) throw new Refused("NOT_ACTIVE", `${i.number} is ${i.status === "closed" ? "closed" : "void"}. Only open items get a pin.`);
  const x = point(args.x);
  const y = point(args.y);
  const already = (await loadPins(db, c, { linkedRecordId: i.ItemId })).find((p) => livePin(p));
  if (already) {
    const [where] = await loadSheets(db, c, { ItemId: already.sheetId });
    throw new Refused("ALREADY_PINNED", `${i.number} is already pinned${where ? ` on ${where.sheetNumber}` : ""}. Move that pin instead.`);
  }
  const row = {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    sheetId: s.ItemId,
    fromRevisionIndex: Number(s.currentRevisionIndex),
    toRevisionIndex: 0,
    version: 0,
    x,
    y,
    linkedRecordType: "punchItem",
    linkedRecordId: i.ItemId,
    linkedRecordNumber: i.number,
    createdByUserId: me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: actorName(c),
    createdAt: new Date().toISOString(),
    isVoided: false,
    lastChange: { kind: "created", nonce: crypto.randomUUID(), actorUserId: me.userId }
  };
  const itemId = await db.insert("Pin", row);
  await Promise.all([
    history(db, c, "sheet", s.ItemId, s.sheetNumber, "pinned", `${actorName(c)} pinned ${i.number} on ${s.sheetNumber} rev ${s.currentRevisionLabel}`),
    punchHistory(db, c, i.ItemId, i.number, "pinned", `${actorName(c)} pinned it on ${s.sheetNumber}`)
  ]);
  return { ok: true, pin: pinView({ ...row, ItemId: itemId }, c) };
}

// Pins a daily log photo where it was taken (one live pin per photo; also on a submitted log).
async function pinPhoto(db, me, c, s, args) {
  await loadLogPhotos(db, c);
  const ph = c.photoById.get(String(args.recordId ?? ""));
  if (!canSeeLogPhoto(ph, c)) throw new Refused("NOT_FOUND", "That photo doesn't exist, isn't on a daily log, or you can't open it.");
  const log = c.logById.get(ph.linkedRecordId);
  const x = point(args.x);
  const y = point(args.y);
  const already = (await loadPins(db, c, { linkedRecordId: ph.ItemId })).find((p) => p.linkedRecordType === "photo" && livePin(p));
  if (already) {
    const [where] = await loadSheets(db, c, { ItemId: already.sheetId });
    throw new Refused("ALREADY_PINNED", `This photo is already pinned${where ? ` on ${where.sheetNumber}` : ""}. Move that pin instead.`);
  }
  const row = {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    sheetId: s.ItemId,
    fromRevisionIndex: Number(s.currentRevisionIndex),
    toRevisionIndex: 0,
    version: 0,
    x,
    y,
    linkedRecordType: "photo",
    linkedRecordId: ph.ItemId,
    linkedRecordNumber: log.logDate,
    createdByUserId: me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: actorName(c),
    createdAt: new Date().toISOString(),
    isVoided: false,
    lastChange: { kind: "created", nonce: crypto.randomUUID(), actorUserId: me.userId }
  };
  const itemId = await db.insert("Pin", row);
  await Promise.all([
    history(db, c, "sheet", s.ItemId, s.sheetNumber, "pinned", `${actorName(c)} pinned ${pinLabel(row)} on ${s.sheetNumber} rev ${s.currentRevisionLabel}`),
    history(db, c, "dailyLog", log.ItemId, log.logDate, "photoPinned", `${actorName(c)} pinned a photo on ${s.sheetNumber}`)
  ]);
  const pin = pinView({ ...row, ItemId: itemId }, c);
  await photoLinks(db, c, [pin]);
  return { ok: true, pin };
}

// Where each of these photos is pinned now (the live pin on its sheet), for "Pinned on A-101".
// Only photos the caller can see; removed sheets and pins are left out.
async function photoPins(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const ids = Array.isArray(args.photoIds) ? [...new Set(args.photoIds.map(String))].slice(0, LINKS_PER_CALL) : [];
  if (!ids.length) return { ok: true, pins: {} };
  const wanted = new Set(ids);
  const [pins, sheets] = await Promise.all([loadPins(db, c, { linkedRecordType: "photo" }), loadSheets(db, c), loadLogPhotos(db, c)]);
  const sheetById = new Map(sheets.filter((s) => !s.isVoided).map((s) => [s.ItemId, s]));
  const out = {};
  for (const p of pins) {
    if (!wanted.has(p.linkedRecordId) || !livePin(p) || !sheetById.has(p.sheetId)) continue;
    if (!canSeeLogPhoto(c.photoById.get(p.linkedRecordId), c)) continue;
    out[p.linkedRecordId] = { pinId: p.ItemId, sheetId: p.sheetId, sheetNumber: sheetById.get(p.sheetId).sheetNumber };
  }
  return { ok: true, pins: out };
}

// The punch item's own history (the punch Function shows it in the item panel).
function punchHistory(db, c, itemId, number, action, summary) {
  return history(db, c, "punchItem", itemId, number, action, summary);
}

async function movePin(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const { p, v } = await loadPin(db, c, args.pinId);
  if (!v.canMove) throw new Refused("NOT_ALLOWED", "Only the person who placed this pin, the project manager or the document controller moves it.");
  const s = await loadSheet(db, c, p.sheetId);
  onCurrent(s, args.revisionIndex);
  if (Number(p.toRevisionIndex) && Number(p.toRevisionIndex) < Number(s.currentRevisionIndex)) throw new Refused("NOT_FOUND", "This pin isn't on the current revision.");
  const x = point(args.x);
  const y = point(args.y);
  const cur = Number(s.currentRevisionIndex);
  const lastChange = { kind: "moved", nonce: crypto.randomUUID(), actorUserId: me.userId, before: `${p.x},${p.y}`, after: `${x},${y}` };
  let saved;
  if (Number(p.fromRevisionIndex) < cur) {
    // Placed on an older revision: it stays where it was there, and starts again here.
    const n = await db.updateWhere("Pin", { ItemId: { eq: p.ItemId }, version: { eq: Number(p.version ?? 0) } }, c.me.tenantRole, {
      toRevisionIndex: cur - 1,
      version: Number(p.version ?? 0) + 1,
      lastChange
    });
    if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just moved this pin. The sheet has been reloaded.");
    const row = {
      ...Object.fromEntries(Object.entries(p).filter(([k]) => !["ItemId", "tenantRole"].includes(k))),
      tenantRole: me.tenantRole,
      fromRevisionIndex: cur,
      toRevisionIndex: 0,
      version: 0,
      x,
      y,
      movedFromPinId: p.ItemId,
      lastChange: { kind: "created", nonce: crypto.randomUUID(), actorUserId: me.userId }
    };
    const itemId = await db.insert("Pin", row);
    saved = { ...row, ItemId: itemId };
  } else {
    const n = await db.updateWhere("Pin", { ItemId: { eq: p.ItemId }, version: { eq: Number(p.version ?? 0) } }, c.me.tenantRole, {
      x,
      y,
      version: Number(p.version ?? 0) + 1,
      lastChange
    });
    if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just moved this pin. The sheet has been reloaded.");
    saved = { ...p, x, y, version: Number(p.version ?? 0) + 1 };
  }
  await history(db, c, "sheet", s.ItemId, s.sheetNumber, "pinMoved", `${actorName(c)} moved the pin of ${pinLabel(p)} on ${s.sheetNumber}`);
  if (p.linkedRecordType === "punchItem") await punchHistory(db, c, p.linkedRecordId, p.linkedRecordNumber, "pinMoved", `${actorName(c)} moved its pin on ${s.sheetNumber}`);
  const log = p.linkedRecordType === "photo" ? photoLogOf(p, c) : null;
  if (log) await history(db, c, "dailyLog", log.ItemId, log.logDate, "photoPinMoved", `${actorName(c)} moved a photo's pin on ${s.sheetNumber}`);
  const view = pinView(saved, c);
  await photoLinks(db, c, [view]);
  return { ok: true, pin: view, replacedPinId: saved.ItemId !== p.ItemId ? p.ItemId : undefined };
}

async function removePin(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const { p, v } = await loadPin(db, c, args.pinId);
  if (!v.canRemove) throw new Refused("NOT_ALLOWED", "Only the person who placed this pin, the project manager or the document controller removes it.");
  const s = await loadSheet(db, c, p.sheetId);
  const n = await db.updateWhere("Pin", { ItemId: { eq: p.ItemId }, version: { eq: Number(p.version ?? 0) } }, c.me.tenantRole, {
    isVoided: true,
    voidedAt: new Date().toISOString(),
    voidedByUserId: me.userId,
    version: Number(p.version ?? 0) + 1,
    lastChange: { kind: "removed", nonce: crypto.randomUUID(), actorUserId: me.userId }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just changed this pin. The sheet has been reloaded.");
  await history(db, c, "sheet", s.ItemId, s.sheetNumber, "unpinned", `${actorName(c)} removed the pin of ${pinLabel(p)} from ${s.sheetNumber}`);
  if (p.linkedRecordType === "punchItem") await punchHistory(db, c, p.linkedRecordId, p.linkedRecordNumber, "unpinned", `${actorName(c)} removed its pin from ${s.sheetNumber}`);
  const log = p.linkedRecordType === "photo" ? photoLogOf(p, c) : null;
  if (log) await history(db, c, "dailyLog", log.ItemId, log.logDate, "photoUnpinned", `${actorName(c)} removed a photo's pin from ${s.sheetNumber}`);
  return { ok: true, pinId: p.ItemId };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "drawings", {
    list: (args, { db, me }) => list(db, me, args),
    links: (args, { db, me }) => links(db, me, args),
    sheet: (args, { db, me }) => sheet(db, me, args),
    uploadLinks: (args, { db, me }) => uploadLinks(db, me, args),
    publish: (args, { db, me }) => publish(db, me, args),
    updateSheet: (args, { db, me }) => updateSheet(db, me, args),
    voidRevision: (args, { db, me }) => voidRevision(db, me, args),
    pin: (args, { db, me }) => pin(db, me, args),
    movePin: (args, { db, me }) => movePin(db, me, args),
    removePin: (args, { db, me }) => removePin(db, me, args),
    photoPins: (args, { db, me }) => photoPins(db, me, args)
  });
}
