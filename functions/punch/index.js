// Punch list, part 1: the server (docs/architecture/06-punch-list.md; permissions in
// functions/_shared/permissions.js). Every PunchItem and its comments are read and written only
// here: the Data Gateway rules let only the service identity touch them, because a rule can't see a
// person's role or company on ONE project.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list", projectId }                       -> { items, role, can, companies, suggestions, today }
//   { action: "get", projectId, itemId }                -> detail
//   { action: "create", projectId, clientRequestId, title, description?, assigneeCompanyId,
//     assigneeUserId?, priority?, dueDate?, location?, trade?, withPhoto?,
//     pin?: { sheetId, revisionIndex, x, y } }          -> detail (+ created: true | false)
//   { action: "edit", projectId, itemId, version?, changes: { title?, description?, location?,
//     priority?, dueDate?, trade? } }                   -> detail
//   { action: "reassign", projectId, itemId, assigneeCompanyId, assigneeUserId? } -> detail
//   { action: "start" | "markReady" | "close", projectId, itemId }                -> detail
//   { action: "sendBack" | "reopen" | "void", projectId, itemId, reason }         -> detail
//   { action: "comment", projectId, itemId, body }                                -> detail
//   { action: "bulk", projectId, itemIds (1..50), op: "reassign" | "setDue" | "start" | "markReady" |
//     "close" | "void", assigneeCompanyId?, assigneeUserId?, dueDate?, reason? }
//                                                       -> { updated: [itemId], rejected: [{ itemId, number, code, error }] }
// detail = { item, can, photos, pin, comments, history }. Every change answers with the fresh detail.
// Pins (part 3): an item's place on a drawing is its live Pin row (not voided, on the sheet's
// current revision). Pins are placed, moved and removed in the sheet viewer (drawings Function), so
// `item.sheetId`, `item.pinId` and `item.sheetNumber` are read from the Pin and Sheet rows, and the
// detail adds `pin` with the sheet's thumbnail and the spot on it.
// Notifications (part 4, 06 §7): marked ready, sent back / reopened and closed are told right away
// (tellPunch); new and reassigned items wait for the 15-minute pass, which also sends the daily
// overdue digest (runNotices, started only by the `punch-notices` workflow or a project admin's
// `blocks logic function test` with { action: "notices", dryRun?, anyTime? }).
//
// Status flow (06 §5): open -> inProgress -> readyForReview -> closed, plus void.
// - Start and Mark ready: the general contractor (PM, superintendent) or the assigned company.
//   Mark ready needs an after photo.
// - Close: the general contractor only, with an after photo (they may take it themselves).
// - Send back (from ready) and Reopen (from closed): the general contractor, with a reason; the
//   item goes back to In progress and needs a NEW after photo.
// - Void: the PM, or the creator while the item is still open, with a reason.
// Photos are Photo records linked to the item (linkRole before | after), added through the photos
// Function (part 2); this Function only reads them.
// Ball in court: open / in progress -> the assigned person (or the company's first field user);
// ready for review -> the verifier (the creator while they are still a PM or superintendent on the
// project, else the first project manager); closed / void -> nobody.
//
// Security:
// - The caller must be an active member of the project with a punch permission. Subcontractors
//   (punch_item.view_assigned) see only items assigned to their company or created by them.
// - Every update matches the row's `version` (compare-and-set): when two people act at once, the
//   second gets STATE_CHANGED and reloads.
// Never returns or logs a token.

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["open", "inProgress", "readyForReview", "closed", "void"];
const ACTIVE = ["open", "inProgress", "readyForReview"];
const PRIORITIES = ["low", "normal", "high"];
const STATUS_LABEL = { open: "open", inProgress: "in progress", readyForReview: "ready for review", closed: "closed", void: "void" };
const DEFAULT_DUE_WORKING_DAYS = 7;
const BULK_MAX = 50;
const BULK_OPS = ["reassign", "setDue", "start", "markReady", "close", "void"];
const LINKED_IN_LIST = 300; // items whose thumbnails come with the list
const LINK_MINUTES = 50;

const ITEM_FIELDS =
  "ItemId projectId number seq version clientRequestId title description status priority trade location dueDate " +
  "assigneeCompanyId assigneeUserId assigneeCompanyName assigneeName ballInCourtUserId ballInCourtName ballInCourtRole " +
  "createdByUserId createdByCompanyId createdByName createdAt startedAt readyAt closedAt readyByUserId closedByUserId " +
  "reopenCount lastRejectReason afterPhotoSince photoExpected sheetId pinId notifyPending notifyPendingSince " +
  "isVoided voidedAt voidedByUserId voidReason";
const TEAM_FIELDS = "ItemId userId displayName email companyId companyName companyRelation trade role status joinedAt";
const PHOTO_FIELDS = "ItemId linkedRecordType linkedRecordId linkRole fileId previewFileId thumbFileId caption takenAt uploadedAt uploadedByUserId uploadedByName isVoided";
const COMMENT_FIELDS = "ItemId recordId body authorUserId authorCompanyId authorName postedAt isVoided";
const EVENT_FIELDS = "ItemId recordId action actorUserId actorName at summary reason fromStatus toStatus";
const PIN_FIELDS = "ItemId sheetId x y linkedRecordId toRevisionIndex isVoided createdAt";
const SHEET_FIELDS = "ItemId sheetNumber title isVoided currentThumbFileId currentRevisionLabel";

// ---------- small helpers ----------
const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const longText = (v, max) => String(v ?? "").trim().slice(0, max);
const expiry = () => new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
const actor = (c) => c.mine.displayName || "Someone";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- dates (project timezone, weekends only; public holidays come with the calendar) ----------
function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const isWeekend = (iso) => weekday(iso) === 0 || weekday(iso) === 6;
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextWorkingDay(iso) {
  let d = iso;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}
function addWorkingDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d)) left -= 1;
  }
  return d;
}

