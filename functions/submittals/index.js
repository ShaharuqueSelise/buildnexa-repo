// Submittals, part 1: the server (docs/architecture/04-submittals.md; permissions in
// functions/_shared/permissions.js). Every Submittal, its finished steps (SubmittalReview) and its
// comments are read and written only here: the Data Gateway rules let only the service identity
// touch them, because a rule can't see a person's role or company on ONE project.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list", projectId }                     -> { submittals, role, can, defaults, companies, reviewers, gcReviewers, today }
//   { action: "get", projectId, submittalId }         -> detail
//   { action: "create", projectId, clientRequestId, title, specSection, specSectionTitle?, type,
//     responsibleCompanyId, responsibleUserId?, designReviewerUserId, gcReviewerUserId?,
//     requiredOnSiteDate, leadTimeDays, gcReviewDays?, designReviewDays?, description?,
//     internalNotes?, send? }                         -> detail (+ created: true | false)
//   { action: "edit", projectId, submittalId, version?, changes: { same fields as create } } -> detail
//   { action: "send", projectId, submittalId, version? }                       -> detail
//   { action: "submit", projectId, submittalId, version?, attachments, comment? } -> detail
//   { action: "forward", projectId, submittalId, version?, comment? }          -> detail
//   { action: "returnToSub", projectId, submittalId, version?, comment }       -> detail
//   { action: "decide", projectId, submittalId, version?, decision, comment?, attachments? } -> detail
//   { action: "newRevision" | "void", projectId, submittalId, version?, reason } -> detail
//   { action: "comment", projectId, submittalId, body, attachments? }          -> detail
//   { action: "distribute", projectId, submittalId, userIds, note? }           -> detail (+ sentTo)
//   { action: "uploadLinks", projectId, submittalId, files: [{ name, contentType, sizeBytes }] } -> { uploads }
//   { action: "fileLinks", projectId, submittalId }   -> { files: { fileId: download link } }
// detail = { submittal, can, steps, comments, history, files, linksExpireAt }. Every change answers
// with the fresh detail, so the screen needs no second call.
//
// Flow (04 §5): draft -> awaitingSubmission -> inGcReview -> inDesignReview -> closed, plus void.
// - Send (draft -> awaiting): the PM or the document controller. "Create and send" does both.
// - Submit (awaiting -> GC check): the responsible company's field users, or the PM / document
//   controller on their behalf; at least one file.
// - Forward (GC check -> design review) or Return to the subcontractor with a comment (-> awaiting,
//   same revision, the files stay so they can add the missing ones): the PM or the document controller.
// - Decide: the assigned design reviewer (the PM may decide for the design team). Approved, Approved
//   as noted and Rejected close it; Revise and resubmit opens the next revision (same number) and
//   gives the ball back to the subcontractor. A marked-up file is required for every decision except
//   Approved; a comment for Revise and resubmit and Rejected.
// - New revision after Rejected (-> awaiting, revision + 1): the PM or the document controller.
// - Void, with a reason, from any open state: the PM.
// Ball in court: draft and GC check -> the GC reviewer (document controller); awaiting -> the named
// person of the responsible company, else its first field user; design review -> the design
// reviewer; closed and void -> nobody.
// Dates: submit-by = required on site - lead time (calendar days) - GC days - design days (working
// days, weekends off). Each step's due date: awaiting = submit-by (first time) or 5 working days after
// a return or a new revision; GC check = + GC days; design review = + design days.
//
// Security:
// - The caller must be an active member of the project with a submittal permission. Subcontractors
//   (submittal.view_own) see only their company's submittals; drafts only the PM and the DC.
// - Internal notes go only to submittal.see_internal (PM, superintendent, DC).
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN = ["draft", "awaitingSubmission", "inGcReview", "inDesignReview"];
const ACTIVE_STEP = ["awaitingSubmission", "inGcReview", "inDesignReview"];
const TYPES = ["shopDrawing", "productData", "sample", "mockup", "calculation", "certificate", "warranty", "other"];
const DECISIONS = ["approved", "approvedAsNoted", "reviseResubmit", "rejected"];
const STATUS_LABEL = { draft: "a draft", awaitingSubmission: "waiting for the subcontractor", inGcReview: "with the GC", inDesignReview: "with the design reviewer", closed: "closed", void: "void" };
const DECISION_LABEL = { approved: "Approved", approvedAsNoted: "Approved as noted", reviseResubmit: "Revise and resubmit", rejected: "Rejected" };
const DEFAULT_GC_DAYS = 3;
const DEFAULT_DESIGN_DAYS = 10;
const RESUBMIT_DAYS = 5;
const MAX_LEAD_DAYS = 730;
const MAX_REVIEW_DAYS = 60;
const MAX_DISTRIBUTE = 50;
const LINK_MINUTES = 50;

const ATT = "{ fileId thumbnailFileId fileName contentType sizeBytes uploadedBy uploadedAt }";
const SUB_FIELDS =
  "ItemId projectId number seq version revision clientRequestId title specSection specSectionTitle type status decision " +
  "responsibleCompanyId responsibleUserId gcReviewerUserId designReviewerUserId responsibleCompanyName responsibleName gcReviewerName designReviewerName " +
  "requiredOnSiteDate submitByDate dueDate leadTimeDays gcReviewDays designReviewDays ballInCourtUserId ballInCourtName ballInCourtRole " +
  `files ${ATT} decisionFiles ${ATT} decisionComment description internalNotes createdByUserId createdByCompanyId createdByName ` +
  "createdAt sentAt submittedAt forwardedAt decidedAt stepStartedAt decidedByUserId decidedByName isVoided voidedAt voidedByUserId voidReason";
const REVIEW_FIELDS = `ItemId submittalId revision stepOrder stepType outcome comment attachments ${ATT} actorUserId actorName actorRole startedAt completedAt dueDate isVoided`;
const TEAM_FIELDS = "ItemId userId displayName email companyId companyName companyRelation trade role status joinedAt";
const COMMENT_FIELDS = `ItemId recordId body attachments ${ATT} authorUserId authorCompanyId authorName postedAt isVoided`;
const EVENT_FIELDS = "ItemId recordId action actorUserId actorName at summary reason fromStatus toStatus";
const PREF_FIELDS = "ItemId userId emailEnabled reminderEmails";

