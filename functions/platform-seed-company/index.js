// Operator-only: writes a seeded company's records with the Buildnexa service identity.
// Called by tools/seed-company.mjs through `blocks logic function test`, which runs as the
// impersonated project owner. Any other caller is refused: a signed-in app user can never
// reach the service identity through this Function.
//
// Input (users already exist in IAM; the script passes their userIds):
//   { tenantRole, company, admin: {userId,email,firstName,lastName},
//     partners: [{key,name,relation,tradeCodes,city}],
//     people:   [{key,userId,email,firstName,lastName,jobTitle,orgRole,partner?,canCreateProjects?}],
//     projects: [{number,name,description,clientName,address,startDate,endDate,
//                 members:[{person,role,trade?}]}] }
// Idempotent: every record is looked up first (Company by name, OrgMember by userId, Project by
// number, ProjectMember by project + user) and reported as existed instead of written again.
// Never returns or logs a token.

const API = "https://blocksapi.slsblx.com";
const PROJECT_ROLES = ["project-manager", "superintendent", "document-controller", "field-user", "design-reviewer", "owner-viewer"];

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

function gateway(ctx, token) {
  async function gql(query, variables) {
    const res = await fetch(`${API}/data/v4/gateway`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-blocks-key": ctx.context.tenantId },
      body: JSON.stringify({ query, variables })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) {
      throw new Error(`gateway ${res.status}: ${JSON.stringify(body.errors?.map((e) => e.message) ?? body).slice(0, 300)}`);
    }
    return body.data;
  }
  // The service reads every tenant, so filter by tenant here (seed volumes are tiny).
  async function list(schema, fields) {
    const query = `get${schema}s`;
    const data = await gql(`query q($input: DynamicQueryInput) { ${query}(input: $input) { items { ${fields} } } }`, {
      input: { pageNo: 1, pageSize: 1000 }
    });
    return data?.[query]?.items ?? [];
  }
  async function insert(schema, input) {
    const data = await gql(`mutation m($input: ${schema}InsertInput!) { insert${schema}(input: $input) { acknowledged itemId message } }`, { input });
    const r = data?.[`insert${schema}`];
    if (!r?.acknowledged || !r.itemId) throw new Error(`insert${schema} not acknowledged: ${JSON.stringify(r)}`);
    return r.itemId;
  }
  return { insert, list };
}

const displayName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email;

