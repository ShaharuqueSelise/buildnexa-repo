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

const API = "https://blocksapi.slsblx.com";
const PROJECT_ROLES = ["project-manager", "superintendent", "document-controller", "field-user", "design-reviewer", "owner-viewer"];

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
  // The service reads every tenant; always filter to the caller's company.
  async function list(schema, fields, tenantRole) {
    const q = `get${schema}s`;
    const data = await gql(`query q($input: DynamicQueryInput) { ${q}(input: $input) { items { tenantRole ${fields} } } }`, { input: { pageNo: 1, pageSize: 1000 } });
    return (data?.[q]?.items ?? []).filter((r) => r.tenantRole === tenantRole);
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
  return { iam, gql, insert, list, update, updateWhere };
}

function caller(ctx) {
  const roles = ctx.context.roles ?? [];
  const companyRoles = roles.filter((r) => typeof r === "string" && r.startsWith("co-"));
  if (companyRoles.length !== 1) throw new Refused("NO_COMPANY", "Your account is not linked to exactly one company in this organization.");
  return {
    userId: ctx.context.userId,
    organizationId: ctx.context.organizationId,
    tenantRole: companyRoles[0],
    isAdmin: roles.includes("company-admin"),
    isStaff: roles.includes("staff") || roles.includes("company-admin")
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
    const rows = (await db.list("Sequence", SEQ_FIELDS, me.tenantRole))
      .filter((s) => s.projectId === projectId && s.key === key)
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
async function handle(input, ctx, label, actions) {
  const args = (input && input.method ? input.body : input) ?? {};
  try {
    const action = actions[args.action];
    if (!action) return { ok: false, code: "BAD_ACTION", error: "Unknown action." };
    const me = caller(ctx);
    const db = client(ctx, await serviceToken(ctx));
    return await action(args, { ctx, me, db });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, error: error.message };
    ctx.log.error(`${label} failed`, { action: args.action, message: error.message });
    return { ok: false, code: "FAILED", error: "Something went wrong. Please try again." };
  }
}
// <<< shared

const STAGES = ["preconstruction", "construction", "closeout"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ORG_FIELDS = "ItemId userId email displayName firstName lastName companyId companyName companyRelation orgRole canCreateProjects status";
const PM_FIELDS = "ItemId projectId userId orgMemberId role status";

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
  let added = 0;
  for (const t of team) {
    const m = orgMembers.find((x) => x.ItemId === t.orgMemberId && x.status !== "removed");
    if (!m) throw new Refused("NOT_IN_COMPANY", "One of these people is not in your company. Invite them in Company admin first.");
    const existing = rows.find((r) => r.projectId === projectId && r.userId === m.userId);
    if (existing?.status === "active") continue;
    if (existing) await db.update("ProjectMember", existing.ItemId, me.tenantRole, { role: t.role, status: "active", joinedAt: now, removedAt: null, removedReason: null });
    else await db.insert("ProjectMember", memberRow(me, projectId, m, t.role, now));
    added += 1;
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
  if (!me.isAdmin && !(me.isStaff && self.canCreateProjects)) {
    throw new Refused("NOT_ALLOWED_TO_CREATE", "Only Company Admins and staff allowed to create projects can do this.");
  }
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
  ctx.log.info("project created", { projectId, team: added });
  return { ok: true, projectId, added };
}

// Company admins pass for every project; otherwise the caller must be this project's PM.
async function teamContext(db, me, args) {
  const projectId = String(args.projectId ?? "");
  const [projects, rows] = await Promise.all([
    db.list("Project", "ItemId status", me.tenantRole),
    db.list("ProjectMember", PM_FIELDS, me.tenantRole)
  ]);
  const project = projects.find((p) => p.ItemId === projectId);
  if (!project) throw new Refused("NOT_FOUND", "This project is not in your company.");
  if (project.status === "archived") throw new Refused("ARCHIVED", "This project is archived and read-only.");
  const team = rows.filter((r) => r.projectId === projectId);
  const mine = team.find((r) => r.userId === me.userId && r.status === "active");
  if (!me.isAdmin && mine?.role !== "project-manager") {
    throw new Refused("NOT_ALLOWED", "Only the Project Manager or a Company Admin can change the team.");
  }
  return { projectId, rows, team };
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
  const orgMembers = await db.list("OrgMember", ORG_FIELDS, me.tenantRole);
  const added = await addTeam(db, me, ctx.projectId, team, orgMembers, ctx.rows);
  return { ok: true, added };
}

async function setRole(db, me, args) {
  const role = String(args.role ?? "");
  if (!PROJECT_ROLES.includes(role)) throw new Refused("BAD_ROLE", "Choose a project role.");
  const ctx = await teamContext(db, me, args);
  const row = findRow(me, ctx, String(args.projectMemberId ?? ""));
  if (role !== "project-manager") keepOnePm(ctx, row);
  await db.update("ProjectMember", row.ItemId, me.tenantRole, { role });
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
  return { ok: true };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "projects", {
    create: (args, { ctx, db, me }) => create(ctx, db, me, args),
    addMembers: (args, { db, me }) => addMembers(db, me, args),
    setRole: (args, { db, me }) => setRole(db, me, args),
    removeMember: (args, { db, me }) => removeMember(db, me, args)
  });
}