// ---------- small helpers ----------
const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const longText = (v, max) => String(v ?? "").trim().slice(0, max);
const expiry = () => new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
const actor = (c) => c.mine.displayName || "Someone";
const html = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shortDate = (iso) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`));
  } catch {
    return String(iso);
  }
};
const fileWord = (n) => `${n} file${n === 1 ? "" : "s"}`;

// ---------- dates (project timezone, weekends off) ----------
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
function addWorkingDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d)) left -= 1;
  }
  return d;
}
function subtractWorkingDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    if (!isWeekend(d)) left -= 1;
  }
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}
/** Required on site - lead time (calendar days) - GC and design review (working days). */
function submitByOf(v) {
  return subtractWorkingDays(addDays(v.requiredOnSiteDate, -v.leadTimeDays), v.gcReviewDays + v.designReviewDays);
}

// ---------- who is asking, on which project ----------
async function projectContext(db, me, projectId, { write = false } = {}) {
  const id = String(projectId ?? "");
  if (!id) throw new Refused("NOT_FOUND", "Choose a project first.");
  const [projects, team] = await Promise.all([
    db.list("Project", "ItemId number name status timezone settings { submittalReviewWorkingDays }", me.tenantRole, { ItemId: id }),
    db.list("ProjectMember", TEAM_FIELDS, me.tenantRole, { projectId: id })
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  const active = team.filter((r) => r.status === "active");
  const mine = active.find((r) => r.userId === me.userId);
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. Submittals are open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const role = mine.role;
  const seesAll = projectCan(role, "submittal.view");
  const seesOwn = projectCan(role, "submittal.view_own");
  if (!seesAll && !seesOwn) throw new Refused("NOT_ALLOWED", "Your project role doesn't include submittals.");
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
    seesOwn,
    manager: projectCan(role, "submittal.manage"),
    uploader: projectCan(role, "submittal.upload_own"),
    reviewer: projectCan(role, "submittal.review"),
    voider: projectCan(role, "submittal.void"),
    commenter: projectCan(role, "submittal.comment"),
    seesInternal: projectCan(role, "submittal.see_internal")
  };
}

const memberOf = (c, userId) => c.active.find((r) => r.userId === userId);
// Designers review; the PM also holds submittal.review but manages the register, so "a design
// reviewer" is someone who reviews without managing.
const isDesigner = (m) => projectCan(m.role, "submittal.review") && !projectCan(m.role, "submittal.manage");

// ---------- visibility and what the caller may do ----------
const ownCompany = (s, companyId) => Boolean(s.responsibleCompanyId) && s.responsibleCompanyId === companyId;

/** May this team member (role, company) see this submittal? Drafts: the register managers only. */
function memberSees(m, s) {
  if (!m) return false;
  if (s.status === "draft") return projectCan(m.role, "submittal.manage");
  if (projectCan(m.role, "submittal.view")) return true;
  return projectCan(m.role, "submittal.view_own") && ownCompany(s, m.companyId);
}
const canSee = (s, c) => memberSees(c.mine, s);

function abilities(s, c) {
  const st = s.status;
  const open = !c.archived;
  const live = open && OPEN.includes(st);
  const own = c.uploader && ownCompany(s, c.mine.companyId);
  return {
    edit: live && c.manager,
    send: open && st === "draft" && c.manager,
    submit: open && st === "awaitingSubmission" && (own || c.manager),
    onBehalf: open && st === "awaitingSubmission" && c.manager && !own,
    forward: open && st === "inGcReview" && c.manager,
    returnToSub: open && st === "inGcReview" && c.manager,
    decide: open && st === "inDesignReview" && c.reviewer && (s.designReviewerUserId === c.me.userId || c.manager),
    newRevision: open && st === "closed" && s.decision === "rejected" && c.manager,
    void: live && c.voider,
    comment: open && st !== "void" && c.commenter && (c.seesAll || own),
    distribute: open && st === "closed" && c.manager,
    seeInternal: c.seesInternal
  };
}

// ---------- the people ----------
// The field users of a company on this project, the longest on the team first.
function fieldUsersOf(c, companyId) {
  return c.active
    .filter((m) => m.companyId === companyId && projectCan(m.role, "submittal.upload_own"))
    .sort((a, b) => String(a.joinedAt ?? "").localeCompare(String(b.joinedAt ?? "")) || String(a.displayName ?? "").localeCompare(String(b.displayName ?? "")));
}

// The companies a submittal can go to: every company with a field user on the team.
function companiesOf(c) {
  const out = new Map();
  for (const m of c.active) {
    if (!projectCan(m.role, "submittal.upload_own") || !m.companyId) continue;
    if (!out.has(m.companyId)) out.set(m.companyId, { companyId: m.companyId, companyName: m.companyName ?? "", trade: m.trade ?? "", people: [] });
    out.get(m.companyId).people.push({ userId: m.userId, displayName: m.displayName ?? "" });
  }
  return [...out.values()].sort((a, b) => a.companyName.localeCompare(b.companyName));
}

const personRow = (m) => ({ userId: m.userId, displayName: m.displayName ?? "", companyName: m.companyName ?? "", role: m.role });
const reviewersOf = (c) => c.active.filter(isDesigner).map(personRow);
const gcReviewersOf = (c) => c.active.filter((m) => projectCan(m.role, "submittal.manage")).map(personRow);

function responsibleOf(c, companyId, userId) {
  const company = String(companyId ?? "");
  const people = company ? fieldUsersOf(c, company) : [];
  if (!people.length) throw new Refused("COMPANY_NOT_ON_PROJECT", "Choose a subcontractor that has people on this project's team.");
  let person;
  if (userId) {
    person = people.find((m) => m.userId === String(userId));
    if (!person) throw new Refused("CONTACT_NOT_IN_COMPANY", "The contact must be a field user of that company on this project.");
  }
  return {
    responsibleCompanyId: company,
    responsibleCompanyName: people[0].companyName ?? "",
    responsibleUserId: person?.userId ?? "",
    responsibleName: person?.displayName ?? ""
  };
}

function designReviewerOf(c, userId) {
  const m = memberOf(c, String(userId ?? ""));
  if (!m || !isDesigner(m)) {
    throw new Refused(reviewersOf(c).length ? "REVIEWER_NOT_ON_PROJECT" : "NO_REVIEWER", reviewersOf(c).length
      ? "Choose a design reviewer from this project's team."
      : "This project has no design reviewer yet. Add one to the team first.");
  }
  return { designReviewerUserId: m.userId, designReviewerName: m.displayName ?? "" };
}

// The GC check: the named PM or document controller, else the first document controller, else the caller.
function gcReviewerOf(c, userId) {
  if (userId) {
    const m = memberOf(c, String(userId));
    if (!m || !projectCan(m.role, "submittal.manage")) throw new Refused("GC_REVIEWER_NOT_ALLOWED", "The GC check is done by a project manager or a document controller on this project.");
    return { gcReviewerUserId: m.userId, gcReviewerName: m.displayName ?? "" };
  }
  const dc = c.active
    .filter((m) => projectCan(m.role, "submittal.manage") && !projectCan(m.role, "submittal.void"))
    .sort((a, b) => String(a.joinedAt ?? "").localeCompare(String(b.joinedAt ?? "")))[0];
  const m = dc ?? c.mine;
  return { gcReviewerUserId: m.userId, gcReviewerName: m.displayName ?? "" };
}

const NO_BALL = { ballInCourtUserId: "", ballInCourtName: "", ballInCourtRole: "none" };

// Who holds the ball in the submittal's (new) status.
function ballOf(c, s) {
  const pick = (m, role) => (m ? { ballInCourtUserId: m.userId, ballInCourtName: m.displayName ?? "", ballInCourtRole: role } : NO_BALL);
  switch (s.status) {
    case "draft":
    case "inGcReview":
      return pick(memberOf(c, s.gcReviewerUserId), "gc");
    case "awaitingSubmission": {
      const named = s.responsibleUserId ? memberOf(c, s.responsibleUserId) : undefined;
      return pick(named && named.companyId === s.responsibleCompanyId ? named : fieldUsersOf(c, s.responsibleCompanyId)[0], "sub");
    }
    case "inDesignReview":
      return pick(memberOf(c, s.designReviewerUserId), "reviewer");
    default:
      return NO_BALL;
  }
}

// ---------- input ----------
function dayCount(v, { min, max, what, fallback }) {
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Refused("BAD_DAYS", `Enter the ${what}.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Refused("BAD_DAYS", `The ${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

function defaultDesignDays(c) {
  const n = Number(c.project.settings?.submittalReviewWorkingDays);
  return Number.isInteger(n) && n > 0 && n <= MAX_REVIEW_DAYS ? n : DEFAULT_DESIGN_DAYS;
}

// The fields people type. `base` is the submittal being edited ({} for a new one).
function submittalInput(args, base, c) {
  const has = (k) => args[k] !== undefined;
  const v = {
    title: has("title") ? text(args.title, 200) : base.title ?? "",
    specSection: has("specSection") ? text(args.specSection, 40) : base.specSection ?? "",
    specSectionTitle: has("specSectionTitle") ? text(args.specSectionTitle, 120) : base.specSectionTitle ?? "",
    type: has("type") ? String(args.type) : base.type ?? "",
    description: has("description") ? longText(args.description, 4000) : base.description ?? "",
    requiredOnSiteDate: has("requiredOnSiteDate") ? String(args.requiredOnSiteDate ?? "").trim() : base.requiredOnSiteDate ?? "",
    leadTimeDays: has("leadTimeDays") ? dayCount(args.leadTimeDays, { min: 0, max: MAX_LEAD_DAYS, what: "lead time" }) : Number(base.leadTimeDays ?? NaN),
    gcReviewDays: has("gcReviewDays") ? dayCount(args.gcReviewDays, { min: 1, max: MAX_REVIEW_DAYS, what: "GC check days", fallback: DEFAULT_GC_DAYS }) : Number(base.gcReviewDays ?? DEFAULT_GC_DAYS),
    designReviewDays: has("designReviewDays") ? dayCount(args.designReviewDays, { min: 1, max: MAX_REVIEW_DAYS, what: "design review days", fallback: defaultDesignDays(c) }) : Number(base.designReviewDays ?? defaultDesignDays(c))
  };
  if (has("internalNotes")) {
    if (!c.seesInternal) throw new Refused("NOT_ALLOWED", "Your role can't write internal notes.");
    v.internalNotes = longText(args.internalNotes, 2000);
  }
  if (v.title.length < 3) throw new Refused("BAD_TITLE", "Give the submittal a title (at least 3 characters).");
  if (!v.specSection) throw new Refused("BAD_SPEC_SECTION", "Enter the spec section, e.g. 08 71 00.");
  if (!TYPES.includes(v.type)) throw new Refused("BAD_TYPE", "Choose what kind of submittal it is.");
  if (!DATE.test(v.requiredOnSiteDate) || !Number.isFinite(Date.parse(`${v.requiredOnSiteDate}T00:00:00Z`))) {
    throw new Refused("BAD_DATE", "Enter the date the material is needed on site.");
  }
  if (!Number.isInteger(v.leadTimeDays)) throw new Refused("BAD_DAYS", "Enter the lead time.");
  v.submitByDate = submitByOf(v);
  return v;
}

const searchTextOf = (s) => [s.number, s.title, s.specSection, s.specSectionTitle, s.responsibleCompanyName, s.designReviewerName].filter(Boolean).join(" ").toLowerCase();

// ---------- reading ----------
async function loadAll(db, c, where = {}) {
  return db.list("Submittal", SUB_FIELDS, c.me.tenantRole, { projectId: c.projectId, ...where });
}

async function loadOne(db, c, submittalId) {
  const [s] = await loadAll(db, c, { ItemId: String(submittalId ?? "") });
  if (!s || !canSee(s, c)) throw new Refused("NOT_FOUND", "This submittal doesn't exist, or you can't open it.");
  return s;
}

function present(s, c) {
  const { tenantRole: _t, clientRequestId: _r, internalNotes, ...out } = s;
  const step = ACTIVE_STEP.includes(s.status);
  return {
    ...out,
    ...(c.seesInternal ? { internalNotes: internalNotes ?? "" } : {}),
    revision: Number(s.revision ?? 0),
    files: s.files ?? [],
    decisionFiles: s.decisionFiles ?? [],
    overdue: step && Boolean(s.dueDate) && s.dueDate < c.today,
    submitLate: (s.status === "draft" || s.status === "awaitingSubmission") && Boolean(s.submitByDate) && s.submitByDate < c.today
  };
}

async function detail(db, c, sOrId) {
  const s = typeof sOrId === "string" ? await loadOne(db, c, sOrId) : sOrId;
  const [steps, comments, events] = await Promise.all([
    db.list("SubmittalReview", REVIEW_FIELDS, c.me.tenantRole, { projectId: c.projectId, submittalId: s.ItemId }).catch(() => []),
    db.list("Comment", COMMENT_FIELDS, c.me.tenantRole, { projectId: c.projectId, recordId: s.ItemId }).catch(() => []),
    db.list("ActivityEvent", EVENT_FIELDS, c.me.tenantRole, { projectId: c.projectId, recordId: s.ItemId }).catch(() => [])
  ]);
  const liveSteps = steps.filter((x) => !x.isVoided).sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  const liveComments = comments.filter((x) => !x.isVoided).sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  return {
    ok: true,
    role: c.role,
    today: c.today,
    linksExpireAt: expiry(),
    submittal: present(s, c),
    can: abilities(s, c),
    steps: liveSteps.map((x) => ({
      ItemId: x.ItemId,
      revision: Number(x.revision ?? 0),
      stepOrder: Number(x.stepOrder ?? 0),
      stepType: x.stepType,
      outcome: x.outcome,
      comment: x.comment ?? "",
      attachments: x.attachments ?? [],
      actorUserId: x.actorUserId,
      actorName: x.actorName ?? "",
      actorRole: x.actorRole ?? "",
      startedAt: x.startedAt,
      completedAt: x.completedAt,
      dueDate: x.dueDate ?? ""
    })),
    comments: liveComments.map((x) => ({ ItemId: x.ItemId, body: x.body, attachments: x.attachments ?? [], authorUserId: x.authorUserId, authorName: x.authorName ?? "", postedAt: x.postedAt })),
    history: events
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((e) => ({ ItemId: e.ItemId, action: e.action, actorName: e.actorName, at: e.at, summary: e.summary, reason: e.reason, fromStatus: e.fromStatus, toStatus: e.toStatus })),
    files: await linksFor(db, [s, liveSteps, liveComments])
  };
}

// Download links for every file of a submittal (its package, markups, steps and comments).
async function linksFor(db, [s, steps, comments]) {
  const ids = [];
  const add = (list) => { for (const a of list ?? []) ids.push(a.fileId, a.thumbnailFileId); };
  add(s.files);
  add(s.decisionFiles);
  for (const x of steps) add(x.attachments);
  for (const x of comments) add(x.attachments);
  const wanted = [...new Set(ids.filter(Boolean))];
  const out = {};
  for (let i = 0; i < wanted.length; i += 100) {
    try {
      Object.assign(out, await db.downloadUrls(wanted.slice(i, i + 100)));
    } catch {
      // the page shows the file name and asks again
    }
  }
  return out;
}

async function list(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const rows = await loadAll(db, c);
  const visible = rows.filter((s) => canSee(s, c)).sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0));
  return {
    ok: true,
    role: c.role,
    archived: c.archived,
    today: c.today,
    can: {
      create: !c.archived && c.manager,
      seesAllCompanies: c.seesAll,
      seeInternal: c.seesInternal
    },
    defaults: { gcReviewDays: DEFAULT_GC_DAYS, designReviewDays: defaultDesignDays(c) },
    companies: c.manager ? companiesOf(c) : [],
    reviewers: c.manager ? reviewersOf(c) : [],
    gcReviewers: c.manager ? gcReviewersOf(c) : [],
    submittals: visible.map((s) => present(s, c))
  };
}

async function get(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  return detail(db, c, String(args.submittalId ?? ""));
}

// ---------- telling people (04 §7) ----------
// Right away, from the change itself (bell + email; emails follow each person's settings):
// - sent (new, or a draft sent)   -> the responsible company's field users;
// - submitted                     -> the GC reviewer;
// - forwarded                     -> the design reviewer;
// - returned / new revision       -> the responsible company's field users, with the comment;
// - decided                       -> the responsible company and the GC reviewer (bell + email),
//                                    the superintendents (bell);
// - reassigned                    -> the new ball holder (or the new company);
// - voided                        -> the responsible company and the design reviewer (bell);
// - distributed                   -> the people the PM or DC picked.
// Nobody is told about their own action, and nobody is told about a submittal they can't open.
const itemLink = (projectId, s) => `/submittals/${s.ItemId}?project=${projectId}`;
const headOf = (s) => `${s.title} · ${s.specSection}`;

function companyPeople(c, s) {
  const people = fieldUsersOf(c, s.responsibleCompanyId);
  const named = people.find((m) => m.userId === s.responsibleUserId);
  return named ? [named, ...people.filter((m) => m !== named)] : people;
}

function noticesFor(c, s, event, extra = {}) {
  const head = headOf(s);
  const rev = `rev ${Number(s.revision ?? 0)}`;
  const why = extra.comment ? ` · “${String(extra.comment).slice(0, 200)}”` : "";
  switch (event) {
    case "sent":
      return [{ kind: "assigned", to: companyPeople(c, s), title: `New submittal ${s.number} for ${s.responsibleCompanyName || "your company"}`, body: `${head} · submit by ${shortDate(s.submitByDate)} · from ${actor(c)}`, email: true }];
    case "submitted":
      return [{ kind: "submitted", to: [memberOf(c, s.gcReviewerUserId)], title: `${s.number} was submitted for your check`, body: `${head} · ${rev} · ${s.responsibleCompanyName} · ${fileWord((s.files ?? []).length)}`, email: true }];
    case "forwarded":
      return [{ kind: "review", to: [memberOf(c, s.designReviewerUserId)], title: `${s.number} is with you for review`, body: `${head} · ${rev} · decision due ${shortDate(s.dueDate)} · from ${actor(c)}`, email: true }];
    case "returned":
      return [{ kind: "returned", to: companyPeople(c, s), title: `${s.number} was returned: something is missing`, body: `${head} · by ${actor(c)}${why}`, email: true }];
    case "newRevision":
      return [{ kind: "returned", to: companyPeople(c, s), title: `${s.number}: ${rev} is open for your resubmission`, body: `${head} · by ${actor(c)}${why}`, email: true }];
    case "decided": {
      const label = DECISION_LABEL[s.decision] ?? s.decision;
      const doneRev = s.decision === "reviseResubmit" ? `rev ${Number(s.revision ?? 0) - 1}` : rev;
      const next = s.decision === "reviseResubmit" ? ` · ${rev} is open for your resubmission` : "";
      const title = `${s.number}: ${label}`;
      const body = `${head} · ${doneRev} · by ${actor(c)}${why}${next}`;
      const supts = c.active.filter((m) => projectCan(m.role, "submittal.see_internal") && !projectCan(m.role, "submittal.manage"));
      return [
        { kind: "decided", to: [...companyPeople(c, s), memberOf(c, s.gcReviewerUserId)], title, body, email: true },
        { kind: "decided", to: supts, title, body, email: false }
      ];
    }
    case "reassigned": {
      const to = extra.to ?? [];
      const mine = s.status === "awaitingSubmission" ? `New submittal ${s.number} for ${s.responsibleCompanyName || "your company"}` : s.status === "inDesignReview" ? `${s.number} is with you for review` : `${s.number} is with you`;
      return [{ kind: "assigned", to, title: mine, body: `${head} · ${rev}${s.dueDate ? ` · due ${shortDate(s.dueDate)}` : ""} · from ${actor(c)}`, email: true }];
    }
    case "voided":
      return [{ kind: "voided", to: [...companyPeople(c, s), memberOf(c, s.designReviewerUserId)], title: `${s.number} was voided`, body: `${head} · by ${actor(c)}${why}`, email: false }];
    case "distributed": {
      const label = DECISION_LABEL[s.decision] ?? s.decision;
      return [{ kind: "decided", to: extra.to ?? [], title: `${s.number}: ${label}`, body: `${head} · ${rev} · sent to you by ${actor(c)}${why}`, email: true }];
    }
    default:
      return [];
  }
}

// Sends prepared messages ({ m: team member, kind, title, body, link, email }): one bell call per
// identical message, one email per person (never a shared "to" list).
async function deliver(db, project, messages, result) {
  if (!messages.length) return;
  const p0 = Date.now();
  const prefs = await db.list("NotificationPreference", PREF_FIELDS, project.tenantRole).catch(() => []);
  const prefsMs = Date.now() - p0;
  const firstPref = new Map();
  for (const x of [...prefs].sort((a, b) => String(a.ItemId).localeCompare(String(b.ItemId)))) if (!firstPref.has(x.userId)) firstPref.set(x.userId, x);
  const emailsOn = (u) => firstPref.get(u)?.emailEnabled !== false;
  const groups = new Map();
  for (const x of messages) {
    const key = `${x.kind}\n${x.title}\n${x.body}\n${x.link}`;
    if (!groups.has(key)) groups.set(key, { x, users: [] });
    groups.get(key).users.push(x.m.userId);
  }
  // How long each Blocks call took (milliseconds only), so a slow send can be found from the run.
  const ms = result.ms ?? (result.ms = { prefs: prefsMs, bell: [], email: [] });
  const timed = (list, p) => {
    const t0 = Date.now();
    return p.finally(() => { list.push(Date.now() - t0); });
  };
  const tasks = [];
  for (const { x, users } of groups.values()) {
    tasks.push(timed(ms.bell, db.notify(users, { title: x.title, body: x.body, link: x.link, projectId: project.ItemId, kind: `submittal.${x.kind}` })).then(() => { result.bell += users.length; }));
  }
  for (const x of messages) {
    if (!x.email || !x.m.email || !emailsOn(x.m.userId)) continue;
    const subject = `${project.number ? `[${project.number}] ` : ""}${x.title}`;
    tasks.push(timed(ms.email, db.mail(x.m.email, subject, {
      DisplayName: html(x.m.displayName || ""),
      Heading: html(x.title),
      Text: html(x.body),
      ProjectName: html(project.name || ""),
      ButtonLabel: "Open the submittal",
      ButtonUrl: `${db.appUrl}${x.link}`,
      SettingsUrl: `${db.appUrl}/inbox?tab=settings`
    })).then(() => { result.email += 1; }));
  }
  for (const r of await Promise.allSettled(tasks)) if (r.status === "rejected") result.failed.push(String(r.reason?.message ?? r.reason).slice(0, 200));
}

// Tells what one change did. Never fails the change.
async function tell(db, c, s, event, extra = {}) {
  const result = { bell: 0, email: 0, failed: [] };
  try {
    const seen = new Set();
    const messages = [];
    for (const n of noticesFor(c, s, event, extra)) {
      for (const m of n.to) {
        if (!m || m.userId === c.me.userId || seen.has(m.userId) || !memberSees(m, s)) continue;
        seen.add(m.userId);
        messages.push({ m, kind: n.kind, title: n.title, body: n.body, link: itemLink(c.projectId, s), email: n.email });
      }
    }
    await deliver(db, { ...c.project, tenantRole: c.me.tenantRole }, messages, result);
  } catch (error) {
    result.failed.push(String(error?.message ?? error).slice(0, 200));
  }
  return result;
}

// ---------- writing ----------
// One compare-and-set update: matches the version read, bumps it, stamps lastChange.
async function save(db, c, s, changes, kind, extra = {}) {
  const next = { ...s, ...changes };
  const version = Number(s.version ?? 0);
  const n = await db.updateWhere("Submittal", { ItemId: { eq: s.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    version: version + 1,
    searchText: searchTextOf(next),
    lastChange: {
      kind,
      nonce: crypto.randomUUID(),
      fromStatus: s.status,
      toStatus: next.status,
      previousBallUserId: s.ballInCourtUserId ?? "",
      actorUserId: c.me.userId,
      reason: extra.reason ?? "",
      before: extra.before ?? "",
      after: extra.after ?? ""
    }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", `Someone else just changed ${s.number}. It has been reloaded; please try again.`);
  return { ...next, version: version + 1 };
}

function history(db, c, s, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType: "submittal",
    recordId: s.ItemId,
    recordNumber: s.number,
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

// A finished step, for the review chain and the files of earlier revisions. Written after the
// submittal itself (which carries what the next step needs), so a failed write here only leaves a
// gap in the chain's history; it never undoes or blocks the change.
const STEP_ORDER = { submit: 1, gcReview: 2, designReview: 3 };
async function logStep(db, c, s, step) {
  try {
    await db.insert("SubmittalReview", {
      tenantRole: c.me.tenantRole,
      projectId: c.projectId,
      submittalId: s.ItemId,
      submittalNumber: s.number,
      revision: step.revision,
      stepOrder: STEP_ORDER[step.stepType],
      stepType: step.stepType,
      outcome: step.outcome,
      comment: step.comment ?? "",
      attachments: step.attachments ?? [],
      actorUserId: c.me.userId,
      actorCompanyId: c.mine.companyId ?? "",
      actorName: actor(c),
      actorRole: c.role,
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      completedAt: new Date().toISOString(),
      dueDate: step.dueDate ?? "",
      isVoided: false
    });
  } catch {
    // the chain shows a gap for this step; the change itself stands
  }
}

async function create(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager and the document controller add to the submittal register.");
  const clientRequestId = text(args.clientRequestId, 64);
  if (!clientRequestId) throw new Refused("BAD_REQUEST", "Missing request id. Reload the page and try again.");
  // A retried request (double click, network retry) returns the submittal the first one made.
  const earlier = await db.list("Submittal", "ItemId", me.tenantRole, { projectId: c.projectId, clientRequestId });
  if (earlier[0]) return { ...(await detail(db, c, earlier[0].ItemId)), created: false };

  const v = submittalInput(args, {}, c);
  const who = responsibleOf(c, args.responsibleCompanyId, args.responsibleUserId);
  const reviewer = designReviewerOf(c, args.designReviewerUserId);
  const gc = gcReviewerOf(c, args.gcReviewerUserId);
  const send = args.send !== false;
  const now = new Date().toISOString();
  const n = await allocateNumber(db, me, c.projectId, "submittal", clientRequestId);
  const row = {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    clientRequestId,
    number: n.number,
    seq: n.seq,
    version: 0,
    revision: 0,
    title: v.title,
    specSection: v.specSection,
    specSectionTitle: v.specSectionTitle,
    type: v.type,
    status: send ? "awaitingSubmission" : "draft",
    decision: "",
    ...who,
    ...reviewer,
    ...gc,
    requiredOnSiteDate: v.requiredOnSiteDate,
    leadTimeDays: v.leadTimeDays,
    gcReviewDays: v.gcReviewDays,
    designReviewDays: v.designReviewDays,
    submitByDate: v.submitByDate,
    dueDate: send ? v.submitByDate : "",
    files: [],
    decisionFiles: [],
    decisionComment: "",
    description: v.description,
    internalNotes: v.internalNotes ?? "",
    createdByUserId: me.userId,
    createdByCompanyId: c.mine.companyId ?? "",
    createdByName: actor(c),
    createdAt: now,
    ...(send ? { sentAt: now, stepStartedAt: now } : {}),
    isVoided: false
  };
  Object.assign(row, ballOf(c, row));
  row.searchText = searchTextOf(row);
  row.lastChange = { kind: "created", nonce: crypto.randomUUID(), fromStatus: "", toStatus: row.status, previousBallUserId: "", actorUserId: me.userId, reason: "" };
  // A failed save hands its number back, so the next try gets the same one (no gap).
  const itemId = await db.insert("Submittal", row).catch((error) => giveBackNumber(db, me, c.projectId, "submittal", n, error));
  const saved = { ...row, ItemId: itemId };
  await history(db, c, saved, "created",
    `${actor(c)} added ${row.number} to the register for ${row.responsibleCompanyName}${send ? `, submit by ${row.submitByDate}` : " as a draft"}`,
    { toStatus: row.status });
  if (!send) return { ...(await detail(db, c, saved)), created: true };
  const [d, notified] = await Promise.all([detail(db, c, saved), tell(db, c, saved, "sent")]);
  return { ...d, created: true, notified };
}

const EDIT_NAMES = {
  title: "title", specSection: "spec section", specSectionTitle: "spec section title", type: "type", description: "description",
  internalNotes: "internal notes", requiredOnSiteDate: "required-on-site date", leadTimeDays: "lead time", gcReviewDays: "GC check days",
  designReviewDays: "design review days", responsibleCompanyId: "subcontractor", responsibleUserId: "contact",
  designReviewerUserId: "design reviewer", gcReviewerUserId: "GC reviewer"
};
const QUIET = new Set(["description", "internalNotes"]); // changed, but not copied into the history line

async function edit(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const s = await loadOne(db, c, args.submittalId);
  if (!c.manager) throw new Refused("NOT_ALLOWED", "Only the project manager and the document controller change the register.");
  if (!OPEN.includes(s.status)) throw new Refused("INVALID_TRANSITION", `${s.number} is ${STATUS_LABEL[s.status]} and can't be changed.`);
  checkVersion(s, args);
  const changes = args.changes && typeof args.changes === "object" ? args.changes : {};
  const v = submittalInput(changes, s, c);
  const patch = {};
  for (const k of ["title", "specSection", "specSectionTitle", "type", "description", "requiredOnSiteDate", "leadTimeDays", "gcReviewDays", "designReviewDays", "internalNotes"]) {
    if (v[k] !== undefined && v[k] !== (s[k] ?? (typeof v[k] === "number" ? undefined : ""))) patch[k] = v[k];
  }
  if (changes.responsibleCompanyId !== undefined || changes.responsibleUserId !== undefined) {
    const companyId = changes.responsibleCompanyId ?? s.responsibleCompanyId;
    if (companyId !== s.responsibleCompanyId && !["draft", "awaitingSubmission"].includes(s.status)) {
      throw new Refused("INVALID_TRANSITION", `The subcontractor can only change before ${s.number} is submitted.`);
    }
    const who = responsibleOf(c, companyId, changes.responsibleUserId ?? (companyId === s.responsibleCompanyId ? s.responsibleUserId : ""));
    for (const [k, x] of Object.entries(who)) if (x !== (s[k] ?? "")) patch[k] = x;
  }
  if (changes.designReviewerUserId !== undefined && String(changes.designReviewerUserId) !== s.designReviewerUserId) Object.assign(patch, designReviewerOf(c, changes.designReviewerUserId));
  if (changes.gcReviewerUserId !== undefined && String(changes.gcReviewerUserId) !== s.gcReviewerUserId) Object.assign(patch, gcReviewerOf(c, changes.gcReviewerUserId));
  const changed = Object.keys(patch).filter((k) => EDIT_NAMES[k]);
  if (!changed.length) return detail(db, c, s);
  // New dates: a new submit-by; while the first submission is awaited, its due date follows.
  if (v.submitByDate !== s.submitByDate) {
    patch.submitByDate = v.submitByDate;
    if (s.status === "awaitingSubmission" && Number(s.revision ?? 0) === 0 && s.dueDate === s.submitByDate) patch.dueDate = v.submitByDate;
  }
  const next = { ...s, ...patch };
  const ball = ballOf(c, next);
  if (ball.ballInCourtUserId !== (s.ballInCourtUserId ?? "")) Object.assign(patch, ball);
  const shown = changed.filter((k) => !QUIET.has(k) && !k.endsWith("Name"));
  const fmt = (x, k) => (k === "responsibleCompanyId" ? x.responsibleCompanyName : k === "responsibleUserId" ? x.responsibleName || "anyone" : k === "designReviewerUserId" ? x.designReviewerName : k === "gcReviewerUserId" ? x.gcReviewerName : x[k]);
  const before = shown.map((k) => `${EDIT_NAMES[k]}: ${fmt(s, k) ?? ""}`).join("; ");
  const after = shown.map((k) => `${EDIT_NAMES[k]}: ${fmt(next, k) ?? ""}`).join("; ");
  const saved = await save(db, c, s, patch, "edited", { before, after });
  // Everyone who opens the submittal reads its history: internal notes stay out of it.
  const names = [...new Set(changed.filter((k) => k !== "internalNotes").map((k) => EDIT_NAMES[k]))];
  if (names.length) await history(db, c, saved, "edited", `${actor(c)} changed the ${names.join(", ")} of ${s.number}`, { before, after });
  // The ball moved to someone new (a new reviewer, GC reviewer, contact or company): tell them.
  const moved = patch.ballInCourtUserId !== undefined && saved.ballInCourtUserId;
  if (!moved || s.status === "draft") return detail(db, c, saved);
  const to = saved.status === "awaitingSubmission" && patch.responsibleCompanyId ? companyPeople(c, saved) : [memberOf(c, saved.ballInCourtUserId)];
  const [d, notified] = await Promise.all([detail(db, c, saved), tell(db, c, saved, "reassigned", { to })]);
  return { ...d, notified };
}

