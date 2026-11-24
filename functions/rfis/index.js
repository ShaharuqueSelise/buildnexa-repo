// RFIs, part 1 (docs/architecture/03-rfis.md; permissions in docs/permissions/PERMISSIONS.md).
// Every RFI read and write goes through here: the Data Gateway rules let only the service identity
// touch Rfi and RfiResponse, because they can't check a person's role on ONE project.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list", projectId }                         -> { rfis, role, canCreate }
//   { action: "get", projectId, rfiId }                   -> detail
//   { action: "create", projectId, clientRequestId, submit, subject, question, suggestedAnswer?,
//     priority?, discipline?, location?, dueDate?, assigneeUserIds, distributionUserIds,
//     costImpact?, scheduleImpact?, costImpactAmount?, scheduleImpactDays?, internalNote? }
//                                                          -> detail (+ created: true)
//   { action: "edit", projectId, rfiId, changes: { same fields as create } }  -> detail
//   { action: "submit" | "close", projectId, rfiId }                           -> detail
//   { action: "reassign", projectId, rfiId, toUserId, note? }                  -> detail
//   { action: "respond", projectId, rfiId, body, asOfficial? }                 -> detail
//   { action: "markOfficial", projectId, rfiId, responseId }                   -> detail
//   { action: "askAgain" | "reopen" | "void", projectId, rfiId, reason, toUserId? } -> detail
//   { action: "uploadLinks", projectId, rfiId?, files: [{ name, contentType, sizeBytes, thumbnail? }] }
//                                                          -> { uploads: [{ fileId, uploadUrl, …, ticket }] }
//   { action: "fileLinks", projectId, rfiId }             -> { files: { fileId: download link } }
// Reminders (Part 4) run only when the hourly `rfi-reminders` workflow calls this Function (see
// runReminders near the end); people can't start them.
// create / edit (changes.attachments) / respond take `attachments`: the uploads with their tickets.
// detail = { rfi, can, responses, history, files }. Every change answers with the fresh detail, so
// the screen needs no second call.
//
// Security:
// - The caller must be an active member of the project (spec: membership required). Company
//   admins get no RFIs from their company role.
// - What a role may do comes from the shared permission table (projectCan); what depends on the
//   record (creator, manager, assignee, ball holder, company) is checked here.
// - Subcontractors see RFIs they or their company raised, or that involve them; drafts are seen by
//   their creator and the PM. Cost and schedule impact and internal notes are removed from every
//   answer for roles without rfi.see_cost / rfi.see_internal, and refused on input.
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
  async function gql(query, variables) {
    const res = await fetch(`${API}/data/v4/gateway`, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) throw new Error(`gateway ${res.status}: ${JSON.stringify(body.errors?.map((e) => e.message) ?? body).slice(0, 200)}`);
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

// Next number for `key` in one project. A project created before numbering existed gets its
// counter on first use (two first callers at once can each create one; everyone then uses the
// same one, sorted by id, and the others stay unused).
// Self-heal of numbers whose record was never written comes with the first numbered record.
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
    const n = last + 1;
    const won = await db.updateWhere("Sequence", { ItemId: { eq: seq.ItemId }, lastValue: { eq: last } }, me.tenantRole, {
      lastValue: n,
      claimRef: ref,
      claimedAt: new Date().toISOString()
    });
    if (won === 1) return { seq: n, number: formatNumber(seq.prefix || def.prefix, n, seq.padWidth || 3), claimRef: ref };
    await pause(attempt * 40 + Math.floor(Math.random() * 80));
  }
  throw new Refused("SEQUENCE_CONTENDED", "Too many people are creating records right now. Please try again.");
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
  "drawing.pin": [PM, SUPT, SUB],
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
  "daily_log.view": [PM, SUPT, DC],
  "daily_log.view_submitted": [DESIGN, OWNER],
  "daily_log.create": [PM, SUPT],
  "daily_log.crew_own": [SUB],
  "daily_log.correct": [PM], // audited correction after submit
  // Punch list
  "punch_item.view": [PM, SUPT, DC, DESIGN, OWNER],
  "punch_item.view_assigned": [SUB],
  "punch_item.create": [PM, SUPT],
  "punch_item.assign": [PM, SUPT],
  "punch_item.close": [PM, SUPT],
  "punch_item.update_assigned": [SUB],
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
const IMPACTS = ["no", "yes", "tbd"];
const PRIORITIES = ["low", "normal", "high"];
const ACTIVE = ["open", "answered"];

const ATTACHMENT_FIELDS = "attachments { fileId thumbnailFileId fileName contentType sizeBytes uploadedBy uploadedAt }";
const TEAM_FIELDS = "ItemId userId displayName email companyId companyName companyRelation role status";
const RFI_FIELDS =
  "ItemId projectId number seq version clientRequestId subject question suggestedAnswer status priority discipline location dueDate " +
  "managerUserId assigneeUserIds distributionUserIds ballInCourtUserId ballInCourtCompanyId ballInCourtName ballInCourtRole " +
  "createdByUserId createdByCompanyId createdByName createdAt openedDate answeredDate closedDate closedByUserId " +
  "officialResponseId officialAnswerText costImpact scheduleImpact costImpactAmount scheduleImpactDays internalNote " +
  "responseCount lastResponseAt isVoided voidReason " + ATTACHMENT_FIELDS;
const RESPONSE_FIELDS = "ItemId rfiId rfiNumber body authorUserId authorCompanyId authorName authorRole postedAt isOfficial markedOfficialByUserId markedOfficialAt isVoided " + ATTACHMENT_FIELDS;
const EVENT_FIELDS = "ItemId recordId action actorUserId actorName at summary reason fromStatus toStatus";

const COST_FIELDS = ["costImpact", "scheduleImpact", "costImpactAmount", "scheduleImpactDays"];

// ---------- dates (project timezone, weekends only; public holidays come with the calendar) ----------
function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextWorkingDay(iso) {
  let d = iso;
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
}

