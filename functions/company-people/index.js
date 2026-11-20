// Company admin › People (Phase 1): the company's people, as on the demo app's Company admin page.
// Called from the app with the signed-in user's token (blocksClient.logic.functions.call).
//
//   { action: "list" }                        -> people + IAM account details, companies, projects
//   { action: "invite", email, firstName, lastName, jobTitle?, companyId, defaultRole, projectIds? }
//   { action: "setDefaultRole", memberId, role }
//   { action: "resend", memberId }            -> new invitation email (people not joined yet)
//   { action: "deactivate", memberId }        -> removes this company's access; records stay
//   { action: "reactivate", memberId }        -> gives the access back
//
// Security (docs/architecture/01 §4.2):
// - Company admins only. The Buildnexa service password (Blocks secret) is readable by the role
//   company-admin only, so for anyone else Blocks stops the run before this code starts.
// - The caller's company is taken from THEIR token: the one `co-` role they hold in their current
//   organization. Every read is filtered to it and every write is stamped with it.
// - The only IAM roles this Function grants are `staff`/`external` (or `company-admin` back to an
//   admin on reactivate) plus the caller's own `co-` role.
// - Nobody changes or deactivates themselves.
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function adminOnly(me) {
  if (!me.isAdmin) throw new Refused("NOT_ADMIN", "Only a company admin can manage people.");
  return me;
}

const MEMBER_FIELDS =
  "ItemId userId email firstName lastName displayName phone jobTitle companyId companyName companyRelation orgRole defaultRole isCompanyAdmin status invitedAt joinedAt";

const strip = ({ tenantRole: _t, ...rest }) => rest;

async function listPeople(ctx, db, me) {
  const [members, companies, projects, projectMembers] = await Promise.all([
    db.list("OrgMember", MEMBER_FIELDS, me.tenantRole),
    db.list("Company", "ItemId name relation brandColor isVoided", me.tenantRole),
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
    db.list("OrgMember", "ItemId email userId status", me.tenantRole),
    db.list("Project", "ItemId status", me.tenantRole)
  ]);
  const company = companies.find((c) => c.ItemId === args.companyId && !c.isVoided);
  if (!company) throw new Refused("BAD_COMPANY", "Choose the company this person works for.");
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
  return { ok: true, memberId, invited };
}

async function setDefaultRole(db, me, args) {
  const role = String(args.role ?? "");
  if (!PROJECT_ROLES.includes(role)) throw new Refused("BAD_ROLE", "Choose a default role.");
  const m = await findMember(db, me, args.memberId);
  notMe(me, m, "change the role of");
  await db.update("OrgMember", m.ItemId, me.tenantRole, { defaultRole: role });
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
  const m = await findMember(db, me, args.memberId);
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
  return { ok: true };
}

export default async function handler(input, ctx) {
  return handle(input, ctx, "company-people", {
    list: (args, { ctx, db, me }) => listPeople(ctx, db, adminOnly(me)),
    invite: (args, { ctx, db, me }) => invite(ctx, db, adminOnly(me), args),
    setDefaultRole: (args, { db, me }) => setDefaultRole(db, adminOnly(me), args),
    resend: (args, { ctx, db, me }) => resend(ctx, db, adminOnly(me), args),
    deactivate: (args, { db, me }) => setActive(db, adminOnly(me), args, false),
    reactivate: (args, { db, me }) => setActive(db, adminOnly(me), args, true)
  });
}
