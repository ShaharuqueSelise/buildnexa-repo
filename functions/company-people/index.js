// Company admin › People (Phase 1): the company's people, as on the demo app's Company admin page.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list" }                        -> people + IAM account details, companies, projects
//   { action: "invite", email, firstName, lastName, jobTitle?, companyId, defaultRole, projectIds? }
//   { action: "setDefaultRole", memberId, role }
//   { action: "resend", memberId }            -> new invitation email (people not joined yet)
//   { action: "deactivate", memberId }        -> removes this company's access; records stay
//   { action: "reactivate", memberId }        -> gives the access back
//   { action: "setAdmin", memberId, isAdmin, role? } -> make a staff member a company admin, or
//                                                 turn an admin back into staff (role = their
//                                                 default project role from then on)
//
// Security (docs/architecture/01 §4.2):
// - Company admins only. The Buildnexa service password (Blocks secret) is readable by the role
//   company-admin only, so for anyone else Blocks stops the run before this code starts.
// - The caller's company is taken from THEIR token: the one `co-` role they hold in their current
//   organization. Every read is filtered to it and every write is stamped with it.
// - The only IAM roles this Function grants are `staff`/`external`/`company-admin` plus the
//   caller's own company tag. `company-admin` only ever goes to the company's own staff.
// - Nobody changes or deactivates themselves, and the last company admin can't be removed.
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function adminOnly(me) {
  if (!accountCan(me.roles, "company.manage_people")) throw new Refused("NOT_ADMIN", "Only a company admin can manage people.");
  return me;
}

function partnersAdminOnly(me) {
  if (!accountCan(me.roles, "company.manage_partners")) throw new Refused("NOT_ADMIN", "Only a company admin can manage partner companies.");
  return me;
}

const roleNotForPartner = () =>
  new Refused("PARTNER_ROLE", "People from partner companies can be Subcontractor, Designer/Consultant or Owner on a project, not Project Manager, Superintendent or Document Controller.");

// The admin's own name for the activity history.
const nameOf = (members, me) => {
  const m = members.find((x) => x.userId === me.userId);
  return m ? personName(m) : undefined;
};

const MEMBER_FIELDS =
  "ItemId userId email firstName lastName displayName phone jobTitle companyId companyName companyRelation orgRole defaultRole isCompanyAdmin status invitedAt joinedAt";

const strip = ({ tenantRole: _t, ...rest }) => rest;

async function listPeople(ctx, db, me) {
  const [members, companies, projects, projectMembers] = await Promise.all([
    db.list("OrgMember", MEMBER_FIELDS, me.tenantRole),
    db.list("Company", "ItemId name relation brandColor isVoided tradeCodes address { city }", me.tenantRole),
    db.list("Project", "ItemId number name status", me.tenantRole),
    db.list("ProjectMember", "ItemId projectId userId orgMemberId role status", me.tenantRole)
  ]);
  // Account state, last sign-in, phone and language live in IAM.
  const people = await Promise.all(
    members.map(async (m) => {
      let account = { accountState: "Unknown" };
      try {
        const u = await db.iam(`/iam/v4/iam/users/${encodeURIComponent(m.userId)}?organizationId=${encodeURIComponent(me.organizationId)}`);
        const d = u.data ?? u;
        account = {
          accountState: d.accountState,
          // IAM sends year 0001 for "never signed in".
          lastLoggedInTime: d.lastLoggedInTime && !d.lastLoggedInTime.startsWith("0001") ? d.lastLoggedInTime : undefined,
          phoneNumber: d.phoneNumber || undefined,
          language: d.language || undefined
        };
      } catch (error) {
        // keep "Unknown"; the row still shows
        ctx.log.warn("IAM user read failed", { memberId: m.ItemId, message: error.message });
      }
      // Keep the company list in step with IAM: someone who set up their account is "active",
      // so screens that read OrgMember directly (the project Directory) show it too.
      if (account.accountState === "Active" && m.status === "invited") {
        try {
          const joinedAt = new Date().toISOString();
          await db.update("OrgMember", m.ItemId, me.tenantRole, { status: "active", joinedAt });
          Object.assign(m, { status: "active", joinedAt });
        } catch (error) {
          ctx.log.warn("member status update failed", { memberId: m.ItemId, message: error.message });
        }
      }
      return { ...strip(m), ...account, isMe: m.userId === me.userId };
    })
  );
  return {
    ok: true,
    people: people.sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? "")),
    companies: companies.filter((c) => !c.isVoided).map(strip),
    projects: projects.filter((p) => p.status !== "archived").map(strip),
    memberships: projectMembers.filter((pm) => pm.status !== "removed").map(strip)
  };
}