// ---------- the review chain ----------
function checkVersion(s, args) {
  if (args.version !== undefined && Number(args.version) !== Number(s.version ?? 0)) {
    throw new Refused("STATE_CHANGED", `Someone else just changed ${s.number}. It has been reloaded; please try again.`);
  }
}
const wrongState = (s, what) => new Refused("INVALID_TRANSITION", `${s.number} is ${STATUS_LABEL[s.status]}, so it can't be ${what}.`);
const commentOf = (v) => longText(v, 2000);
function requiredComment(v, what) {
  const r = commentOf(v);
  if (r.length < 3) throw new Refused("COMMENT_REQUIRED", `Say ${what} (at least 3 characters).`);
  return r;
}

// One step of the chain: load, check, save, log the finished step, history, tell.
function step(run) {
  return async (db, me, args) => {
    const c = await projectContext(db, me, args.projectId, { write: true });
    const s = await loadOne(db, c, args.submittalId);
    checkVersion(s, args);
    const { saved, event, extra } = await run(db, c, s, args, abilities(s, c));
    if (!event) return detail(db, c, saved);
    const [d, notified] = await Promise.all([detail(db, c, saved), tell(db, c, saved, event, extra)]);
    return { ...d, notified };
  };
}

const send = step(async (db, c, s, _args, can) => {
  if (s.status !== "draft") throw wrongState(s, "sent");
  if (!can.send) throw new Refused("NOT_ALLOWED", "Only the project manager and the document controller send submittals to the subcontractor.");
  const now = new Date().toISOString();
  const next = { ...s, status: "awaitingSubmission" };
  const saved = await save(db, c, s, { status: "awaitingSubmission", sentAt: now, stepStartedAt: now, dueDate: s.submitByDate, ...ballOf(c, next) }, "sent");
  await history(db, c, saved, "sent", `${actor(c)} sent ${s.number} to ${s.responsibleCompanyName}, submit by ${s.submitByDate}`, { fromStatus: "draft", toStatus: "awaitingSubmission" });
  return { saved, event: "sent" };
});

