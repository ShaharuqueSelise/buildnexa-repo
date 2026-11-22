// Platform admin (ADM-02): Buildnexa operations list and create customer companies.
// Called from the app with the signed-in platform admin's token (blocksClient.logic.functions.call).
//
//   { action: "list" }   -> every customer company: name, tag, admins, people, projects, created
//   { action: "create", name, shortName, admin: { email, firstName, lastName } }
//        -> the company's tag role company-<shortName>, its Blocks organization, the bell
//           permissions for the shared roles inside it, the first company admin (IAM emails the
//           invite) and the Company + OrgMember records. Safe to run again after a failure: each
//           step is skipped when it is already done.
//   { action: "addCompanyAdmin", companyId, admin: { email, firstName, lastName } }
//        -> story 3.4: rescue a company that lost its admin (invite, or promote someone already in it)
//   { action: "listAdmins" }                       -> story 3.5: everyone with platform-admin
//   { action: "addAdmin", email, firstName, lastName } -> story 3.6 (invite or add to an account)
//   { action: "removeAdmin", userId }              -> story 3.7 (not yourself, never the last)
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
    const selected = [...new Set([...fields.split(/\s+/), ...Object.keys(where)].filter(Boolean))].join(" ");
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
  return { iam, gql, insert, list, listAll, update, updateWhere, audit };
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
  "document.manage": [PM, DC],
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHORT_NAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
// "company-admin" is a job role, so a company may never be called "admin".
const RESERVED = ["admin"];
const SHARED_ROLES = ["company-admin", "staff", "external"];

const text = (v) => (typeof v === "string" ? v.trim() : "");

// Platform admins run onboarding, so a failed step tells them which one and why (IAM's reason);
// everything before it stays done, and running Create again continues from there.
async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused("STEP_FAILED", `Creating the company stopped at "${label}": ${error.message}. Steps before it are done; press Create again to continue.`);
  }
}

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
  // "search" matches role names only; "slugs" finds the exact slug.
  const res = await db.iam("/iam/v4/iam/roles", { filter: { search: "", slugs: [slug] }, page: 0, pageSize: 10 });
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
  const [allCompanies, admins] = await Promise.all([
    db.listAll("Company", "ItemId name relation isVoided"),
    db.listAll("OrgMember", "ItemId isCompanyAdmin")
  ]);
  const companies = allCompanies.filter((c) => c.relation === "self" && !c.isVoided);
  // A company row without an admin row is an earlier run that stopped half way: continue it.
  const unfinished = companies.find((c) => c.tenantRole === tenantRole && !admins.some((m) => m.tenantRole === tenantRole && m.isCompanyAdmin));
  if (!unfinished && companies.some((c) => c.tenantRole === tenantRole)) throw new Refused("SHORT_NAME_TAKEN", "Another company already uses this short name.");
  if (companies.some((c) => c !== unfinished && String(c.name).toLowerCase() === name.toLowerCase())) throw new Refused("COMPANY_EXISTS", "A company with this name already exists.");
  const steps = {};

  // 1. The company's tag: a project-wide role every person and record of the company carries.
  await step("company tag", async () => {
    if (await findRole(db, tenantRole)) {
      steps.tag = "existed";
      return;
    }
    await db.iam("/iam/v4/iam/roles/create", { name: `Company ${name}`, slug: tenantRole, description: `Company tag of ${name}: every person and record of this company carries it. Not a job role.` });
    if (!(await findRole(db, tenantRole))) throw new Error(`role ${tenantRole} was not created with that exact slug`);
    steps.tag = "created";
  });

  // 2. The company's Blocks organization.
  const org = await step("organization", async () => {
    const found = await findOrganization(db, name);
    if (found) {
      steps.organization = "existed";
      return found;
    }
    const created = await db.iam("/iam/v4/iam/organizations/create", { name, description: `Buildnexa customer company (${tenantRole})` });
    const id = created.itemId ?? created.id ?? created.organizationId ?? created.data?.itemId ?? created.data;
    if (typeof id !== "string") throw new Error("IAM returned no organization id");
    steps.organization = "created";
    return { itemId: id, name };
  });

  // 3. The bell: reading and marking notifications needs these permissions on the person's role
  //    INSIDE the company's organization (a grant in "default" alone gets 403).
  const notifier = String(ctx.env.NOTIFIER_PERMISSION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (notifier.length !== 2) throw new Error("NOTIFIER_PERMISSION_IDS is not set");
  await step("bell permissions", async () => {
    for (const slug of SHARED_ROLES) {
      await db.iam("/iam/v4/iam/roles/assign-permissions", { slug, organizationId: org.itemId, addPermissions: notifier, removePermissions: [] });
    }
    steps.bell = "granted";
  });

  // 4. The first company admin. IAM emails the invitation to a new account.
  const roles = ["company-admin", tenantRole];
  const userId = await step("first company admin", async () => {
    const exists = await db.iam("/iam/v4/iam/users/exists", { email });
    let id = exists.userId || exists.data?.userId;
    if (!id) {
      const created = await db.iam("/iam/v4/iam/users/create", { email, firstName, lastName, organizationId: org.itemId, roles });
      id = created.itemId ?? created.data?.itemId ?? created.userId ?? created.data;
      steps.admin = "invited (new account)";
    } else {
      await db.iam("/iam/v4/iam/users/access", { userId: id, organizationId: org.itemId, roles });
      steps.admin = "existing account added";
    }
    if (typeof id !== "string") throw new Error("IAM returned no user id");
    return id;
  });

  // 5. The records the company's screens read.
  const now = new Date().toISOString();
  const companyId = unfinished?.ItemId ?? await step("company records", () => db.insert("Company", { tenantRole, name, legalName: name, relation: "self", status: "active", defaultLanguage: "en", isVoided: false }));
  await step("company records", () => db.insert("OrgMember", {
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
  }));
  steps.records = "created";
  ctx.log.info("company created", { tenantRole, organizationId: org.itemId, steps });
  return { ok: true, company: { id: companyId, name, tag: tenantRole, organizationId: org.itemId }, steps };
}

