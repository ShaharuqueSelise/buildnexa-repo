// Photos (DOC-01; docs/architecture/09-photos-and-documents.md, Phase 3 step 1): the project's
// photo gallery. Every photo is a Photo record that only this Function writes, after checking the
// caller's role on the project. Each photo has three files, all owned by the Buildnexa service
// identity: the original as taken (EXIF kept, up to 50 MB), a 1600 px copy for viewing and a
// 320 px copy for the grid. The browser makes both copies before upload; a type it can't draw
// (HEIC on most desktops) has only the original, and the page shows a placeholder for it.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list", projectId, removed? }                          -> listing
//   { action: "links", projectId, photoIds }                         -> { links: { [photoId]: { thumb, preview } }, linksExpireAt }
//   { action: "uploadLinks", projectId, files: [{ name, contentType, sizeBytes, preview?, thumb? }] }
//                                                                    -> { uploads: [{ fileId, previewFileId, thumbFileId, …, ticket }] }
//   { action: "add", projectId, photos: [upload + ticket + { takenAt?, width?, height?, caption? }],
//     locationLabel?, tags?, link?: { type: "rfi", id } | { type: "punchItem", id, role: "before" | "after" }
//                                    | { type: "dailyLog", id } }
//                                                                    -> { photos } (the new ones)
//   { action: "update", projectId, photoId, version, caption?, locationLabel?, tags? } -> { photos: [photo] }
//   { action: "tag", projectId, photoIds, add?, remove? }           -> { photos, skipped }
//   { action: "remove" | "restore", projectId, photoId, reason? }   -> { photos: [photo] }
//   { action: "originalLink", projectId, photoId }                  -> { url, fileName, contentType }
// listing = { role, archived, companyId, can, photos, rfis, linksExpireAt, linked }; photos carry
// `thumbUrl` and `previewUrl` for the newest LINKED_IN_LIST of them (the rest via `links`).
//
// Rules (Phase 3 decisions, 24 Nov 2026):
// - The caller must be an active member of the project. Company admins get no photos from their
//   company role.
// - photo.view (PM, superintendent, document controller, designer, owner) sees every photo.
//   photo.view_company (subcontractor) sees their own company's photos and photos linked to a
//   record they can open (RFIs with the RFI page's rules, punch items with the punch list's).
// - photo.upload: everyone except the owner. A photo can be linked to an RFI the caller can open
//   (not a draft or a voided one), or to a punch item (Phase 3 step 3) with the punch Function's
//   rules: a before photo by the superintendent or PM while the item is not closed or void; an after
//   photo while it is open or in progress, by the GC (superintendent, PM) or the assigned company.
// - Daily log photos (Phase 3 daily logs part 4) follow the daily log's rules, here and in the gallery:
//   added to a DRAFT log by the PM, the superintendent or a subcontractor; seen by whoever sees that
//   part of the log: PM, superintendent and document controller all of them, a subcontractor their
//   own company's, the owner once the log is submitted, designers none. A photo on a submitted log
//   is removed only by the PM or the document controller (the log is a record).
// - The uploader edits caption, location and tags of their own photos; photo.manage (PM, document
//   controller) edits every photo, and alone sees and restores removed photos.
// - Remove: photo.manage any photo; the uploader their own, a subcontractor only within 24 h.
//   Nothing is deleted: a removed photo stays restorable and keeps its files.
// - Every update matches the row's `version` (compare-and-set).
// Never returns or logs a token or a download link in a log.

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
const PHOTO_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const COPY_TYPES = ["image/jpeg", "image/webp"];
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
const MAX_THUMB_BYTES_PHOTO = 300 * 1024;
const MAX_PER_CALL = 10;
const MAX_TAGS = 15;
const SUB_REMOVE_HOURS = 24;
const LINKED_IN_LIST = 240; // newest photos that come with links in the list
const LINKS_PER_CALL = 240;
const LINK_MINUTES = 50; // storage links last an hour; the page asks again before they run out

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
};

const PHOTO_FIELDS =
  "ItemId projectId fileId previewFileId thumbFileId fileName contentType sizeBytes width height version takenAt uploadedAt yearMonth " +
  "caption locationLabel tags linkedRecordType linkedRecordId linkedRecordNumber linkedRecordLabel linkRole uploadedByUserId uploaderCompanyId " +
  "uploadedByName isVoided voidedAt voidedByUserId lastChange { kind reason }";
