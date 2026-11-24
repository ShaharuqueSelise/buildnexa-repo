// Projects (Phase 1): create a project and manage its team, as on the demo app's All projects and
// Directory pages. Reading projects and teams needs no Function: the app reads them directly
// (Project and ProjectMember are readable by everyone in the company organization).
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "create", number, name, clientName?, projectType?, street, city, startDate, endDate,
//     timezone, stage, contractValue?, team?: [{ orgMemberId, role }] }  -> { projectId }
//   { action: "addMembers", projectId, team: [{ orgMemberId, role }] }
//   { action: "setRole", projectId, projectMemberId, role }
//   { action: "removeMember", projectId, projectMemberId }
//   { action: "notificationSettings" }                       -> { emailEnabled, reminderEmails }
//   { action: "setNotificationSettings", emailEnabled?, reminderEmails? } -> { emailEnabled, reminderEmails }
//     The caller's own notification settings (one row per person per company). Email is on unless
//     they turn it off; the bell is always on. The rfis Function reads them before it emails.
//
// Security (docs/architecture/01 §3, §4.3, §4.4):
// - The caller's company is taken from THEIR token (their one `co-` role). Every read is filtered
//   to it and every write is stamped with it.
// - Create: company admins, or staff whose OrgMember has canCreateProjects. The creator becomes
//   the project's Project Manager.
// - Team changes: company admins (every project) or the project's own Project Manager.
// - Nobody changes or removes themselves; a project always keeps at least one Project Manager.
// - The service password (Blocks secret) is readable by the roles on its access list only, so
//   Blocks stops the run for anyone else before this code starts.
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