// ---------- who is asking, on which project ----------
async function projectContext(db, me, projectId, { write = false } = {}) {
  const id = String(projectId ?? "");
  if (!id) throw new Refused("NOT_FOUND", "Choose a project first.");
  const [projects, team] = await Promise.all([
    db.list("Project", "ItemId number name status timezone settings { punchDefaultDueDays }", me.tenantRole, { ItemId: id }),
    db.list("ProjectMember", TEAM_FIELDS, me.tenantRole, { projectId: id })
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  const active = team.filter((r) => r.status === "active");
  const mine = active.find((r) => r.userId === me.userId);
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. The punch list is open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const role = mine.role;
  const seesAll = projectCan(role, "punch_item.view");
  const seesAssigned = projectCan(role, "punch_item.view_assigned");
  if (!seesAll && !seesAssigned) throw new Refused("NOT_ALLOWED", "Your project role doesn't include the punch list.");
  return {
    me,
    project,
    projectId: id,
    active,
    mine,
    role,
    archived,
    today: todayIn(project.timezone),
    seesAll,
    seesAssigned,
    creator: projectCan(role, "punch_item.create"),
    assigner: projectCan(role, "punch_item.assign"),
    gc: projectCan(role, "punch_item.close"),
    worker: projectCan(role, "punch_item.update_assigned"),
    voider: projectCan(role, "punch_item.void")
  };
}

const memberOf = (c, userId) => c.active.find((r) => r.userId === userId);

// ---------- visibility and what the caller may do ----------
const ownCompany = (item, c) => Boolean(item.assigneeCompanyId) && item.assigneeCompanyId === c.mine.companyId;

function canSee(item, c) {
  if (c.seesAll) return true;
  if (c.seesAssigned) return ownCompany(item, c) || item.createdByUserId === c.me.userId;
  return false;
}

// Photos linked to items: { before: [], after: [] } per item id, newest first. After photos count
// only from `afterPhotoSince` (sending an item back asks for a new one).
function photosByItem(photos) {
  const m = new Map();
  for (const p of photos) {
    if (p.isVoided || p.linkedRecordType !== "punchItem") continue;
    if (!m.has(p.linkedRecordId)) m.set(p.linkedRecordId, []);
    m.get(p.linkedRecordId).push(p);
  }
  for (const list of m.values()) list.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  return m;
}
function photoSummary(item, list = []) {
  const since = String(item.afterPhotoSince ?? "");
  const before = list.filter((p) => p.linkRole !== "after");
  const after = list.filter((p) => p.linkRole === "after" && String(p.uploadedAt ?? "") >= since);
  return { before, after };
}

function abilities(item, c, photos) {
  const s = item.status;
  const open = !c.archived;
  const live = open && ACTIVE.includes(s);
  const work = c.gc || (c.worker && ownCompany(item, c));
  const hasAfter = photos.after.length > 0;
  return {
    edit: live && c.assigner,
    reassign: live && c.assigner,
    start: open && s === "open" && work,
    markReady: open && (s === "open" || s === "inProgress") && work,
    close: live && c.gc,
    sendBack: open && s === "readyForReview" && c.gc,
    reopen: open && s === "closed" && c.gc,
    void: live && (c.voider || (s === "open" && c.creator && item.createdByUserId === c.me.userId)),
    comment: open && s !== "void" && work,
    addBeforePhoto: live && (c.creator || c.assigner),
    addAfterPhoto: open && (s === "open" || s === "inProgress") && work,
    hasAfterPhoto: hasAfter
  };
}

// ---------- the assigned company and the ball ----------
// The field users of a company on this project, the longest on the team first.
function fieldUsersOf(c, companyId) {
  return c.active
    .filter((m) => m.companyId === companyId && m.role === "field-user")
    .sort((a, b) => String(a.joinedAt ?? "").localeCompare(String(b.joinedAt ?? "")) || String(a.displayName ?? "").localeCompare(String(b.displayName ?? "")));
}

// The companies an item can go to: every company with a field user on the team.
function companiesOf(c) {
  const out = new Map();
  for (const m of c.active) {
    if (m.role !== "field-user" || !m.companyId) continue;
    if (!out.has(m.companyId)) out.set(m.companyId, { companyId: m.companyId, companyName: m.companyName ?? "", trade: m.trade ?? "", people: [] });
    out.get(m.companyId).people.push({ userId: m.userId, displayName: m.displayName ?? "" });
  }
  return [...out.values()].sort((a, b) => a.companyName.localeCompare(b.companyName));
}

function assignment(c, companyId, userId) {
  const company = String(companyId ?? "");
  const people = company ? fieldUsersOf(c, company) : [];
  if (!people.length) throw new Refused("COMPANY_NOT_ON_PROJECT", "Choose a subcontractor that has people on this project's team.");
  let person;
  if (userId) {
    person = people.find((m) => m.userId === String(userId));
    if (!person) throw new Refused("ASSIGNEE_NOT_IN_COMPANY", "The person must be a field user of that company on this project.");
  }
  return {
    assigneeCompanyId: company,
    assigneeCompanyName: people[0].companyName ?? "",
    assigneeUserId: person?.userId ?? "",
    assigneeName: person?.displayName ?? "",
    tradeOfCompany: people.find((m) => m.trade)?.trade ?? ""
  };
}

const NO_BALL = { ballInCourtUserId: "", ballInCourtName: "", ballInCourtRole: "none" };

// Open and in progress: the named person, else the company's first field user.
function assigneeBall(c, item) {
  const named = item.assigneeUserId ? memberOf(c, item.assigneeUserId) : undefined;
  const m = named && named.companyId === item.assigneeCompanyId ? named : fieldUsersOf(c, item.assigneeCompanyId)[0];
  return m ? { ballInCourtUserId: m.userId, ballInCourtName: m.displayName ?? "", ballInCourtRole: "assignee" } : NO_BALL;
}

// Ready for review: the creator while they still verify on this project, else the first PM.
function verifierBall(c, item) {
  const creator = memberOf(c, item.createdByUserId);
  const m = creator && projectCan(creator.role, "punch_item.close") ? creator : c.active.find((x) => x.role === "project-manager");
  return m ? { ballInCourtUserId: m.userId, ballInCourtName: m.displayName ?? "", ballInCourtRole: "verifier" } : NO_BALL;
}

// ---------- input ----------
function dueDateOf(c, v, { required }) {
  const d = String(v ?? "").trim();
  if (!d) {
    if (required) throw new Refused("BAD_DUE_DATE", "Choose a due date.");
    return "";
  }
  if (!DATE.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`))) throw new Refused("BAD_DUE_DATE", "Enter a valid due date.");
  const due = nextWorkingDay(d);
  if (due < c.today) throw new Refused("DUE_DATE_IN_PAST", "The due date can't be in the past.");
  return due;
}

function defaultDue(c) {
  const n = Number(c.project.settings?.punchDefaultDueDays);
  return addWorkingDays(c.today, Number.isInteger(n) && n > 0 && n <= 60 ? n : DEFAULT_DUE_WORKING_DAYS);
}

// The fields people type. `base` is the item being edited ({} for a new one).
function itemInput(args, base, c) {
  const has = (k) => args[k] !== undefined;
  const v = {
    title: has("title") ? text(args.title, 140) : base.title ?? "",
    description: has("description") ? longText(args.description, 2000) : base.description ?? "",
    priority: has("priority") ? String(args.priority) : base.priority ?? "normal",
    location: has("location") ? text(args.location, 120) : base.location ?? "",
    trade: has("trade") ? text(args.trade, 60) : base.trade ?? ""
  };
  if (v.title.length < 3) throw new Refused("BAD_TITLE", "Say what's wrong (at least 3 characters).");
  if (!PRIORITIES.includes(v.priority)) throw new Refused("BAD_PRIORITY", "Choose a priority: low, normal or high.");
  if (has("dueDate")) v.dueDate = dueDateOf(c, args.dueDate, { required: Boolean(base.ItemId) });
  return v;
}

const searchTextOf = (i) => [i.number, i.title, i.location, i.assigneeCompanyName, i.assigneeName].filter(Boolean).join(" ").toLowerCase();

// ---------- reading ----------
async function loadItems(db, c, where = {}) {
  return db.list("PunchItem", ITEM_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where });
}

async function loadItem(db, c, itemId) {
  const [item] = await loadItems(db, c, { ItemId: String(itemId ?? "") });
  if (!item || !canSee(item, c)) throw new Refused("NOT_FOUND", "This punch item doesn't exist, or you can't open it.");
  return item;
}

async function loadPhotos(db, c, itemId) {
  const where = { projectId: c.projectId, linkedRecordType: "punchItem", ...(itemId ? { linkedRecordId: itemId } : {}) };
  return db.list("Photo", PHOTO_FIELDS, c.me.tenantRole, where).catch(() => []);
}

// Where items are on the drawings: item id -> { pin, sheet } for live pins on sheets that still exist.
async function placesOf(db, c, itemId) {
  const pins = await db.list("Pin", PIN_FIELDS, c.me.tenantRole, { projectId: c.projectId, linkedRecordType: "punchItem", ...(itemId ? { linkedRecordId: itemId } : {}) }).catch(() => []);
  const live = pins.filter((p) => !p.isVoided && !Number(p.toRevisionIndex)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!live.length) return new Map();
  const sheetIds = [...new Set(live.map((p) => p.sheetId))];
  const sheets = sheetIds.length === 1
    ? await db.list("Sheet", SHEET_FIELDS, c.me.tenantRole, { projectId: c.projectId, ItemId: sheetIds[0] }).catch(() => [])
    : await db.list("Sheet", SHEET_FIELDS, c.me.tenantRole, { projectId: c.projectId }).catch(() => []);
  const sheetById = new Map(sheets.filter((x) => !x.isVoided).map((x) => [x.ItemId, x]));
  const out = new Map();
  for (const pin of live) {
    const sheet = sheetById.get(pin.sheetId);
    if (sheet && !out.has(pin.linkedRecordId)) out.set(pin.linkedRecordId, { pin, sheet });
  }
  return out;
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

function present(item, c, photos, links = {}, place) {
  const { tenantRole: _t, clientRequestId: _r, notifyPending: _n, notifyPendingSince: _s, ...out } = item;
  const firstBefore = photos.before[photos.before.length - 1];
  const lastAfter = photos.after[0];
  return {
    ...out,
    sheetId: place?.sheet.ItemId ?? "",
    pinId: place?.pin.ItemId ?? "",
    sheetNumber: place?.sheet.sheetNumber ?? "",
    reopenCount: Number(item.reopenCount ?? 0),
    overdue: ACTIVE.includes(item.status) && Boolean(item.dueDate) && item.dueDate < c.today,
    beforePhotos: photos.before.length,
    afterPhotos: photos.after.length,
    photoMissing: Boolean(item.photoExpected) && !photos.before.length && !place,
    beforeThumbUrl: firstBefore ? links[firstBefore.thumbFileId] ?? undefined : undefined,
    afterThumbUrl: lastAfter ? links[lastAfter.thumbFileId] ?? undefined : undefined
  };
}

async function detail(db, c, itemOrId) {
  const item = typeof itemOrId === "string" ? await loadItem(db, c, itemOrId) : itemOrId;
  const [photoRows, comments, events, places] = await Promise.all([
    loadPhotos(db, c, item.ItemId),
    db.list("Comment", COMMENT_FIELDS, c.me.tenantRole, { projectId: c.projectId, recordId: item.ItemId }).catch(() => []),
    db.list("ActivityEvent", EVENT_FIELDS, c.me.tenantRole, { projectId: c.projectId, recordId: item.ItemId }).catch(() => []),
    placesOf(db, c, item.ItemId)
  ]);
  const place = places.get(item.ItemId);
  const photos = photoSummary(item, photosByItem(photoRows).get(item.ItemId));
  const shown = [...photos.before, ...photos.after];
  const links = await linksFor(db, [...shown.flatMap((p) => [p.thumbFileId, p.previewFileId || p.fileId]), place?.sheet.currentThumbFileId]);
  const photoView = (p, role) => ({
    ItemId: p.ItemId,
    role,
    caption: p.caption ?? "",
    takenAt: p.takenAt,
    uploadedAt: p.uploadedAt,
    uploadedByName: p.uploadedByName ?? "",
    thumbUrl: links[p.thumbFileId] ?? undefined,
    previewUrl: links[p.previewFileId || p.fileId] ?? undefined
  });
  return {
    ok: true,
    role: c.role,
    today: c.today,
    linksExpireAt: expiry(),
    item: present(item, c, photos, links, place),
    can: abilities(item, c, photos),
    pin: place
      ? {
          pinId: place.pin.ItemId,
          sheetId: place.sheet.ItemId,
          sheetNumber: place.sheet.sheetNumber ?? "",
          sheetTitle: place.sheet.title ?? "",
          revisionLabel: place.sheet.currentRevisionLabel ?? "",
          x: Number(place.pin.x),
          y: Number(place.pin.y),
          thumbUrl: links[place.sheet.currentThumbFileId] ?? undefined
        }
      : null,
    photos: [...photos.before.map((p) => photoView(p, "before")), ...photos.after.map((p) => photoView(p, "after"))],
    comments: comments
      .filter((x) => !x.isVoided)
      .sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)))
      .map((x) => ({ ItemId: x.ItemId, body: x.body, authorUserId: x.authorUserId, authorName: x.authorName ?? "", postedAt: x.postedAt })),
    history: events
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((e) => ({ ItemId: e.ItemId, action: e.action, actorName: e.actorName, at: e.at, summary: e.summary, reason: e.reason, fromStatus: e.fromStatus, toStatus: e.toStatus }))
  };
}

// Recent titles (the caller's own first) and locations, for the quick-create chips.
function suggestionsOf(items, c) {
  const newest = [...items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const uniq = (list) => [...new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean))];
  return {
    titles: uniq([...newest.filter((i) => i.createdByUserId === c.me.userId).map((i) => i.title), ...newest.map((i) => i.title)]).slice(0, 8),
    locations: uniq(newest.map((i) => i.location)).slice(0, 12),
    lastCompanyId: newest.find((i) => i.createdByUserId === c.me.userId)?.assigneeCompanyId ?? ""
  };
}

async function list(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const [rows, photoRows, places] = await Promise.all([loadItems(db, c), loadPhotos(db, c), placesOf(db, c)]);
  const visible = rows.filter((i) => canSee(i, c)).sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0));
  const byItem = photosByItem(photoRows);
  const summaries = new Map(visible.map((i) => [i.ItemId, photoSummary(i, byItem.get(i.ItemId))]));
  const head = visible.filter((i) => !i.isVoided).slice(0, LINKED_IN_LIST);
  const links = await linksFor(db, head.flatMap((i) => {
    const s = summaries.get(i.ItemId);
    return [s.before[s.before.length - 1]?.thumbFileId, s.after[0]?.thumbFileId];
  }));
  return {
    ok: true,
    role: c.role,
    archived: c.archived,
    today: c.today,
    linksExpireAt: expiry(),
    can: {
      create: !c.archived && c.creator,
      bulk: !c.archived && c.assigner,
      void: !c.archived && c.voider,
      seesAllCompanies: c.seesAll
    },
    defaultDueDate: defaultDue(c),
    companies: c.creator || c.assigner ? companiesOf(c) : [],
    suggestions: suggestionsOf(visible, c),
    items: visible.map((i) => present(i, c, summaries.get(i.ItemId), links, places.get(i.ItemId)))
  };
}

async function get(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  return detail(db, c, String(args.itemId ?? ""));
}

// ---------- telling people (part 4; 06-punch-list.md §7) ----------
// Right away, from the change itself:
// - marked ready -> the verifier (who holds the ball now): bell + email;
// - sent back / reopened -> the assigned company's people on the project: bell + email, with the reason;
// - closed -> the assigned company's people: bell only.
// - new item, or moved to another company -> that company's people on the project: bell + email.
//   This is the "on save" mode (the default since 25 Nov 2026), because Blocks doesn't let the
//   15-minute workflow read the service secret (blocks-study E2), so the batch never ran. Set the
//   Function variable PUNCH_ASSIGNED_NOTICE=batch to go back to the 15-minute pass (runNotices),
//   which sends one notice per company so a walkthrough of 20 items is one message, not 20.
// A bulk change sends one notice per person ("4 punch items were closed"). Emails follow the person's settings (email off = bell only;
// the overdue digest also follows "reminder emails").
const PREF_FIELDS = "ItemId userId emailEnabled reminderEmails";
const html = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shortDate = (iso) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`));
  } catch {
    return String(iso);
  }
};
const OP_EVENT = { markReady: "markedReady", sendBack: "sentBack", reopen: "reopened", close: "closed" };
const MANY = {
  markedReady: "are ready for your check",
  sentBack: "were sent back: new after photos are needed",
  reopened: "were reopened: new after photos are needed",
  closed: "were closed",
  assigned: "were assigned to your company"
};
const itemLink = (projectId, item) => `/punch/${item.ItemId}?project=${projectId}`;
const listLink = (projectId, extra = "") => `/punch?project=${projectId}${extra}`;
const headOf = (item) => `${item.title}${item.location ? ` · ${item.location}` : ""}`;
function numbersOf(items, max = 8) {
  const shown = items.slice(0, max).map((i) => i.number).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

// The assigned company's people on this project (its field users), the named assignee first.
function companyPeople(c, item) {
  const people = fieldUsersOf(c, item.assigneeCompanyId);
  const named = people.find((m) => m.userId === item.assigneeUserId);
  return named ? [named, ...people.filter((m) => m !== named)] : people;
}

// What one change tells, and to whom.
function noticeFor(c, item, event, extra = {}) {
  const head = headOf(item);
  if (event === "markedReady") {
    return { kind: "ready", to: [memberOf(c, item.ballInCourtUserId)], title: `${item.number} is ready for your check`, body: `${head} · ${item.assigneeCompanyName} · marked ready by ${actor(c)}`, email: true };
  }
  if (event === "sentBack" || event === "reopened") {
    const why = extra.reason ? ` · “${String(extra.reason).slice(0, 200)}”` : "";
    return {
      kind: "rejected",
      to: companyPeople(c, item),
      title: `${item.number} was ${event === "sentBack" ? "sent back" : "reopened"}: a new after photo is needed`,
      body: `${head} · by ${actor(c)}${why}`,
      email: true
    };
  }
  if (event === "closed") return { kind: "closed", to: companyPeople(c, item), title: `${item.number} was closed`, body: `${head} · closed by ${actor(c)}`, email: false };
  if (event === "assigned") {
    const company = item.assigneeCompanyName || "your company";
    return {
      kind: "assigned",
      to: companyPeople(c, item),
      title: `New punch item ${item.number} for ${company}`,
      body: `${head}${item.dueDate ? ` · due ${shortDate(item.dueDate)}` : ""} · from ${actor(c)}`,
      email: true
    };
  }
  return null;
}

// Sends prepared messages ({ m: team member, kind, title, body, link, email }): one bell call per
// identical message, one email per person (never a shared "to" list).
async function deliver(db, project, messages, result, { reminder = false } = {}) {
  if (!messages.length) return;
  const prefs = await db.list("NotificationPreference", PREF_FIELDS, project.tenantRole).catch(() => []);
  // One row per person; if two were ever made, the first by id counts (as in the rfis Function).
  const firstPref = new Map();
  for (const x of [...prefs].sort((a, b) => String(a.ItemId).localeCompare(String(b.ItemId)))) if (!firstPref.has(x.userId)) firstPref.set(x.userId, x);
  const emailsOn = (u) => firstPref.get(u)?.emailEnabled !== false && (!reminder || firstPref.get(u)?.reminderEmails !== false);
  const groups = new Map();
  for (const x of messages) {
    const key = `${x.kind}\n${x.title}\n${x.body}\n${x.link}`;
    if (!groups.has(key)) groups.set(key, { x, users: [] });
    groups.get(key).users.push(x.m.userId);
  }
  const tasks = [];
  for (const { x, users } of groups.values()) {
    tasks.push(db.notify(users, { title: x.title, body: x.body, link: x.link, projectId: project.ItemId, kind: `punch.${x.kind}` }).then(() => { result.bell += users.length; }));
  }
  for (const x of messages) {
    if (!x.email || !x.m.email || !emailsOn(x.m.userId)) continue;
    const subject = `${project.number ? `[${project.number}] ` : ""}${x.title}`;
    tasks.push(db.mail(x.m.email, subject, {
      DisplayName: html(x.m.displayName || ""),
      Heading: html(x.title),
      Text: html(x.body),
      ProjectName: html(project.name || ""),
      ButtonLabel: x.link.startsWith("/punch/") ? "Open the punch item" : "Open the punch list",
      ButtonUrl: `${db.appUrl}${x.link}`,
      SettingsUrl: `${db.appUrl}/inbox?tab=settings`
    }).then(() => { result.email += 1; }));
  }
  for (const r of await Promise.allSettled(tasks)) if (r.status === "rejected") result.failed.push(String(r.reason?.message ?? r.reason).slice(0, 200));
}

// Tells what changes did: events = [{ item (saved), event, extra? }]. Never fails the change.
async function tellPunch(db, c, events) {
  const result = { bell: 0, email: 0, failed: [] };
  try {
    const per = new Map();
    for (const { item, event, extra } of events) {
      const n = noticeFor(c, item, event, extra);
      if (!n) continue;
      for (const m of n.to) {
        if (!m || m.userId === c.me.userId) continue;
        const key = `${m.userId}\n${event}`;
        if (!per.has(key)) per.set(key, { m, event, n, items: [] });
        per.get(key).items.push(item);
      }
    }
    const messages = [...per.values()].map(({ m, event, n, items }) => (items.length === 1
      ? { m, kind: n.kind, title: n.title, body: n.body, link: itemLink(c.projectId, items[0]), email: n.email }
      : { m, kind: n.kind, title: `${items.length} punch items ${MANY[event]}`, body: `${numbersOf(items)} · by ${actor(c)}`, link: listLink(c.projectId), email: n.email }));
    await deliver(db, c.project, messages, result);
  } catch (error) {
    result.failed.push(String(error?.message ?? error).slice(0, 200));
  }
  return result;
}

// ---------- writing ----------
// One compare-and-set update: matches the version read, bumps it, stamps lastChange.
async function save(db, c, item, changes, kind, extra = {}) {
  const next = { ...item, ...changes };
  const version = Number(item.version ?? 0);
  const n = await db.updateWhere("PunchItem", { ItemId: { eq: item.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    version: version + 1,
    searchText: searchTextOf(next),
    lastChange: {
      kind,
      nonce: crypto.randomUUID(),
      fromStatus: item.status,
      toStatus: next.status,
      previousBallUserId: item.ballInCourtUserId ?? "",
      actorUserId: c.me.userId,
      reason: extra.reason ?? "",
      before: extra.before ?? "",
      after: extra.after ?? ""
    }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", `Someone else just changed ${item.number}. It has been reloaded; please try again.`);
  return { ...next, version: version + 1 };
}

function history(db, c, item, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType: "punchItem",
    recordId: item.ItemId,
    recordNumber: item.number,
    action,
    actorName: actor(c),
    summary,
    reason: extra.reason,
    fromStatus: extra.fromStatus,
    toStatus: extra.toStatus,
    before: extra.before,
    after: extra.after
  });
}

// ---------- a pin on a drawing (New punch item here, from the sheet viewer) ----------
// Same rules as the drawings Function: drawing.pin, on the sheet's current revision only.
async function checkPin(db, c, pin) {
  if (!projectCan(c.role, "drawing.pin")) throw new Refused("NOT_ALLOWED", "Your role can't place pins on drawings.");
  const [sheet] = await db.list("Sheet", "ItemId sheetNumber currentRevisionIndex currentRevisionLabel isVoided", c.me.tenantRole, { projectId: c.projectId, ItemId: String(pin?.sheetId ?? "") });
  if (!sheet || sheet.isVoided) throw new Refused("NOT_FOUND", "That sheet doesn't exist in this project.");
  if (Number(pin.revisionIndex) !== Number(sheet.currentRevisionIndex ?? 0)) {
    throw new Refused("NOT_CURRENT", `Pins go on the current revision (rev ${sheet.currentRevisionLabel}). Reload the sheet and try again.`);
  }
  const at = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Refused("BAD_POINT", "Place the pin on the sheet.");
    return Math.round(n * 100000) / 100000;
  };
  return { sheet, x: at(pin.x), y: at(pin.y) };
}

async function placePin(db, c, { sheet, x, y }, item) {
  return db.insert("Pin", {
    tenantRole: c.me.tenantRole,
    projectId: c.projectId,
    sheetId: sheet.ItemId,
    fromRevisionIndex: Number(sheet.currentRevisionIndex),
    toRevisionIndex: 0,
    version: 0,
    x,
    y,
    linkedRecordType: "punchItem",
    linkedRecordId: item.ItemId,
    linkedRecordNumber: item.number,
    createdByUserId: c.me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: actor(c),
    createdAt: new Date().toISOString(),
    isVoided: false,
    lastChange: { kind: "created", nonce: crypto.randomUUID(), actorUserId: c.me.userId }
  });
}

async function create(db, me, args, mode = {}) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  c.assignedOnSave = mode.assignedOnSave === true;
  if (!c.creator) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager create punch items.");
  const clientRequestId = text(args.clientRequestId, 64);
  if (!clientRequestId) throw new Refused("BAD_REQUEST", "Missing request id. Reload the page and try again.");
  // A retried request (double tap, network retry, the upload queue) returns the item the first one made.
  const earlier = await db.list("PunchItem", "ItemId", me.tenantRole, { projectId: c.projectId, clientRequestId });
  if (earlier[0]) return { ...(await detail(db, c, earlier[0].ItemId)), created: false };

  const v = itemInput(args, {}, c);
  const who = assignment(c, args.assigneeCompanyId, args.assigneeUserId);
  const pinAt = args.pin ? await checkPin(db, c, args.pin) : undefined;
  const withPhoto = args.withPhoto === true;
  if (!withPhoto && !pinAt) throw new Refused("PHOTO_OR_PIN", "Add a photo or pin it on a sheet, so the trade can find it.");
  const now = new Date().toISOString();
  const n = await allocateNumber(db, me, c.projectId, "punchItem", clientRequestId);
  const { tradeOfCompany, ...assigned } = who;
  const row = {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    clientRequestId,
    number: n.number,
    seq: n.seq,
    version: 0,
    title: v.title,
    description: v.description,
    priority: v.priority,
    location: v.location,
    trade: v.trade || tradeOfCompany,
    dueDate: v.dueDate || defaultDue(c),
    status: "open",
    ...assigned,
    createdByUserId: me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: actor(c),
    createdAt: now,
    reopenCount: 0,
    afterPhotoSince: now,
    photoExpected: withPhoto,
    sheetId: pinAt?.sheet.ItemId ?? "",
    pinId: "",
    notifyPending: !c.assignedOnSave,
    ...(c.assignedOnSave ? {} : { notifyPendingSince: now }), // a DateTime: never ""
    isVoided: false
  };
  Object.assign(row, assigneeBall(c, row));
  row.searchText = searchTextOf(row);
  row.lastChange = { kind: "created", nonce: crypto.randomUUID(), fromStatus: "", toStatus: "open", previousBallUserId: "", actorUserId: me.userId, reason: "" };
  // A failed save hands its number back, so the next try gets the same one (no gap).
  const itemId = await db.insert("PunchItem", row).catch((error) => giveBackNumber(db, me, c.projectId, "punchItem", n, error));
  let saved = { ...row, ItemId: itemId };
  if (pinAt) {
    const pinId = await placePin(db, c, pinAt, saved);
    saved = await save(db, c, saved, { pinId }, "pinned");
  }
  const where = pinAt ? ` on ${pinAt.sheet.sheetNumber}` : row.location ? ` at ${row.location}` : "";
  await history(db, c, saved, "created", `${actor(c)} created ${row.number}${where} for ${row.assigneeCompanyName}, due ${row.dueDate}`, { toStatus: "open" });
  if (!c.assignedOnSave) return { ...(await detail(db, c, saved)), created: true };
  const [d, notified] = await Promise.all([detail(db, c, saved), tellPunch(db, c, [{ item: saved, event: "assigned" }])]);
  return { ...d, created: true, notified };
}