// ---------- who is asking, on which project ----------
async function projectContext(db, me, projectId, { write = false } = {}) {
  const id = String(projectId ?? "");
  if (!id) throw new Refused("NOT_FOUND", "Choose a project first.");
  const [projects, team] = await Promise.all([
    db.list("Project", "ItemId number name status timezone", me.tenantRole, { ItemId: id }),
    db.list("ProjectMember", TEAM_FIELDS, me.tenantRole, { projectId: id })
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  const active = team.filter((r) => r.status === "active");
  const mine = active.find((r) => r.userId === me.userId);
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. RFIs are open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  return { me, project, projectId: id, active, mine, role: mine.role, archived, today: todayIn(project.timezone) };
}

const memberOf = (c, userId) => c.active.find((r) => r.userId === userId);

// ---------- visibility and what the caller may do ----------
function involved(r, c) {
  const u = c.me.userId;
  return r.createdByUserId === u || r.ballInCourtUserId === u || (r.assigneeUserIds ?? []).includes(u) || (r.distributionUserIds ?? []).includes(u);
}

// `c.answered` (roles that see only what involves them): RFIs that the caller or their company
// has responded to. Someone who answered keeps seeing the RFI after the ball moves on.
function canSee(r, c) {
  if (r.status === "draft") return r.createdByUserId === c.me.userId || projectCan(c.role, "rfi.edit");
  if (projectCan(c.role, "rfi.view")) return true;
  if (projectCan(c.role, "rfi.view_involved")) {
    return involved(r, c) || (Boolean(r.createdByCompanyId) && r.createdByCompanyId === c.mine.companyId) || Boolean(c.answered?.has(r.ItemId));
  }
  return false;
}

// Loads c.answered for roles that need it; `rfiId` limits the read to one RFI.
async function loadAnswered(db, c, rfiId) {
  if (projectCan(c.role, "rfi.view") || !projectCan(c.role, "rfi.view_involved")) return;
  const where = rfiId ? { projectId: c.projectId, rfiId } : { projectId: c.projectId };
  const rows = await db.list("RfiResponse", "rfiId authorUserId authorCompanyId isVoided", c.me.tenantRole, where);
  const company = c.mine.companyId;
  c.answered = new Set(rows.filter((x) => !x.isVoided && (x.authorUserId === c.me.userId || (company && x.authorCompanyId === company))).map((x) => x.rfiId));
}

function abilities(r, c) {
  const u = c.me.userId;
  const s = r.status;
  const creator = r.createdByUserId === u;
  const manager = r.managerUserId === u;
  const gc = projectCan(c.role, "rfi.respond");
  const assigned = (r.assigneeUserIds ?? []).includes(u) || r.ballInCourtUserId === u;
  const live = ACTIVE.includes(s) && !c.archived;
  const can = {
    edit: !c.archived && (s === "draft" ? creator || projectCan(c.role, "rfi.edit") : live && (projectCan(c.role, "rfi.edit") || manager)),
    submit: !c.archived && s === "draft" && (creator || projectCan(c.role, "rfi.edit")),
    reassign: live && (projectCan(c.role, "rfi.reassign") || manager || (creator && gc)),
    respond: live && (projectCan(c.role, "rfi.respond") || (projectCan(c.role, "rfi.respond_assigned") && assigned)),
    markOfficial: live && (projectCan(c.role, "rfi.mark_official") || manager),
    markOfficialOwn: live && projectCan(c.role, "rfi.mark_official_own"),
    askAgain: !c.archived && s === "answered" && (projectCan(c.role, "rfi.edit") || manager),
    close: !c.archived && s === "answered" && Boolean(r.officialResponseId) && (projectCan(c.role, "rfi.close") || creator),
    reopen: !c.archived && s === "closed" && projectCan(c.role, "rfi.reopen"),
    void: !c.archived && (s === "draft" ? creator || projectCan(c.role, "rfi.void") : live && projectCan(c.role, "rfi.void"))
  };
  return can;
}

function present(r, c) {
  const { tenantRole: _t, clientRequestId: _c, ...out } = r;
  if (!projectCan(c.role, "rfi.see_cost")) for (const k of COST_FIELDS) delete out[k];
  if (!projectCan(c.role, "rfi.see_internal")) delete out.internalNote;
  return out;
}

// ---------- input ----------
const text = (v, max) => String(v ?? "").trim().slice(0, max);

function people(c, ids, { label, max, allowOwner }) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) throw new Refused("BAD_PEOPLE", `Choose the ${label} from the project team.`);
  const out = [...new Set(ids.map(String))];
  if (out.length > max) throw new Refused("BAD_PEOPLE", `At most ${max} ${label}.`);
  for (const id of out) {
    const m = memberOf(c, id);
    if (!m) throw new Refused("ASSIGNEE_NOT_MEMBER", `Everyone in ${label} must be on the project team.`);
    if (!allowOwner && m.role === "owner-viewer") throw new Refused("ASSIGNEE_NOT_ALLOWED", "Owners read RFIs but don't answer them. Put them on the distribution list instead.");
  }
  return out;
}

// Merges `args` over `base` (an existing RFI, or {} for a new one) and checks the result.
// `submit`: the RFI is (or becomes) open, so everything needed to answer it must be there.
function rfiInput(args, base, c, { submit }) {
  const seesCost = projectCan(c.role, "rfi.see_cost");
  const seesInternal = projectCan(c.role, "rfi.see_internal");
  const has = (k) => args[k] !== undefined;
  const v = {
    subject: has("subject") ? text(args.subject, 200) : base.subject ?? "",
    question: has("question") ? String(args.question ?? "").trim() : base.question ?? "",
    suggestedAnswer: has("suggestedAnswer") ? String(args.suggestedAnswer ?? "").trim() : base.suggestedAnswer ?? "",
    priority: has("priority") ? String(args.priority) : base.priority ?? "normal",
    discipline: has("discipline") ? text(args.discipline, 60) : base.discipline ?? "",
    location: has("location") ? text(args.location, 120) : base.location ?? "",
    dueDate: has("dueDate") ? String(args.dueDate ?? "") : base.dueDate ?? "",
    assigneeUserIds: people(c, args.assigneeUserIds, { label: "assignees", max: 10, allowOwner: false }) ?? base.assigneeUserIds ?? [],
    distributionUserIds: people(c, args.distributionUserIds, { label: "the distribution list", max: 50, allowOwner: true }) ?? base.distributionUserIds ?? []
  };
  if (v.subject.length < 3) throw new Refused("BAD_SUBJECT", "Write a subject (at least 3 characters).");
  if (v.question.length > 10000 || v.suggestedAnswer.length > 10000) throw new Refused("TOO_LONG", "The question and the suggested answer can be at most 10 000 characters.");
  if (!PRIORITIES.includes(v.priority)) throw new Refused("BAD_PRIORITY", "Choose a priority.");
  if (v.dueDate && !DATE.test(v.dueDate)) throw new Refused("BAD_DUE_DATE", "Enter a valid due date.");
  if (v.dueDate) v.dueDate = nextWorkingDay(v.dueDate);
  if (has("dueDate") && v.dueDate && v.dueDate < c.today) throw new Refused("DUE_DATE_IN_PAST", "The due date can't be in the past.");
  if (submit) {
    if (!v.question) throw new Refused("BAD_QUESTION", "Write the question before submitting.");
    if (!v.assigneeUserIds.length) throw new Refused("NO_ASSIGNEE", "Choose who should answer before submitting.");
    if (!v.dueDate) throw new Refused("BAD_DUE_DATE", "Choose a due date before submitting.");
  }

  // Cost and schedule impact: only roles that see them may set them.
  const costSent = COST_FIELDS.some((k) => has(k) && args[k] !== "" && args[k] !== null && !(k.endsWith("Impact") && args[k] === "tbd"));
  if (costSent && !seesCost) throw new Refused("FORBIDDEN_FIELD", "Cost and schedule impact are set by the general contractor.");
  if (has("internalNote") && String(args.internalNote ?? "").trim() && !seesInternal) throw new Refused("FORBIDDEN_FIELD", "Internal notes are for the general contractor only.");
  if (seesCost) {
    v.costImpact = has("costImpact") ? String(args.costImpact) : base.costImpact ?? "tbd";
    v.scheduleImpact = has("scheduleImpact") ? String(args.scheduleImpact) : base.scheduleImpact ?? "tbd";
    if (!IMPACTS.includes(v.costImpact) || !IMPACTS.includes(v.scheduleImpact)) throw new Refused("BAD_IMPACT", "Cost and schedule impact are No, Yes or To be decided.");
    if (has("costImpactAmount")) {
      const n = args.costImpactAmount === "" || args.costImpactAmount === null ? undefined : Number(args.costImpactAmount);
      if (n !== undefined && !(Number.isFinite(n) && n >= 0)) throw new Refused("BAD_AMOUNT", "The cost amount must be a positive number.");
      if (n !== undefined) v.costImpactAmount = n;
    }
    if (has("scheduleImpactDays")) {
      const n = args.scheduleImpactDays === "" || args.scheduleImpactDays === null ? undefined : Number(args.scheduleImpactDays);
      if (n !== undefined && !(Number.isInteger(n) && n >= 0)) throw new Refused("BAD_DAYS", "The schedule impact must be a whole number of days.");
      if (n !== undefined) v.scheduleImpactDays = n;
    }
  } else if (!base.ItemId) {
    v.costImpact = "tbd";
    v.scheduleImpact = "tbd";
  }
  if (seesInternal && has("internalNote")) v.internalNote = text(args.internalNote, 5000);
  return v;
}

