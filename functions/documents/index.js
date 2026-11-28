// Documents (DOC-02; docs/architecture/09-photos-and-documents.md, changed for the Part 3 file
// design): project folders with per-folder rules, versioned files, rename, move, trash and restore.
// Every file belongs to the Buildnexa service identity, as RFI files do; people hold no Storage
// permission. Folders, versions and trash are records (DocFolder, Document) that only this
// Function writes, after checking the caller's role on the project and the folder's rules.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list", projectId }                                  -> listing
//   { action: "uploadLinks", projectId, folderId, files: [{ name, contentType, sizeBytes }] }
//                                                                   -> { uploads: [{ fileId, uploadUrl, …, ticket }] }
//   { action: "addFiles", projectId, folderId, files: [upload + ticket], note? }
//                                                                   -> listing + { added: [{ name, documentId, versionNo }] }
//   { action: "newVersion", projectId, documentId, file: upload + ticket, note? }   -> listing
//   { action: "restoreVersion", projectId, documentId, versionNo }                 -> listing
//   { action: "rename", projectId, documentId, name }                              -> listing
//   { action: "move", projectId, documentId, folderId }                            -> listing
//   { action: "trash" | "restore", projectId, documentId }                         -> listing
//   { action: "createFolder", projectId, name, viewRoles, uploadRoles }            -> listing + { folderId }
//   { action: "setFolderAccess", projectId, folderId, viewRoles, uploadRoles }     -> listing
//   { action: "downloadLink", projectId, documentId, versionNo? }                  -> { url, fileName }
//   (the listing already carries `url` for each file's current version, valid until linksExpireAt)
// listing = { role, archived, can, folders, hiddenFolders, documents }. Every change answers with
// the fresh listing, so the screen needs no second call.
//
// Rules (spec §3, agreed 2026-11-23: the spec's matrix, and the PM can change it per folder):
// - The caller must be an active member of the project. Company admins get no documents from
//   their company role.
// - PM and document controller (document.manage) see and change everything, and alone trash and
//   restore. Nothing is ever deleted: trash stays restorable, no purge in the app.
// - Everyone else sees a folder when their role is in its viewRoles, and uploads, adds versions,
//   renames and moves in it when their role is in its uploadRoles (moving needs both folders).
//   The owner never uploads (no document.upload). Trashed files are shown to managers only.
// - Only the PM (document.folder_access) changes a folder's roles.
// - Every update matches the row's `version` (compare-and-set): when two people act at once, the
//   second gets STATE_CHANGED and reloads.
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
  // Revision impact (2026-11-27): the GC team follows up a new revision (who confirmed, reminders,
  // flagged pins still valid); each subcontractor company confirms it builds to the new revision.
  "drawing.follow_up_revision": [PM, SUPT, DC],
  "drawing.confirm_revision": [SUB],
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
  "submittal.review": [PM, DESIGN], // design: when assigned; the PM may decide for the design team
  "submittal.void": [PM],
  "submittal.comment": [PM, SUPT, DC, DESIGN, SUB], // subcontractors on their company's; the owner reads only
  "submittal.see_internal": [PM, SUPT, DC], // internal notes
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

// ---------- folders ----------
const VIEW_ALL_BUT_SUB = ["project-manager", "superintendent", "document-controller", "design-reviewer", "owner-viewer"];
// The standard folders every project gets (spec §3 matrix). PM and DC are always allowed.
const STANDARD_FOLDERS = [
  { key: "contracts", name: "Contracts", viewRoles: ["project-manager", "document-controller", "owner-viewer"], uploadRoles: [] },
  { key: "specifications", name: "Specifications", viewRoles: VIEW_ALL_BUT_SUB, uploadRoles: ["design-reviewer"] },
  { key: "permits", name: "Permits", viewRoles: VIEW_ALL_BUT_SUB, uploadRoles: [] },
  { key: "correspondence", name: "Correspondence", viewRoles: VIEW_ALL_BUT_SUB, uploadRoles: ["superintendent", "design-reviewer"] },
  { key: "minutes", name: "Meeting minutes", viewRoles: VIEW_ALL_BUT_SUB, uploadRoles: [] },
  { key: "site", name: "Site", viewRoles: [...VIEW_ALL_BUT_SUB, "field-user"], uploadRoles: ["superintendent"] },
  { key: "handover", name: "Handover", viewRoles: VIEW_ALL_BUT_SUB, uploadRoles: [] }
];
const MANAGERS = ["project-manager", "document-controller"];
const MAX_FOLDERS = 40;