async function edit(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const item = await loadItem(db, c, args.itemId);
  if (!c.assigner) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager change punch items.");
  if (!ACTIVE.includes(item.status)) throw new Refused("INVALID_TRANSITION", `${item.number} is ${STATUS_LABEL[item.status]} and can't be changed.`);
  if (args.version !== undefined && Number(args.version) !== Number(item.version ?? 0)) {
    throw new Refused("STATE_CHANGED", `Someone else just changed ${item.number}. It has been reloaded; please try again.`);
  }
  const changes = args.changes && typeof args.changes === "object" ? args.changes : {};
  const v = itemInput(changes, item, c);
  const names = { title: "title", description: "description", priority: "priority", location: "location", trade: "trade", dueDate: "due date" };
  const changed = Object.keys(names).filter((k) => v[k] !== undefined && v[k] !== (item[k] ?? ""));
  if (!changed.length) return detail(db, c, item);
  const patch = Object.fromEntries(changed.map((k) => [k, v[k]]));
  const before = changed.filter((k) => k !== "description").map((k) => `${names[k]}: ${item[k] ?? ""}`).join("; ");
  const after = changed.filter((k) => k !== "description").map((k) => `${names[k]}: ${v[k]}`).join("; ");
  const saved = await save(db, c, item, patch, "edited", { before, after });
  await history(db, c, saved, "edited", `${actor(c)} changed the ${changed.map((k) => names[k]).join(", ")} of ${item.number}`, { before, after });
  return detail(db, c, saved);
}

