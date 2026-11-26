// Daily logs: the server (docs/architecture/05-daily-logs.md; permissions in
// functions/_shared/permissions.js). Every DailyLog and DailyLogCrew is read and written only here:
// the Data Gateway rules let only the service identity touch them, because a rule can't see a
// person's role or company on ONE project.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "month", projectId, month: "yyyy-MM" }   -> { days, today, role, can }
//   { action: "get", projectId, date }                 -> detail (log: null when the day has none)
//   { action: "open", projectId, date }                -> detail, creating the day's log (with the
//                                                         day's Open-Meteo forecast) when allowed
//   { action: "saveSection", projectId, date, section, value, base? }   -> detail
//       section: equipment | deliveries | visitors | delays | safety | notes | siteConditions | weatherOverride
//       base: the section as the caller last saw it; a save is refused (CONFLICT) only when someone
//       changed that same section since, so two people editing different cards never block each other.
//   { action: "saveCrew", projectId, date, companyId?, manpower, notes, version? }  -> detail
//   { action: "submit", projectId, date }              -> detail (the day's weather is read again)
//   { action: "refreshWeather", projectId, date }      -> detail (GC, draft only)
//   { action: "correct", projectId, date, reason, section + value | crewCompanyId + manpower + notes } -> detail
// detail = { date, today, role, archived, log, crews, companies, missingCrews, can, history, photos }.
// Photos are added through the photos Function (link { type: "dailyLog", id }); `can.addPhotos` says when.
//
// Who (05 §3, decisions of 2026-11-26):
// - PM, superintendent (daily_log.create): open any day up to tomorrow, fill every section and
//   every company's crew, submit.
// - Document controller (daily_log.view): reads everything, drafts included; writes nothing.
// - Subcontractor (daily_log.crew_own): the day's header (date, status, weather, site conditions)
//   and their OWN company's crew and notes; other companies' rows are hidden. Opens today only.
// - Owner (daily_log.view_submitted): submitted logs only, every section; drafts show as pending.
// - Designer / consultant: no daily logs.
// - PM (daily_log.correct): corrects a submitted log with a reason; the history keeps before/after.
// A submitted log never goes back to draft.
//
// One log per day: Blocks has no unique index. When two people open an empty day at once, both
// may insert; the log saved first (CreatedDate, then ItemId) is the day's log and the other is
// marked `duplicateOf`. Every action addresses the log by its date and resolves it the same way.
// Crews: the same, per (log, company).
// Every update matches the row's `version` (compare-and-set). Never returns or logs a token.

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
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ROWS = 200;
const ROW_SECTIONS = ["equipment", "deliveries", "visitors", "delays", "safety"];
const SECTIONS = [...ROW_SECTIONS, "notes", "siteConditions", "weatherOverride"];
const SECTION_LABEL = {
  equipment: "equipment", deliveries: "deliveries", visitors: "visitors", delays: "delays", safety: "safety",
  notes: "notes", siteConditions: "site conditions", weatherOverride: "weather"
};
const SITE_CONDITIONS = ["normal", "wet", "frozen", "flooded", "noAccess"];
const EQUIPMENT_STATUS = ["working", "idle", "broken"];
const DELAY_TYPES = ["weather", "material", "labour", "design", "owner", "inspection", "access", "other"];
const SAFETY_TYPES = ["observation", "nearMiss", "incident", "toolboxTalk", "inspection"];
const CONDITIONS = ["clear", "partlyCloudy", "cloudy", "fog", "drizzle", "rain", "snow", "thunderstorm"];
// The fields of each row, in a fixed order (also how two versions of a section are compared).
const ROW_FIELDS = {
  equipment: ["rowId", "name", "quantity", "hoursUsed", "status", "notes"],
  deliveries: ["rowId", "time", "supplier", "material", "quantity", "deliveryNoteNo"],
  visitors: ["rowId", "name", "organisation", "purpose", "timeIn", "timeOut"],
  delays: ["rowId", "type", "description", "durationHours"],
  safety: ["rowId", "type", "description", "actionTaken"],
  manpower: ["rowId", "trade", "headcount", "hours", "workDone", "location"]
};
const WEATHER_FIELDS = "source place condition summary fetchedAt tempMinC tempMaxC precipitationMm windMaxKph";
const ROWS = (name, fields) => `${name} { ${fields.join(" ")} }`;
const LOG_FIELDS = [
  "ItemId CreatedDate projectId logDate status version isWorkingDay siteConditions notes",
  `weather { ${WEATHER_FIELDS} }`,
  `weatherOverride { ${WEATHER_FIELDS} }`,
  ...ROW_SECTIONS.map((s) => ROWS(s, ROW_FIELDS[s])),
  `manpowerSummary { companyId companyName ${ROW_FIELDS.manpower.join(" ")} }`,
  "totalHeadcount totalHours createdAt createdByUserId submittedAt submittedByUserId submittedByName correctionCount duplicateOf"
].join(" ");
const CREW_FIELDS = `ItemId CreatedDate projectId dailyLogId logDate companyId companyName status version ${ROWS("manpower", ROW_FIELDS.manpower)} notes lastEditedByUserId lastEditedByName lastEditedAt duplicateOf`;
const MONTH_FIELDS = `ItemId CreatedDate logDate status isWorkingDay totalHeadcount correctionCount duplicateOf weather { condition } weatherOverride { source condition }`;
const TEAM_FIELDS = "ItemId userId displayName email companyId companyName companyRelation trade role status joinedAt";
const PHOTO_FIELDS = "ItemId fileName caption takenAt uploadedAt uploadedByName uploaderCompanyId thumbFileId previewFileId isVoided";
const EVENT_FIELDS = "ItemId recordId action actorUserId actorName at summary reason fromStatus toStatus beforeJson afterJson";