async function findMember(db, me, memberId) {
  const members = await db.list("OrgMember", MEMBER_FIELDS, me.tenantRole);
  const m = members.find((x) => x.ItemId === memberId);
  if (!m) throw new Refused("NOT_FOUND", "This person is not in your company.");
  return m;
}

function notMe(me, m, what) {
  if (m.userId === me.userId) throw new Refused("SELF", `You can't ${what} yourself.`);
}

async function invite(ctx, db, me, args) {
  const email = String(args.email ?? "").trim().toLowerCase();
  const firstName = String(args.firstName ?? "").trim();
  const lastName = String(args.lastName ?? "").trim();
  const jobTitle = String(args.jobTitle ?? "").trim() || undefined;
  const defaultRole = String(args.defaultRole ?? "");
  const projectIds = Array.isArray(args.projectIds) ? [...new Set(args.projectIds.map(String))] : [];
  if (!EMAIL.test(email)) throw new Refused("BAD_EMAIL", "Enter a valid email address.");
  if (!firstName || !lastName) throw new Refused("BAD_NAME", "Enter a first and last name.");
  if (!PROJECT_ROLES.includes(defaultRole)) throw new Refused("BAD_ROLE", "Choose a default role.");

  const [companies, members, projects] = await Promise.all([
    db.list("Company", "ItemId name relation isVoided", me.tenantRole),
    db.list("OrgMember", "ItemId email userId status displayName firstName lastName", me.tenantRole),
    db.list("Project", "ItemId status", me.tenantRole)
  ]);
  const company = companies.find((c) => c.ItemId === args.companyId && !c.isVoided);
  if (!company) throw new Refused("BAD_COMPANY", "Choose the company this person works for.");
  if (!mayHoldProjectRole(company.relation, defaultRole)) throw roleNotForPartner();
  const orgRole = company.relation === "self" ? "staff" : "external";
  for (const pid of projectIds) {
    if (!projects.some((p) => p.ItemId === pid && p.status !== "archived")) throw new Refused("BAD_PROJECT", "One of the projects is not in your company.");
  }
  if (members.some((m) => (m.email ?? "").toLowerCase() === email && m.status !== "removed")) {
    throw new Refused("ALREADY_MEMBER", "This person already has an account in your company.");
  }

  const roles = [orgRole, me.tenantRole];
  const exists = await db.iam("/iam/v4/iam/users/exists", { email });
  let userId = exists.userId || exists.data?.userId;
  let invited;
  if (!userId) {
    // New account: IAM emails the invitation (the link opens the Buildnexa "Set up your account" page).
    const created = await db.iam("/iam/v4/iam/users/create", { email, firstName, lastName, organizationId: me.organizationId, roles });
    userId = created.itemId ?? created.data?.itemId ?? created.userId ?? created.data;
    invited = "new-account";
  } else {
    // Existing Blocks account (e.g. in another company): add this organization.
    const orgs = exists.organizationIds ?? exists.data?.organizationIds ?? [];
    if (!orgs.includes(me.organizationId)) {
      await db.iam("/iam/v4/iam/users/access", { userId, organizationId: me.organizationId, roles });
    }
    invited = "existing-account";
  }
  if (typeof userId !== "string") throw new Error("IAM returned no user id");

  const now = new Date().toISOString();
  const displayName = `${firstName} ${lastName}`;
  const memberId = await db.insert("OrgMember", {
    tenantRole: me.tenantRole,
    userId,
    email,
    firstName,
    lastName,
    displayName,
    jobTitle,
    companyId: company.ItemId,
    companyName: company.name,
    companyRelation: company.relation,
    orgRole,
    defaultRole,
    isCompanyAdmin: false,
    canCreateProjects: false,
    status: "invited",
    invitedByUserId: me.userId,
    invitedAt: now
  });
  for (const projectId of projectIds) {
    await db.insert("ProjectMember", {
      tenantRole: me.tenantRole,
      projectId,
      userId,
      orgMemberId: memberId,
      email,
      displayName,
      companyId: company.ItemId,
      companyName: company.name,
      companyRelation: company.relation,
      role: defaultRole,
      status: "active",
      isBallInCourtEligible: true,
      joinedAt: now
    });
  }
  ctx.log.info("person invited", { memberId, orgRole, invited, projects: projectIds.length });
  const who = nameOf(members, me);
  await db.audit(me, { recordType: "person", recordId: userId, action: "invited", actorName: who, after: { company: company.name, defaultRole, projects: projectIds.length }, summary: `${who ?? "A company admin"} invited ${displayName} (${company.name}) as ${defaultRole}` });
  for (const projectId of projectIds) {
    await db.audit(me, { projectId, recordType: "projectMember", recordId: userId, action: "memberAdded", actorName: who, after: { role: defaultRole }, summary: `${who ?? "A company admin"} added ${displayName} as ${defaultRole}` });
  }
  return { ok: true, memberId, invited };
}