const submit = step(async (db, c, s, args, can) => {
  if (s.status !== "awaitingSubmission") throw wrongState(s, "submitted");
  if (!can.submit) throw new Refused("NOT_ALLOWED", `Only ${s.responsibleCompanyName || "the responsible subcontractor"} (or the GC on their behalf) submits ${s.number}.`);
  const files = await acceptAttachments(db, c.me, c.projectId, args.attachments ?? [], s.files ?? []);
  if (!files.length) throw new Refused("FILE_REQUIRED", "Upload at least one file before submitting.");
  const comment = commentOf(args.comment);
  const now = new Date().toISOString();
  const next = { ...s, status: "inGcReview" };
  const saved = await save(db, c, s, {
    status: "inGcReview",
    files,
    submittedAt: now,
    stepStartedAt: now,
    dueDate: addWorkingDays(c.today, Number(s.gcReviewDays ?? DEFAULT_GC_DAYS)),
    ...ballOf(c, next)
  }, "submitted", { reason: comment });
  const rev = Number(s.revision ?? 0);
  await logStep(db, c, saved, { revision: rev, stepType: "submit", outcome: "submitted", comment, attachments: files, startedAt: s.stepStartedAt, dueDate: s.dueDate });
  const behalf = can.onBehalf ? ` on behalf of ${s.responsibleCompanyName}` : "";
  await history(db, c, saved, "submitted", `${actor(c)} submitted ${s.number} rev ${rev}${behalf} (${fileWord(files.length)})`, { reason: comment, fromStatus: s.status, toStatus: "inGcReview" });
  return { saved, event: "submitted" };
});