// ---------- small helpers ----------
const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const longText = (v, max) => String(v ?? "").trim().slice(0, max);
const actor = (c) => c.mine.displayName || "Someone";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const oneOf = (v, list, fallback = "") => (list.includes(v) ? v : fallback);
const first = (rows) => [...rows].sort((a, b) => String(a.CreatedDate ?? "").localeCompare(String(b.CreatedDate ?? "")) || String(a.ItemId).localeCompare(String(b.ItemId)))[0];
// A number within limits, or undefined when empty (never "" into a number field).
function num(v, min, max, { int = false } = {}) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return NaN;
  return int ? Math.round(n) : Math.round(n * 100) / 100;
}
const bad = (what) => {
  throw new Refused("VALIDATION", what);
};

// ---------- dates (project timezone; weekends only, public holidays come with the calendar) ----------
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
function validDate(v) {
  const d = String(v ?? "");
  if (!DATE.test(d) || new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) !== d) throw new Refused("BAD_DATE", "Choose a valid date.");
  return d;
}
const niceDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// ---------- who is asking, on which project ----------
async function projectContext(db, me, projectId, { write = false } = {}) {
  const id = String(projectId ?? "");
  if (!id) throw new Refused("NOT_FOUND", "Choose a project first.");
  const [projects, team] = await Promise.all([
    db.list("Project", "ItemId number name status timezone address { city country }", me.tenantRole, { ItemId: id }),
    db.list("ProjectMember", TEAM_FIELDS, me.tenantRole, { projectId: id })
  ]);
  const project = projects[0];
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  const active = team.filter((r) => r.status === "active");
  const mine = active.find((r) => r.userId === me.userId);
  if (!mine) throw new Refused("NOT_ON_PROJECT", "You're not on this project's team. Daily logs are open to the project team only.");
  const archived = project.status === "archived";
  if (write && archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const role = mine.role;
  const c = {
    me,
    project,
    projectId: id,
    active,
    mine,
    role,
    archived,
    today: todayIn(project.timezone),
    seesAll: projectCan(role, "daily_log.view"),
    seesSubmitted: projectCan(role, "daily_log.view_submitted"),
    writer: projectCan(role, "daily_log.create"),
    crewOwn: projectCan(role, "daily_log.crew_own"),
    corrector: projectCan(role, "daily_log.correct")
  };
  if (!c.seesAll && !c.seesSubmitted && !c.writer && !c.crewOwn) throw new Refused("NOT_ALLOWED", "Your project role doesn't include daily logs.");
  return c;
}

// The companies that keep a crew in the log: the general contractor's own company and every
// company with a subcontractor (field user) on the team.
function crewCompanies(c) {
  const out = new Map();
  for (const m of c.active) {
    if (!m.companyId || out.has(m.companyId)) continue;
    const own = m.companyRelation === "self";
    if (own || m.role === "field-user") out.set(m.companyId, { companyId: m.companyId, companyName: m.companyName || "", own });
  }
  return [...out.values()].sort((a, b) => Number(b.own) - Number(a.own) || a.companyName.localeCompare(b.companyName));
}

// ---------- reading ----------
async function loadLog(db, c, date) {
  const rows = await db.list("DailyLog", LOG_FIELDS, c.me.tenantRole, { projectId: c.projectId, logDate: date });
  return first(rows.filter((r) => !r.duplicateOf)) ?? null;
}
async function loadCrews(db, c, log) {
  const rows = await db.list("DailyLogCrew", CREW_FIELDS, c.me.tenantRole, { projectId: c.projectId, dailyLogId: log.ItemId });
  const per = new Map();
  for (const r of rows.filter((x) => !x.duplicateOf)) {
    const best = per.get(r.companyId);
    if (!best || first([best, r]) === r) per.set(r.companyId, r);
  }
  return [...per.values()];
}
async function loadHistory(db, c, log) {
  const rows = await db.list("ActivityEvent", EVENT_FIELDS, c.me.tenantRole, { projectId: c.projectId, recordType: "dailyLog", recordId: log.ItemId }).catch(() => []);
  return rows
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
    .map((e) => ({ id: e.ItemId, action: e.action, actorName: e.actorName, at: e.at, summary: e.summary, reason: e.reason || "", before: parsed(e.beforeJson), after: parsed(e.afterJson) }));
}

const isSubmitted = (log) => log?.status === "submitted";
const fullView = (c, log) => c.seesAll || (c.seesSubmitted && isSubmitted(log));
const effectiveWeather = (log) => (log.weatherOverride?.source === "manual" ? log.weatherOverride : log.weather?.source ? log.weather : null);

// ---------- weather: Open-Meteo through two Blocks Proxies ----------
// The proxies keep the provider's address on the server, one endpoint each (called on the proxy's
// base path, so nothing else of the provider is reachable): `geocoding` →
// geocoding-api.open-meteo.com/v1/search (the project's city to coordinates) and `weather` →
// api.open-meteo.com/v1/forecast (the day's figures). Moving to Open-Meteo's paid plan (its free API is for non-commercial
// use only) is a proxy change: new upstream plus the API key as a proxy secret, no code change.
// The data is CC BY 4.0, so the screen credits Open-Meteo. Best effort throughout: any failure
// means "no forecast", and the site team enters the weather by hand.
const PROXY = { geocoding: "geocoding", weather: "weather" };
const WEATHER_SOURCE = "open-meteo";
const WEATHER_TIMEOUT_MS = 5000;
// The forecast API answers for about three months back and two weeks ahead.
const WEATHER_PAST_DAYS = 90;
const WEATHER_AHEAD_DAYS = 14;
const WEATHER_DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max";
// WMO weather code → our condition and the provider's wording.
const WMO = {
  0: ["clear", "Clear sky"], 1: ["partlyCloudy", "Mainly clear"], 2: ["partlyCloudy", "Partly cloudy"], 3: ["cloudy", "Overcast"],
  45: ["fog", "Fog"], 48: ["fog", "Freezing fog"],
  51: ["drizzle", "Light drizzle"], 53: ["drizzle", "Moderate drizzle"], 55: ["drizzle", "Dense drizzle"],
  56: ["drizzle", "Light freezing drizzle"], 57: ["drizzle", "Dense freezing drizzle"],
  61: ["rain", "Slight rain"], 63: ["rain", "Moderate rain"], 65: ["rain", "Heavy rain"],
  66: ["rain", "Light freezing rain"], 67: ["rain", "Heavy freezing rain"],
  71: ["snow", "Slight snowfall"], 73: ["snow", "Moderate snowfall"], 75: ["snow", "Heavy snowfall"], 77: ["snow", "Snow grains"],
  80: ["rain", "Slight rain showers"], 81: ["rain", "Moderate rain showers"], 82: ["rain", "Violent rain showers"],
  85: ["snow", "Slight snow showers"], 86: ["snow", "Heavy snow showers"],
  95: ["thunderstorm", "Thunderstorm"], 96: ["thunderstorm", "Thunderstorm with slight hail"], 99: ["thunderstorm", "Thunderstorm with heavy hail"]
};
const round1 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);