// Stories 3.1 and 3.2: more than one company admin.
async function setAdmin(db, me, args) {
  const makeAdmin = args.isAdmin === true;
  const members = await db.list("OrgMember", MEMBER_FIELDS, me.tenantRole);
  const m = members.find((x) => x.ItemId === args.memberId);
  if (!m) throw new Refused("NOT_FOUND", "This person is not in your company.");
  notMe(me, m, makeAdmin ? "make an admin of" : "remove admin rights from");
  if (m.status === "deactivated" || m.status === "removed") throw new Refused("NOT_ACTIVE", "Reactivate this person first.");

  if (makeAdmin) {
    if (m.isCompanyAdmin) return { ok: true };
    // An outside company (subcontractor, designer, owner) must never run this company's account.
    if (m.orgRole === "external" || (m.companyRelation && m.companyRelation !== "self")) {
      throw new Refused("NOT_STAFF", "Only your own staff can be company admins, not people from partner companies.");
    }
    await db.iam("/iam/v4/iam/users/access", { userId: m.userId, organizationId: me.organizationId, roles: ["company-admin", me.tenantRole] });
    await db.update("OrgMember", m.ItemId, me.tenantRole, { isCompanyAdmin: true, canCreateProjects: true });
    await db.audit(me, { recordType: "person", recordId: m.userId, action: "madeAdmin", actorName: nameOf(members, me), summary: `${nameOf(members, me) ?? "A company admin"} made ${personName(m)} a company admin` });
    return { ok: true };
  }

  if (!m.isCompanyAdmin) return { ok: true };
  const admins = members.filter((x) => x.isCompanyAdmin && x.status !== "deactivated" && x.status !== "removed");
  if (admins.length <= 1) throw new Refused("LAST_ADMIN", "A company needs at least one company admin.");
  const role = PROJECT_ROLES.includes(String(args.role)) ? String(args.role) : m.defaultRole;
  await db.iam("/iam/v4/iam/users/access", { userId: m.userId, organizationId: me.organizationId, roles: ["staff", me.tenantRole] });
  await db.update("OrgMember", m.ItemId, me.tenantRole, { isCompanyAdmin: false, orgRole: "staff", ...(role ? { defaultRole: role } : {}) });
  await db.audit(me, { recordType: "person", recordId: m.userId, action: "adminRemoved", actorName: nameOf(members, me), summary: `${nameOf(members, me) ?? "A company admin"} removed company admin rights from ${personName(m)}` });
  return { ok: true };
}

async function setDefaultRole(db, me, args) {
  const role = String(args.role ?? "");
  if (!PROJECT_ROLES.includes(role)) throw new Refused("BAD_ROLE", "Choose a default role.");
  const members = await db.list("OrgMember", MEMBER_FIELDS, me.tenantRole);
  const m = members.find((x) => x.ItemId === args.memberId);
  if (!m) throw new Refused("NOT_FOUND", "This person is not in your company.");
  notMe(me, m, "change the role of");
  if (!mayHoldProjectRole(m.companyRelation, role)) throw roleNotForPartner();
  if (m.defaultRole === role) return { ok: true };
  await db.update("OrgMember", m.ItemId, me.tenantRole, { defaultRole: role });
  await db.audit(me, { recordType: "person", recordId: m.userId, action: "defaultRoleChanged", actorName: nameOf(members, me), changedFields: ["defaultRole"], before: { defaultRole: m.defaultRole }, after: { defaultRole: role }, summary: `${nameOf(members, me) ?? "A company admin"} changed ${personName(m)}'s default role to ${role}` });
  return { ok: true };
}

