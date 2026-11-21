// Platform admin (ADM-02): Buildnexa operations list and create customer companies.
// Called from the app with the signed-in platform admin's token (blocksClient.logic.functions.call).
//
//   { action: "list" }   -> every customer company: name, tag, admins, people, projects, created
//   { action: "create", name, shortName, admin: { email, firstName, lastName } }
//        -> the company's tag role company-<shortName>, its Blocks organization, the bell
//           permissions for the shared roles inside it, the first company admin (IAM emails the
//           invite) and the Company + OrgMember records. Safe to run again after a failure: each
//           step is skipped when it is already done.
//
// Security:
// - Platform admins only: the Function's trigger allows only the role platform-admin, platformCaller
//   checks it again, and the platform service password (Blocks secret) is readable by
//   platform-admin only. Company people can never reach this service identity.
// - Platform admins see company names and counts, never project records.
// - Never returns or logs a token.

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
  // Every company's rows: only for platform work (counts per company), never sent to a company.
  async function listAll(schema, fields) {
    const q = `get${schema}s`;
    const data = await gql(`query q($input: DynamicQueryInput) { ${q}(input: $input) { items { tenantRole ${fields} } } }`, { input: { pageNo: 1, pageSize: 1000 } });
    return data?.[q]?.items ?? [];
  }
  // The service reads every tenant; always filter to the caller's company.
  async function list(schema, fields, tenantRole) {
    return (await listAll(schema, fields)).filter((r) => r.tenantRole === tenantRole);
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
  return { iam, gql, insert, list, listAll, update, updateWhere };
}

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
// <<< shared

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHORT_NAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
// "company-admin" is a job role, so a company may never be called "admin".
const RESERVED = ["admin"];
const SHARED_ROLES = ["company-admin", "staff", "external"];

const text = (v) => (typeof v === "string" ? v.trim() : "");

