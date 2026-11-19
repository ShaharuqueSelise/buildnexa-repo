// Operator-only: writes a seeded company's first records (the Company row for the customer
// itself and the OrgMember row of its first company admin) with the Buildnexa service identity.
// Called by tools/seed-company.mjs through `blocks logic function test`, which runs as the
// impersonated project owner. Any other caller is refused: a signed-in app user can never
// reach the service identity through this Function.
//
// Input: { tenantRole, company: {...Company fields}, admin: { userId, email, firstName, lastName } }
// Idempotent: an existing Company (relation self) or OrgMember (same userId) for the tenant is
// reported, not written again. Never returns or logs a token.

const API = "https://blocksapi.slsblx.com";

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

async function gql(ctx, token, query, variables) {
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
async function listAll(ctx, token, query, field) {
  const data = await gql(ctx, token, `query q($input: DynamicQueryInput) { ${query}(input: $input) { items { ${field} } } }`, {
    input: { pageNo: 1, pageSize: 500 }
  });
  return data?.[query]?.items ?? [];
}

const insert = (schema) =>
  `mutation m($input: ${schema}InsertInput!) { insert${schema}(input: $input) { acknowledged itemId message } }`;

export default async function handler(input, ctx) {
  if (!ctx.context.impersonated) return { ok: false, error: "operator only" };
  const args = (input && input.method ? input.body : input) ?? {};
  const { tenantRole, company, admin } = args;
  if (!/^co-[a-z0-9-]{3,40}$/.test(tenantRole ?? "")) return { ok: false, error: "tenantRole must look like co-<slug>" };
  if (!company?.name) return { ok: false, error: "company.name is required" };

  const token = await serviceToken(ctx);
  const out = { ok: true, tenantRole };

  const companies = await listAll(ctx, token, "getCompanys", "ItemId tenantRole relation name");
  const self = companies.find((c) => c.tenantRole === tenantRole && c.relation === "self");
  if (self) {
    out.company = { existed: true, itemId: self.ItemId };
  } else {
    const r = await gql(ctx, token, insert("Company"), {
      input: { ...company, tenantRole, relation: "self", status: company.status ?? "active", isVoided: false }
    });
    out.company = { created: r.insertCompany?.acknowledged === true, itemId: r.insertCompany?.itemId };
  }

  if (admin?.userId) {
    const members = await listAll(ctx, token, "getOrgMembers", "ItemId tenantRole userId");
    const existing = members.find((m) => m.tenantRole === tenantRole && m.userId === admin.userId);
    if (existing) {
      out.admin = { existed: true, itemId: existing.ItemId };
    } else {
      const displayName = [admin.firstName, admin.lastName].filter(Boolean).join(" ") || admin.email;
      const r = await gql(ctx, token, insert("OrgMember"), {
        input: {
          tenantRole,
          userId: admin.userId,
          email: admin.email,
          firstName: admin.firstName,
          lastName: admin.lastName,
          displayName,
          companyId: out.company.itemId,
          companyName: company.name,
          companyRelation: "self",
          orgRole: "staff",
          isCompanyAdmin: true,
          canCreateProjects: true,
          status: "invited",
          invitedAt: new Date().toISOString()
        }
      });
      out.admin = { created: r.insertOrgMember?.acknowledged === true, itemId: r.insertOrgMember?.itemId };
    }
  }
  return out;
}