// ---------- ball in court ----------
function ball(c, userId, role) {
  const m = userId ? memberOf(c, userId) : undefined;
  return { ballInCourtUserId: userId || "", ballInCourtCompanyId: m?.companyId ?? "", ballInCourtName: m?.displayName ?? "", ballInCourtRole: userId ? role : "none" };
}
const NO_BALL = { ballInCourtUserId: "", ballInCourtCompanyId: "", ballInCourtName: "", ballInCourtRole: "none" };

// The RFI manager reviews answers and closes: the creator when they are a PM, else the first PM.
function defaultManager(c) {
  if (c.role === "project-manager") return c.me.userId;
  return c.active.find((r) => r.role === "project-manager")?.userId ?? c.me.userId;
}

// Opening: a GC role sends it straight to the first assignee; a subcontractor's RFI goes to the
// manager first, who reviews it and passes it on (03-rfis §5).
const openingBall = (c, v, managerUserId) => (projectCan(c.role, "rfi.respond") ? ball(c, v.assigneeUserIds[0], "assignee") : ball(c, managerUserId, "manager"));

const searchTextOf = (r) => [r.number, r.subject, r.ballInCourtName].filter(Boolean).join(" ").toLowerCase();

// ---------- reading ----------
async function loadRfi(db, c, rfiId) {
  const rows = await db.list("Rfi", RFI_FIELDS, c.me.tenantRole, { projectId: c.projectId, ItemId: String(rfiId ?? "") });
  const r = rows[0];
  if (r && !canSee(r, c)) await loadAnswered(db, c, r.ItemId);
  if (!r || !canSee(r, c)) throw new Refused("NOT_FOUND", "This RFI doesn't exist, or you can't open it.");
  return r;
}

async function detail(db, c, rfiOrId) {
  const r = typeof rfiOrId === "string" ? await loadRfi(db, c, rfiOrId) : rfiOrId;
  const [all, events] = await Promise.all([
    db.list("RfiResponse", RESPONSE_FIELDS, c.me.tenantRole, { projectId: c.projectId, rfiId: r.ItemId }),
    db.list("ActivityEvent", EVENT_FIELDS, c.me.tenantRole, { projectId: c.projectId, recordId: r.ItemId })
  ]);
  const responses = all.filter((x) => !x.isVoided).sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  return {
    ok: true,
    rfi: present(r, c),
    can: abilities(r, c),
    files: await fileLinksFor(db, r, responses),
    responses: responses.map(({ tenantRole: _t, ...x }) => x),
    history: events
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((e) => ({ ItemId: e.ItemId, action: e.action, actorName: e.actorName, at: e.at, summary: e.summary, reason: e.reason, fromStatus: e.fromStatus, toStatus: e.toStatus }))
  };
}

async function list(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const [rows] = await Promise.all([db.list("Rfi", RFI_FIELDS, me.tenantRole, { projectId: c.projectId }), loadAnswered(db, c)]);
  return {
    ok: true,
    role: c.role,
    canCreate: !c.archived && projectCan(c.role, "rfi.create"),
    seesCost: projectCan(c.role, "rfi.see_cost"),
    seesInternal: projectCan(c.role, "rfi.see_internal"),
    rfis: rows.filter((r) => canSee(r, c)).map((r) => present(r, c))
  };
}