const forward = step(async (db, c, s, args, can) => {
  if (s.status !== "inGcReview") throw wrongState(s, "forwarded");
  if (!can.forward) throw new Refused("NOT_ALLOWED", "Only the project manager and the document controller forward submittals.");
  if (!memberOf(c, s.designReviewerUserId)) throw new Refused("REVIEWER_NOT_ON_PROJECT", `${s.designReviewerName || "The design reviewer"} is no longer on the team. Choose another design reviewer first.`);
  const comment = commentOf(args.comment);
  const now = new Date().toISOString();
  const next = { ...s, status: "inDesignReview" };
  const saved = await save(db, c, s, {
    status: "inDesignReview",
    forwardedAt: now,
    stepStartedAt: now,
    dueDate: addWorkingDays(c.today, Number(s.designReviewDays ?? DEFAULT_DESIGN_DAYS)),
    ...ballOf(c, next)
  }, "forwarded", { reason: comment });
  await logStep(db, c, saved, { revision: Number(s.revision ?? 0), stepType: "gcReview", outcome: "forwarded", comment, startedAt: s.stepStartedAt, dueDate: s.dueDate });
  await history(db, c, saved, "forwarded", `${actor(c)} forwarded ${s.number} to ${s.designReviewerName} for review`, { reason: comment, fromStatus: s.status, toStatus: "inDesignReview" });
  return { saved, event: "forwarded", extra: { comment } };
});