const RFI_FIELDS = "ItemId number subject status isVoided createdByUserId createdByCompanyId ballInCourtUserId assigneeUserIds distributionUserIds";
const PUNCH_FIELDS = "ItemId number title status isVoided assigneeCompanyId createdByUserId";
const LOG_FIELDS = "ItemId logDate status duplicateOf";

// ---------- who is asking, on which project ----------
async function projectContext(db, me, projectId, { write = false } = {}) {
  const id = String(projectId ?? "");
  if (!id) throw new Refused("NOT_FOUND", "Choose a project first.");
  const [projects, mineRows] = await Promise.all([
    db.list("Project", "ItemId number name status", me.tenantRole, { ItemId: id }),
    db.list("ProjectMember", "ItemId userId displayName companyId role status", me.tenantRole, { projectId: id, userId: me.userId })
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  const mine = mineRows.find((r) => r.status === "active");
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. Photos are open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const role = mine.role;
  const all = projectCan(role, "photo.view");
  if (!all && !projectCan(role, "photo.view_company")) throw new Refused("NOT_ALLOWED", "Your project role doesn't include photos.");
  return { me, project, projectId: id, mine, role, archived, all, manager: projectCan(role, "photo.manage") };
}

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
  if (c.rfis) return c.rfis;
  const [rows, answers] = await Promise.all([
    db.list("Rfi", RFI_FIELDS, c.me.tenantRole, { projectId: c.projectId }),
    projectCan(c.role, "rfi.view") || !projectCan(c.role, "rfi.view_involved")
      ? Promise.resolve([])
      : db.list("RfiResponse", "rfiId authorUserId authorCompanyId isVoided", c.me.tenantRole, { projectId: c.projectId })
  ]);
  const company = c.mine.companyId;
  c.answered = new Set(answers.filter((x) => !x.isVoided && (x.authorUserId === c.me.userId || (company && x.authorCompanyId === company))).map((x) => x.rfiId));
  c.rfis = rows.filter((r) => canSeeRfi(r, c));
  return c.rfis;
}
// RFIs a photo can be linked to: open to the caller, not drafts, not voided.
const linkable = (rfis) => rfis.filter((r) => r.status !== "draft" && !r.isVoided && r.number);

// ---------- punch items the caller can open (same rules as functions/punch canSee) ----------
const PUNCH_ACTIVE = ["open", "inProgress", "readyForReview"];
function canSeePunch(i, c) {
  if (projectCan(c.role, "punch_item.view")) return true;
  if (projectCan(c.role, "punch_item.view_assigned")) {
    return (Boolean(i.assigneeCompanyId) && i.assigneeCompanyId === c.mine.companyId) || i.createdByUserId === c.me.userId;
  }
  return false;
}
async function loadPunch(db, c, where = {}) {
  const rows = await db.list("PunchItem", PUNCH_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where }).catch(() => []);
  return rows.filter((i) => canSeePunch(i, c));
}
// May the caller add a before or after photo to this punch item? (functions/punch abilities)
function punchPhotoAllowed(i, c, role) {
  const gc = projectCan(c.role, "punch_item.close");
  if (role === "before") return PUNCH_ACTIVE.includes(i.status) && (projectCan(c.role, "punch_item.create") || projectCan(c.role, "punch_item.assign"));
  const ownCompany = Boolean(i.assigneeCompanyId) && i.assigneeCompanyId === c.mine.companyId;
  return (i.status === "open" || i.status === "inProgress") && (gc || (projectCan(c.role, "punch_item.update_assigned") && ownCompany));
}

// ---------- daily logs (same rules as functions/daily-logs) ----------
const logsAll = (c) => projectCan(c.role, "daily_log.view") || projectCan(c.role, "daily_log.create");
const logPhotoAllowed = (c) => projectCan(c.role, "daily_log.create") || projectCan(c.role, "daily_log.crew_own");
const logDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
async function loadLogs(db, c, where = {}) {
  return db.list("DailyLog", LOG_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where }).catch(() => []);
}
function seesLogPhoto(p, c) {
  if (logsAll(c)) return true;
  if (projectCan(c.role, "daily_log.crew_own")) return Boolean(p.uploaderCompanyId) && p.uploaderCompanyId === c.mine.companyId;
  if (projectCan(c.role, "daily_log.view_submitted")) return Boolean(c.submittedLogIds?.has(p.linkedRecordId));
  return false;
}

