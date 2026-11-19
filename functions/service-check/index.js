// Check (dev): do Data Gateway rules let the Buildnexa service identity through, and only it?
//   1. service token (client credential buildnexa-service-dev, role cpm-service) -> claims only
//   2. service token: insert a Company test record, then read Companys
//   3. caller token (no cpm-service, no co- role): same insert and read, expected to be refused
// Never returns or logs a token or a token response body.

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
  let claims;
  if (token) {
    try {
      const c = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      claims = { sub: c.sub, org_id: c.org_id, roles: c.roles ?? c.role, permissions: c.permissions ?? c.permission };
    } catch {
      claims = "unreadable";
    }
  }
  return { status: res.status, token, claims, error: token ? undefined : { error: json?.error, keys: json ? Object.keys(json) : "not json" } };
}

async function gql(ctx, token, query, variables) {
  const res = await fetch(`${API}/data/v4/gateway`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-blocks-key": ctx.context.tenantId },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, data: body?.data, errors: body?.errors?.map((e) => e.message ?? e) };
}

const INSERT = `mutation insertCompany($input: CompanyInsertInput!) { insertCompany(input: $input) { acknowledged itemId message totalImpactedData } }`;
const LIST = `query getCompanys($input: DynamicQueryInput) { getCompanys(input: $input) { totalCount items { ItemId name tenantRole } } }`;

const record = (who) => ({
  tenantRole: "co-servicecheck",
  name: `SERVICE CHECK (${who}) - test record, ignore`,
  relation: "self",
  status: "inactive",
  isVoided: true
});

export default async function handler(input, ctx) {
  const out = { context: { tenantId: ctx.context.tenantId, roles: ctx.context.roles, organizationId: ctx.context.organizationId } };

  const svc = await serviceToken(ctx);
  out.service = { tokenStatus: svc.status, claims: svc.claims, tokenError: svc.error };
  if (svc.token) {
    out.service.insert = await gql(ctx, svc.token, INSERT, { input: record("service") });
    out.service.list = await gql(ctx, svc.token, LIST, { input: { pageNo: 1, pageSize: 10 } });
  }

  const caller = await ctx.blocks.getAccessToken();
  out.caller = { hasToken: Boolean(caller) };
  if (caller) {
    out.caller.insert = await gql(ctx, caller, INSERT, { input: record("caller") });
    out.caller.list = await gql(ctx, caller, LIST, { input: { pageNo: 1, pageSize: 10 } });
  }
  return out;
}