const returnToSub = step(async (db, c, s, args, can) => {
  if (s.status !== "inGcReview") throw wrongState(s, "returned");
  if (!can.returnToSub) throw new Refused("NOT_ALLOWED", "Only the project manager and the document controller return submittals.");
  const comment = requiredComment(args.comment, "what is missing");
  const now = new Date().toISOString();
  const next = { ...s, status: "awaitingSubmission" };
  const saved = await save(db, c, s, {
    status: "awaitingSubmission",
    stepStartedAt: now,
    dueDate: addWorkingDays(c.today, RESUBMIT_DAYS),
    ...ballOf(c, next)
  }, "returned", { reason: comment });
  await logStep(db, c, saved, { revision: Number(s.revision ?? 0), stepType: "gcReview", outcome: "returnedIncomplete", comment, startedAt: s.stepStartedAt, dueDate: s.dueDate });
  await history(db, c, saved, "returned", `${actor(c)} returned ${s.number} to ${s.responsibleCompanyName}: something is missing`, { reason: comment, fromStatus: s.status, toStatus: "awaitingSubmission" });
  return { saved, event: "returned", extra: { comment } };
});

const decide = step(async (db, c, s, args, can) => {
  if (s.status !== "inDesignReview") throw wrongState(s, "decided");
  if (!can.decide) throw new Refused("NOT_ALLOWED", `Only ${s.designReviewerName || "the assigned design reviewer"} decides on ${s.number}.`);
  const decision = String(args.decision ?? "");
  if (!DECISIONS.includes(decision)) throw new Refused("BAD_DECISION", "Choose a decision: Approved, Approved as noted, Revise and resubmit or Rejected.");
  const markups = await acceptAttachments(db, c.me, c.projectId, args.attachments ?? [], []);
  if (decision !== "approved" && !markups.length) throw new Refused("FILE_REQUIRED", `Attach the marked-up file for “${DECISION_LABEL[decision]}”.`);
  const comment = decision === "reviseResubmit" || decision === "rejected" ? requiredComment(args.comment, "what has to change") : commentOf(args.comment);
  const now = new Date().toISOString();
  const rev = Number(s.revision ?? 0);
  const base = { decision, decisionFiles: markups, decisionComment: comment, decidedAt: now, decidedByUserId: c.me.userId, decidedByName: actor(c) };
  let changes;
  if (decision === "reviseResubmit") {
    const next = { ...s, status: "awaitingSubmission" };
    changes = { ...base, status: "awaitingSubmission", revision: rev + 1, files: [], stepStartedAt: now, dueDate: addWorkingDays(c.today, RESUBMIT_DAYS), ...ballOf(c, next) };
  } else {
    changes = { ...base, status: "closed", dueDate: "", ...NO_BALL };
  }
  const saved = await save(db, c, s, changes, "decided", { reason: comment, after: decision });
  await logStep(db, c, saved, { revision: rev, stepType: "designReview", outcome: decision, comment, attachments: markups, startedAt: s.stepStartedAt, dueDate: s.dueDate });
  const opened = decision === "reviseResubmit" ? `; rev ${rev + 1} is open for resubmission by ${s.responsibleCompanyName}` : "";
  const onBehalf = s.designReviewerUserId !== c.me.userId ? ` for ${s.designReviewerName}` : "";
  await history(db, c, saved, "decided", `${actor(c)}${onBehalf} decided ${s.number} rev ${rev}: ${DECISION_LABEL[decision]}${opened}`, { reason: comment, fromStatus: s.status, toStatus: saved.status, after: decision });
  return { saved, event: "decided", extra: { comment } };
});