async function proxyGet(ctx, token, slug, query) {
  const res = await fetch(`${API}/logic/v4/proxy/gateway/${slug}?${new URLSearchParams(query)}`, {
    headers: { authorization: `Bearer ${token}`, "x-blocks-key": ctx.context.tenantId },
    signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`proxy ${slug} answered ${res.status}`);
  return res.json();
}

// The project's city as coordinates. With several towns of that name, the one in the project's
// country (name or ISO code) wins; else the largest (the provider sorts by population).
async function geocode(ctx, token, address) {
  const city = text(address?.city, 100);
  if (!city) return null;
  const json = await proxyGet(ctx, token, PROXY.geocoding, { name: city, count: "10", language: "en", format: "json" });
  const results = (Array.isArray(json?.results) ? json.results : []).filter((r) => Number.isFinite(r?.latitude) && Number.isFinite(r?.longitude));
  const country = text(address?.country, 100).toLowerCase();
  const hit = (country && results.find((r) => [r.country, r.country_code].some((v) => String(v ?? "").toLowerCase() === country))) || results[0];
  return hit ? { latitude: hit.latitude, longitude: hit.longitude, place: text(hit.name, 100) || city, timezone: hit.timezone } : null;
}

/** The day's weather for the project's city, or null (no city, out of range, provider down). */
async function forecastFor(ctx, c, date) {
  if (!ctx || date < addDays(c.today, -WEATHER_PAST_DAYS) || date > addDays(c.today, WEATHER_AHEAD_DAYS)) return null;
  const t0 = Date.now();
  let step = "token";
  try {
    // The caller's own token: the proxies accept anyone signed in. (With the service identity's
    // token the proxy gateway never answered from inside a Function, seen on Dev 2026-11-26.)
    const token = (await ctx.blocks?.getAccessToken?.().catch(() => null)) || (await serviceToken(ctx));
    step = "geocoding";
    const at = await geocode(ctx, token, c.project.address);
    if (!at) {
      ctx.log?.warn?.("weather: the project's city was not found", { ms: Date.now() - t0 });
      return null;
    }
    step = "forecast";
    const json = await proxyGet(ctx, token, PROXY.weather, {
      latitude: String(at.latitude),
      longitude: String(at.longitude),
      daily: WEATHER_DAILY,
      timezone: c.project.timezone || at.timezone || "auto",
      start_date: date,
      end_date: date,
      wind_speed_unit: "kmh"
    });
    const d = json?.daily;
    if (!d || d.time?.[0] !== date) return null;
    const pick = (k) => round1(Array.isArray(d[k]) ? d[k][0] : undefined);
    const [condition, summary] = WMO[d.weather_code?.[0]] ?? [];
    const snap = {
      source: WEATHER_SOURCE,
      place: at.place,
      fetchedAt: new Date().toISOString(),
      condition,
      summary,
      tempMaxC: pick("temperature_2m_max"),
      tempMinC: pick("temperature_2m_min"),
      precipitationMm: pick("precipitation_sum"),
      windMaxKph: pick("wind_speed_10m_max")
    };
    if (!snap.condition && snap.tempMaxC === undefined) return null;
    return Object.fromEntries(Object.entries(snap).filter(([, v]) => v !== undefined));
  } catch (error) {
    ctx.log?.warn?.("weather unavailable", { step, ms: Date.now() - t0, message: String(error?.message ?? error).slice(0, 200) });
    return null;
  }
}
const rowsOf = (rows) => (Array.isArray(rows) ? rows : []);
const totalsOf = (rows) => ({
  headcount: rows.reduce((s, r) => s + (Number(r.headcount) || 0), 0),
  hours: Math.round(rows.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 100) / 100
});

function presentCrew(r) {
  const manpower = rowsOf(r.manpower);
  return {
    id: r.ItemId,
    companyId: r.companyId,
    companyName: r.companyName || "",
    status: r.status || "open",
    version: Number(r.version ?? 0),
    manpower,
    notes: r.notes || "",
    ...totalsOf(manpower),
    lastEditedByName: r.lastEditedByName || "",
    lastEditedAt: r.lastEditedAt || ""
  };
}

function presentLog(c, log) {
  const header = {
    id: log.ItemId,
    date: log.logDate,
    status: log.status,
    version: Number(log.version ?? 0),
    isWorkingDay: log.isWorkingDay !== false,
    weather: effectiveWeather(log),
    siteConditions: log.siteConditions || "",
    submittedAt: log.submittedAt || "",
    submittedByName: log.submittedByName || "",
    correctionCount: Number(log.correctionCount ?? 0)
  };
  if (!fullView(c, log)) return header;
  return {
    ...header,
    weatherForecast: log.weather?.source ? log.weather : null,
    weatherOverride: log.weatherOverride?.source === "manual" ? log.weatherOverride : null,
    ...Object.fromEntries(ROW_SECTIONS.map((s) => [s, rowsOf(log[s])])),
    notes: log.notes || "",
    manpowerSummary: rowsOf(log.manpowerSummary),
    totalHeadcount: Number(log.totalHeadcount ?? 0),
    totalHours: Number(log.totalHours ?? 0)
  };
}

function abilities(c, log, date) {
  const open = !c.archived;
  const draft = Boolean(log) && log.status === "draft";
  const mayCreate = c.writer ? date <= addDays(c.today, 1) : c.crewOwn && date === c.today;
  return {
    open: open && !log && mayCreate,
    editSections: open && draft && c.writer,
    editAnyCrew: open && draft && c.writer,
    editOwnCrew: open && draft && (c.writer || c.crewOwn),
    submit: open && draft && c.writer,
    // Photos go on a draft log, added through the photos Function (which checks the same).
    addPhotos: open && draft && (c.writer || c.crewOwn),
    correct: open && isSubmitted(log) && c.corrector
  };
}

async function detail(db, c, date, known) {
  const log = known === undefined ? await loadLog(db, c, date) : known;
  const base = { ok: true, date, today: c.today, role: c.role, archived: c.archived, place: c.project.address?.city || "" };
  // Owners see a draft only as "not submitted yet".
  if (!log || (!c.seesAll && !c.crewOwn && !c.writer && !isSubmitted(log))) {
    return { ...base, log: null, pending: Boolean(log), crews: [], companies: [], missingCrews: [], history: [], photos: [], can: abilities(c, null, date) };
  }
  const crews = (await loadCrews(db, c, log)).map(presentCrew);
  const full = fullView(c, log);
  const visibleCrews = full ? crews : crews.filter((x) => x.companyId === c.mine.companyId);
  const companies = c.writer ? crewCompanies(c) : [];
  const withRows = new Set(crews.filter((x) => x.manpower.length).map((x) => x.companyId));
  const [history, photos] = await Promise.all([full ? loadHistory(db, c, log) : [], loadPhotos(db, c, log, full)]);
  return {
    ...base,
    log: presentLog(c, log),
    pending: false,
    crews: visibleCrews,
    ownCompanyId: c.mine.companyId || "",
    ownCompanyName: c.mine.companyName || "",
    companies,
    missingCrews: c.writer ? companies.filter((x) => !x.own && !withRows.has(x.companyId)) : [],
    history,
    photos,
    can: abilities(c, log, date)
  };
}

// The log's photos (Photo records linked to it, written by the photos Function): everyone who sees
// the whole log sees all of them; a subcontractor only their own company's. Newest first, with
// short-lived image links (none when storage doesn't answer; the page shows a placeholder).
async function loadPhotos(db, c, log, full) {
  const rows = (await db.list("Photo", PHOTO_FIELDS, c.me.tenantRole, { projectId: c.projectId, linkedRecordType: "dailyLog", linkedRecordId: log.ItemId }).catch(() => []))
    .filter((p) => !p.isVoided && (full || (Boolean(p.uploaderCompanyId) && p.uploaderCompanyId === c.mine.companyId)))
    .sort((a, b) => String(b.takenAt || b.uploadedAt).localeCompare(String(a.takenAt || a.uploadedAt)));
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((p) => [p.thumbFileId, p.previewFileId]).filter(Boolean))];
  const urls = {};
  for (let i = 0; i < ids.length; i += 100) Object.assign(urls, await db.downloadUrls(ids.slice(i, i + 100)).catch(() => ({})));
  const companies = new Map(c.active.map((m) => [m.companyId, m.companyName]));
  return rows.map((p) => ({
    ItemId: p.ItemId,
    caption: p.caption || "",
    takenAt: p.takenAt || p.uploadedAt,
    uploadedByName: p.uploadedByName || "",
    companyName: companies.get(p.uploaderCompanyId) || "",
    thumbUrl: urls[p.thumbFileId] ?? urls[p.previewFileId],
    previewUrl: urls[p.previewFileId] ?? urls[p.thumbFileId]
  }));
}