const STAGES = ["preconstruction", "construction", "closeout"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ORG_FIELDS = "ItemId userId email displayName firstName lastName companyId companyName companyRelation orgRole canCreateProjects status";
const PM_FIELDS = "ItemId projectId userId orgMemberId displayName companyRelation role status";

const roleNotForPartner = () =>
  new Refused("PARTNER_ROLE", "People from partner companies can be Subcontractor, Designer/Consultant or Owner on a project, not Project Manager, Superintendent or Document Controller.");

const actorName = (orgMembers, me) => {
  const m = orgMembers.find((x) => x.userId === me.userId);
  return m ? personName(m) : undefined;
};

function checkTeam(team) {
  if (!Array.isArray(team)) return [];
  const seen = new Set();
  return team.map((t) => {
    const orgMemberId = String(t?.orgMemberId ?? "");
    const role = String(t?.role ?? "");
    if (!PROJECT_ROLES.includes(role)) throw new Refused("BAD_ROLE", "Choose a project role for every person.");
    if (seen.has(orgMemberId)) throw new Refused("DUPLICATE_PERSON", "A person is listed twice.");
    seen.add(orgMemberId);
    return { orgMemberId, role };
  });
}

function memberRow(me, projectId, m, role, now) {
  return {
    tenantRole: me.tenantRole,
    projectId,
    userId: m.userId,
    orgMemberId: m.ItemId,
    email: m.email,
    displayName: personName(m),
    companyId: m.companyId,
    companyName: m.companyName,
    companyRelation: m.companyRelation,
    role,
    status: "active",
    isBallInCourtEligible: true,
    joinedAt: now
  };
}

// Adds people to a project; someone removed earlier gets their row back with the new role.
async function addTeam(db, me, projectId, team, orgMembers, rows) {
  const now = new Date().toISOString();
  // Check everyone first, so a refused person never leaves the team half added.
  for (const t of team) {
    const m = orgMembers.find((x) => x.ItemId === t.orgMemberId && x.status !== "removed");
    if (!m) throw new Refused("NOT_IN_COMPANY", "One of these people is not in your company. Invite them in Company admin first.");
    if (!mayHoldProjectRole(m.companyRelation, t.role)) throw roleNotForPartner();
  }
  const added = [];
  for (const t of team) {
    const m = orgMembers.find((x) => x.ItemId === t.orgMemberId && x.status !== "removed");
    const existing = rows.find((r) => r.projectId === projectId && r.userId === m.userId);
    if (existing?.status === "active") continue;
    if (existing) await db.update("ProjectMember", existing.ItemId, me.tenantRole, { role: t.role, status: "active", joinedAt: now, removedAt: null, removedReason: null });
    else await db.insert("ProjectMember", memberRow(me, projectId, m, t.role, now));
    added.push({ name: personName(m), role: t.role, userId: m.userId });
  }
  return added;
}

async function create(ctx, db, me, args) {
  const number = String(args.number ?? "").trim();
  const projectName = String(args.name ?? "").trim();
  const street = String(args.street ?? "").trim();
  const city = String(args.city ?? "").trim();
  const startDate = String(args.startDate ?? "");
  const endDate = String(args.endDate ?? "");
  const stage = String(args.stage ?? "preconstruction");
  const contractValue = args.contractValue === undefined || args.contractValue === "" ? undefined : Number(args.contractValue);
  if (!number) throw new Refused("BAD_NUMBER", "Project number is required.");
  if (!projectName) throw new Refused("BAD_NAME", "Name is required.");
  if (!street) throw new Refused("BAD_ADDRESS", "Address is required.");
  if (!DATE.test(startDate) || !DATE.test(endDate)) throw new Refused("BAD_DATES", "Enter a start date and a planned completion date.");
  if (endDate <= startDate) throw new Refused("BAD_DATES", "End date must be after the start date.");
  if (!STAGES.includes(stage)) throw new Refused("BAD_STAGE", "Choose a stage.");
  if (contractValue !== undefined && !(Number.isFinite(contractValue) && contractValue >= 0)) throw new Refused("BAD_VALUE", "Contract value must be a positive number.");
  const team = checkTeam(args.team);

  const [orgMembers, projects, company] = await Promise.all([
    db.list("OrgMember", ORG_FIELDS, me.tenantRole),
    db.list("Project", "ItemId number", me.tenantRole),
    db.list("Company", "ItemId name relation defaultLanguage", me.tenantRole)
  ]);
  const self = orgMembers.find((m) => m.userId === me.userId && m.status !== "removed" && m.status !== "deactivated");
  if (!self) throw new Refused("NOT_IN_COMPANY", "Your account has no member record in this company.");
  const mayCreate = accountCan(me.roles, "project.create") || (accountCan(me.roles, "project.create_when_allowed") && self.canCreateProjects === true);
  if (!mayCreate) throw new Refused("NOT_ALLOWED_TO_CREATE", "Only Company Admins and staff allowed to create projects can do this.");
  if (projects.some((p) => (p.number ?? "").toLowerCase() === number.toLowerCase())) {
    throw new Refused("DUPLICATE_PROJECT_NUMBER", "That project number already exists.");
  }

  const own = company.find((c) => c.relation === "self");
  const projectId = await db.insert("Project", {
    tenantRole: me.tenantRole,
    number,
    name: projectName,
    clientName: String(args.clientName ?? "").trim() || undefined,
    projectType: String(args.projectType ?? "").trim() || undefined,
    address: { street, city, country: "DE" },
    status: "active",
    stage,
    startDate: `${startDate}T00:00:00Z`,
    endDate: `${endDate}T00:00:00Z`,
    currency: "EUR",
    timezone: String(args.timezone ?? "Europe/Berlin"),
    locale: "de-DE",
    defaultLanguage: own?.defaultLanguage || "en",
    contractValue,
    createdByUserId: me.userId,
    settings: { rfiDefaultDueWorkingDays: 7, submittalReviewWorkingDays: 10, punchDefaultDueDays: 7, changeOrderApprover: "owner-viewer", disciplines: [] },
    calendar: { country: "DE", weekendDays: [0, 6], holidays: [] }
  });

  // Number counters (RFI-001, SUB-001, …) exist from the start, so the first records never race
  // to create them.
  await Promise.all(Object.keys(SEQUENCES).map((key) => db.insert("Sequence", sequenceRow(me, projectId, key))));

  // The creator is the Project Manager; the rest of the team as chosen (the creator is skipped there).
  const rows = [];
  const now = new Date().toISOString();
  await db.insert("ProjectMember", memberRow(me, projectId, self, "project-manager", now));
  rows.push({ projectId, userId: self.userId, status: "active" });
  const added = await addTeam(db, me, projectId, team.filter((t) => t.orgMemberId !== self.ItemId), orgMembers, rows);
  const who = personName(self);
  await db.audit(me, { projectId, recordType: "project", recordId: projectId, recordNumber: number, action: "created", actorName: who, summary: `${who} created ${number} ${projectName}` });
  for (const a of added) {
    await db.audit(me, { projectId, recordType: "projectMember", recordId: a.userId, recordNumber: number, action: "memberAdded", actorName: who, after: { role: a.role }, summary: `${who} added ${a.name} as ${a.role}` });
  }
  ctx.log.info("project created", { projectId, team: added.length });
  return { ok: true, projectId, added: added.length };
}

// Company admins may change every project's team; otherwise the caller must hold
// project.manage_members on THIS project (its Project Manager).
async function teamContext(db, me, args) {
  const projectId = String(args.projectId ?? "");
  const [projects, team, orgMembers] = await Promise.all([
    db.list("Project", "ItemId number status", me.tenantRole, { ItemId: projectId }),
    db.list("ProjectMember", PM_FIELDS, me.tenantRole, { projectId }),
    db.list("OrgMember", ORG_FIELDS, me.tenantRole)
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  if (project.status === "archived") throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const mine = team.find((r) => r.userId === me.userId && r.status === "active");
  if (!accountCan(me.roles, "project.manage_members_any") && !projectCan(mine?.role, "project.manage_members")) {
    throw new Refused("NOT_ALLOWED", "Only the Project Manager or a Company Admin can change the team.");
  }
  return { projectId, project, rows: team, team, orgMembers, actor: actorName(orgMembers, me) };
}

function findRow(me, ctx, id) {
  const row = ctx.team.find((r) => r.ItemId === id && r.status === "active");
  if (!row) throw new Refused("NOT_FOUND", "This person is not on the project.");
  if (row.userId === me.userId) throw new Refused("SELF", "You can't change your own project role.");
  return row;
}

function keepOnePm(ctx, row) {
  const pms = ctx.team.filter((r) => r.status === "active" && r.role === "project-manager");
  if (row.role === "project-manager" && pms.length <= 1) throw new Refused("LAST_PM", "A project needs at least one Project Manager. Make someone else Project Manager first.");
}

async function addMembers(db, me, args) {
  const team = checkTeam(args.team);
  if (team.length === 0) throw new Refused("EMPTY", "Choose at least one person.");
  const ctx = await teamContext(db, me, args);
  const added = await addTeam(db, me, ctx.projectId, team, ctx.orgMembers, ctx.rows);
  for (const a of added) {
    await db.audit(me, { projectId: ctx.projectId, recordType: "projectMember", recordId: a.userId, recordNumber: ctx.project.number, action: "memberAdded", actorName: ctx.actor, after: { role: a.role }, summary: `${ctx.actor ?? "Someone"} added ${a.name} as ${a.role}` });
  }
  return { ok: true, added: added.length };
}

async function setRole(db, me, args) {
  const role = String(args.role ?? "");
  if (!PROJECT_ROLES.includes(role)) throw new Refused("BAD_ROLE", "Choose a project role.");
  const ctx = await teamContext(db, me, args);
  const row = findRow(me, ctx, String(args.projectMemberId ?? ""));
  if (!mayHoldProjectRole(row.companyRelation, role)) throw roleNotForPartner();
  if (role !== "project-manager") keepOnePm(ctx, row);
  if (row.role === role) return { ok: true };
  await db.update("ProjectMember", row.ItemId, me.tenantRole, { role });
  await db.audit(me, { projectId: ctx.projectId, recordType: "projectMember", recordId: row.userId, recordNumber: ctx.project.number, action: "roleChanged", actorName: ctx.actor, changedFields: ["role"], before: { role: row.role }, after: { role }, summary: `${ctx.actor ?? "Someone"} changed ${row.displayName ?? "a person"} from ${row.role} to ${role}` });
  return { ok: true };
}

async function removeMember(db, me, args) {
  const ctx = await teamContext(db, me, args);
  const row = findRow(me, ctx, String(args.projectMemberId ?? ""));
  keepOnePm(ctx, row);
  // Records they created stay on the project; only their access to it ends.
  await db.update("ProjectMember", row.ItemId, me.tenantRole, {
    status: "removed",
    removedAt: new Date().toISOString(),
    removedReason: "removed from the project team"
  });
  await db.audit(me, { projectId: ctx.projectId, recordType: "projectMember", recordId: row.userId, recordNumber: ctx.project.number, action: "memberRemoved", actorName: ctx.actor, before: { role: row.role }, summary: `${ctx.actor ?? "Someone"} removed ${row.displayName ?? "a person"} (${row.role}) from the project` });
  return { ok: true };
}

// What a person from a partner company may see: only the projects they are on, those projects'
// teams, the people on them and the companies involved. Company staff read these records directly
// (Data Gateway rules allow staff and admins only), so this is the partners' only way in.
const W_PROJECT = "ItemId number name clientName projectType address { street city } status stage startDate endDate timezone createdByUserId";
const W_TEAM = "ItemId projectId userId orgMemberId email displayName companyId companyName companyRelation role status joinedAt";
const W_PEOPLE = "ItemId userId email displayName firstName lastName phone jobTitle companyId companyName companyRelation orgRole defaultRole status joinedAt";
const W_COMPANY = "ItemId name relation brandColor isVoided address { city } tradeCodes";

async function workspace(db, me) {
  const [projects, team, people, companies] = await Promise.all([
    db.list("Project", W_PROJECT, me.tenantRole),
    db.list("ProjectMember", W_TEAM, me.tenantRole),
    db.list("OrgMember", W_PEOPLE, me.tenantRole),
    db.list("Company", W_COMPANY, me.tenantRole)
  ]);
  const mine = new Set(team.filter((r) => r.userId === me.userId && r.status === "active").map((r) => r.projectId));
  const myTeam = team.filter((r) => mine.has(r.projectId));
  const onMyProjects = new Set(myTeam.map((r) => r.userId).concat(me.userId));
  const companyIds = new Set(myTeam.map((r) => r.companyId));
  // The caller is signed in, so their account is set up: an invited member record becomes active
  // (the company admin's People list does the same from IAM; partners never open it).
  const self = people.find((m) => m.userId === me.userId && m.status === "invited");
  if (self) {
    const joinedAt = new Date().toISOString();
    try {
      await db.update("OrgMember", self.ItemId, me.tenantRole, { status: "active", joinedAt });
      Object.assign(self, { status: "active", joinedAt });
    } catch {
      // still shown as invited; the next load tries again
    }
  }
  const strip = ({ tenantRole: _t, ...rest }) => rest;
  return {
    ok: true,
    // No contract value: the budget is the Project Manager's.
    projects: projects.filter((p) => mine.has(p.ItemId)).map(strip),
    team: myTeam.map(strip),
    people: people.filter((m) => onMyProjects.has(m.userId)).map(strip),
    companies: companies.filter((c) => c.relation === "self" || companyIds.has(c.ItemId)).map(strip)
  };
}

// ---------- my notification settings ----------
// Email on or off as a whole, and reminder emails (RFI due soon / overdue) on or off; unset = on.
const PREF_FIELDS = "ItemId userId emailEnabled reminderEmails updatedAt";
const settingsOf = (row) => ({ emailEnabled: row?.emailEnabled !== false, reminderEmails: row?.reminderEmails !== false });

async function myPreference(db, me) {
  const rows = await db.list("NotificationPreference", PREF_FIELDS, me.tenantRole, { userId: me.userId });
  return rows.sort((a, b) => String(a.ItemId).localeCompare(String(b.ItemId)))[0];
}

async function notificationSettings(db, me) {
  return { ok: true, ...settingsOf(await myPreference(db, me)) };
}

async function setNotificationSettings(db, me, args) {
  const changes = {};
  if (typeof args.emailEnabled === "boolean") changes.emailEnabled = args.emailEnabled;
  if (typeof args.reminderEmails === "boolean") changes.reminderEmails = args.reminderEmails;
  if (!Object.keys(changes).length) throw new Refused("BAD_REQUEST", "Choose whether you want emails.");
  const row = await myPreference(db, me);
  const values = { ...changes, updatedAt: new Date().toISOString() };
  // Two first saves at once can make two rows; every reader uses the first by id, and so does this.
  if (row) await db.update("NotificationPreference", row.ItemId, me.tenantRole, values);
  else await db.insert("NotificationPreference", { tenantRole: me.tenantRole, userId: me.userId, ...values });
  return { ok: true, ...settingsOf({ ...row, ...changes }) };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "projects", {
    create: (args, { ctx, db, me }) => create(ctx, db, me, args),
    addMembers: (args, { db, me }) => addMembers(db, me, args),
    setRole: (args, { db, me }) => setRole(db, me, args),
    removeMember: (args, { db, me }) => removeMember(db, me, args),
    workspace: (args, { db, me }) => workspace(db, me),
    notificationSettings: (args, { db, me }) => notificationSettings(db, me),
    setNotificationSettings: (args, { db, me }) => setNotificationSettings(db, me, args)
  });
}