// ---------- writing ----------
// One compare-and-set update: matches the version read, bumps it, stamps lastChange.
async function save(db, c, r, changes, kind, extra = {}) {
  const next = { ...r, ...changes };
  const version = Number(r.version ?? 0);
  const n = await db.updateWhere("Rfi", { ItemId: { eq: r.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    version: version + 1,
    searchText: searchTextOf(next),
    lastChange: {
      kind,
      nonce: crypto.randomUUID(),
      fromStatus: r.status,
      toStatus: next.status,
      previousBallUserId: r.ballInCourtUserId ?? "",
      actorUserId: c.me.userId,
      reason: extra.reason ?? ""
    }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", "Someone else just changed this RFI. It has been reloaded; please try again.");
  return { ...next, version: version + 1 };
}

const label = (r) => r.number || "a draft RFI";
const withFiles = (n) => (n ? ` (${n} file${n === 1 ? "" : "s"})` : "");
const actor = (c) => c.mine.displayName || "Someone";

function history(db, c, r, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType: "rfi",
    recordId: r.ItemId,
    recordNumber: r.number || undefined,
    action,
    actorName: c.mine.displayName,
    summary,
    reason: extra.reason,
    fromStatus: extra.fromStatus,
    toStatus: extra.toStatus
  });
}

// ---------- telling people (bell + email; docs/architecture/10-notifications.md) ----------
// After a change that moves work, the people concerned hear about it:
// - whoever now holds the ball: bell AND email ("RFI-002 needs your answer");
// - the creator, when their RFI is answered or closed: bell and email;
// - the distribution list (and, on void or close, the others involved): bell only.
// Never the person who made the change, never someone who can't open the RFI, and never cost
// figures or internal notes. Each person gets one notice per change (the first that applies).
// A failure here never fails the change: it is returned as `notified.failed` for support.
const PREF_FIELDS = "ItemId userId emailEnabled";
// Email bodies are HTML: what people typed (subjects, names) is escaped before it goes in.
const html = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shortDate = (iso) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`));
  } catch {
    return String(iso);
  }
};

function notices(c, before, r, event, extra) {
  const num = r.number || "An RFI";
  const who = actor(c);
  const due = r.dueDate && ACTIVE.includes(r.status) ? ` · due ${shortDate(r.dueDate)}` : "";
  const why = extra.reason ? ` · “${extra.reason.slice(0, 200)}”` : "";
  const files = fileCount(extra.files);
  const out = new Map();
  const add = (userId, kind, title, body, email) => {
    if (!userId || userId === c.me.userId || out.has(userId)) return;
    out.set(userId, { kind, title, body, email });
  };
  const ballMoved = Boolean(r.ballInCourtUserId) && r.ballInCourtUserId !== (before?.ballInCourtUserId ?? "");
  if (ballMoved) {
    const title = r.ballInCourtRole !== "manager" ? `${num} needs your answer`
      : r.status === "answered" ? `${num} was answered: please review and close`
      : `${num} is waiting for you`;
    add(r.ballInCourtUserId, "turn", title, `${r.subject}${due} · from ${who}${why}${files}`, true);
  }
  if (event === "answered") add(r.createdByUserId, "decided", `Your ${num} was answered`, `${r.subject} · answered by ${extra.answeredBy || who}${files}`, true);
  if (event === "closed") add(r.createdByUserId, "decided", `Your ${num} was closed`, `${r.subject} · closed by ${who}`, true);
  const info = { submitted: "was raised", answered: "was answered", closed: "was closed", voided: "was voided", reopened: "was reopened" }[event];
  if (info) {
    const others = [...(r.distributionUserIds ?? [])];
    if (event === "closed") others.push(...(r.assigneeUserIds ?? []));
    if (event === "voided") others.push(r.createdByUserId, before?.ballInCourtUserId, ...(r.assigneeUserIds ?? []));
    for (const u of others) add(u, "info", `${num} ${info}`, `${r.subject} · ${who}${why}${files}`, false);
  }
  // A response while the ball stays put: the holder hears about it in the bell.
  if (event === "responded" && !ballMoved) add(r.ballInCourtUserId, "info", `New response on ${num}`, `${r.subject} · ${who}${files}`, false);
  return out;
}

async function tell(db, c, before, r, event, extra = {}) {
  const result = { bell: 0, email: 0, failed: [] };
  try {
    if (r.status === "draft") return result;
    const wanted = notices(c, before, r, event, extra);
    // Only active team members who can open this RFI (subcontractors see only what involves them).
    const ids = [...wanted.keys()].filter((u) => {
      const m = memberOf(c, u);
      return m && canSee(r, { me: { userId: u }, role: m.role, mine: m });
    });
    if (!ids.length) return result;
    const link = `/rfis/${r.ItemId}?project=${c.projectId}`;
    const prefs = await db.list("NotificationPreference", PREF_FIELDS, c.me.tenantRole).catch(() => []);
    // One row per person; if two were ever made, the first by id counts (as in the projects Function).
    const firstPref = new Map();
    for (const p of [...prefs].sort((x, y) => String(x.ItemId).localeCompare(String(y.ItemId)))) if (!firstPref.has(p.userId)) firstPref.set(p.userId, p);
    const emailOff = new Set([...firstPref.values()].filter((p) => p.emailEnabled === false).map((p) => p.userId));
    const groups = new Map();
    for (const u of ids) {
      const n = wanted.get(u);
      const key = `${n.kind}\n${n.title}\n${n.body}`;
      if (!groups.has(key)) groups.set(key, { n, users: [] });
      groups.get(key).users.push(u);
    }
    const tasks = [];
    for (const { n, users } of groups.values()) {
      tasks.push(db.notify(users, { title: n.title, body: n.body, link, projectId: c.projectId, kind: `rfi.${n.kind}` }).then(() => { result.bell += users.length; }));
    }
    for (const u of ids) {
      const n = wanted.get(u);
      const m = memberOf(c, u);
      if (!n.email || emailOff.has(u) || !m.email) continue;
      const subject = `${c.project.number ? `[${c.project.number}] ` : ""}${n.title}`;
      tasks.push(db.mail(m.email, subject, {
        DisplayName: html(m.displayName || ""),
        Heading: html(n.title),
        Text: html(n.body),
        ProjectName: html(c.project.name || ""),
        ButtonLabel: "Open the RFI",
        ButtonUrl: `${db.appUrl}${link}`,
        SettingsUrl: `${db.appUrl}/inbox?tab=settings`
      }).then(() => { result.email += 1; }));
    }
    for (const x of await Promise.allSettled(tasks)) if (x.status === "rejected") result.failed.push(String(x.reason?.message ?? x.reason).slice(0, 200));
  } catch (error) {
    result.failed.push(String(error?.message ?? error).slice(0, 200));
  }
  return result;
}

async function create(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!projectCan(c.role, "rfi.create")) throw new Refused("NOT_ALLOWED", "Your project role can't raise RFIs.");
  const clientRequestId = text(args.clientRequestId, 64);
  if (!clientRequestId) throw new Refused("BAD_REQUEST", "Missing request id. Reload the page and try again.");
  // A retried request (double click, network retry) returns the RFI the first one made.
  const earlier = await db.list("Rfi", "ItemId", me.tenantRole, { projectId: c.projectId, clientRequestId });
  if (earlier[0]) return { ...(await detail(db, c, earlier[0].ItemId)), created: false };

  const submit = args.submit === true;
  const v = rfiInput(args, {}, c, { submit });
  const attachments = (await acceptAttachments(db, me, c.projectId, args.attachments)) ?? [];
  const now = new Date().toISOString();
  const managerUserId = defaultManager(c);
  const row = {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    clientRequestId,
    ...v,
    attachments,
    status: submit ? "open" : "draft",
    number: "",
    version: 0,
    managerUserId,
    createdByUserId: me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: c.mine.displayName ?? "",
    createdAt: now,
    responseCount: 0,
    isVoided: false,
    ...(submit ? openingBall(c, v, managerUserId) : ball(c, me.userId, "creator"))
  };
  if (submit) {
    const n = await allocateNumber(db, me, c.projectId, "rfi", clientRequestId);
    Object.assign(row, { number: n.number, seq: n.seq, openedDate: now });
  }
  row.searchText = searchTextOf(row);
  row.lastChange = { kind: "created", nonce: crypto.randomUUID(), fromStatus: "", toStatus: row.status, previousBallUserId: "", actorUserId: me.userId, reason: "" };
  const rfiId = await db.insert("Rfi", row);
  const saved = { ...row, ItemId: rfiId };
  const [, notified] = await Promise.all([
    history(db, c, saved, submit ? "submitted" : "draftCreated", (submit ? `${actor(c)} raised ${row.number} and passed it to ${row.ballInCourtName || "the manager"}` : `${actor(c)} saved a draft`) + withFiles(attachments.length), { toStatus: row.status }),
    submit ? tell(db, c, undefined, saved, "submitted", { files: attachments.length }) : undefined
  ]);
  return { ...(await detail(db, c, saved)), created: true, notified };
}

async function edit(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  if (!abilities(r, c).edit) throw new Refused("NOT_ALLOWED", r.status === "draft" ? "Only the creator or the Project Manager edits a draft." : "Only the Project Manager or the RFI manager edits an RFI after it is submitted.");
  const changes = rfiInput(args.changes ?? {}, r, c, { submit: r.status !== "draft" });
  const kept = r.attachments ?? [];
  const attachments = await acceptAttachments(db, me, c.projectId, args.changes?.attachments, kept);
  if (attachments) {
    // Once submitted, an RFI's files are part of the record: more can be added, none removed.
    if (r.status !== "draft" && kept.some((a) => !attachments.some((x) => x.fileId === a.fileId))) {
      throw new Refused("FILES_LOCKED", "Files on a submitted RFI stay with it. You can add more, but not remove them.");
    }
    changes.attachments = attachments;
  }
  // The ball holder was an assignee who is no longer one: the ball moves to the first assignee.
  if (r.ballInCourtRole === "assignee" && !changes.assigneeUserIds.includes(r.ballInCourtUserId)) Object.assign(changes, ball(c, changes.assigneeUserIds[0], "assignee"));
  const changed = Object.keys(changes).filter((k) => JSON.stringify(changes[k]) !== JSON.stringify(r[k]));
  if (!changed.length) return detail(db, c, r);
  const saved = await save(db, c, r, changes, "edited");
  await history(db, c, saved, "edited", `${actor(c)} edited ${label(saved)} (${changed.filter((k) => !k.startsWith("ballInCourt")).map((k) => (k === "attachments" ? "files" : k)).join(", ")})`);
  return detail(db, c, saved);
}

async function submit(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  if (!abilities(r, c).submit) throw new Refused("NOT_ALLOWED", r.status === "draft" ? "Only the creator or the Project Manager submits a draft." : "This RFI is already submitted.");
  const v = rfiInput({}, r, c, { submit: true });
  if (v.dueDate < c.today) throw new Refused("DUE_DATE_IN_PAST", "The due date has passed. Choose a new one before submitting.");
  const managerUserId = r.managerUserId || defaultManager(c);
  const n = await allocateNumber(db, me, c.projectId, "rfi", r.ItemId);
  const now = new Date().toISOString();
  // If two people submit the same draft at once, the loser's number stays unused (a gap in the
  // log). Rare enough to accept; the number is claimed with this RFI's id, so it can be traced.
  const saved = await save(db, c, r, { status: "open", number: n.number, seq: n.seq, openedDate: now, managerUserId, ...openingBall(c, v, managerUserId) }, "statusChanged");
  const [, notified] = await Promise.all([
    history(db, c, saved, "submitted", `${actor(c)} submitted ${saved.number} to ${saved.ballInCourtName || "the manager"}`, { fromStatus: "draft", toStatus: "open" }),
    tell(db, c, r, saved, "submitted")
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

async function reassign(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  if (!abilities(r, c).reassign) throw new Refused("NOT_ALLOWED", "Only the Project Manager, the RFI manager or a GC creator passes the ball.");
  const to = String(args.toUserId ?? "");
  const m = memberOf(c, to);
  if (!m) throw new Refused("ASSIGNEE_NOT_MEMBER", "Choose someone on the project team.");
  if (m.role === "owner-viewer") throw new Refused("ASSIGNEE_NOT_ALLOWED", "Owners read RFIs but don't answer them.");
  if (to === r.ballInCourtUserId) return detail(db, c, r);
  const note = text(args.note, 1000);
  const saved = await save(db, c, r, ball(c, to, to === r.managerUserId ? "manager" : "assignee"), "ballChanged", { reason: note });
  const [, notified] = await Promise.all([
    history(db, c, saved, "ballChanged", `${actor(c)} passed the ball from ${r.ballInCourtName || "nobody"} to ${saved.ballInCourtName}`, { reason: note || undefined }),
    tell(db, c, r, saved, "ballChanged", { reason: note })
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

// Marks one response official (and any earlier one not), then moves the RFI to answered.
async function setOfficial(db, c, r, response, extraChanges = {}) {
  const now = new Date().toISOString();
  const previous = r.officialResponseId && r.officialResponseId !== response.ItemId ? r.officialResponseId : "";
  await db.update("RfiResponse", response.ItemId, c.me.tenantRole, { isOfficial: true, markedOfficialByUserId: c.me.userId, markedOfficialAt: now });
  try {
    const saved = await save(db, c, r, {
      ...extraChanges,
      status: "answered",
      officialResponseId: response.ItemId,
      officialAnswerText: response.body,
      ...(r.answeredDate ? {} : { answeredDate: now }),
      ...ball(c, r.managerUserId, "manager")
    }, "statusChanged");
    if (previous) await db.update("RfiResponse", previous, c.me.tenantRole, { isOfficial: false }).catch(() => undefined);
    return saved;
  } catch (error) {
    await db.update("RfiResponse", response.ItemId, c.me.tenantRole, { isOfficial: false }).catch(() => undefined);
    throw error;
  }
}

async function respond(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  let r = await loadRfi(db, c, args.rfiId);
  const before = r;
  const can = abilities(r, c);
  if (!can.respond) {
    throw new Refused("NOT_ALLOWED_TO_RESPOND", r.status === "draft" ? "Submit the draft before anyone responds." : !ACTIVE.includes(r.status) ? `This RFI is ${r.status}.` : "You can respond when the RFI is assigned to you.");
  }
  const body = String(args.body ?? "").trim();
  const official = args.asOfficial === true;
  const attachments = (await acceptAttachments(db, me, c.projectId, args.attachments)) ?? [];
  // A photo alone is a fine reply; an official answer always needs words.
  if (!body && (official || !attachments.length)) throw new Refused("BAD_BODY", official ? "Write the answer before marking it official." : "Write a response or add a file first.");
  if (body.length > 10000) throw new Refused("TOO_LONG", "A response can be at most 10 000 characters.");
  if (official && !(can.markOfficial || can.markOfficialOwn)) throw new Refused("OFFICIAL_NOT_ALLOWED", "Your role can't mark an answer as official.");
  const now = new Date().toISOString();
  const responseId = await db.insert("RfiResponse", {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    rfiId: r.ItemId,
    rfiNumber: r.number,
    body,
    authorUserId: me.userId,
    authorCompanyId: c.mine.companyId ?? "",
    authorName: c.mine.displayName ?? "",
    authorRole: c.role,
    postedAt: now,
    isOfficial: false,
    source: "app",
    attachments,
    isVoided: false
  });
  const response = { ItemId: responseId, body, authorUserId: me.userId };
  // The response is stored; the RFI's counters follow. If someone changed the RFI meanwhile, read
  // it again and retry, so the response is never left uncounted.
  for (let attempt = 1; ; attempt += 1) {
    const changes = { responseCount: Number(r.responseCount ?? 0) + 1, lastResponseAt: now };
    // The assignee holding the ball answered: it goes to the manager to review.
    if (r.ballInCourtUserId === me.userId && r.ballInCourtRole === "assignee" && r.managerUserId && r.managerUserId !== me.userId) Object.assign(changes, ball(c, r.managerUserId, "manager"));
    try {
      if (official) r = await setOfficial(db, c, r, response, changes);
      else r = await save(db, c, r, changes, "responded");
      break;
    } catch (error) {
      if (!(error instanceof Refused) || error.code !== "STATE_CHANGED" || attempt >= 3) throw error;
      r = await loadRfi(db, c, r.ItemId);
    }
  }
  const [, notified] = await Promise.all([
    history(db, c, r, official ? "answeredOfficially" : "responded", (official ? `${actor(c)} answered ${label(r)} and marked the answer official` : `${actor(c)} responded`) + withFiles(attachments.length), official ? { toStatus: "answered" } : {}),
    tell(db, c, before, r, official ? "answered" : "responded", { files: attachments.length })
  ]);
  return { ...(await detail(db, c, r)), notified };
}

async function markOfficial(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  const can = abilities(r, c);
  const rows = await db.list("RfiResponse", RESPONSE_FIELDS, me.tenantRole, { projectId: c.projectId, rfiId: r.ItemId, ItemId: String(args.responseId ?? "") });
  const response = rows.find((x) => !x.isVoided);
  if (!response) throw new Refused("NOT_FOUND", "This response doesn't exist.");
  if (!(can.markOfficial || (can.markOfficialOwn && response.authorUserId === me.userId))) {
    throw new Refused("OFFICIAL_NOT_ALLOWED", "Only the Project Manager, the RFI manager, or a designer for their own answer marks it official.");
  }
  if (r.officialResponseId === response.ItemId && r.status === "answered") return detail(db, c, r);
  const saved = await setOfficial(db, c, r, response);
  const whose = response.authorUserId === me.userId ? "their own answer" : `the answer by ${response.authorName || "someone"}`;
  const [, notified] = await Promise.all([
    history(db, c, saved, "officialAnswer", `${actor(c)} marked ${whose} as official`, { fromStatus: r.status, toStatus: "answered" }),
    tell(db, c, r, saved, "answered", { answeredBy: response.authorName })
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

const requireReason = (args) => {
  const reason = text(args.reason, 1000);
  if (!reason) throw new Refused("REASON_REQUIRED", "Give a reason.");
  return reason;
};

async function clearOfficial(db, c, r) {
  if (r.officialResponseId) await db.update("RfiResponse", r.officialResponseId, c.me.tenantRole, { isOfficial: false }).catch(() => undefined);
}

async function askAgain(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  if (!abilities(r, c).askAgain) throw new Refused("NOT_ALLOWED", "Only the Project Manager or the RFI manager sends an answered RFI back.");
  const reason = requireReason(args);
  const to = String(args.toUserId ?? "") || (r.assigneeUserIds ?? []).find((u) => memberOf(c, u)) || "";
  if (!memberOf(c, to)) throw new Refused("ASSIGNEE_NOT_MEMBER", "Choose who should answer again.");
  const saved = await save(db, c, r, { status: "open", officialResponseId: "", officialAnswerText: "", ...ball(c, to, "assignee") }, "statusChanged", { reason });
  await clearOfficial(db, c, r);
  const [, notified] = await Promise.all([
    history(db, c, saved, "askedAgain", `${actor(c)} asked ${saved.ballInCourtName} again`, { reason, fromStatus: "answered", toStatus: "open" }),
    tell(db, c, r, saved, "askedAgain", { reason })
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

async function close(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  const can = abilities(r, c);
  if (!can.close) {
    if (r.status === "closed") return detail(db, c, r); // a double click
    throw new Refused(r.status === "answered" && !r.officialResponseId ? "OFFICIAL_ANSWER_REQUIRED" : "NOT_ALLOWED", r.status !== "answered" ? "Only an answered RFI can be closed." : !r.officialResponseId ? "Mark a response as the official answer first." : "Only the Project Manager or the creator closes an RFI.");
  }
  const saved = await save(db, c, r, { status: "closed", closedDate: new Date().toISOString(), closedByUserId: me.userId, ...NO_BALL }, "statusChanged");
  const [, notified] = await Promise.all([
    history(db, c, saved, "closed", `${actor(c)} closed ${label(saved)}`, { fromStatus: "answered", toStatus: "closed" }),
    tell(db, c, r, saved, "closed")
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

async function reopen(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  if (!abilities(r, c).reopen) throw new Refused("NOT_ALLOWED", r.status === "closed" ? "Only the Project Manager reopens an RFI." : "Only a closed RFI can be reopened.");
  const reason = requireReason(args);
  const to = String(args.toUserId ?? "") || (r.assigneeUserIds ?? []).find((u) => memberOf(c, u)) || r.managerUserId;
  const saved = await save(db, c, r, { status: "open", officialResponseId: "", officialAnswerText: "", ...ball(c, to, to === r.managerUserId ? "manager" : "assignee") }, "statusChanged", { reason });
  await clearOfficial(db, c, r);
  const [, notified] = await Promise.all([
    history(db, c, saved, "reopened", `${actor(c)} reopened ${label(saved)}`, { reason, fromStatus: "closed", toStatus: "open" }),
    tell(db, c, r, saved, "reopened", { reason })
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

async function voidRfi(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const r = await loadRfi(db, c, args.rfiId);
  if (!abilities(r, c).void) {
    throw new Refused("NOT_ALLOWED", r.status === "draft" ? "Only the creator or the Project Manager voids a draft." : r.status === "closed" || r.status === "void" ? `A ${r.status} RFI can't be voided.` : "Only the Project Manager voids a submitted RFI.");
  }
  const reason = requireReason(args);
  const saved = await save(db, c, r, { status: "void", isVoided: true, voidReason: reason, ...NO_BALL }, "statusChanged", { reason });
  const [, notified] = await Promise.all([
    history(db, c, saved, "voided", `${actor(c)} voided ${label(saved)}`, { reason, fromStatus: r.status, toStatus: "void" }),
    r.status === "draft" ? undefined : tell(db, c, r, saved, "voided", { reason })
  ]);
  return { ...(await detail(db, c, saved)), notified };
}