// ---------- checking what people send ----------
const rowId = (v) => text(v, 40) || crypto.randomUUID();
function cleanRow(section, r, i) {
  const at = `${SECTION_LABEL[section] ?? section} row ${i + 1}`;
  const o = r && typeof r === "object" ? r : {};
  const out = { rowId: rowId(o.rowId) };
  const put = (k, v) => {
    if (v !== undefined) out[k] = v;
  };
  const numOk = (k, v, what) => {
    if (Number.isNaN(v)) bad(`${at}: ${what}.`);
    put(k, v);
  };
  if (section === "equipment") {
    out.name = text(o.name, 120) || bad(`${at}: name the equipment.`);
    numOk("quantity", num(o.quantity, 0, 9999, { int: true }), "quantity must be 0 to 9999");
    numOk("hoursUsed", num(o.hoursUsed, 0, 9999), "hours must be 0 to 9999");
    out.status = oneOf(o.status, EQUIPMENT_STATUS, "working");
    out.notes = text(o.notes, 500);
  } else if (section === "deliveries") {
    out.time = TIME.test(String(o.time ?? "")) ? o.time : "";
    out.supplier = text(o.supplier, 120) || bad(`${at}: name the supplier.`);
    out.material = text(o.material, 200) || bad(`${at}: say what was delivered.`);
    out.quantity = text(o.quantity, 60);
    out.deliveryNoteNo = text(o.deliveryNoteNo, 60);
  } else if (section === "visitors") {
    out.name = text(o.name, 120) || bad(`${at}: name the visitor.`);
    out.organisation = text(o.organisation, 120);
    out.purpose = text(o.purpose, 200);
    out.timeIn = TIME.test(String(o.timeIn ?? "")) ? o.timeIn : "";
    out.timeOut = TIME.test(String(o.timeOut ?? "")) ? o.timeOut : "";
  } else if (section === "delays") {
    out.type = oneOf(o.type, DELAY_TYPES) || bad(`${at}: choose the kind of delay.`);
    out.description = longText(o.description, 1000) || bad(`${at}: describe the delay.`);
    numOk("durationHours", num(o.durationHours, 0, 24), "hours lost must be 0 to 24");
  } else if (section === "safety") {
    out.type = oneOf(o.type, SAFETY_TYPES) || bad(`${at}: choose the kind of observation.`);
    out.description = longText(o.description, 1000) || bad(`${at}: describe what happened.`);
    out.actionTaken = longText(o.actionTaken, 1000);
  } else if (section === "manpower") {
    out.trade = text(o.trade, 60);
    const h = num(o.headcount, 0, 500, { int: true });
    if (h === undefined || Number.isNaN(h)) bad(`${at}: workers must be 0 to 500.`);
    out.headcount = h;
    numOk("hours", num(o.hours, 0, 5000), "hours must be 0 to 5000");
    out.workDone = longText(o.workDone, 1000);
    out.location = text(o.location, 120);
  }
  return out;
}
function cleanRows(section, rows) {
  if (!Array.isArray(rows)) bad(`Send the ${SECTION_LABEL[section] ?? section} as a list.`);
  if (rows.length > MAX_ROWS) bad(`At most ${MAX_ROWS} rows per section.`);
  const seen = new Set();
  return rows.map((r, i) => {
    const out = cleanRow(section, r, i);
    if (seen.has(out.rowId)) out.rowId = crypto.randomUUID();
    seen.add(out.rowId);
    return out;
  });
}
function cleanWeather(v) {
  if (v === null || v === undefined || v === "") return { source: "none" }; // cleared: back to the forecast
  if (typeof v !== "object") bad("Send the weather as an object.");
  const out = { source: "manual", condition: oneOf(v.condition, CONDITIONS), summary: text(v.summary, 200), fetchedAt: new Date().toISOString() };
  for (const [k, min, max, what] of [["tempMinC", -60, 60, "temperatures"], ["tempMaxC", -60, 60, "temperatures"], ["precipitationMm", 0, 1000, "rain"], ["windMaxKph", 0, 400, "wind"]]) {
    const n = num(v[k], min, max);
    if (Number.isNaN(n)) bad(`Weather: ${what} out of range.`);
    if (n !== undefined) out[k] = n;
  }
  if (!out.condition && !out.summary && out.tempMaxC === undefined && out.tempMinC === undefined) bad("Weather: choose a condition or enter a temperature.");
  return out;
}
function cleanSection(section, value) {
  if (ROW_SECTIONS.includes(section)) return cleanRows(section, value);
  if (section === "notes") return longText(value, 8000);
  if (section === "siteConditions") return value === "" || value === null ? "" : oneOf(value, SITE_CONDITIONS) || bad("Choose a site condition from the list.");
  if (section === "weatherOverride") return cleanWeather(value);
  throw new Refused("BAD_SECTION", "Unknown section of the daily log.");
}
// A section in a fixed shape, so two versions can be compared.
function canon(section, value) {
  if (ROW_SECTIONS.includes(section) || section === "manpower") {
    return JSON.stringify(rowsOf(value).map((r) => ROW_FIELDS[section].map((k) => (r?.[k] === undefined || r?.[k] === "" ? null : r[k]))));
  }
  if (section === "weatherOverride") {
    const w = value && value.source === "manual" ? value : null;
    return JSON.stringify(w ? WEATHER_FIELDS.split(" ").filter((k) => k !== "fetchedAt").map((k) => w[k] ?? null) : null);
  }
  return JSON.stringify(String(value ?? ""));
}
// What a correction changed, for the history (the audit helper stores it as JSON). A very long
// section is kept as a cut-off text instead.
const clip = (v) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 3900 ? `${s.slice(0, 3900)}…` : v ?? null;
};
const parsed = (s) => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------- writing ----------
async function saveLog(db, c, log, changes, kind, extra = {}) {
  const version = Number(log.version ?? 0);
  const n = await db.updateWhere("DailyLog", { ItemId: { eq: log.ItemId }, version: { eq: version } }, c.me.tenantRole, {
    ...changes,
    version: version + 1,
    lastChange: { kind, nonce: crypto.randomUUID(), fromStatus: log.status, toStatus: changes.status ?? log.status, previousBallUserId: "", actorUserId: c.me.userId, reason: extra.reason ?? "", before: "", after: "" }
  });
  if (n !== 1) throw new Refused("STATE_CHANGED", `Someone else just changed the log for ${niceDate(log.logDate)}. It has been reloaded; please try again.`);
  return { ...log, ...changes, version: version + 1 };
}