// ---------- which photos the caller sees and may change ----------
function seesPhoto(p, c) {
  if (p.isVoided && !c.manager) return false;
  if (p.linkedRecordType === "dailyLog") return seesLogPhoto(p, c);
  if (c.all) return true;
  if (p.uploaderCompanyId && p.uploaderCompanyId === c.mine.companyId) return true;
  if (p.linkedRecordType === "rfi") return Boolean(c.rfiIds?.has(p.linkedRecordId));
  if (p.linkedRecordType === "punchItem") return Boolean(c.punchIds?.has(p.linkedRecordId));
  return false;
}
const own = (p, c) => p.uploadedByUserId === c.me.userId;
const canEdit = (p, c) => !c.archived && !p.isVoided && (c.manager || own(p, c));
function canRemove(p, c) {
  if (c.archived || p.isVoided) return false;
  if (c.manager) return true;
  if (!own(p, c)) return false;
  if (p.linkedRecordType === "dailyLog" && c.submittedLogIds?.has(p.linkedRecordId)) return false;
  if (projectCan(c.role, "photo.view_company")) return Date.now() - Date.parse(p.uploadedAt) <= SUB_REMOVE_HOURS * 3600_000;
  return true;
}

async function prepareVisibility(db, c) {
  // Every role needs the RFI list for the upload dialog; subcontractors also to see linked photos.
  const [rfis, punch, logs] = await Promise.all([loadRfis(db, c), c.all ? Promise.resolve([]) : loadPunch(db, c), loadLogs(db, c)]);
  c.rfiIds = new Set(rfis.map((r) => r.ItemId));
  c.punchIds = new Set(punch.map((i) => i.ItemId));
  c.submittedLogIds = new Set(logs.filter((l) => l.status === "submitted").map((l) => l.ItemId));
}

async function loadPhotos(db, c, where = {}) {
  return db.list("Photo", PHOTO_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where });
}

async function loadPhoto(db, c, photoId) {
  const [p] = await loadPhotos(db, c, { ItemId: String(photoId ?? "") });
  if (!p) throw new Refused("NOT_FOUND", "This photo doesn't exist, or you can't open it.");
  await prepareVisibility(db, c);
  if (!seesPhoto(p, c)) throw new Refused("NOT_FOUND", "This photo doesn't exist, or you can't open it.");
  return p;
}

const newestFirst = (a, b) => String(b.takenAt || b.uploadedAt).localeCompare(String(a.takenAt || a.uploadedAt)) || String(b.ItemId).localeCompare(String(a.ItemId));

// Download links for many files: storage answers in batches.
async function linksFor(db, fileIds) {
  const ids = [...new Set(fileIds.filter(Boolean))];
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    try {
      Object.assign(out, await db.downloadUrls(ids.slice(i, i + 100)));
    } catch {
      // the page shows a placeholder and asks again (`links`)
    }
  }
  return out;
}

function present(p, c, links) {
  const out = {
    ItemId: p.ItemId,
    fileName: p.fileName,
    contentType: p.contentType ?? "",
    sizeBytes: Number(p.sizeBytes ?? 0),
    width: p.width ?? undefined,
    height: p.height ?? undefined,
    version: Number(p.version ?? 0),
    takenAt: p.takenAt || p.uploadedAt,
    uploadedAt: p.uploadedAt,
    yearMonth: p.yearMonth || String(p.takenAt || p.uploadedAt || "").slice(0, 7),
    caption: p.caption ?? "",
    locationLabel: p.locationLabel ?? "",
    tags: p.tags ?? [],
    link:
      p.linkedRecordType && p.linkedRecordType !== "none" && p.linkedRecordId
        ? { type: p.linkedRecordType, id: p.linkedRecordId, number: p.linkedRecordNumber ?? "", label: p.linkedRecordLabel ?? "", role: p.linkRole || "general" }
        : undefined,
    uploadedByUserId: p.uploadedByUserId,
    uploadedByName: p.uploadedByName ?? "",
    uploaderCompanyId: p.uploaderCompanyId ?? "",
    hasPreview: Boolean(p.previewFileId),
    removed: Boolean(p.isVoided),
    removedAt: p.voidedAt ?? undefined,
    canEdit: canEdit(p, c),
    canRemove: canRemove(p, c)
  };
  if (p.isVoided) {
    out.removedByName = c.names?.get(p.voidedByUserId) ?? "";
    out.removedReason = p.lastChange?.kind === "remove" ? p.lastChange.reason ?? "" : "";
  }
  if (links && showsImage(p, c)) {
    const thumb = links[p.thumbFileId] ?? links[p.previewFileId];
    const preview = links[p.previewFileId] ?? links[p.thumbFileId];
    if (thumb) out.thumbUrl = thumb;
    if (preview) out.previewUrl = preview;
  }
  return out;
}