// ---------- status changes (one item; bulk uses the same steps) ----------
const reasonOf = (v, what) => {
  const r = text(v, 500);
  if (r.length < 3) throw new Refused("REASON_REQUIRED", `Say why you ${what} (at least 3 characters).`);
  return r;
};

function wrongState(item, what) {
  return new Refused("INVALID_TRANSITION", `${item.number} is ${STATUS_LABEL[item.status]}, so it can't be ${what}.`);
}

// Applies one change to one item (already loaded and visible). Returns the saved item.
async function applyChange(db, c, item, op, args, photos) {
  const can = abilities(item, c, photos);
  const now = new Date().toISOString();
  const s = item.status;
  switch (op) {
    case "start": {
      if (s !== "open") throw wrongState(item, "started");
      if (!can.start) throw new Refused("NOT_ALLOWED", "Only the assigned company or the general contractor starts this item.");
      const saved = await save(db, c, item, { status: "inProgress", startedAt: now }, "started");
      await history(db, c, saved, "started", `${actor(c)} started work on ${item.number}`, { fromStatus: s, toStatus: "inProgress" });
      return saved;
    }
    case "markReady": {
      if (s !== "open" && s !== "inProgress") throw wrongState(item, "marked ready");
      if (!can.markReady) throw new Refused("NOT_ALLOWED", "Only the assigned company or the general contractor marks this item ready.");
      if (!photos.after.length) throw new Refused("AFTER_PHOTO_REQUIRED", `Add an after photo of the fix to ${item.number} first.`);
      const next = { ...item, status: "readyForReview" };
      const saved = await save(db, c, item, { status: "readyForReview", readyAt: now, readyByUserId: c.me.userId, ...verifierBall(c, next) }, "markedReady");
      await history(db, c, saved, "markedReady", `${actor(c)} marked ${item.number} ready for review${saved.ballInCourtName ? ` by ${saved.ballInCourtName}` : ""}`, { fromStatus: s, toStatus: "readyForReview" });
      return saved;
    }
    case "close": {
      if (!ACTIVE.includes(s)) throw wrongState(item, "closed");
      if (!can.close) throw new Refused("NOT_ALLOWED", "Only the superintendent or the project manager closes punch items.");
      if (!photos.after.length) throw new Refused("AFTER_PHOTO_REQUIRED", `Add an after photo before closing ${item.number} (you can take it yourself).`);
      const saved = await save(db, c, item, { status: "closed", closedAt: now, closedByUserId: c.me.userId, ...NO_BALL }, "closed");
      await history(db, c, saved, "closed", `${actor(c)} closed ${item.number}`, { fromStatus: s, toStatus: "closed" });
      return saved;
    }
    case "sendBack":
    case "reopen": {
      const from = op === "sendBack" ? "readyForReview" : "closed";
      if (s !== from) throw wrongState(item, op === "sendBack" ? "sent back" : "reopened");
      if (!can[op]) throw new Refused("NOT_ALLOWED", `Only the superintendent or the project manager ${op === "sendBack" ? "sends items back" : "reopens items"}.`);
      const reason = reasonOf(args.reason, op === "sendBack" ? "send it back" : "reopen it");
      const next = { ...item, status: "inProgress" };
      const saved = await save(db, c, item, {
        status: "inProgress",
        reopenCount: Number(item.reopenCount ?? 0) + 1,
        lastRejectReason: reason,
        afterPhotoSince: now,
        ...assigneeBall(c, next)
      }, op === "sendBack" ? "sentBack" : "reopened", { reason });
      await history(db, c, saved, op === "sendBack" ? "sentBack" : "reopened", `${actor(c)} ${op === "sendBack" ? "sent" : "reopened"} ${item.number}${op === "sendBack" ? " back" : ""} to ${item.assigneeCompanyName}: a new after photo is needed`, { reason, fromStatus: s, toStatus: "inProgress" });
      return saved;
    }
    case "void": {
      if (!ACTIVE.includes(s)) throw wrongState(item, "voided");
      if (!can.void) throw new Refused("NOT_ALLOWED", "Only the project manager voids punch items (the creator too, while the item is still open).");
      const reason = reasonOf(args.reason, "void it");
      const saved = await save(db, c, item, { status: "void", isVoided: true, voidReason: reason, voidedAt: now, voidedByUserId: c.me.userId, notifyPending: false, ...NO_BALL }, "voided", { reason });
      await history(db, c, saved, "voided", `${actor(c)} voided ${item.number}`, { reason, fromStatus: s, toStatus: "void" });
      return saved;
    }
    case "reassign": {
      if (!ACTIVE.includes(s)) throw wrongState(item, "reassigned");
      if (!can.reassign) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager reassign punch items.");
      const { tradeOfCompany, ...who } = args.assignment ?? assignment(c, args.assigneeCompanyId, args.assigneeUserId);
      if (who.assigneeCompanyId === item.assigneeCompanyId && who.assigneeUserId === (item.assigneeUserId ?? "")) return item;
      const companyChanged = who.assigneeCompanyId !== item.assigneeCompanyId;
      const next = { ...item, ...who };
      const patch = { ...who, ...(s === "readyForReview" ? {} : assigneeBall(c, next)) };
      if (companyChanged) Object.assign(patch, { ...(c.assignedOnSave ? {} : { notifyPending: true, notifyPendingSince: now }), ...(tradeOfCompany ? { trade: tradeOfCompany } : {}) });
      const before = `${item.assigneeCompanyName}${item.assigneeName ? ` (${item.assigneeName})` : ""}`;
      const after = `${who.assigneeCompanyName}${who.assigneeName ? ` (${who.assigneeName})` : ""}`;
      const saved = await save(db, c, item, patch, "reassigned", { before, after });
      await history(db, c, saved, "reassigned", `${actor(c)} assigned ${item.number} to ${after} (was ${before})`, { before, after });
      return saved;
    }
    case "setDue": {
      if (!ACTIVE.includes(s)) throw wrongState(item, "given a new due date");
      if (!can.edit) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager change due dates.");
      const due = args.dueDateChecked ?? dueDateOf(c, args.dueDate, { required: true });
      if (due === item.dueDate) return item;
      const saved = await save(db, c, item, { dueDate: due }, "edited", { before: item.dueDate ?? "", after: due });
      await history(db, c, saved, "edited", `${actor(c)} moved the due date of ${item.number} to ${due}`, { before: item.dueDate ?? "", after: due });
      return saved;
    }
    default:
      throw new Refused("BAD_ACTION", "Unknown change.");
  }
}