function history(db, c, log, action, summary, extra = {}) {
  return db.audit(c.me, {
    projectId: c.projectId,
    recordType: "dailyLog",
    recordId: log.ItemId,
    recordNumber: log.logDate,
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

// The day's log, created when it has none (the earliest saved wins a race).
async function ensureLog(db, c, date, ctx) {
  const existing = await loadLog(db, c, date);
  if (existing) return existing;
  const weather = await forecastFor(ctx, c, date);
  const now = new Date().toISOString();
  const row = {
    tenantRole: c.me.tenantRole,
    projectId: c.projectId,
    logDate: date,
    status: "draft",
    version: 0,
    isWorkingDay: !isWeekend(date),
    ...(weather ? { weather } : {}),
    siteConditions: "",
    equipment: [],
    deliveries: [],
    visitors: [],
    delays: [],
    safety: [],
    notes: "",
    manpowerSummary: [],
    totalHeadcount: 0,
    totalHours: 0,
    createdAt: now,
    createdByUserId: c.me.userId,
    correctionCount: 0,
    lastChange: { kind: "created", nonce: crypto.randomUUID(), fromStatus: "", toStatus: "draft", previousBallUserId: "", actorUserId: c.me.userId, reason: "", before: "", after: "" }
  };
  const itemId = await db.insert("DailyLog", row);
  const winner = await loadLog(db, c, date);
  if (winner && winner.ItemId !== itemId) {
    await db.updateWhere("DailyLog", { ItemId: { eq: itemId } }, c.me.tenantRole, { duplicateOf: winner.ItemId }).catch(() => 0);
    return winner;
  }
  const log = winner ?? { ...row, ItemId: itemId };
  await history(db, c, log, "created", `${actor(c)} opened the log for ${niceDate(date)}`, { toStatus: "draft" });
  return log;
}

async function month(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  const m = String(args.month ?? c.today.slice(0, 7));
  if (!MONTH.test(m)) throw new Refused("BAD_DATE", "Choose a month.");
  const rows = (await db.list("DailyLog", MONTH_FIELDS, me.tenantRole, { projectId: c.projectId })).filter((r) => !r.duplicateOf && String(r.logDate ?? "").startsWith(m));
  const byDate = new Map();
  for (const r of rows) if (!byDate.has(r.logDate) || first([byDate.get(r.logDate), r]) === r) byDate.set(r.logDate, r);
  const days = [...byDate.values()]
    .sort((a, b) => a.logDate.localeCompare(b.logDate))
    .map((r) => {
      const submitted = r.status === "submitted";
      if (!c.seesAll && !c.writer && !c.crewOwn && !submitted) return { date: r.logDate, status: "pending", isWorkingDay: r.isWorkingDay !== false };
      const wx = r.weatherOverride?.source === "manual" ? r.weatherOverride.condition : r.weather?.condition;
      return {
        date: r.logDate,
        status: r.status,
        isWorkingDay: r.isWorkingDay !== false,
        condition: wx || "",
        headcount: submitted && fullView(c, r) ? Number(r.totalHeadcount ?? 0) : null,
        corrections: Number(r.correctionCount ?? 0)
      };
    });
  return { ok: true, month: m, today: c.today, role: c.role, place: c.project.address?.city || "", days, can: { open: !c.archived && (c.writer || c.crewOwn), seesCrewTotals: c.seesAll || c.seesSubmitted } };
}

async function get(db, me, args) {
  const c = await projectContext(db, me, args.projectId);
  return detail(db, c, validDate(args.date));
}

async function open(db, me, args, ctx) {
  const c = await projectContext(db, me, args.projectId);
  const date = validDate(args.date);
  const existing = await loadLog(db, c, date);
  if (existing) return detail(db, c, date, existing);
  if (c.archived) throw new Refused("ARCHIVED", "This project is archived and read-only.");
  if (date > addDays(c.today, 1)) throw new Refused("FUTURE_DATE", "A log can be opened up to one day ahead.");
  if (!c.writer && !(c.crewOwn && date === c.today)) {
    throw new Refused("NOT_ALLOWED", c.crewOwn ? "Only the superintendent or the project manager opens the log for another day." : "Only the superintendent or the project manager opens a day's log.");
  }
  return detail(db, c, date, await ensureLog(db, c, date, ctx));
}

async function saveSection(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const date = validDate(args.date);
  const section = String(args.section ?? "");
  if (!SECTIONS.includes(section)) throw new Refused("BAD_SECTION", "Unknown section of the daily log.");
  if (!c.writer) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager fill in the log.");
  if (date > addDays(c.today, 1)) throw new Refused("FUTURE_DATE", "A log can be opened up to one day ahead.");
  const value = cleanSection(section, args.value);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const log = (await loadLog(db, c, date)) ?? (await ensureLog(db, c, date));
    if (log.status !== "draft") throw new Refused("LOG_SUBMITTED", `The log for ${niceDate(date)} is submitted. The project manager can correct it with a reason.`);
    const now = log[section];
    if (args.base !== undefined && canon(section, now) !== canon(section, args.base)) {
      throw new Refused("CONFLICT", `Someone else just changed the ${SECTION_LABEL[section]} of this log. It has been reloaded; check it and save again.`);
    }
    if (canon(section, now) === canon(section, value)) return detail(db, c, date, log);
    try {
      const saved = await saveLog(db, c, log, { [section]: value }, "edited");
      const what = ROW_SECTIONS.includes(section) ? `${SECTION_LABEL[section]} (${plural(value.length, "row")})` : SECTION_LABEL[section];
      await history(db, c, saved, "edited", `${actor(c)} updated ${what}`);
      return detail(db, c, date, saved);
    } catch (error) {
      // Another card of the same log was saved in between: read again and retry this one.
      if (!(error instanceof Refused && error.code === "STATE_CHANGED") || attempt === 3) throw error;
    }
  }
  throw new Refused("STATE_CHANGED", "The log is busy. Please try again.");
}

// Which company's crew the caller may write: their own (subcontractors), any on the team (GC).
function crewCompanyFor(c, wanted) {
  const own = c.mine.companyId;
  if (!c.writer) {
    if (!c.crewOwn || !own) throw new Refused("NOT_ALLOWED", "Your project role can't add crew to the daily log.");
    if (wanted && wanted !== own) throw new Refused("NOT_ALLOWED", "You can only add your own company's crew.");
    return { companyId: own, companyName: c.mine.companyName || "" };
  }
  const id = wanted || own;
  const co = crewCompanies(c).find((x) => x.companyId === id);
  if (!co) throw new Refused("NOT_FOUND", "That company has nobody on this project's team.");
  return co;
}

async function writeCrew(db, c, log, co, manpower, notes, version) {
  const crews = await loadCrews(db, c, log);
  const mine = crews.find((x) => x.companyId === co.companyId);
  const now = new Date().toISOString();
  const fields = { manpower, notes, lastEditedByUserId: c.me.userId, lastEditedByName: actor(c), lastEditedAt: now };
  if (!mine) {
    const itemId = await db.insert("DailyLogCrew", {
      tenantRole: c.me.tenantRole, projectId: c.projectId, dailyLogId: log.ItemId, logDate: log.logDate,
      companyId: co.companyId, companyName: co.companyName, status: "open", version: 0, ...fields
    });
    const winner = (await loadCrews(db, c, log)).find((x) => x.companyId === co.companyId);
    if (winner && winner.ItemId !== itemId) {
      // Two first saves for one company at once: the other one is the company's crew.
      await db.updateWhere("DailyLogCrew", { ItemId: { eq: itemId } }, c.me.tenantRole, { duplicateOf: winner.ItemId }).catch(() => 0);
      throw new Refused("STATE_CHANGED", `Someone else just saved ${co.companyName || "this company"}'s crew. It has been reloaded; check it and save again.`);
    }
    return { before: null, after: { manpower, notes } };
  }
  if (version !== undefined && Number(version) !== Number(mine.version ?? 0)) {
    throw new Refused("STATE_CHANGED", `Someone else just changed ${co.companyName || "this company"}'s crew. It has been reloaded; check it and save again.`);
  }
  const n = await db.updateWhere("DailyLogCrew", { ItemId: { eq: mine.ItemId }, version: { eq: Number(mine.version ?? 0) } }, c.me.tenantRole, { ...fields, version: Number(mine.version ?? 0) + 1 });
  if (n !== 1) throw new Refused("STATE_CHANGED", `Someone else just changed ${co.companyName || "this company"}'s crew. It has been reloaded; check it and save again.`);
  return { before: { manpower: rowsOf(mine.manpower), notes: mine.notes || "" }, after: { manpower, notes } };
}

async function saveCrew(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const date = validDate(args.date);
  const co = crewCompanyFor(c, text(args.companyId, 64));
  const manpower = cleanRows("manpower", args.manpower ?? []);
  const notes = longText(args.notes, 4000);
  let log = await loadLog(db, c, date);
  if (!log) {
    if (date > addDays(c.today, 1) || (!c.writer && date !== c.today)) throw new Refused("NO_LOG", "There is no log for this day yet. The superintendent opens it.");
    log = await ensureLog(db, c, date);
  }
  if (log.status !== "draft") throw new Refused("LOG_SUBMITTED", `The log for ${niceDate(date)} is submitted. Ask the project manager to add your crew as a correction.`);
  await writeCrew(db, c, log, co, manpower, notes, args.version);
  const t = totalsOf(manpower);
  await history(db, c, log, "crewUpdated", `${actor(c)} updated ${co.companyName || "a company"}'s crew (${plural(t.headcount, "worker")}, ${t.hours} h)`);
  return detail(db, c, date);
}

// Every company's crew rows in one list, with the company on each row.
function summaryOf(crews) {
  const rows = [];
  for (const x of crews) for (const r of rowsOf(x.manpower)) rows.push({ ...r, companyId: x.companyId, companyName: x.companyName || "" });
  return { manpowerSummary: rows, totalHeadcount: totalsOf(rows).headcount, totalHours: totalsOf(rows).hours };
}

async function submit(db, me, args, ctx) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const date = validDate(args.date);
  if (!c.writer) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager submit the log.");
  const log = await loadLog(db, c, date);
  if (!log) throw new Refused("NO_LOG", "There is no log for this day yet.");
  if (log.status !== "draft") throw new Refused("INVALID_TRANSITION", `The log for ${niceDate(date)} is already submitted.`);
  if (date > c.today) throw new Refused("FUTURE_DATE", "A day can be submitted once it has started.");
  const crews = await loadCrews(db, c, log);
  // Crews first, the log last: if this stops half way, the log is still a draft and the next
  // submit locks them again.
  for (const x of crews) {
    if (x.status === "locked") continue;
    await db.updateWhere("DailyLogCrew", { ItemId: { eq: x.ItemId }, version: { eq: Number(x.version ?? 0) } }, me.tenantRole, { status: "locked", version: Number(x.version ?? 0) + 1 });
  }
  const sum = summaryOf(crews);
  // The day's weather as recorded at submit (best effort; a failure keeps the morning's forecast).
  const weather = await forecastFor(ctx, c, date);
  const now = new Date().toISOString();
  const saved = await saveLog(db, c, log, { status: "submitted", submittedAt: now, submittedByUserId: me.userId, submittedByName: actor(c), ...sum, ...(weather ? { weather } : {}) }, "statusChanged");
  await history(db, c, saved, "submitted", `${actor(c)} submitted the log for ${niceDate(date)} (${plural(sum.totalHeadcount, "worker")}, ${plural(crews.filter((x) => rowsOf(x.manpower).length).length, "company")})`, { fromStatus: "draft", toStatus: "submitted" });
  return detail(db, c, date, saved);
}

// "Refresh forecast" on a draft: the GC reads the day's weather again (the morning forecast for a
// day that has passed becomes the measured figures).
async function refreshWeather(db, me, args, ctx) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const date = validDate(args.date);
  if (!c.writer) throw new Refused("NOT_ALLOWED", "Only the superintendent and the project manager refresh the forecast.");
  const log = await loadLog(db, c, date);
  if (!log) throw new Refused("NO_LOG", "There is no log for this day yet.");
  if (log.status !== "draft") throw new Refused("INVALID_TRANSITION", "A submitted log keeps the weather it was submitted with.");
  if (!text(c.project.address?.city, 100)) throw new Refused("NO_LOCATION", "The project has no city, so there is no forecast. Add the city in the project settings, or enter the weather by hand.");
  const weather = await forecastFor(ctx, c, date);
  if (!weather) throw new Refused("WEATHER_UNAVAILABLE", "The forecast couldn't be loaded for this day. Try again later, or enter the weather by hand.");
  const saved = await saveLog(db, c, log, { weather }, "updated");
  return detail(db, c, date, saved);
}