// Spec §6 list, plus the older Office formats, jpeg and csv that sites still send.
const ALLOWED_EXT = ["pdf", "docx", "doc", "xlsx", "xls", "csv", "pptx", "dwg", "jpg", "jpeg", "png", "zip", "msg", "eml", "txt"];
const extOf = (name) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
};

const FOLDER_FIELDS = "ItemId projectId key name sortOrder version viewRoles uploadRoles createdByUserId createdAt isVoided";
const VERSION_FIELDS = "versions { versionNo fileId fileName contentType sizeBytes uploadedBy uploadedByName note uploadedAt restoredFrom }";
const DOC_FIELDS =
  "ItemId projectId folderId name nameKey ext contentType currentVersion sizeBytes version createdByUserId createdByCompanyId createdByName createdAt " +
  "updatedByUserId updatedByName updatedAt trashed trashedAt trashedByUserId trashedByName trashedFromFolderId " + VERSION_FIELDS;

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
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. Documents are open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const role = mine.role;
  const sees = projectCan(role, "document.view") || projectCan(role, "document.view_relevant");
  if (!sees) throw new Refused("NOT_ALLOWED", "Your project role doesn't include documents.");
  return { me, project, projectId: id, mine, role, archived, manager: projectCan(role, "document.manage") };
}

// The project's folders (the standard ones are created on first open). Two first opens at once can
// each create a set: the oldest-looking copy (lowest id) of each standard folder wins, and files
// put into a duplicate are shown in the winner (`alias`).
async function loadFolders(db, c) {
  let rows = await db.list("DocFolder", FOLDER_FIELDS, c.me.tenantRole, { projectId: c.projectId });
  if (!rows.length && !c.archived) {
    const now = new Date().toISOString();
    await Promise.all(STANDARD_FOLDERS.map((f, i) => db.insert("DocFolder", {
      tenantRole: c.me.tenantRole, projectId: c.projectId, key: f.key, name: f.name, sortOrder: (i + 1) * 10, version: 0,
      viewRoles: f.viewRoles, uploadRoles: f.uploadRoles, createdByUserId: c.me.userId, createdAt: now, isVoided: false
    })));
    rows = await db.list("DocFolder", FOLDER_FIELDS, c.me.tenantRole, { projectId: c.projectId });
  }
  rows = rows.filter((f) => !f.isVoided).sort((a, b) => String(a.ItemId).localeCompare(String(b.ItemId)));
  const alias = new Map();
  const byKey = new Map();
  const folders = [];
  for (const f of rows) {
    const winner = f.key ? byKey.get(f.key) : undefined;
    if (winner) {
      alias.set(f.ItemId, winner.ItemId);
      continue;
    }
    if (f.key) byKey.set(f.key, f);
    folders.push(f);
  }
  folders.sort((a, b) => Number(a.sortOrder ?? 999) - Number(b.sortOrder ?? 999) || String(a.name).localeCompare(String(b.name)));
  c.folders = folders;
  c.alias = alias;
  return folders;
}

const folderIdOf = (c, id) => c.alias.get(id) ?? id;
const canView = (f, c) => c.manager || (f.viewRoles ?? []).includes(c.role);
const canUpload = (f, c) =>
  !c.archived && (c.manager || (projectCan(c.role, "document.upload") && canView(f, c) && (f.uploadRoles ?? []).includes(c.role)));