const newRevision = step(async (db, c, s, args, can) => {
  if (s.status !== "closed" || s.decision !== "rejected") throw new Refused("INVALID_TRANSITION", `A new revision can only follow a rejection; ${s.number} is ${STATUS_LABEL[s.status]}.`);
  if (!can.newRevision) throw new Refused("NOT_ALLOWED", "Only the project manager and the document controller open a new revision.");
  const reason = requiredComment(args.reason, "why a new revision is needed");
  const now = new Date().toISOString();
  const rev = Number(s.revision ?? 0) + 1;
  const next = { ...s, status: "awaitingSubmission" };
  const saved = await save(db, c, s, { status: "awaitingSubmission", revision: rev, files: [], stepStartedAt: now, dueDate: addWorkingDays(c.today, RESUBMIT_DAYS), ...ballOf(c, next) }, "newRevision", { reason });
  await history(db, c, saved, "newRevision", `${actor(c)} opened rev ${rev} of ${s.number} for ${s.responsibleCompanyName}`, { reason, fromStatus: "closed", toStatus: "awaitingSubmission" });
  return { saved, event: "newRevision", extra: { comment: reason } };
});

const voidOne = step(async (db, c, s, args, can) => {
  if (!OPEN.includes(s.status)) throw wrongState(s, "voided");
  if (!can.void) throw new Refused("NOT_ALLOWED", "Only the project manager voids submittals.");
  const reason = requiredComment(args.reason, "why it is void");
  const saved = await save(db, c, s, { status: "void", isVoided: true, voidReason: reason, voidedAt: new Date().toISOString(), voidedByUserId: c.me.userId, dueDate: "", ...NO_BALL }, "voided", { reason });
  await history(db, c, saved, "voided", `${actor(c)} voided ${s.number}`, { reason, fromStatus: s.status, toStatus: "void" });
  // A draft was never sent: nobody outside the register managers knows about it.
  return { saved, event: s.status === "draft" ? undefined : "voided", extra: { comment: reason } };
});