// ---------- story 3.4: add a company admin to a customer company ----------

async function addCompanyAdmin(ctx, db, me, args) {
  const email = text(args.admin?.email).toLowerCase();
  const firstName = text(args.admin?.firstName);
  const lastName = text(args.admin?.lastName);
  if (!EMAIL.test(email)) throw new Refused("BAD_EMAIL", "Enter the new company admin's email address.");
  const company = (await db.listAll("Company", "ItemId name relation isVoided")).find((c) => c.ItemId === args.companyId && c.relation === "self" && !c.isVoided);
  if (!company) throw new Refused("NOT_FOUND", "This company doesn't exist.");
  const tenantRole = company.tenantRole;
  const org = await step("organization", () => findOrganization(db, company.name));
  if (!org) throw new Refused("NO_ORGANIZATION", `No Blocks organization is named "${company.name}". Rename one of them so they match, then try again.`);
  const roles = ["company-admin", tenantRole];
  const members = await db.list("OrgMember", "ItemId userId email orgRole companyRelation isCompanyAdmin status", tenantRole);
  const already = members.find((m) => String(m.email).toLowerCase() === email && m.status !== "removed");

  if (already) {
    // Someone already in the company: only its own staff may become admins.
    if (already.orgRole === "external" || (already.companyRelation && already.companyRelation !== "self")) {
      throw new Refused("NOT_STAFF", "This person works for a partner company. Only the company's own staff can be company admins.");
    }
    if (already.isCompanyAdmin && already.status !== "deactivated") throw new Refused("ALREADY_ADMIN", "This person is already a company admin.");
    await step("company admin rights", () => db.iam("/iam/v4/iam/users/access", { userId: already.userId, organizationId: org.itemId, roles }));
    await db.update("OrgMember", already.ItemId, tenantRole, { isCompanyAdmin: true, canCreateProjects: true, orgRole: "staff", status: already.status === "deactivated" ? "active" : already.status });
    ctx.log.info("company admin added", { tenantRole, by: me.userId, existingMember: true });
    return { ok: true, invited: false };
  }

  if (!firstName || !lastName) throw new Refused("BAD_ADMIN_NAME", "Enter the new company admin's first and last name.");
  const userId = await step("company admin account", async () => {
    const exists = await db.iam("/iam/v4/iam/users/exists", { email });
    let id = exists.userId || exists.data?.userId;
    if (!id) {
      const created = await db.iam("/iam/v4/iam/users/create", { email, firstName, lastName, organizationId: org.itemId, roles });
      id = created.itemId ?? created.data?.itemId ?? created.userId ?? created.data;
    } else {
      await db.iam("/iam/v4/iam/users/access", { userId: id, organizationId: org.itemId, roles });
    }
    if (typeof id !== "string") throw new Error("IAM returned no user id");
    return id;
  });
  await step("company records", () => db.insert("OrgMember", {
    tenantRole,
    userId,
    email,
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    companyId: company.ItemId,
    companyName: company.name,
    companyRelation: "self",
    orgRole: "staff",
    isCompanyAdmin: true,
    canCreateProjects: true,
    status: "invited",
    invitedByUserId: me.userId,
    invitedAt: new Date().toISOString()
  }));
  ctx.log.info("company admin added", { tenantRole, by: me.userId, existingMember: false });
  return { ok: true, invited: true };
}