function folderFor(c, folderId, { upload = false } = {}) {
  const f = c.folders.find((x) => x.ItemId === folderIdOf(c, String(folderId ?? "")));
  if (!f || !canView(f, c)) throw new Refused("NOT_FOUND", "This folder doesn't exist, or it isn't shared with your role.");
  if (upload && !canUpload(f, c)) {
    throw new Refused(c.archived ? "ARCHIVED" : "NOT_ALLOWED", c.archived ? "This project is archived and read-only." : `Your role can't add or change files in ${f.name}.`);
  }
  return f;
}

async function loadDocs(db, c) {
  const rows = await db.list("Document", DOC_FIELDS, c.me.tenantRole, { projectId: c.projectId });
  return rows.map((d) => ({ ...d, folderId: folderIdOf(c, d.folderId) }));
}

async function loadDoc(db, c, documentId) {
  const rows = await db.list("Document", DOC_FIELDS, c.me.tenantRole, { projectId: c.projectId, ItemId: String(documentId ?? "") });
  const d = rows[0];
  const f = d && c.folders.find((x) => x.ItemId === folderIdOf(c, d.folderId));
  if (!d || !f || !canView(f, c) || (d.trashed && !c.manager)) throw new Refused("NOT_FOUND", "This file doesn't exist, or you can't open it.");
  return { doc: { ...d, folderId: f.ItemId }, folder: f };
}

function present(d) {
  const { tenantRole: _t, nameKey: _k, searchText: _s, lastChange: _l, ...out } = d;
  out.versions = [...(d.versions ?? [])].sort((a, b) => Number(b.versionNo) - Number(a.versionNo));
  return out;
}

async function listing(db, c) {
  if (!c.folders) await loadFolders(db, c);
  const docs = await loadDocs(db, c);
  const visible = c.folders.filter((f) => canView(f, c));
  const ids = new Set(visible.map((f) => f.ItemId));
  const shown = docs.filter((d) => ids.has(d.folderId) && (!d.trashed || c.manager));
  // A link to each file's current version comes with the list, so opening or downloading needs no
  // second call (a call can wait half a minute in the queue). Links last an hour; the page asks
  // again (downloadLink) once linksExpireAt has passed, or for an older version.
  const currentFile = (d) => (d.versions ?? []).find((v) => Number(v.versionNo) === Number(d.currentVersion))?.fileId;
  let links = {};
  try {
    links = await db.downloadUrls(shown.filter((d) => !d.trashed).map(currentFile));
  } catch {
    links = {}; // the list still works; the page falls back to asking per file
  }
  return {
    ok: true,
    role: c.role,
    archived: c.archived,
    can: { manage: c.manager && !c.archived, folderAccess: projectCan(c.role, "document.folder_access") && !c.archived },
    folders: visible.map((f) => ({
      ItemId: f.ItemId,
      key: f.key || "",
      name: f.name,
      viewRoles: f.viewRoles ?? [],
      uploadRoles: f.uploadRoles ?? [],
      canUpload: canUpload(f, c)
    })),
    hiddenFolders: c.folders.length - visible.length,
    linksExpireAt: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
    documents: shown.map((d) => {
      const url = d.trashed ? undefined : links[currentFile(d)];
      return url ? { ...present(d), url } : present(d);
    })
  };
}

// ---------- writing ----------
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const actorName = (c) => c.mine.displayName || "Someone";
const searchTextOf = (d, folder) => [d.name, folder?.name].filter(Boolean).join(" ").toLowerCase();