// One item, one change: start, markReady, close, sendBack, reopen, void, reassign.
// The event a saved change tells about: the status events, and (on-save mode) a move to another company.
function eventOf(c, op, item, saved) {
  if (saved === item) return undefined;
  if (op === "reassign") return c.assignedOnSave && saved.assigneeCompanyId !== item.assigneeCompanyId ? "assigned" : undefined;
  return OP_EVENT[op];
}

function change(op) {
  return async (db, me, raw, mode = {}) => {
    // `assignment` and `dueDateChecked` are filled in by bulk() after its own checks, never by a caller.
    const { assignment: _a, dueDateChecked: _d, ...args } = raw;
    const c = await projectContext(db, me, args.projectId, { write: true });
    c.assignedOnSave = mode.assignedOnSave === true;
    const item = await loadItem(db, c, args.itemId);
    const photos = photoSummary(item, photosByItem(await loadPhotos(db, c, item.ItemId)).get(item.ItemId));
    const saved = await applyChange(db, c, item, op, args, photos);
    const event = eventOf(c, op, item, saved);
    if (!event) return detail(db, c, saved);
    const [d, notified] = await Promise.all([detail(db, c, saved), tellPunch(db, c, [{ item: saved, event, extra: { reason: saved.lastRejectReason } }])]);
    return { ...d, notified };
  };
}