// Removed photos keep their files; only managers (who restore them) see their images.
const showsImage = (p, c) => !p.isVoided || c.manager;

// Names of the people who removed photos, for "Removed by …" in the photo view.
async function loadRemovers(db, c, rows) {
  const ids = [...new Set(rows.filter((p) => p.isVoided && p.voidedByUserId).map((p) => p.voidedByUserId))];
  c.names = c.names ?? new Map([[c.me.userId, c.mine.displayName ?? ""]]);
  const missing = ids.filter((id) => !c.names.has(id));
  if (!missing.length) return;
  const members = await db.list("ProjectMember", "userId displayName", c.me.tenantRole, { projectId: c.projectId });
  for (const m of members) if (m.userId && !c.names.has(m.userId)) c.names.set(m.userId, m.displayName ?? "");
}

async function presentMany(db, c, rows) {
  await loadRemovers(db, c, rows);
  const live = rows.filter((p) => showsImage(p, c));
  const links = await linksFor(db, live.flatMap((p) => [p.thumbFileId, p.previewFileId]));
  return rows.map((p) => present(p, c, links));
}

const expiry = () => new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();

// ---------- writing ----------
const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const actorName = (c) => c.mine.displayName || "Someone";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function cleanTags(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Refused("BAD_TAGS", "Tags could not be read.");
  const out = [];
  for (const t of list) {
    const tag = String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new Refused("TOO_MANY_TAGS", `A photo has at most ${MAX_TAGS} tags.`);
  return out;
}

const searchTextOf = (p) =>
  [p.caption, p.locationLabel, ...(p.tags ?? []), p.linkedRecordNumber, p.linkedRecordLabel, p.uploadedByName, p.fileName].filter(Boolean).join(" ").toLowerCase();

async function savePhoto(db, c, p, changes, kind, extra = {}) {
  const version = Number(p.version ?? 0);
  const lastChange = { kind, nonce: crypto.randomUUID(), actorUserId: c.me.userId, reason: extra.reason ?? "", before: extra.before ?? "", after: extra.after ?? "" };
  const next = { ...p, ...changes, lastChange };
  const n = await db.updateWhere("Photo", { ItemId: { eq: p.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    searchText: searchTextOf(next),
    version: version + 1,
    lastChange
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just changed this photo. The gallery has been reloaded; please try again.");
  return { ...next, version: version + 1 };
}

function history(db, c, recordId, recordNumber, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType: "photo",
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

// ---------- upload tickets (three files per photo) ----------
const photoTicket = (a, me, projectId) =>
  ["p1", a.fileId, a.previewFileId || "", a.thumbFileId || "", me.userId, me.tenantRole, projectId, a.fileName, a.contentType, a.sizeBytes, a.uploadedAt];
const TICKET_HOURS_PHOTO = 24;

function checkPhotoType(name, contentType) {
  const ext = extOf(name);
  if (!PHOTO_EXT.includes(ext) || (contentType && !PHOTO_TYPES.includes(String(contentType).toLowerCase()))) {
    throw new Refused("FILE_TYPE_NOT_ALLOWED", `${safeFileName(name)} isn't a photo. Photos can be JPG, PNG, WebP or HEIC; other files go into Documents.`);
  }
}

const copyOk = (x, max) => x && COPY_TYPES.includes(String(x.contentType)) && Number(x.sizeBytes) > 0 && Number(x.sizeBytes) <= max;

// ---------- actions ----------
async function listing(db, c, { removed = false } = {}) {
  await prepareVisibility(db, c);
  const rows = (await loadPhotos(db, c)).filter((p) => seesPhoto(p, c) && (removed ? p.isVoided : !p.isVoided)).sort(newestFirst);
  const head = rows.slice(0, LINKED_IN_LIST).filter((p) => showsImage(p, c));
  const [links] = await Promise.all([linksFor(db, head.flatMap((p) => [p.thumbFileId, p.previewFileId])), loadRemovers(db, c, rows)]);
  return {
    ok: true,
    role: c.role,
    archived: c.archived,
    companyId: c.mine.companyId ?? "",
    can: {
      upload: projectCan(c.role, "photo.upload") && !c.archived,
      manage: c.manager && !c.archived,
      seeRemoved: c.manager
    },
    removed,
    linksExpireAt: expiry(),
    linked: head.length,
    photos: rows.map((p) => present(p, c, links)),
    rfis: linkable(c.rfis).map((r) => ({ ItemId: r.ItemId, number: r.number, subject: r.subject ?? "" })).sort((a, b) => String(b.number).localeCompare(String(a.number), undefined, { numeric: true }))
  };
}

async function list(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const removed = Boolean(args.removed);
  if (removed && !c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller sees removed photos.");
  return listing(db, c, { removed });
}

async function links(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const ids = Array.isArray(args.photoIds) ? [...new Set(args.photoIds.map(String))].slice(0, LINKS_PER_CALL) : [];
  if (!ids.length) return { ok: true, links: {}, linksExpireAt: expiry() };
  await prepareVisibility(db, c);
  const wanted = new Set(ids);
  const rows = (await loadPhotos(db, c)).filter((p) => wanted.has(p.ItemId) && showsImage(p, c) && seesPhoto(p, c));
  const urls = await linksFor(db, rows.flatMap((p) => [p.thumbFileId, p.previewFileId]));
  const out = {};
  for (const p of rows) {
    const thumb = urls[p.thumbFileId] ?? urls[p.previewFileId];
    const preview = urls[p.previewFileId] ?? urls[p.thumbFileId];
    if (thumb || preview) out[p.ItemId] = { thumb, preview };
  }
  return { ok: true, links: out, linksExpireAt: expiry() };
}

async function uploadLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!projectCan(c.role, "photo.upload")) throw new Refused("NOT_ALLOWED", "Your role views photos but doesn't add them.");
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length) throw new Refused("NO_FILES", "Choose a photo first.");
  if (files.length > MAX_PER_CALL) throw new Refused("TOO_MANY_FILES", `Add at most ${MAX_PER_CALL} photos at a time.`);
  const now = new Date().toISOString();
  const props = { app: "buildnexa", tenantRole: me.tenantRole, projectId: c.projectId, uploadedBy: me.userId, record: "photo" };
  const uploads = await Promise.all(files.map(async (f) => {
    const fileName = safeFileName(f?.name);
    const sizeBytes = Number(f?.sizeBytes);
    const contentType = String(f?.contentType || "").toLowerCase().slice(0, 100);
    checkPhotoType(fileName, contentType);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Refused("EMPTY_FILE", `${fileName} is empty.`);
    if (sizeBytes > MAX_FILE_BYTES) throw new Refused("FILE_TOO_LARGE", `${fileName} is ${Math.round(sizeBytes / 1048576)} MB. The limit is 50 MB per photo.`);
    const tag = crypto.randomUUID().slice(0, 8);
    const dot = fileName.lastIndexOf(".");
    const stored = dot > 0 ? `${fileName.slice(0, dot)}-${tag}${fileName.slice(dot)}` : `${fileName}-${tag}`;
    const wantPreview = copyOk(f.preview, MAX_PREVIEW_BYTES);
    const wantThumb = copyOk(f.thumb, MAX_THUMB_BYTES_PHOTO);
    const [main, preview, thumb] = await Promise.all([
      db.presignUpload(stored, props),
      wantPreview ? db.presignUpload(`photo-1600-${tag}.${String(f.preview.contentType).split("/")[1]}`, { ...props, copy: "preview" }) : undefined,
      wantThumb ? db.presignUpload(`photo-320-${tag}.${String(f.thumb.contentType).split("/")[1]}`, { ...props, copy: "thumb" }) : undefined
    ]);
    const a = { fileId: main.fileId, previewFileId: preview?.fileId ?? "", thumbFileId: thumb?.fileId ?? "", fileName, contentType: contentType || "image/jpeg", sizeBytes, uploadedAt: now };
    return {
      ...a,
      uploadUrl: main.uploadUrl,
      previewUploadUrl: preview?.uploadUrl,
      thumbUploadUrl: thumb?.uploadUrl,
      ticket: await db.sign(photoTicket(a, me, c.projectId))
    };
  }));
  return { ok: true, uploads };
}

// The date the photo was taken, from the browser (EXIF or the file's date). Anything odd -> upload time.
function takenAtOf(value, uploadedAt) {
  const t = Date.parse(String(value ?? ""));
  if (!Number.isFinite(t) || t < Date.parse("2000-01-01T00:00:00Z") || t > Date.now() + 24 * 3600_000) return uploadedAt;
  return new Date(t).toISOString();
}

async function add(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!projectCan(c.role, "photo.upload")) throw new Refused("NOT_ALLOWED", "Your role views photos but doesn't add them.");
  const list = Array.isArray(args.photos) ? args.photos : [];
  if (!list.length) throw new Refused("NO_FILES", "Choose a photo first.");
  if (list.length > MAX_PER_CALL) throw new Refused("TOO_MANY_FILES", `Add at most ${MAX_PER_CALL} photos at a time.`);

  // Check every ticket before saving anything.
  const accepted = [];
  for (const x of list) {
    const a = {
      fileId: String(x?.fileId ?? ""),
      previewFileId: String(x?.previewFileId ?? ""),
      thumbFileId: String(x?.thumbFileId ?? ""),
      fileName: safeFileName(x?.fileName),
      contentType: String(x?.contentType ?? ""),
      sizeBytes: Number(x?.sizeBytes),
      uploadedAt: String(x?.uploadedAt ?? "")
    };
    const age = Date.now() - Date.parse(a.uploadedAt);
    const expected = await db.sign(photoTicket(a, me, c.projectId));
    if (!a.fileId || x?.ticket !== expected || !(age >= -60_000 && age <= TICKET_HOURS_PHOTO * 3600_000)) {
      throw new Refused("BAD_FILE_TICKET", `${a.fileName}: the upload could not be confirmed. Remove it and add it again.`);
    }
    checkPhotoType(a.fileName, a.contentType);
    const dim = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 100000 ? Number(v) : undefined);
    accepted.push({ ...a, takenAt: takenAtOf(x?.takenAt, new Date().toISOString()), width: dim(x?.width), height: dim(x?.height), caption: text(x?.caption, 300) });
  }

  let link;
  if (args.link && args.link.type === "punchItem") {
    const role = String(args.link.role ?? "");
    if (role !== "before" && role !== "after") throw new Refused("BAD_LINK", "Say whether this is a before or an after photo.");
    const [item] = await loadPunch(db, c, { ItemId: String(args.link.id ?? "") });
    if (!item || item.isVoided) throw new Refused("NOT_FOUND", "That punch item doesn't exist, or you can't open it.");
    if (!punchPhotoAllowed(item, c, role)) {
      throw new Refused("NOT_ALLOWED", role === "before"
        ? `Only the superintendent or the project manager adds before photos, while ${item.number} is not closed.`
        : `After photos go on ${item.number} while it is open or in progress, from the assigned company or the general contractor.`);
    }
    link = { linkedRecordType: "punchItem", linkedRecordId: item.ItemId, linkedRecordNumber: item.number, linkedRecordLabel: text(item.title, 120), linkRole: role };
  } else if (args.link && args.link.type === "dailyLog") {
    const [log] = await loadLogs(db, c, { ItemId: String(args.link.id ?? "") });
    if (!log || log.duplicateOf || !logPhotoAllowed(c)) throw new Refused("NOT_FOUND", "That daily log doesn't exist, or you can't add photos to it.");
    if (log.status !== "draft") throw new Refused("LOG_SUBMITTED", `The log for ${logDay(log.logDate)} is submitted: it is a read-only record and takes no new photos.`);
    link = { linkedRecordType: "dailyLog", linkedRecordId: log.ItemId, linkedRecordNumber: log.logDate, linkedRecordLabel: `Daily log ${logDay(log.logDate)}`, linkRole: "general" };
  } else if (args.link) {
    if (args.link.type !== "rfi") throw new Refused("BAD_LINK", "Photos can be linked to RFIs, punch items and daily logs.");
    const rfi = linkable(await loadRfis(db, c)).find((r) => r.ItemId === String(args.link.id ?? ""));
    if (!rfi) throw new Refused("NOT_FOUND", "That RFI doesn't exist, or you can't open it.");
    link = { linkedRecordType: "rfi", linkedRecordId: rfi.ItemId, linkedRecordNumber: rfi.number, linkedRecordLabel: text(rfi.subject, 120), linkRole: "general" };
  }
  const tags = cleanTags(args.tags) ?? [];
  const locationLabel = text(args.locationLabel, 120);

  // A retry after a lost answer sends the same files again: those are returned, not added twice.
  const existing = await loadPhotos(db, c);
  const byFile = new Map(existing.map((p) => [p.fileId, p]));
  const now = new Date().toISOString();
  const rows = [];
  for (const a of accepted) {
    const again = byFile.get(a.fileId);
    if (again) {
      rows.push(again);
      continue;
    }
    const row = {
      tenantRole: me.tenantRole,
      projectId: c.projectId,
      fileId: a.fileId,
      previewFileId: a.previewFileId,
      thumbFileId: a.thumbFileId,
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      width: a.width,
      height: a.height,
      version: 0,
      takenAt: a.takenAt,
      uploadedAt: now,
      yearMonth: a.takenAt.slice(0, 7),
      caption: a.caption,
      locationLabel,
      tags,
      ...(link ?? { linkedRecordType: "none" }),
      uploadedByUserId: me.userId,
      uploaderCompanyId: c.mine.companyId ?? "",
      uploadedByName: actorName(c),
      isVoided: false
    };
    row.searchText = searchTextOf(row);
    const itemId = await db.insert("Photo", row);
    rows.push({ ...row, ItemId: itemId });
  }
  const added = rows.filter((r) => !byFile.has(r.fileId));
  if (added.length) {
    await history(db, c, added[0].ItemId, "", "uploaded",
      `${actorName(c)} added ${plural(added.length, link?.linkRole === "before" || link?.linkRole === "after" ? `${link.linkRole} photo` : "photo")}${locationLabel ? ` at ${locationLabel}` : ""}${link ? ` to ${link.linkedRecordNumber}` : ""}`);
  }
  // The daily log's history says so too.
  if (added.length && link?.linkedRecordType === "dailyLog") {
    await db.audit(me, {
      projectId: c.projectId,
      recordType: "dailyLog",
      recordId: link.linkedRecordId,
      recordNumber: link.linkedRecordNumber,
      action: "photoAdded",
      actorName: actorName(c),
      summary: `${actorName(c)} added ${plural(added.length, "photo")}`
    });
  }
  // The punch item's own history says so too ("Anna added an after photo").
  if (added.length && link?.linkedRecordType === "punchItem") {
    await db.audit(me, {
      projectId: c.projectId,
      recordType: "punchItem",
      recordId: link.linkedRecordId,
      recordNumber: link.linkedRecordNumber,
      action: link.linkRole === "after" ? "afterPhotoAdded" : "beforePhotoAdded",
      actorName: actorName(c),
      summary: `${actorName(c)} added ${added.length === 1 ? `${link.linkRole === "after" ? "an" : "a"} ${link.linkRole} photo` : `${added.length} ${link.linkRole} photos`}`
    });
  }
  await prepareVisibility(db, c);
  return { ok: true, photos: await presentMany(db, c, rows), linksExpireAt: expiry() };
}

async function update(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const p = await loadPhoto(db, c, args.photoId);
  if (!canEdit(p, c)) throw new Refused("NOT_ALLOWED", "Only the person who took this photo, the project manager or the document controller can change it.");
  if (args.version !== undefined && Number(args.version) !== Number(p.version ?? 0)) {
    throw new Refused("STATE_CHANGED", "Someone else just changed this photo. The gallery has been reloaded; please try again.");
  }
  const changes = {};
  if (args.caption !== undefined) changes.caption = text(args.caption, 300);
  if (args.locationLabel !== undefined) changes.locationLabel = text(args.locationLabel, 120);
  if (args.tags !== undefined) changes.tags = cleanTags(args.tags);
  const changed = Object.keys(changes).filter((k) => JSON.stringify(changes[k]) !== JSON.stringify(p[k] ?? (k === "tags" ? [] : "")));
  if (!changed.length) return { ok: true, photos: await presentMany(db, c, [p]) };
  const before = Object.fromEntries(changed.map((k) => [k, p[k] ?? ""]));
  const after = Object.fromEntries(changed.map((k) => [k, changes[k]]));
  const saved = await savePhoto(db, c, p, changes, "edit");
  await history(db, c, p.ItemId, p.fileName, "edited", `${actorName(c)} changed the ${changed.map((k) => ({ caption: "caption", locationLabel: "location", tags: "tags" })[k]).join(", ")} of ${p.fileName}`, { before, after });
  return { ok: true, photos: await presentMany(db, c, [saved]) };
}

async function tag(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const ids = Array.isArray(args.photoIds) ? [...new Set(args.photoIds.map(String))] : [];
  if (!ids.length) throw new Refused("NO_PHOTOS", "Select photos first.");
  if (ids.length > 100) throw new Refused("TOO_MANY", "Tag at most 100 photos at a time.");
  const addTags = cleanTags(args.add ?? []);
  const removeTags = cleanTags(args.remove ?? []);
  if (!addTags.length && !removeTags.length) throw new Refused("BAD_TAGS", "Enter a tag.");
  await prepareVisibility(db, c);
  const wanted = new Set(ids);
  const rows = (await loadPhotos(db, c)).filter((p) => wanted.has(p.ItemId) && seesPhoto(p, c));
  const done = [];
  let skipped = ids.length - rows.length;
  for (const p of rows) {
    if (!canEdit(p, c)) {
      skipped += 1;
      continue;
    }
    const tags = [...(p.tags ?? []).filter((t) => !removeTags.includes(t)), ...addTags.filter((t) => !(p.tags ?? []).includes(t))];
    if (tags.length > MAX_TAGS) {
      skipped += 1;
      continue;
    }
    if (JSON.stringify(tags) === JSON.stringify(p.tags ?? [])) {
      done.push(p);
      continue;
    }
    try {
      done.push(await savePhoto(db, c, p, { tags }, "tag", { before: (p.tags ?? []).join(", "), after: tags.join(", ") }));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      skipped += 1; // changed by someone else at the same moment
    }
  }
  if (done.length) {
    const what = [addTags.length ? `added ${addTags.map((t) => `#${t}`).join(" ")}` : "", removeTags.length ? `removed ${removeTags.map((t) => `#${t}`).join(" ")}` : ""].filter(Boolean).join(" and ");
    await history(db, c, done[0].ItemId, "", "tagged", `${actorName(c)} ${what} on ${plural(done.length, "photo")}`);
  }
  return { ok: true, photos: await presentMany(db, c, done), skipped };
}

async function remove(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const p = await loadPhoto(db, c, args.photoId);
  if (p.isVoided) return { ok: true, photos: await presentMany(db, c, [p]) };
  if (!canRemove(p, c)) {
    if (own(p, c) && p.linkedRecordType === "dailyLog" && c.submittedLogIds?.has(p.linkedRecordId)) {
      throw new Refused("NOT_ALLOWED", "This photo is on a submitted daily log. Only the project manager or the document controller removes it.");
    }
    const sub = own(p, c) && projectCan(c.role, "photo.view_company");
    throw new Refused("NOT_ALLOWED", sub
      ? `You can remove your own photos for ${SUB_REMOVE_HOURS} hours after upload. Ask the project manager to remove this one.`
      : "Only the person who took this photo, the project manager or the document controller can remove it.");
  }
  const reason = text(args.reason, 300);
  const saved = await savePhoto(db, c, p, { isVoided: true, voidedAt: new Date().toISOString(), voidedByUserId: me.userId }, "remove", { reason });
  await history(db, c, p.ItemId, p.fileName, "removed", `${actorName(c)} removed the photo ${p.fileName}${reason ? `: ${reason}` : ""}`, { reason });
  return { ok: true, photos: await presentMany(db, c, [saved]) };
}

async function restore(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller restores photos.");
  const p = await loadPhoto(db, c, args.photoId);
  if (!p.isVoided) return { ok: true, photos: await presentMany(db, c, [p]) };
  const saved = await savePhoto(db, c, p, { isVoided: false, voidedByUserId: "" }, "restore");
  await history(db, c, p.ItemId, p.fileName, "restored", `${actorName(c)} restored the photo ${p.fileName}`);
  return { ok: true, photos: await presentMany(db, c, [saved]) };
}

async function originalLink(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const p = await loadPhoto(db, c, args.photoId);
  if (p.isVoided) throw new Refused("NOT_FOUND", "This photo was removed. Restore it first.");
  const urls = await db.downloadUrls([p.fileId]);
  const url = urls[p.fileId];
  if (!url) throw new Refused("NO_LINK", "The photo couldn't be fetched right now. Please try again.");
  return { ok: true, url, fileName: p.fileName, contentType: p.contentType ?? "" };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "photos", {
    list: (args, { db, me }) => list(db, me, args),
    links: (args, { db, me }) => links(db, me, args),
    uploadLinks: (args, { db, me }) => uploadLinks(db, me, args),
    add: (args, { db, me }) => add(db, me, args),
    update: (args, { db, me }) => update(db, me, args),
    tag: (args, { db, me }) => tag(db, me, args),
    remove: (args, { db, me }) => remove(db, me, args),
    restore: (args, { db, me }) => restore(db, me, args),
    originalLink: (args, { db, me }) => originalLink(db, me, args)
  });
}