async function saveDoc(db, c, d, changes, kind, extra = {}) {
  const version = Number(d.version ?? 0);
  const n = await db.updateWhere("Document", { ItemId: { eq: d.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    version: version + 1,
    lastChange: { kind, nonce: crypto.randomUUID(), actorUserId: c.me.userId, reason: extra.reason ?? "", before: extra.before ?? "", after: extra.after ?? "" }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just changed this file. The list has been reloaded; please try again.");
}

async function saveFolder(db, c, f, changes, kind) {
  const version = Number(f.version ?? 0);
  const n = await db.updateWhere("DocFolder", { ItemId: { eq: f.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    version: version + 1,
    lastChange: { kind, nonce: crypto.randomUUID(), actorUserId: c.me.userId }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just changed this folder. The list has been reloaded; please try again.");
}

function history(db, c, recordId, recordNumber, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType: extra.recordType ?? "document",
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

// A live file with this name in this folder (one live file per name per folder: a same-name upload
// becomes its next version).
const liveNamed = (docs, folderId, name, exceptId) =>
  docs.find((d) => !d.trashed && d.folderId === folderId && d.nameKey === String(name).toLowerCase() && d.ItemId !== exceptId);

function checkType(name) {
  const ext = extOf(name);
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Refused("FILE_TYPE_NOT_ALLOWED", `${safeFileName(name)}: .${ext || "?"} files can't go into Documents. Allowed: ${ALLOWED_EXT.join(", ")}.`);
  }
  return ext;
}

function versionOf(a, c, versionNo, note, restoredFrom) {
  return {
    versionNo,
    fileId: a.fileId,
    fileName: a.fileName,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    uploadedBy: c.me.userId,
    uploadedByName: actorName(c),
    note: text(note, 200),
    uploadedAt: new Date().toISOString(),
    ...(restoredFrom ? { restoredFrom } : {})
  };
}

// The file's name follows its current version's type: "Contract.docx" + a signed PDF -> "Contract.pdf".
function renamedFor(doc, ext) {
  if (doc.ext === ext) return doc.name;
  return `${doc.name.replace(/\.[^.]+$/, "")}.${ext}`;
}

async function appendVersion(db, c, doc, folder, v, kind) {
  const versions = [...(doc.versions ?? []), v];
  const ext = extOf(v.fileName);
  const name = renamedFor(doc, ext);
  await saveDoc(db, c, doc, {
    versions,
    currentVersion: v.versionNo,
    name,
    nameKey: name.toLowerCase(),
    ext,
    contentType: v.contentType,
    sizeBytes: v.sizeBytes,
    updatedByUserId: c.me.userId,
    updatedByName: actorName(c),
    updatedAt: v.uploadedAt,
    searchText: searchTextOf({ name }, folder)
  }, kind);
}

// ---------- actions ----------
async function list(db, me, args) {
  return listing(db, await projectContext(db, me, args.projectId));
}

async function uploadLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  await loadFolders(db, c);
  folderFor(c, args.folderId, { upload: true });
  for (const f of Array.isArray(args.files) ? args.files : []) checkType(f?.name);
  // Documents need no preview images: drop any the browser offers.
  const files = Array.isArray(args.files) ? args.files.map((f) => ({ name: f?.name, contentType: f?.contentType, sizeBytes: f?.sizeBytes })) : args.files;
  return { ok: true, uploads: await issueUploads(db, me, c.projectId, files, "document") };
}

async function addFiles(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  await loadFolders(db, c);
  const folder = folderFor(c, args.folderId, { upload: true });
  if (!Array.isArray(args.files) || !args.files.length) throw new Refused("NO_FILES", "Choose a file first.");
  if (args.files.length > 10) throw new Refused("TOO_MANY_FILES", "Add at most 10 files at a time.");
  const accepted = await acceptAttachments(db, me, c.projectId, args.files);
  for (const a of accepted) checkType(a.fileName);
  const docs = await loadDocs(db, c);
  const added = [];
  for (const a of accepted) {
    const existing = liveNamed(docs, folder.ItemId, a.fileName);
    if (existing) {
      const v = versionOf(a, c, Number(existing.currentVersion ?? existing.versions?.length ?? 1) + 1, args.note);
      await appendVersion(db, c, existing, folder, v, "version");
      existing.version = Number(existing.version ?? 0) + 1;
      existing.currentVersion = v.versionNo;
      existing.versions = [...(existing.versions ?? []), v];
      added.push({ name: existing.name, documentId: existing.ItemId, versionNo: v.versionNo });
      await history(db, c, existing.ItemId, existing.name, "version", `${actorName(c)} uploaded version ${v.versionNo} of ${existing.name} in ${folder.name}`);
      continue;
    }
    const v = versionOf(a, c, 1, args.note || "");
    const row = {
      tenantRole: me.tenantRole,
      projectId: c.projectId,
      folderId: folder.ItemId,
      name: a.fileName,
      nameKey: a.fileName.toLowerCase(),
      ext: extOf(a.fileName),
      contentType: a.contentType,
      currentVersion: 1,
      sizeBytes: a.sizeBytes,
      version: 0,
      versions: [v],
      createdByUserId: me.userId,
      createdByCompanyId: c.mine.companyId ?? "",
      createdByName: actorName(c),
      createdAt: v.uploadedAt,
      updatedByUserId: me.userId,
      updatedByName: actorName(c),
      updatedAt: v.uploadedAt,
      trashed: false,
      searchText: searchTextOf({ name: a.fileName }, folder)
    };
    const itemId = await db.insert("Document", row);
    docs.push({ ...row, ItemId: itemId });
    added.push({ name: a.fileName, documentId: itemId, versionNo: 1 });
    await history(db, c, itemId, a.fileName, "uploaded", `${actorName(c)} uploaded ${a.fileName} to ${folder.name}`);
  }
  return { ...(await listing(db, c)), added };
}

async function newVersion(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  await loadFolders(db, c);
  const { doc, folder } = await loadDoc(db, c, args.documentId);
  folderFor(c, folder.ItemId, { upload: true });
  if (doc.trashed) throw new Refused("TRASHED", "Restore the file from the trash first.");
  const [a] = await acceptAttachments(db, me, c.projectId, [args.file]);
  if (!a) throw new Refused("NO_FILES", "Choose a file first.");
  const ext = checkType(a.fileName);
  const clash = liveNamed(await loadDocs(db, c), folder.ItemId, renamedFor(doc, ext), doc.ItemId);
  if (clash) throw new Refused("NAME_TAKEN", `${clash.name} already exists in ${folder.name}. Rename one of them first.`);
  const v = versionOf(a, c, Number(doc.currentVersion ?? 1) + 1, args.note);
  await appendVersion(db, c, doc, folder, v, "version");
  await history(db, c, doc.ItemId, doc.name, "version", `${actorName(c)} uploaded version ${v.versionNo} of ${doc.name}${a.fileName !== doc.name ? ` (from ${a.fileName})` : ""}`);
  return listing(db, c);
}

async function restoreVersion(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  await loadFolders(db, c);
  const { doc, folder } = await loadDoc(db, c, args.documentId);
  folderFor(c, folder.ItemId, { upload: true });
  if (doc.trashed) throw new Refused("TRASHED", "Restore the file from the trash first.");
  const from = (doc.versions ?? []).find((v) => Number(v.versionNo) === Number(args.versionNo));
  if (!from) throw new Refused("NOT_FOUND", "That version doesn't exist.");
  if (Number(from.versionNo) === Number(doc.currentVersion)) throw new Refused("ALREADY_CURRENT", `Version ${from.versionNo} is already the current one.`);
  const ext = extOf(from.fileName);
  const clash = liveNamed(await loadDocs(db, c), folder.ItemId, renamedFor(doc, ext), doc.ItemId);
  if (clash) throw new Refused("NAME_TAKEN", `${clash.name} already exists in ${folder.name}. Rename one of them first.`);
  const v = versionOf(from, c, Number(doc.currentVersion ?? 1) + 1, `Restored from version ${from.versionNo}`, Number(from.versionNo));
  await appendVersion(db, c, doc, folder, v, "restoreVersion");
  await history(db, c, doc.ItemId, doc.name, "version restored", `${actorName(c)} made version ${from.versionNo} of ${doc.name} current again (as version ${v.versionNo})`);
  return listing(db, c);
}

async function rename(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  await loadFolders(db, c);
  const { doc, folder } = await loadDoc(db, c, args.documentId);
  folderFor(c, folder.ItemId, { upload: true });
  if (doc.trashed) throw new Refused("TRASHED", "Restore the file from the trash first.");
  const stem = safeFileName(String(args.name ?? "").replace(/\.[^.]+$/, "")).replace(/\.+$/, "").trim();
  if (!stem) throw new Refused("BAD_NAME", "Enter a file name.");
  const name = `${stem.slice(0, 110)}.${doc.ext}`;
  if (name === doc.name) return listing(db, c);
  const clash = liveNamed(await loadDocs(db, c), folder.ItemId, name, doc.ItemId);
  if (clash) throw new Refused("NAME_TAKEN", `${clash.name} already exists in ${folder.name}.`);
  await saveDoc(db, c, doc, { name, nameKey: name.toLowerCase(), searchText: searchTextOf({ name }, folder) }, "rename", { before: doc.name, after: name });
  await history(db, c, doc.ItemId, name, "renamed", `${actorName(c)} renamed ${doc.name} to ${name}`, { before: { name: doc.name }, after: { name } });
  return listing(db, c);
}

async function move(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  await loadFolders(db, c);
  const { doc, folder } = await loadDoc(db, c, args.documentId);
  folderFor(c, folder.ItemId, { upload: true });
  const to = folderFor(c, args.folderId, { upload: true });
  if (doc.trashed) throw new Refused("TRASHED", "Restore the file from the trash first.");
  if (to.ItemId === folder.ItemId) return listing(db, c);
  const clash = liveNamed(await loadDocs(db, c), to.ItemId, doc.name, doc.ItemId);
  if (clash) throw new Refused("NAME_TAKEN", `${to.name} already has a file called ${doc.name}. Rename one of them first.`);
  await saveDoc(db, c, doc, { folderId: to.ItemId, searchText: searchTextOf(doc, to) }, "move", { before: folder.name, after: to.name });
  await history(db, c, doc.ItemId, doc.name, "moved", `${actorName(c)} moved ${doc.name} from ${folder.name} to ${to.name}`, { before: { folder: folder.name }, after: { folder: to.name } });
  return listing(db, c);
}

async function trash(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller moves files to the trash.");
  await loadFolders(db, c);
  const { doc, folder } = await loadDoc(db, c, args.documentId);
  if (doc.trashed) return listing(db, c);
  await saveDoc(db, c, doc, {
    trashed: true, trashedAt: new Date().toISOString(), trashedByUserId: me.userId, trashedByName: actorName(c), trashedFromFolderId: folder.ItemId
  }, "trash");
  await history(db, c, doc.ItemId, doc.name, "trashed", `${actorName(c)} moved ${doc.name} from ${folder.name} to the trash`);
  return listing(db, c);
}

async function restore(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller restores files from the trash.");
  await loadFolders(db, c);
  const { doc, folder } = await loadDoc(db, c, args.documentId);
  if (!doc.trashed) return listing(db, c);
  const clash = liveNamed(await loadDocs(db, c), folder.ItemId, doc.name, doc.ItemId);
  if (clash) throw new Refused("NAME_TAKEN", `${folder.name} already has a file called ${doc.name}. Rename that one first.`);
  await saveDoc(db, c, doc, { trashed: false, trashedByUserId: "", trashedByName: "" }, "restore");
  await history(db, c, doc.ItemId, doc.name, "restored", `${actorName(c)} restored ${doc.name} to ${folder.name}`);
  return listing(db, c);
}

// Roles from the screen -> what is stored: PM and DC always; uploaders must also see the folder;
// the owner never uploads.
function cleanRoles(viewRoles, uploadRoles) {
  if (!Array.isArray(viewRoles) || !Array.isArray(uploadRoles)) throw new Refused("BAD_ROLES", "Choose who can view and who can upload.");
  const view = [...new Set([...MANAGERS, ...viewRoles.map(String)])].filter((r) => PROJECT_ROLES.includes(r));
  const upload = [...new Set(uploadRoles.map(String))].filter((r) => PROJECT_ROLES.includes(r) && !MANAGERS.includes(r));
  for (const r of upload) {
    if (!projectCan(r, "document.upload")) throw new Refused("BAD_ROLES", "The owner reads documents but can't upload them.");
    if (!view.includes(r)) throw new Refused("BAD_ROLES", "Someone who uploads into a folder must also see it.");
  }
  return { viewRoles: PROJECT_ROLES.filter((r) => view.includes(r)), uploadRoles: PROJECT_ROLES.filter((r) => upload.includes(r)) };
}

async function createFolder(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager or the document controller creates folders.");
  await loadFolders(db, c);
  const name = text(args.name, 60).replace(/\s+/g, " ");
  if (!name) throw new Refused("BAD_NAME", "Enter a folder name.");
  if (/[\\/]/.test(name)) throw new Refused("BAD_NAME", "Folder names can't contain slashes.");
  if (c.folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) throw new Refused("NAME_TAKEN", `There is already a folder called ${name}.`);
  if (c.folders.length >= MAX_FOLDERS) throw new Refused("TOO_MANY_FOLDERS", `A project has at most ${MAX_FOLDERS} folders.`);
  const roles = cleanRoles(args.viewRoles, args.uploadRoles);
  const now = new Date().toISOString();
  const sortOrder = Math.max(0, ...c.folders.map((f) => Number(f.sortOrder ?? 0))) + 10;
  const folderId = await db.insert("DocFolder", {
    tenantRole: me.tenantRole, projectId: c.projectId, key: "", name, sortOrder, version: 0, ...roles, createdByUserId: me.userId, createdAt: now, isVoided: false
  });
  await history(db, c, folderId, name, "folder created", `${actorName(c)} created the folder ${name}`, { recordType: "document-folder", after: roles });
  c.folders = undefined;
  return { ...(await listing(db, c)), folderId };
}

async function setFolderAccess(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!projectCan(c.role, "document.folder_access")) throw new Refused("NOT_ALLOWED", "Only the project manager changes who can see a folder.");
  await loadFolders(db, c);
  const f = folderFor(c, args.folderId);
  const roles = cleanRoles(args.viewRoles, args.uploadRoles);
  const before = { viewRoles: f.viewRoles ?? [], uploadRoles: f.uploadRoles ?? [] };
  await saveFolder(db, c, f, roles, "access");
  await history(db, c, f.ItemId, f.name, "folder access changed", `${actorName(c)} changed who can see and upload in ${f.name}`, { recordType: "document-folder", before, after: roles });
  c.folders = undefined;
  return listing(db, c);
}

async function downloadLink(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  await loadFolders(db, c);
  const { doc } = await loadDoc(db, c, args.documentId);
  const want = args.versionNo === undefined ? Number(doc.currentVersion) : Number(args.versionNo);
  const v = (doc.versions ?? []).find((x) => Number(x.versionNo) === want);
  if (!v) throw new Refused("NOT_FOUND", "That version doesn't exist.");
  const links = await db.downloadUrls([v.fileId]);
  const url = links[v.fileId];
  if (!url) throw new Refused("NO_LINK", "The file couldn't be fetched right now. Please try again.");
  const stem = doc.name.replace(/\.[^.]+$/, "");
  const ext = extOf(v.fileName) || doc.ext;
  const fileName = Number(v.versionNo) === Number(doc.currentVersion) ? doc.name : `${stem}_v${v.versionNo}.${ext}`;
  return { ok: true, url, fileName, contentType: v.contentType ?? "" };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "documents", {
    list: (args, { db, me }) => list(db, me, args),
    uploadLinks: (args, { db, me }) => uploadLinks(db, me, args),
    addFiles: (args, { db, me }) => addFiles(db, me, args),
    newVersion: (args, { db, me }) => newVersion(db, me, args),
    restoreVersion: (args, { db, me }) => restoreVersion(db, me, args),
    rename: (args, { db, me }) => rename(db, me, args),
    move: (args, { db, me }) => move(db, me, args),
    trash: (args, { db, me }) => trash(db, me, args),
    restore: (args, { db, me }) => restore(db, me, args),
    createFolder: (args, { db, me }) => createFolder(db, me, args),
    setFolderAccess: (args, { db, me }) => setFolderAccess(db, me, args),
    downloadLink: (args, { db, me }) => downloadLink(db, me, args)
  });
}