async function comment(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const item = await loadItem(db, c, args.itemId);
  const photos = photoSummary(item, photosByItem(await loadPhotos(db, c, item.ItemId)).get(item.ItemId));
  if (!abilities(item, c, photos).comment) {
    throw new Refused("NOT_ALLOWED", item.status === "void" ? `${item.number} is void.` : "Only the general contractor and the assigned company comment on this item.");
  }
  const body = longText(args.body, 2000);
  if (!body) throw new Refused("EMPTY_COMMENT", "Write a comment first.");
  await db.insert("Comment", {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    recordType: "punchItem",
    recordId: item.ItemId,
    recordNumber: item.number,
    body,
    attachments: [],
    authorUserId: me.userId,
    authorCompanyId: c.mine.companyId ?? "",
    authorName: actor(c),
    postedAt: new Date().toISOString(),
    visibility: "all",
    mentionUserIds: [],
    isVoided: false
  });
  return detail(db, c, item);
}

// ---------- bulk (up to 50 items per call; the page sends 200 in four calls) ----------
async function inBatches(list, size, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...(await Promise.all(list.slice(i, i + size).map(fn))));
  return out;
}

async function bulk(db, me, args, mode = {}) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  c.assignedOnSave = mode.assignedOnSave === true;
  if (!c.assigner) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager change several items at once.");
  const op = String(args.op ?? "");
  if (!BULK_OPS.includes(op)) throw new Refused("BAD_ACTION", "Choose what to change.");
  const ids = Array.isArray(args.itemIds) ? [...new Set(args.itemIds.map(String))] : [];
  if (!ids.length) throw new Refused("NO_ITEMS", "Select at least one item.");
  if (ids.length > BULK_MAX) throw new Refused("TOO_MANY_ITEMS", `Change at most ${BULK_MAX} items per call.`);
  // Checked once for all items: a bad company or date refuses the whole call.
  const extra = { reason: args.reason };
  if (op === "reassign") extra.assignment = assignment(c, args.assigneeCompanyId, args.assigneeUserId);
  if (op === "setDue") extra.dueDateChecked = dueDateOf(c, args.dueDate, { required: true });
  if (op === "void") extra.reason = reasonOf(args.reason, "void them");
  const wanted = new Set(ids);
  const [rows, photoRows] = await Promise.all([loadItems(db, c), loadPhotos(db, c)]);
  const byId = new Map(rows.filter((i) => wanted.has(i.ItemId) && canSee(i, c)).map((i) => [i.ItemId, i]));
  const byItem = photosByItem(photoRows);
  const updated = [];
  const rejected = [];
  const events = [];
  await inBatches(ids, 8, async (id) => {
    const item = byId.get(id);
    if (!item) {
      rejected.push({ itemId: id, number: "", code: "NOT_FOUND", error: "This punch item doesn't exist, or you can't open it." });
      return;
    }
    try {
      const saved = await applyChange(db, c, item, op, extra, photoSummary(item, byItem.get(id)));
      const event = eventOf(c, op, item, saved);
      if (event) events.push({ item: saved, event });
      updated.push(id);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      rejected.push({ itemId: id, number: item.number, code: error.code, error: error.message });
    }
  });
  const notified = events.length ? await tellPunch(db, c, events) : undefined;
  return { ok: true, op, updated, rejected, ...(notified ? { notified } : {}) };
}