async function get(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  return detail(db, c, String(args.rfiId ?? ""));
}

// ---------- files (Part 3) ----------
// Download links for the files of an RFI and its responses: { fileId: link }, valid for the
// storage's download expiry. Only ever built after loadRfi() said the caller may see the RFI.
// A storage hiccup leaves the links out instead of failing the page (the files show, without links).
async function fileLinksFor(db, r, responses) {
  const ids = [];
  for (const a of [...(r.attachments ?? []), ...responses.flatMap((x) => x.attachments ?? [])]) ids.push(a.fileId, a.thumbnailFileId);
  if (!ids.some(Boolean)) return {};
  return db.downloadUrls(ids).catch(() => ({}));
}

// Upload links: for a new RFI (anyone who may raise one), or for an RFI the caller may edit or
// answer. The files are attached when the RFI or the response is saved.
async function uploadLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (args.rfiId) {
    const r = await loadRfi(db, c, args.rfiId);
    const can = abilities(r, c);
    if (!(can.edit || can.respond)) throw new Refused("NOT_ALLOWED", "You can add files while you can edit or answer this RFI.");
  } else if (!projectCan(c.role, "rfi.create")) {
    throw new Refused("NOT_ALLOWED", "Your project role can't raise RFIs.");
  }
  return { ok: true, uploads: await issueUploads(db, me, c.projectId, args.files, "rfi") };
}