async function resend(ctx, db, me, args) {
  const m = await findMember(db, me, args.memberId);
  const u = await db.iam(`/iam/v4/iam/users/${encodeURIComponent(m.userId)}?organizationId=${encodeURIComponent(me.organizationId)}`);
  if ((u.data ?? u).accountState === "Active") throw new Refused("ALREADY_JOINED", "This person has already set up their account.");
  try {
    await db.iam("/iam/v4/auth/resend-activation", { userId: m.userId, email: m.email });
  } catch (error) {
    // Open issue (20 Nov 2026): Blocks answers 403 to the service identity here.
    ctx.log.warn("resend refused", { memberId: m.ItemId, message: error.message });
    throw new Refused("RESEND_UNAVAILABLE", "Blocks didn't resend the invitation. This is a known open issue; the first invitation email still works for 24 hours.");
  }
  return { ok: true };
}

async function setActive(db, me, args, active) {
  const members = await db.list("OrgMember", MEMBER_FIELDS, me.tenantRole);
  const m = members.find((x) => x.ItemId === args.memberId);
  if (!m) throw new Refused("NOT_FOUND", "This person is not in your company.");
  notMe(me, m, active ? "reactivate" : "deactivate");
  if (active) {
    const roles = m.isCompanyAdmin ? ["company-admin", me.tenantRole] : [m.orgRole === "external" ? "external" : "staff", me.tenantRole];
    await db.iam("/iam/v4/iam/users/access", { userId: m.userId, organizationId: me.organizationId, roles });
    await db.update("OrgMember", m.ItemId, me.tenantRole, { status: "active" });
  } else {
    // Removes this company's access only; the person's account and other companies are untouched.
    await db.iam("/iam/v4/iam/users/revoke-access", { userId: m.userId, organizationId: me.organizationId });
    await db.update("OrgMember", m.ItemId, me.tenantRole, { status: "deactivated", removedAt: new Date().toISOString(), removedReason: "deactivated by company admin" });
  }
  const who = nameOf(members, me);
  await db.audit(me, { recordType: "person", recordId: m.userId, action: active ? "reactivated" : "deactivated", actorName: who, summary: `${who ?? "A company admin"} ${active ? "reactivated" : "deactivated"} ${personName(m)}` });
  return { ok: true };
}

// ---------- partner companies (spec: Company Admin invites or registers external companies) ----------
const PARTNER_RELATIONS = ["sub", "design", "owner", "supplier"];
const COMPANY_NAME = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