// ---------- the 15-minute pass: new assignments and the daily overdue digest (06 §4.4, §4.5) ----------
// Run only by the `punch-notices` workflow (every 15 minutes) and by a Blocks project admin's
// `blocks logic function test` (see handler()). No action people can name starts it.
// 1. Assigned: items with notifyPending (new, or moved to another company) that are still active.
//    One notice per company and project, to its people on the project: "3 new punch items for
//    Dry Walls Ltd" (bell + email). The flag is cleared BEFORE sending, matched on the item's
//    version as the RFI reminders do: a crash loses the notice instead of sending it twice, and an
//    item changed meanwhile waits for the next run. Closed or void items just lose the flag.
// 2. Overdue: once per working day, from 07:00 project time, the open and in-progress items past
//    their due date that weren't told today (overdueNoticeLastDate) go into one digest per company
//    (bell, + email when reminder emails are on); the project managers get one copy with the count
//    per company. Ready-for-review items wait on the general contractor, so they're not in it.
// Runs that Blocks skips are caught up by the next one. Archived projects are left alone.
const NOTICE_HOUR = 7;
const NOTICE_BUDGET_MS = 22_000;
const RUN_FIELDS =
  "ItemId projectId number seq title location status dueDate version isVoided assigneeCompanyId assigneeCompanyName " +
  "notifyPending overdueNoticeLastDate";

function hourIn(timeZone) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  } catch {
    return new Date().getUTCHours();
  }
}

function workingDaysBetween(from, to) {
  let count = 0;
  let d = String(from).slice(0, 10);
  const end = String(to).slice(0, 10);
  while (d < end) {
    d = addDays(d, 1);
    if (!isWeekend(d)) count += 1;
  }
  return count;
}

// Every company's rows matching `filter` (the service reads all tenants; split per project below).
async function readAll(db, filter) {
  const data = await db.gql(
    `query q($input: DynamicQueryInput) { getPunchItems(input: $input) { items { tenantRole ${RUN_FIELDS} } } }`,
    { input: { pageNo: 1, pageSize: 1000, filter: JSON.stringify(filter) } }
  );
  return (data?.getPunchItems?.items ?? []).filter((i) => Object.entries(filter).every(([k, v]) => i[k] === v));
}