// ---------- comments, distribution, files ----------
async function comment(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const s = await loadOne(db, c, args.submittalId);
  if (!abilities(s, c).comment) {
    throw new Refused("NOT_ALLOWED", s.status === "void" ? `${s.number} is void.` : "Your role can read this submittal but not comment on it.");
  }
  const body = longText(args.body, 2000);
  if (!body) throw new Refused("EMPTY_COMMENT", "Write a comment first.");
  const attachments = await acceptAttachments(db, me, c.projectId, args.attachments ?? [], []);
  await db.insert("Comment", {
    tenantRole: me.tenantRole,
    projectId: c.projectId,
    recordType: "submittal",
    recordId: s.ItemId,
    recordNumber: s.number,
    body,
    attachments,
    authorUserId: me.userId,
    authorCompanyId: c.mine.companyId ?? "",
    authorName: actor(c),
    postedAt: new Date().toISOString(),
    visibility: "all",
    mentionUserIds: [],
    isVoided: false
  });
  return detail(db, c, s);
}

async function distribute(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const s = await loadOne(db, c, args.submittalId);
  if (!abilities(s, c).distribute) {
    throw new Refused(s.status === "closed" ? "NOT_ALLOWED" : "INVALID_TRANSITION", s.status === "closed" ? "Only the project manager and the document controller distribute decisions." : `${s.number} has no final decision to distribute yet.`);
  }
  const ids = [...new Set((Array.isArray(args.userIds) ? args.userIds : []).map(String))];
  if (!ids.length) throw new Refused("NO_RECIPIENTS", "Choose who gets the decision.");
  if (ids.length > MAX_DISTRIBUTE) throw new Refused("TOO_MANY_RECIPIENTS", `Choose at most ${MAX_DISTRIBUTE} people.`);
  const to = ids.map((id) => memberOf(c, id));
  if (to.some((m) => !m || !memberSees(m, s))) throw new Refused("RECIPIENT_NOT_ALLOWED", "Everyone you send it to must be on the team and able to open this submittal.");
  const note = commentOf(args.note);
  // The notices and the history line go out together; the detail is read after, so it shows the line.
  const t0 = Date.now();
  const [notified] = await Promise.all([
    tell(db, c, s, "distributed", { to, comment: note }),
    history(db, c, s, "distributed", `${actor(c)} sent the decision on ${s.number} to ${to.map((m) => m.displayName).join(", ")}`, { reason: note })
  ]);
  const t1 = Date.now();
  const d = await detail(db, c, s);
  notified.ms = { ...(notified.ms ?? {}), tellAndHistory: t1 - t0, detail: Date.now() - t1 };
  return { ...d, notified, sentTo: to.length };
}

// Upload links: for the package (submit), the markups (decide) or a comment's files.
async function uploadLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const s = await loadOne(db, c, args.submittalId);
  const can = abilities(s, c);
  if (!(can.submit || can.decide || can.comment)) throw new Refused("NOT_ALLOWED", "You can add files while it's your turn on this submittal, or with a comment.");
  return { ok: true, uploads: await issueUploads(db, me, c.projectId, args.files, "submittal") };
}

// Fresh download links (the page asks again when the ones it has are about to run out).
async function fileLinks(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const d = await detail(db, c, String(args.submittalId ?? ""));
  return { ok: true, files: d.files, linksExpireAt: d.linksExpireAt };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "submittals", {
    list: (args, { db, me }) => list(db, me, args),
    get: (args, { db, me }) => get(db, me, args),
    create: (args, { db, me }) => create(db, me, args),
    edit: (args, { db, me }) => edit(db, me, args),
    send: (args, { db, me }) => send(db, me, args),
    submit: (args, { db, me }) => submit(db, me, args),
    forward: (args, { db, me }) => forward(db, me, args),
    returnToSub: (args, { db, me }) => returnToSub(db, me, args),
    decide: (args, { db, me }) => decide(db, me, args),
    newRevision: (args, { db, me }) => newRevision(db, me, args),
    void: (args, { db, me }) => voidOne(db, me, args),
    comment: (args, { db, me }) => comment(db, me, args),
    distribute: (args, { db, me }) => distribute(db, me, args),
    uploadLinks: (args, { db, me }) => uploadLinks(db, me, args),
    fileLinks: (args, { db, me }) => fileLinks(db, me, args)
  });
}