function companyInput(args) {
  const name = COMPANY_NAME(args.name);
  if (name.length < 2 || name.length > 120) throw new Refused("BAD_NAME", "Enter the company name (2 to 120 characters).");
  const tradeCodes = Array.isArray(args.tradeCodes) ? [...new Set(args.tradeCodes.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20) : [];
  const city = String(args.city ?? "").trim().slice(0, 80) || undefined;
  return { name, tradeCodes, city };
}

async function addCompany(db, me, args) {
  const relation = String(args.relation ?? "");
  if (!PARTNER_RELATIONS.includes(relation)) throw new Refused("BAD_RELATION", "Choose what the company is: subcontractor, design firm, owner or supplier.");
  const input = companyInput(args);
  const [companies, members] = await Promise.all([
    db.list("Company", "ItemId name isVoided", me.tenantRole),
    db.list("OrgMember", "ItemId userId displayName firstName lastName email", me.tenantRole)
  ]);
  if (companies.some((c) => !c.isVoided && c.name.toLowerCase() === input.name.toLowerCase())) {
    throw new Refused("COMPANY_EXISTS", "A company with this name is already in your list.");
  }
  const companyId = await db.insert("Company", {
    tenantRole: me.tenantRole,
    name: input.name,
    relation,
    tradeCodes: input.tradeCodes,
    address: input.city ? { city: input.city } : undefined,
    status: "active",
    isVoided: false
  });
  const who = nameOf(members, me);
  await db.audit(me, { recordType: "company", recordId: companyId, action: "companyAdded", actorName: who, after: { name: input.name, relation }, summary: `${who ?? "A company admin"} added ${input.name} (${relation})` });
  return { ok: true, companyId };
}

// Name, trades and city. What a company IS (sub, design, owner) stays: its people's roles depend on it.
async function updateCompany(db, me, args) {
  const input = companyInput(args);
  const [companies, members] = await Promise.all([
    db.list("Company", "ItemId name relation isVoided tradeCodes address { city }", me.tenantRole),
    db.list("OrgMember", "ItemId userId displayName firstName lastName email companyId", me.tenantRole)
  ]);
  const c = companies.find((x) => x.ItemId === args.companyId && !x.isVoided);
  if (!c) throw new Refused("NOT_FOUND", "This company is not in your list.");
  if (c.relation === "self") throw new Refused("OWN_COMPANY", "Your own company's details are changed under Branding (coming later).");
  if (companies.some((x) => x.ItemId !== c.ItemId && !x.isVoided && x.name.toLowerCase() === input.name.toLowerCase())) {
    throw new Refused("COMPANY_EXISTS", "A company with this name is already in your list.");
  }
  await db.update("Company", c.ItemId, me.tenantRole, { name: input.name, tradeCodes: input.tradeCodes, address: input.city ? { city: input.city } : null });
  // People and team rows carry the company name for lists; keep them in step.
  if (c.name !== input.name) {
    await db.updateWhere("OrgMember", { companyId: { eq: c.ItemId } }, me.tenantRole, { companyName: input.name });
    await db.updateWhere("ProjectMember", { companyId: { eq: c.ItemId } }, me.tenantRole, { companyName: input.name });
  }
  const who = nameOf(members, me);
  await db.audit(me, { recordType: "company", recordId: c.ItemId, action: "companyChanged", actorName: who, before: { name: c.name, tradeCodes: c.tradeCodes, city: c.address?.city }, after: input, summary: `${who ?? "A company admin"} changed ${input.name}` });
  return { ok: true };
}

// Removing a partner company keeps its history; it is refused while people still work for it.
async function removeCompany(db, me, args) {
  const [companies, members] = await Promise.all([
    db.list("Company", "ItemId name relation isVoided", me.tenantRole),
    db.list("OrgMember", "ItemId userId displayName firstName lastName email companyId status", me.tenantRole)
  ]);
  const c = companies.find((x) => x.ItemId === args.companyId && !x.isVoided);
  if (!c) throw new Refused("NOT_FOUND", "This company is not in your list.");
  if (c.relation === "self") throw new Refused("OWN_COMPANY", "You can't remove your own company.");
  const people = members.filter((m) => m.companyId === c.ItemId && m.status !== "deactivated" && m.status !== "removed");
  if (people.length) throw new Refused("HAS_PEOPLE", `${people.length} ${people.length === 1 ? "person still works" : "people still work"} for this company. Deactivate them first.`);
  await db.update("Company", c.ItemId, me.tenantRole, { isVoided: true, status: "inactive" });
  const who = nameOf(members, me);
  await db.audit(me, { recordType: "company", recordId: c.ItemId, action: "companyRemoved", actorName: who, summary: `${who ?? "A company admin"} removed ${c.name}` });
  return { ok: true };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "company-people", {
    list: (args, { ctx, db, me }) => listPeople(ctx, db, adminOnly(me)),
    invite: (args, { ctx, db, me }) => invite(ctx, db, adminOnly(me), args),
    setDefaultRole: (args, { db, me }) => setDefaultRole(db, adminOnly(me), args),
    resend: (args, { ctx, db, me }) => resend(ctx, db, adminOnly(me), args),
    deactivate: (args, { db, me }) => setActive(db, adminOnly(me), args, false),
    reactivate: (args, { db, me }) => setActive(db, adminOnly(me), args, true),
    setAdmin: (args, { db, me }) => setAdmin(db, adminOnly(me), args),
    addCompany: (args, { db, me }) => addCompany(db, partnersAdminOnly(me), args),
    updateCompany: (args, { db, me }) => updateCompany(db, partnersAdminOnly(me), args),
    removeCompany: (args, { db, me }) => removeCompany(db, partnersAdminOnly(me), args)
  });
}