// Fresh download links (the page asks again when the ones it has are about to run out).
async function fileLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const r = await loadRfi(db, c, args.rfiId);
  const responses = (await db.list("RfiResponse", RESPONSE_FIELDS, me.tenantRole, { projectId: c.projectId, rfiId: r.ItemId })).filter((x) => !x.isVoided);
  return { ok: true, files: await fileLinksFor(db, r, responses) };
}

// ---------- reminders (Part 4, RFI-05; docs/architecture/03-rfis.md §4.7) ----------
// Run only by the hourly `rfi-reminders` workflow (and by a Blocks project admin's
// `blocks logic function test`): see handler(). A person's call can never start it, because it is
// not one of the actions people can name.
// For every active project where it is a working day and 07:00 or later (project timezone):
// - due soon: an open RFI due within 2 working days, not yet reminded for this due date
//   → whoever holds the ball (bell + email);
// - overdue: an open RFI past its due date, not yet reminded today → the ball holder, every working
//   day until it moves (bell + email);
// - the RFI manager: one list of the RFIs that became overdue notices in this run, apart from the
//   ones whose ball they hold themselves (bell + email).
// The marker (dueSoonNotifiedFor / overdueNoticeLastDate) is written BEFORE sending: a crash then
// loses that day's notice instead of sending it twice. Runs that Blocks skips are caught up: the
// next run tells whatever was not told yet today. Emails follow the person's settings (email on,
// and reminder emails on); the bell always rings. Answered, closed, void and draft RFIs never remind.
const REMINDER_HOUR = 7;
const DUE_SOON_DAYS = 2;
const REMINDER_BUDGET_MS = 22_000;