async function listCompanies(db) {
  const [companies, members, projects] = await Promise.all([
    db.listAll("Company", "ItemId name relation status isVoided CreatedDate"),
    db.listAll("OrgMember", "ItemId userId email firstName lastName displayName isCompanyAdmin status"),
    db.listAll("Project", "ItemId status")
  ]);
  const rows = companies
    .filter((c) => c.relation === "self" && !c.isVoided)
    .map((c) => {
      const people = members.filter((m) => m.tenantRole === c.tenantRole && m.status !== "removed" && m.status !== "deactivated");
      return {
        id: c.ItemId,
        name: c.name,
        tag: c.tenantRole,
        status: c.status || "active",
        createdAt: c.CreatedDate,
        admins: people.filter((m) => m.isCompanyAdmin).map((m) => ({ name: personName(m), email: m.email, status: m.status })),
        people: people.length,
        invited: people.filter((m) => m.status === "invited").length,
        projects: projects.filter((p) => p.tenantRole === c.tenantRole && p.status !== "archived").length
      };
    });
  return { ok: true, companies: rows.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

async function findRole(db, slug) {
  const res = await db.iam("/iam/v4/iam/roles", { filter: { search: slug }, page: 0, pageSize: 50 });
  return (res.data ?? []).find((r) => r.slug === slug);
}

async function findOrganization(db, name) {
  const q = new URLSearchParams({ "Filter.Search": name, Page: "0", PageSize: "50" });
  const res = await db.iam(`/iam/v4/iam/organizations?${q}`);
  return (res.organizations ?? []).find((o) => o.name === name);
}

async function createCompany(ctx, db, me, args) {
  const name = text(args.name);
  const shortName = text(args.shortName).toLowerCase();
  const email = text(args.admin?.email).toLowerCase();
  const firstName = text(args.admin?.firstName);
  const lastName = text(args.admin?.lastName);
  if (name.length < 2 || name.length > 120) throw new Refused("BAD_NAME", "Enter the company name (2 to 120 characters).");
  if (!SHORT_NAME.test(shortName) || shortName.includes("--")) {
    throw new Refused("BAD_SHORT_NAME", "The short name uses 3 to 32 lowercase letters, digits and single hyphens, e.g. mueller-bau.");
  }
  if (RESERVED.includes(shortName)) throw new Refused("BAD_SHORT_NAME", `"${shortName}" is reserved. Choose another short name.`);
  if (!EMAIL.test(email)) throw new Refused("BAD_EMAIL", "Enter the first company admin's email address.");
  if (!firstName || !lastName) throw new Refused("BAD_ADMIN_NAME", "Enter the first company admin's first and last name.");

  const tenantRole = `company-${shortName}`;
  const companies = (await db.listAll("Company", "ItemId name relation isVoided")).filter((c) => c.relation === "self" && !c.isVoided);
  if (companies.some((c) => c.tenantRole === tenantRole)) throw new Refused("SHORT_NAME_TAKEN", "Another company already uses this short name.");
  if (companies.some((c) => String(c.name).toLowerCase() === name.toLowerCase())) throw new Refused("COMPANY_EXISTS", "A company with this name already exists.");
  const steps = {};

  // 1. The company's tag: a project-wide role every person and record of the company carries.
  if (await findRole(db, tenantRole)) {
    steps.tag = "existed";
  } else {
    await db.iam("/iam/v4/iam/roles/create", { name: `Company ${name}`, slug: tenantRole, description: `Company tag of ${name}: every person and record of this company carries it. Not a job role.` });
    if (!(await findRole(db, tenantRole))) throw new Error(`role ${tenantRole} was not created with that exact slug`);
    steps.tag = "created";
  }

  // 2. The company's Blocks organization.
  let org = await findOrganization(db, name);
  if (org) {
    steps.organization = "existed";
  } else {
    const created = await db.iam("/iam/v4/iam/organizations/create", { name, description: `Buildnexa customer company (${tenantRole})` });
    const id = created.itemId ?? created.id ?? created.organizationId ?? created.data?.itemId ?? created.data;
    if (typeof id !== "string") throw new Error("IAM returned no organization id");
    org = { itemId: id, name };
    steps.organization = "created";
  }

  // 3. The bell: reading and marking notifications needs these permissions on the person's role
  //    INSIDE the company's organization (a grant in "default" alone gets 403).
  const notifier = String(ctx.env.NOTIFIER_PERMISSION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (notifier.length !== 2) throw new Error("NOTIFIER_PERMISSION_IDS is not set");
  for (const slug of SHARED_ROLES) {
    await db.iam("/iam/v4/iam/roles/assign-permissions", { slug, organizationId: org.itemId, addPermissions: notifier, removePermissions: [] });
  }
  steps.bell = "granted";

  // 4. The first company admin. IAM emails the invitation to a new account.
  const roles = ["company-admin", tenantRole];
  const exists = await db.iam("/iam/v4/iam/users/exists", { email });
  let userId = exists.userId || exists.data?.userId;
  if (!userId) {
    const created = await db.iam("/iam/v4/iam/users/create", { email, firstName, lastName, organizationId: org.itemId, roles });
    userId = created.itemId ?? created.data?.itemId ?? created.userId ?? created.data;
    steps.admin = "invited (new account)";
  } else {
    await db.iam("/iam/v4/iam/users/access", { userId, organizationId: org.itemId, roles });
    steps.admin = "existing account added";
  }
  if (typeof userId !== "string") throw new Error("IAM returned no user id");

  // 5. The records the company's screens read.
  const now = new Date().toISOString();
  const companyId = await db.insert("Company", { tenantRole, name, legalName: name, relation: "self", status: "active", defaultLanguage: "en", isVoided: false });
  await db.insert("OrgMember", {
    tenantRole,
    userId,
    email,
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    companyId,
    companyName: name,
    companyRelation: "self",
    orgRole: "staff",
    isCompanyAdmin: true,
    canCreateProjects: true,
    status: "invited",
    invitedByUserId: me.userId,
    invitedAt: now
  });
  steps.records = "created";
  ctx.log.info("company created", { tenantRole, organizationId: org.itemId, steps });
  return { ok: true, company: { id: companyId, name, tag: tenantRole, organizationId: org.itemId }, steps };
}

export default async function handler(input, ctx) {
  return handle(
    input,
    ctx,
    "platform",
    {
      list: (args, { db }) => listCompanies(db),
      create: (args, { ctx, db, me }) => createCompany(ctx, db, me, args)
    },
    platformCaller
  );
}