async function correct(db, me, args) {
  const c = await projectContext(db, me, args.projectId, { write: true });
  const date = validDate(args.date);
  if (!c.corrector) throw new Refused("NOT_ALLOWED", "Only the project manager corrects a submitted log.");
  const reason = longText(args.reason, 1000);
  if (reason.length < 5) throw new Refused("REASON_REQUIRED", "Say why the log is corrected (at least 5 characters).");
  const log = await loadLog(db, c, date);
  if (!log) throw new Refused("NO_LOG", "There is no log for this day.");
  if (log.status !== "submitted") throw new Refused("INVALID_TRANSITION", "Only a submitted log is corrected. A draft is simply edited.");
  const count = Number(log.correctionCount ?? 0) + 1;
  if (args.crewCompanyId !== undefined) {
    const co = crewCompanyFor(c, text(args.crewCompanyId, 64));
    const manpower = cleanRows("manpower", args.manpower ?? []);
    const notes = longText(args.notes, 4000);
    const change = await writeCrew(db, c, log, co, manpower, notes, undefined);
    const sum = summaryOf(await loadCrews(db, c, log));
    const saved = await saveLog(db, c, log, { ...sum, correctionCount: count }, "corrected", { reason });
    await history(db, c, saved, "corrected", `${actor(c)} corrected ${co.companyName || "a company"}'s crew`, {
      reason, before: clip(change.before), after: clip(change.after)
    });
    // A crew added by correction stays locked like the others.
    const added = (await loadCrews(db, c, log)).find((x) => x.companyId === co.companyId && x.status !== "locked");
    if (added) await db.updateWhere("DailyLogCrew", { ItemId: { eq: added.ItemId } }, me.tenantRole, { status: "locked" }).catch(() => 0);
    return detail(db, c, date);
  }
  const section = String(args.section ?? "");
  if (!SECTIONS.includes(section)) throw new Refused("BAD_SECTION", "Choose what to correct.");
  const value = cleanSection(section, args.value);
  if (canon(section, log[section]) === canon(section, value)) throw new Refused("NO_CHANGE", "Nothing was changed.");
  const saved = await saveLog(db, c, log, { [section]: value, correctionCount: count }, "corrected", { reason });
  await history(db, c, saved, "corrected", `${actor(c)} corrected the ${SECTION_LABEL[section]}`, {
    reason, before: clip(log[section]), after: clip(value)
  });
  return detail(db, c, date, saved);
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "daily-logs", {
    month: (args, { db, me }) => month(db, me, args),
    get: (args, { db, me }) => get(db, me, args),
    open: (args, { ctx, db, me }) => open(db, me, args, ctx),
    saveSection: (args, { db, me }) => saveSection(db, me, args),
    saveCrew: (args, { db, me }) => saveCrew(db, me, args),
    submit: (args, { ctx, db, me }) => submit(db, me, args, ctx),
    refreshWeather: (args, { ctx, db, me }) => refreshWeather(db, me, args, ctx),
    correct: (args, { db, me }) => correct(db, me, args)
  });
}