function workingDaysBetween(from, to) {
  let count = 0;
  let d = String(from).slice(0, 10);
  const end = String(to).slice(0, 10);
  while (d < end) {
    d = addDays(d, 1);
    if (weekday(d) !== 0 && weekday(d) !== 6) count += 1;
  }
  return count;
}

function hourIn(timeZone) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  } catch {
    return new Date().getUTCHours();
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What the reminder says, and to whom. `c` is a project context for the service (no caller).
function reminderFor(r, c) {
  const today = c.today;
  const holder = r.ballInCourtUserId && memberOf(c, r.ballInCourtUserId) ? r.ballInCourtUserId : "";
  // Nobody (or someone who left the team) holds the ball: the manager, else every PM, hears instead.
  const to = holder ? [holder]
    : r.managerUserId && memberOf(c, r.managerUserId) ? [r.managerUserId]
    : c.active.filter((m) => m.role === "project-manager").map((m) => m.userId);
  const num = r.number || "An RFI";
  const waiting = r.ballInCourtRole === "manager" ? "waiting for your review" : "waiting for your answer";
  if (r.dueDate < today) {
    const late = workingDaysBetween(r.dueDate, today);
    return { kind: "overdue", to, late, title: `${num} is ${plural(late, "working day")} overdue`, body: `${r.subject} · was due ${shortDate(r.dueDate)} · ${waiting}` };
  }
  const left = workingDaysBetween(today, r.dueDate);
  const when = left === 0 ? "today" : `in ${plural(left, "working day")}`;
  return { kind: "due", to, left, title: `${num} is due ${when}`, body: `${r.subject} · due ${shortDate(r.dueDate)} · ${waiting}` };
}

async function remindProject(db, project, rfis, now, out, options) {
  const tenantRole = project.tenantRole;
  const today = todayIn(project.timezone);
  const team = await db.list("ProjectMember", TEAM_FIELDS, tenantRole, { projectId: project.ItemId });
  const c = { me: { userId: "", tenantRole }, project, projectId: project.ItemId, active: team.filter((m) => m.status === "active"), today };
  const due = [];
  for (const r of rfis) {
    if (r.status !== "open" || r.isVoided || !DATE.test(String(r.dueDate ?? ""))) continue;
    if (r.dueDate < today) {
      if (r.overdueNoticeLastDate !== today) due.push(r);
    } else if (workingDaysBetween(today, r.dueDate) <= DUE_SOON_DAYS && r.dueSoonNotifiedFor !== r.dueDate) {
      due.push(r);
    }
  }
  if (!due.length) return;
  const prefs = await db.list("NotificationPreference", "ItemId userId emailEnabled reminderEmails", tenantRole).catch(() => []);
  const firstPref = new Map();
  for (const p of [...prefs].sort((x, y) => String(x.ItemId).localeCompare(String(y.ItemId)))) if (!firstPref.has(p.userId)) firstPref.set(p.userId, p);
  const emailsOn = (u) => firstPref.get(u)?.emailEnabled !== false && firstPref.get(u)?.reminderEmails !== false;
  const send = async (userIds, n, link, kind) => {
    const ids = userIds.filter((u) => {
      const m = memberOf(c, u);
      return m && (kind === "rfi.digest" || canSee(n.rfi, { me: { userId: u }, role: m.role, mine: m }));
    });
    if (!ids.length || options.dryRun) {
      out.planned.push({ project: project.number, kind, title: n.title, people: ids.length });
      return;
    }
    const tasks = [db.notify(ids, { title: n.title, body: n.body, link, projectId: c.projectId, kind }).then(() => { out.bell += ids.length; })];
    for (const u of ids) {
      const m = memberOf(c, u);
      if (!m.email || !emailsOn(u)) continue;
      tasks.push(db.mail(m.email, `${project.number ? `[${project.number}] ` : ""}${n.title}`, {
        DisplayName: html(m.displayName || ""),
        Heading: html(n.title),
        Text: html(n.body),
        ProjectName: html(project.name || ""),
        ButtonLabel: kind === "rfi.digest" ? "Open the overdue RFIs" : "Open the RFI",
        ButtonUrl: `${db.appUrl}${link}`,
        SettingsUrl: `${db.appUrl}/inbox?tab=settings`
      }).then(() => { out.email += 1; }));
    }
    for (const x of await Promise.allSettled(tasks)) if (x.status === "rejected") out.failed.push(String(x.reason?.message ?? x.reason).slice(0, 200));
  };
  const overdueByManager = new Map();
  for (const r of due) {
    if (Date.now() - now > REMINDER_BUDGET_MS) {
      out.leftForNextRun += 1;
      continue;
    }
    const n = { ...reminderFor(r, c), rfi: r };
    // Claim first: a second run (or the retry of this one) finds the marker and skips the RFI.
    if (!options.dryRun) {
      const marker = n.kind === "overdue" ? { overdueNoticeLastDate: today } : { dueSoonNotifiedFor: r.dueDate };
      const claimed = await db.updateWhere("Rfi", { ItemId: { eq: r.ItemId }, version: { eq: Number(r.version ?? 0) } }, tenantRole, marker);
      if (claimed !== 1) continue; // changed meanwhile (answered, moved…): the next run decides again
    }
    out[n.kind === "overdue" ? "overdue" : "dueSoon"] += 1;
    await send(n.to, n, `/rfis/${r.ItemId}?project=${c.projectId}`, n.kind === "overdue" ? "rfi.overdue" : "rfi.due");
    if (n.kind === "overdue") {
      const manager = r.managerUserId && memberOf(c, r.managerUserId) ? r.managerUserId : "";
      if (manager && !n.to.includes(manager)) {
        if (!overdueByManager.has(manager)) overdueByManager.set(manager, []);
        overdueByManager.get(manager).push({ r, late: n.late });
      }
    }
  }
  for (const [manager, items] of overdueByManager) {
    items.sort((a, b) => b.late - a.late);
    const shown = items.slice(0, 6).map(({ r, late }) => `${r.number} (${plural(late, "day")}, ${r.ballInCourtName || "nobody"})`);
    const more = items.length > shown.length ? ` · and ${items.length - shown.length} more` : "";
    const n = {
      title: `${plural(items.length, "RFI")} overdue on ${project.number || project.name}`,
      body: `${shown.join(" · ")}${more}`,
      rfi: items[0].r
    };
    out.digests += 1;
    await send([manager], n, `/rfis?project=${c.projectId}&overdue=1`, "rfi.digest");
  }
}

async function runReminders(ctx, options = {}) {
  const now = Date.now();
  const out = { ok: true, projects: 0, dueSoon: 0, overdue: 0, digests: 0, bell: 0, email: 0, leftForNextRun: 0, failed: [], planned: [] };
  try {
    const db = client(ctx, await serviceToken(ctx));
    // Every company's open RFIs in one read (filtered on the server); then per project.
    const data = await db.gql(
      "query q($input: DynamicQueryInput) { getRfis(input: $input) { items { tenantRole dueSoonNotifiedFor overdueNoticeLastDate " + RFI_FIELDS + " } } }",
      { input: { pageNo: 1, pageSize: 1000, filter: JSON.stringify({ status: "open" }) } }
    );
    const open = (data?.getRfis?.items ?? []).filter((r) => r.status === "open" && r.dueDate);
    if (!open.length) return out;
    const projects = await db.listAll("Project", "ItemId number name status timezone");
    for (const project of projects) {
      if (project.status === "archived") continue;
      const today = todayIn(project.timezone);
      if (!options.anyTime && (weekday(today) === 0 || weekday(today) === 6)) continue;
      if (!options.anyTime && hourIn(project.timezone) < REMINDER_HOUR) continue;
      const rfis = open.filter((r) => r.tenantRole === project.tenantRole && r.projectId === project.ItemId);
      if (!rfis.length) continue;
      if (Date.now() - now > REMINDER_BUDGET_MS) {
        out.leftForNextRun += rfis.length;
        continue;
      }
      out.projects += 1;
      await remindProject(db, project, rfis, now, out, options);
    }
  } catch (error) {
    ctx.log.error("rfis reminders failed", { message: error.message });
    out.ok = false;
    out.failed.push(String(error?.message ?? error).slice(0, 200));
  }
  ctx.log.info("rfis reminders", { ...out, planned: out.planned.length });
  if (!options.dryRun) delete out.planned;
  return out;
}

export default async function handler(input, ctx) {
  // The hourly reminder workflow. `ctx.run.invokedBy` is set by Blocks, not by the caller, so an
  // app user can't start this. A project admin's test run may ask for a dry run (nothing written
  // or sent) and ignore the working-day and 07:00 rules (anyTime).
  const by = ctx.run?.invokedBy?.type;
  if (by === "workflow") return runReminders(ctx);
  if (by === "test" && input?.action === "reminders") return runReminders(ctx, { dryRun: input.dryRun === true, anyTime: input.anyTime === true });
  return handle(input, ctx, "rfis", {
    list: (args, { db, me }) => list(db, me, args),
    get: (args, { db, me }) => get(db, me, args),
    create: (args, { db, me }) => create(db, me, args),
    edit: (args, { db, me }) => edit(db, me, args),
    submit: (args, { db, me }) => submit(db, me, args),
    reassign: (args, { db, me }) => reassign(db, me, args),
    respond: (args, { db, me }) => respond(db, me, args),
    markOfficial: (args, { db, me }) => markOfficial(db, me, args),
    askAgain: (args, { db, me }) => askAgain(db, me, args),
    close: (args, { db, me }) => close(db, me, args),
    reopen: (args, { db, me }) => reopen(db, me, args),
    void: (args, { db, me }) => voidRfi(db, me, args),
    uploadLinks: (args, { db, me }) => uploadLinks(db, me, args),
    fileLinks: (args, { db, me }) => fileLinks(db, me, args)
  });
}