// ---------- stories 3.5 to 3.7: platform admins ----------
// Platform admins belong to no company: their role sits in the "default" organization
// (IAM shows it as roles.default). IAM can't list users by role, so all users are read and
// filtered here; fine for hundreds of users, to revisit for many thousands.

const defaultRoles = (u) => (u.roles && typeof u.roles === "object" && !Array.isArray(u.roles) ? u.roles.default ?? [] : []);

async function allUsers(db) {
  const users = [];
  for (let page = 0; page < 50; page += 1) {
    const res = await db.iam("/iam/v4/iam/users", { page, pageSize: 100, sort: { isDescending: false }, filter: {} });
    const items = res.data ?? [];
    users.push(...items);
    if (items.length < 100) break;
  }
  return users;
}

async function listAdmins(db, me) {
  const admins = (await allUsers(db))
    .filter((u) => defaultRoles(u).includes("platform-admin"))
    .map((u) => ({
      userId: u.itemId,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
      email: u.email,
      // IAM: a pending invite is accountState "PendingVerification" (active false, not verified).
      state: u.accountState === "Active" ? "active" : u.accountState === "PendingVerification" || u.isVerified === false ? "invited" : "deactivated",
      lastLoggedInTime: u.lastLoggedInTime && !String(u.lastLoggedInTime).startsWith("0001") ? u.lastLoggedInTime : undefined,
      isMe: u.itemId === me.userId
    }));
  return { ok: true, admins: admins.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function addAdmin(ctx, db, me, args) {
  const email = text(args.email).toLowerCase();
  const firstName = text(args.firstName);
  const lastName = text(args.lastName);
  if (!EMAIL.test(email)) throw new Refused("BAD_EMAIL", "Enter the new platform admin's email address.");
  const exists = await db.iam("/iam/v4/iam/users/exists", { email });
  const id = exists.userId || exists.data?.userId;
  if (id) {
    // Existing account (maybe someone in a company): add the role next to their other ones.
    // The user list is the one IAM read whose shape is verified (roles per organization).
    const u = (await allUsers(db)).find((x) => x.itemId === id);
    const current = u ? defaultRoles(u) : [];
    if (current.includes("platform-admin")) throw new Refused("ALREADY_ADMIN", "This person is already a platform admin.");
    await step("platform admin rights", () => db.iam("/iam/v4/iam/users/access", { userId: id, roles: [...current, "platform-admin"] }));
    ctx.log.info("platform admin added", { by: me.userId, existingAccount: true });
    return { ok: true, invited: false };
  }
  if (!firstName || !lastName) throw new Refused("BAD_NAME", "Enter the new platform admin's first and last name.");
  await step("platform admin account", () => db.iam("/iam/v4/iam/users/create", { email, firstName, lastName, roles: ["platform-admin"] }));
  ctx.log.info("platform admin added", { by: me.userId, existingAccount: false });
  return { ok: true, invited: true };
}

async function removeAdmin(ctx, db, me, args) {
  const userId = text(args.userId);
  if (userId === me.userId) throw new Refused("SELF", "You can't remove your own platform admin rights. Ask another platform admin.");
  const admins = (await allUsers(db)).filter((u) => defaultRoles(u).includes("platform-admin"));
  const target = admins.find((u) => u.itemId === userId);
  if (!target) throw new Refused("NOT_FOUND", "This person is not a platform admin.");
  if (admins.length <= 1) throw new Refused("LAST_ADMIN", "The platform needs at least one platform admin.");
  const rest = defaultRoles(target).filter((r) => r !== "platform-admin");
  await step("remove platform admin rights", () =>
    rest.length
      // IAM keeps the old list when given an empty one, so the role is replaced only when others remain...
      ? db.iam("/iam/v4/iam/users/access", { userId, roles: rest })
      // ...otherwise the person leaves the platform level altogether (their companies are untouched).
      : db.iam("/iam/v4/iam/users/revoke-access", { userId })
  );
  ctx.log.info("platform admin removed", { by: me.userId });
  return { ok: true };
}

export default async function handler(input, ctx) {
  return handle(
    input,
    ctx,
    "platform",
    {
      list: (args, { db }) => listCompanies(db),
      create: (args, { ctx, db, me }) => createCompany(ctx, db, me, args),
      addCompanyAdmin: (args, { ctx, db, me }) => addCompanyAdmin(ctx, db, me, args),
      listAdmins: (args, { db, me }) => listAdmins(db, me),
      addAdmin: (args, { ctx, db, me }) => addAdmin(ctx, db, me, args),
      removeAdmin: (args, { ctx, db, me }) => removeAdmin(ctx, db, me, args)
    },
    platformCaller
  );
}