async function noticeProject(db, project, pending, late, started, out, options) {
  const tenantRole = project.tenantRole;
  const today = todayIn(project.timezone);
  const team = await db.list("ProjectMember", TEAM_FIELDS, tenantRole, { projectId: project.ItemId });
  const c = { me: { userId: "", tenantRole }, project, projectId: project.ItemId, active: team.filter((m) => m.status === "active"), today };
  const overBudget = () => Date.now() - started > NOTICE_BUDGET_MS;
  // Claim first (no version bump, so nobody's open item goes stale): 1 = ours to tell.
  const claim = async (i, patch) => options.dryRun
    || (await db.updateWhere("PunchItem", { ItemId: { eq: i.ItemId }, version: { eq: Number(i.version ?? 0) } }, tenantRole, patch)) === 1;
  const companyName = (items, people) => items[0].assigneeCompanyName || people[0]?.companyName || "your company";
  const messages = [];
  const reminders = [];

  // 1. new and reassigned items, one notice per company
  const assigned = new Map();
  for (const i of [...pending].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))) {
    if (overBudget()) {
      out.leftForNextRun += 1;
      continue;
    }
    if (!(await claim(i, { notifyPending: false }))) continue;
    if (i.isVoided || !ACTIVE.includes(i.status)) {
      out.cleared += 1;
      continue;
    }
    if (!assigned.has(i.assigneeCompanyId)) assigned.set(i.assigneeCompanyId, []);
    assigned.get(i.assigneeCompanyId).push(i);
  }
  for (const [companyId, items] of assigned) {
    out.assigned += items.length;
    const people = fieldUsersOf(c, companyId);
    if (!people.length) continue;
    const name = companyName(items, people);
    const first = items.map((i) => i.dueDate).filter(Boolean).sort()[0];
    const one = items.length === 1;
    const title = one ? `New punch item ${items[0].number} for ${name}` : `${items.length} new punch items for ${name}`;
    const body = one ? `${headOf(items[0])}${first ? ` · due ${shortDate(first)}` : ""}` : `${numbersOf(items)}${first ? ` · first due ${shortDate(first)}` : ""}`;
    const link = one ? itemLink(c.projectId, items[0]) : listLink(c.projectId, `&company=${encodeURIComponent(companyId)}`);
    out.assignedNotices += 1;
    for (const m of people) messages.push({ m, kind: "assigned", title, body, link, email: true });
  }

  // 2. the daily overdue digest (late = this project's candidates, already checked for the hour)
  const lateBy = new Map();
  for (const i of [...late].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))) {
    if (overBudget()) {
      out.leftForNextRun += 1;
      continue;
    }
    if (!(await claim(i, { overdueNoticeLastDate: today }))) continue;
    out.overdue += 1;
    if (!lateBy.has(i.assigneeCompanyId)) lateBy.set(i.assigneeCompanyId, []);
    lateBy.get(i.assigneeCompanyId).push(i);
  }
  const lines = [];
  for (const [companyId, items] of lateBy) {
    const people = fieldUsersOf(c, companyId);
    const name = companyName(items, people);
    lines.push(`${name}: ${items.length}`);
    if (!people.length) continue;
    const oldest = Math.max(...items.map((i) => workingDaysBetween(i.dueDate, today)));
    const title = `${plural(items.length, "punch item")} overdue for ${name}`;
    const body = `${numbersOf(items)} · oldest ${plural(oldest, "working day")} late`;
    out.digests += 1;
    for (const m of people) reminders.push({ m, kind: "overdue", title, body, link: listLink(c.projectId, `&overdue=1&company=${encodeURIComponent(companyId)}`), email: true });
  }
  const pms = c.active.filter((m) => m.role === "project-manager");
  if (lines.length && pms.length) {
    const total = [...lateBy.values()].reduce((n, items) => n + items.length, 0);
    const title = `${plural(total, "punch item")} overdue on ${project.number || project.name}`;
    out.digests += 1;
    for (const m of pms) reminders.push({ m, kind: "digest", title, body: lines.join(" · "), link: listLink(c.projectId, "&overdue=1"), email: true });
  }

  if (options.dryRun) {
    const seen = new Map();
    for (const x of [...messages, ...reminders]) {
      const key = `${x.kind}\n${x.title}`;
      if (!seen.has(key)) seen.set(key, { project: project.number, kind: `punch.${x.kind}`, title: x.title, people: 0 });
      seen.get(key).people += 1;
    }
    out.planned.push(...seen.values());
    return;
  }
  await deliver(db, project, messages, out);
  await deliver(db, project, reminders, out, { reminder: true });
}

async function runNotices(ctx, options = {}) {
  const started = Date.now();
  const out = { ok: true, projects: 0, assigned: 0, assignedNotices: 0, cleared: 0, overdue: 0, digests: 0, bell: 0, email: 0, leftForNextRun: 0, failed: [], planned: [] };
  try {
    const db = client(ctx, await serviceToken(ctx));
    // Every company's flagged and late-candidate items in three reads (filtered on the server).
    const [pending, open, inProgress] = await Promise.all([
      readAll(db, { notifyPending: true }),
      readAll(db, { status: "open" }),
      readAll(db, { status: "inProgress" })
    ]);
    const working = [...open, ...inProgress].filter((i) => !i.isVoided && DATE.test(String(i.dueDate ?? "")));
    if (pending.length || working.length) {
      const projects = await db.listAll("Project", "ItemId number name status timezone");
      for (const project of projects) {
        if (project.status === "archived") continue;
        const ours = (i) => i.tenantRole === project.tenantRole && i.projectId === project.ItemId;
        const today = todayIn(project.timezone);
        const digestTime = options.anyTime || (!isWeekend(today) && hourIn(project.timezone) >= NOTICE_HOUR);
        const p = pending.filter(ours);
        const late = digestTime ? working.filter((i) => ours(i) && i.dueDate < today && i.overdueNoticeLastDate !== today) : [];
        if (!p.length && !late.length) continue;
        if (Date.now() - started > NOTICE_BUDGET_MS) {
          out.leftForNextRun += p.length + late.length;
          continue;
        }
        out.projects += 1;
        await noticeProject(db, project, p, late, started, out, options);
      }
    }
  } catch (error) {
    ctx.log.error("punch notices failed", { message: error.message });
    out.ok = false;
    out.failed.push(String(error?.message ?? error).slice(0, 200));
  }
  ctx.log.info("punch notices", { ...out, planned: out.planned.length });
  if (!options.dryRun) delete out.planned;
  return out;
}

export default async function handler(input, ctx) {
  // The 15-minute notice workflow. `ctx.run.invokedBy` is set by Blocks, not by the caller, so an
  // app user can't start it. A project admin's test run may ask for a dry run (nothing written or
  // sent) and ignore the working-day and 07:00 rule of the overdue digest (anyTime).
  const by = ctx.run?.invokedBy?.type;
  if (by === "workflow") return runNotices(ctx);
  if (by === "test" && input?.action === "notices") return runNotices(ctx, { dryRun: input.dryRun === true, anyTime: input.anyTime === true });
  // New and moved items: told on save unless the Function variable PUNCH_ASSIGNED_NOTICE is "batch".
  const mode = { assignedOnSave: String(ctx.env?.PUNCH_ASSIGNED_NOTICE ?? "").trim().toLowerCase() !== "batch" };
  return handle(input, ctx, "punch", {
    list: (args, { db, me }) => list(db, me, args),
    get: (args, { db, me }) => get(db, me, args),
    create: (args, { db, me }) => create(db, me, args, mode),
    edit: (args, { db, me }) => edit(db, me, args),
    reassign: (args, { db, me }) => change("reassign")(db, me, args, mode),
    start: (args, { db, me }) => change("start")(db, me, args, mode),
    markReady: (args, { db, me }) => change("markReady")(db, me, args, mode),
    close: (args, { db, me }) => change("close")(db, me, args, mode),
    sendBack: (args, { db, me }) => change("sendBack")(db, me, args, mode),
    reopen: (args, { db, me }) => change("reopen")(db, me, args, mode),
    void: (args, { db, me }) => change("void")(db, me, args, mode),
    comment: (args, { db, me }) => comment(db, me, args),
    bulk: (args, { db, me }) => bulk(db, me, args, mode)
  });
}
