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

const API = "https://blocksapi.slsblx.com";
const PROJECT_ROLES = ["project-manager", "superintendent", "document-controller", "field-user", "design-reviewer", "owner-viewer"];
const STAGES = ["preconstruction", "construction", "closeout"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  // Updates one row, matched by id AND company, so a wrong id can never touch another company.
  async function update(schema, itemId, tenantRole, input) {
    const data = await gql(
      `mutation m($where: ${schema}FilterInput, $input: ${schema}UpdateInput) { update${schema}(where: $where, input: $input) { acknowledged totalImpactedData } }`,
      { where: { ItemId: { eq: itemId }, tenantRole: { eq: tenantRole } }, input }
    );
    const r = data?.[`update${schema}`];
    if (!r?.acknowledged) throw new Error(`update${schema} not acknowledged`);
  }
  return { insert, list, update };
}

function caller(ctx) {
  const roles = ctx.context.roles ?? [];
  const companyRoles = roles.filter((r) => typeof r === "string" && r.startsWith("co-"));
  if (companyRoles.length !== 1) throw new Refused("NO_COMPANY", "Your account is not linked to exactly one company in this organization.");
  return {
    userId: ctx.context.userId,
    tenantRole: companyRoles[0],
    isAdmin: roles.includes("company-admin"),
    isStaff: roles.includes("staff") || roles.includes("company-admin")
  };
}

const ORG_FIELDS = "ItemId userId email displayName firstName lastName companyId companyName companyRelation orgRole canCreateProjects status";
const PM_FIELDS = "ItemId projectId userId orgMemberId role status";

function name(m) {
  return m.displayName || [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email;
}

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
    displayName: name(m),
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
  const args = (input && input.method ? input.body : input) ?? {};
  try {
    const me = caller(ctx);
    const db = client(ctx, await serviceToken(ctx));
    switch (args.action) {
      case "create": return await create(ctx, db, me, args);
      case "addMembers": return await addMembers(db, me, args);
      case "setRole": return await setRole(db, me, args);
      case "removeMember": return await removeMember(db, me, args);
      default: return { ok: false, code: "BAD_ACTION", error: "Unknown action." };
    }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, error: error.message };
    ctx.log.error("projects failed", { action: args.action, message: error.message });
    return { ok: false, code: "FAILED", error: "Something went wrong. Please try again." };
  }
}