export default async function handler(input, ctx) {
  if (!ctx.context.impersonated) return { ok: false, error: "operator only" };
  const args = (input && input.method ? input.body : input) ?? {};
  const { tenantRole, company, admin } = args;
  const partners = args.partners ?? [];
  const people = args.people ?? [];
  const projects = args.projects ?? [];
  if (!/^co-[a-z0-9-]{3,40}$/.test(tenantRole ?? "")) return { ok: false, error: "tenantRole must look like co-<slug>" };
  if (!company?.name) return { ok: false, error: "company.name is required" };
  for (const p of projects) {
    for (const m of p.members ?? []) {
      if (!PROJECT_ROLES.includes(m.role)) return { ok: false, error: `unknown project role ${m.role}` };
      if (!people.some((x) => x.key === m.person)) return { ok: false, error: `unknown person ${m.person} in ${p.number}` };
    }
  }
  for (const p of people) {
    if (!p.userId) return { ok: false, error: `person ${p.key} has no userId` };
    if (p.partner && !partners.some((x) => x.key === p.partner)) return { ok: false, error: `unknown partner ${p.partner}` };
  }

  const db = gateway(ctx, await serviceToken(ctx));
  const out = { ok: true, tenantRole, companies: {}, members: {}, projects: {}, projectMembers: {} };
  const now = new Date().toISOString();

  // Companies: the customer itself (relation self) and its partners.
  const companies = (await db.list("Company", "ItemId tenantRole relation name")).filter((c) => c.tenantRole === tenantRole);
  const companyIds = {};
  async function ensureCompany(key, row) {
    const found = companies.find((c) => (row.relation === "self" ? c.relation === "self" : c.name === row.name && c.relation === row.relation));
    if (found) {
      companyIds[key] = { id: found.ItemId, name: row.name, relation: row.relation };
      out.companies[key] = "existed";
      return;
    }
    const id = await db.insert("Company", { ...row, tenantRole, status: row.status ?? "active", isVoided: false });
    companyIds[key] = { id, name: row.name, relation: row.relation };
    out.companies[key] = "created";
  }
  await ensureCompany("self", { ...company, relation: "self" });
  for (const p of partners) {
    await ensureCompany(p.key, {
      name: p.name,
      legalName: p.name,
      relation: p.relation,
      tradeCodes: p.tradeCodes ?? [],
      address: p.city ? { city: p.city, country: "DE" } : undefined
    });
  }

  // OrgMembers: the company admin plus every seeded person.
  const members = (await db.list("OrgMember", "ItemId tenantRole userId")).filter((m) => m.tenantRole === tenantRole);
  const memberIds = {};
  async function ensureMember(key, person, extra) {
    const found = members.find((m) => m.userId === person.userId);
    if (found) {
      memberIds[key] = found.ItemId;
      out.members[key] = "existed";
      return;
    }
    const co = companyIds[person.partner ?? "self"];
    memberIds[key] = await db.insert("OrgMember", {
      tenantRole,
      userId: person.userId,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      displayName: displayName(person),
      jobTitle: person.jobTitle,
      companyId: co.id,
      companyName: co.name,
      companyRelation: co.relation,
      status: "invited",
      invitedAt: now,
      ...extra
    });
    out.members[key] = "created";
  }
  if (admin?.userId) await ensureMember("admin", admin, { orgRole: "staff", isCompanyAdmin: true, canCreateProjects: true });
  for (const p of people) {
    await ensureMember(p.key, p, { orgRole: p.orgRole, isCompanyAdmin: false, canCreateProjects: Boolean(p.canCreateProjects) });
  }

  // Projects and their teams.
  const existingProjects = (await db.list("Project", "ItemId tenantRole number")).filter((p) => p.tenantRole === tenantRole);
  const projectMembers = (await db.list("ProjectMember", "ItemId tenantRole projectId userId")).filter((m) => m.tenantRole === tenantRole);
  for (const p of projects) {
    let projectId = existingProjects.find((x) => x.number === p.number)?.ItemId;
    if (projectId) {
      out.projects[p.number] = "existed";
    } else {
      const pm = p.members.find((m) => m.role === "project-manager");
      const createdBy = (pm && people.find((x) => x.key === pm.person)?.userId) ?? admin?.userId;
      projectId = await db.insert("Project", {
        tenantRole,
        number: p.number,
        name: p.name,
        description: p.description,
        clientName: p.clientName,
        address: p.address,
        status: "active",
        startDate: p.startDate,
        endDate: p.endDate,
        currency: "EUR",
        timezone: "Europe/Berlin",
        locale: "de-DE",
        defaultLanguage: "en",
        createdByUserId: createdBy,
        settings: {
          rfiDefaultDueWorkingDays: 7,
          submittalReviewWorkingDays: 10,
          punchDefaultDueDays: 7,
          changeOrderApprover: "owner-viewer",
          disciplines: []
        },
        calendar: { country: "DE", region: p.address?.region, weekendDays: [0, 6], holidays: [] }
      });
      out.projects[p.number] = "created";
    }

    for (const m of p.members) {
      const person = people.find((x) => x.key === m.person);
      const label = `${p.number}/${m.person}`;
      if (projectMembers.some((x) => x.projectId === projectId && x.userId === person.userId)) {
        out.projectMembers[label] = "existed";
        continue;
      }
      const co = companyIds[person.partner ?? "self"];
      await db.insert("ProjectMember", {
        tenantRole,
        projectId,
        userId: person.userId,
        orgMemberId: memberIds[person.key],
        email: person.email,
        displayName: displayName(person),
        companyId: co.id,
        companyName: co.name,
        companyRelation: co.relation,
        trade: m.trade,
        role: m.role,
        status: "active",
        isBallInCourtEligible: true,
        joinedAt: now
      });
      out.projectMembers[label] = `created (${m.role})`;
    }
  }
  return out;
}
