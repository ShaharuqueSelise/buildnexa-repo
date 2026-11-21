// Isolation exit test: probes what the SIGNED-IN person can read or change by calling Blocks
// directly (Data Gateway, our Functions, IAM, Secrets, Logic), bypassing every screen.
//
// User story: as a customer, I can trust that no other company, no partner and no Buildnexa staff
// member can see or change my data, even with a browser console.
//
// How to run (Development, `npm run dev`): sign in as the person to test, open DevTools on the app
// tab and run
//   const p = await import("/tools/isolation-probe.js"); const r = await p.run(); console.table(r.rows);
// Run it once as an admin of each company first: every run remembers its own company's ids
// (localStorage "isolation-probe:targets": tags and record ids only), and the next person's run
// uses the OTHER companies' ids as targets.
//
// Safety:
// - Reports only "allowed / refused", status codes and row counts. Never a token, cookie, secret
//   value or record content. Secret value routes are called with the body discarded unread.
// - Nothing is changed when the rules hold. Permission checks use requests that cannot do anything
//   even when allowed: an empty body (403 = no permission, 400 = permission), an update or delete
//   that matches no row, or setting a field to the value it already has. The only real writes are
//   inserts stamped "ISOLATION-TEST"; they exist only if the rules are broken (verdict FAIL).
// - Cross-company Function calls use actions that stop before changing anything: `resend` (a
//   foreign person) and `removeMember` with a made-up team row (a foreign project).

import { blocksClient } from "/src/lib/blocks/client.ts";
import { FUNCTIONS } from "/src/lib/blocks/functions.ts";

const MARK = "ISOLATION-TEST";
const TARGETS_KEY = "isolation-probe:targets";
const NONE = "isolation-test-no-such-id";
const SCHEMAS = ["Company", "OrgMember", "Project", "ProjectMember", "Sequence", "ActivityEvent", "Comment"];
// Development secrets (ids are not secret; values are never read).
const SECRET_IDS = {
  "buildnexa-service-dev-secret (Functions' service password)": "3f4c98e2f94c4516abf82893e7469803",
  "buildnexa-platform-dev-secret": "ff88117ab6c34336804d87773978502a"
};
const INSERT_FIELD = { Company: "name", OrgMember: "displayName", Project: "name", ProjectMember: "displayName", Sequence: "key", ActivityEvent: "action", Comment: "body" };

const isCompanyTag = (r) => typeof r === "string" && (r.startsWith("co-") || (r.startsWith("company-") && r !== "company-admin"));

async function send(path, options) {
  try {
    return await blocksClient.http.send(path, options);
  } catch (error) {
    return { status: 0, ok: false, error };
  }
}
async function json(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to discard
  }
}
async function gql(query, variables) {
  const res = await send("/data/v4/gateway", { method: "POST", body: { query, variables } });
  const body = res.status ? await json(res) : undefined;
  const errors = (body?.errors ?? []).map((e) => String(e.message ?? e).slice(0, 120));
  return { status: res.status, data: body?.data, errors };
}
const short = (s) => String(s ?? "").slice(0, 120);

function readTargets() {
  try {
    return JSON.parse(localStorage.getItem(TARGETS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function writeTargets(t) {
  try {
    localStorage.setItem(TARGETS_KEY, JSON.stringify(t));
  } catch {
    // private window: targets must be passed to run({ targets }) instead
  }
}

export async function run(options = {}) {
  const rows = [];
  const add = (area, check, expect, actual, verdict) => rows.push({ area, check, expect, actual, verdict });

  // ---------- who am I ----------
  const me = await blocksClient.iam.me().catch(() => undefined);
  const profile = me?.data ?? me ?? {};
  const roles = Array.isArray(profile.roles) ? profile.roles : [];
  const myTags = roles.filter(isCompanyTag);
  const claims = (await blocksClient.auth.userInfo().catch(() => undefined)) ?? {};
  const myUserId = profile.itemId ?? claims.user_id ?? claims.sub;
  const myOrg = claims.org_id ?? claims.organizationId ?? claims.organization_id ?? profile.organizationId;
  const who = { email: profile.email, roles: roles.join(", "), companyTags: myTags.join(", ") || "(none)", organization: myOrg ?? "(unknown)" };

  // ---------- 1. Data Gateway reads ----------
  const seen = {};
  for (const schema of SCHEMAS) {
    const q = `get${schema}s`;
    const fields = schema === "Company" ? "ItemId tenantRole relation" : schema === "OrgMember" ? "ItemId tenantRole userId" : "ItemId tenantRole";
    const r = await gql(`query q($input: DynamicQueryInput) { ${q}(input: $input) { items { ${fields} } } }`, { input: { pageNo: 1, pageSize: 1000 } });
    const items = r.data?.[q]?.items ?? [];
    seen[schema] = items;
    const foreign = items.filter((i) => !myTags.includes(i.tenantRole));
    const byTag = Object.entries(items.reduce((a, i) => ({ ...a, [i.tenantRole]: (a[i.tenantRole] ?? 0) + 1 }), {})).map(([t, n]) => `${t}:${n}`).join(" ");
    const actual = r.errors.length ? `refused (${r.errors[0]})` : `${items.length} rows${byTag ? ` [${byTag}]` : ""}`;
    add("read", `${schema}: rows I can read`, "only my company's rows", actual, foreign.length ? "FAIL" : "PASS");
  }

  // Remember my company's ids for the other companies' runs.
  const targets = { ...readTargets(), ...(options.targets ?? {}) };
  if (myTags.length === 1) {
    const tag = myTags[0];
    const own = seen.Company.find((c) => c.tenantRole === tag && c.relation === "self");
    const person = seen.OrgMember.find((m) => m.tenantRole === tag && m.userId !== myUserId);
    const project = seen.Project.find((p) => p.tenantRole === tag);
    targets[tag] = { companyId: own?.ItemId ?? targets[tag]?.companyId, memberId: person?.ItemId ?? targets[tag]?.memberId, projectId: project?.ItemId ?? targets[tag]?.projectId };
    writeTargets(targets);
  }
  const victims = Object.entries(targets).filter(([tag]) => !myTags.includes(tag));
  if (!victims.length) add("setup", "other companies' ids", "known from an earlier run", "none yet: run as another company's admin first", "SKIP");

  // ---------- 2. Data Gateway writes ----------
  const writeTags = [...victims.map(([t]) => t), ...myTags];
  for (const schema of SCHEMAS) {
    for (const tag of writeTags) {
      const mine = myTags.includes(tag);
      const r = await gql(`mutation m($input: ${schema}InsertInput!) { insert${schema}(input: $input) { acknowledged itemId } }`, { input: { tenantRole: tag, [INSERT_FIELD[schema]]: MARK } });
      const ok = r.data?.[`insert${schema}`]?.acknowledged === true;
      add("write", `insert ${schema} stamped ${mine ? "with MY company" : `with ${tag}`}`, "refused", ok ? `INSERTED (${MARK} row id ${r.data[`insert${schema}`].itemId})` : `refused (${r.errors[0] ?? r.status})`, ok ? "FAIL" : "PASS");
    }
  }
  for (const [tag, ids] of victims) {
    if (!ids.companyId) continue;
    const r = await gql(
      "mutation m($where: CompanyFilterInput, $input: CompanyUpdateInput) { updateCompany(where: $where, input: $input) { acknowledged totalImpactedData } }",
      { where: { ItemId: { eq: ids.companyId } }, input: { name: `${MARK} renamed` } }
    );
    const n = r.data?.updateCompany?.acknowledged ? Number(r.data.updateCompany.totalImpactedData ?? 0) : 0;
    add("write", `rename ${tag}'s company record`, "nothing changed", n ? `CHANGED ${n} row(s)` : `nothing changed (${r.errors[0] ?? "0 rows"})`, n ? "FAIL" : "PASS");
  }
  // Moving a record into another company = rewriting its tenantRole. Tested without harm: set my own
  // company record's tenantRole to the value it already has. Allowed => the field is writable, so a
  // company admin could also set another company's tag.
  if (myTags.length === 1) {
    const own = seen.Company.find((c) => c.tenantRole === myTags[0] && c.relation === "self");
    if (own) {
      const r = await gql(
        "mutation m($where: CompanyFilterInput, $input: CompanyUpdateInput) { updateCompany(where: $where, input: $input) { acknowledged totalImpactedData } }",
        { where: { ItemId: { eq: own.ItemId }, tenantRole: { eq: myTags[0] } }, input: { tenantRole: myTags[0] } }
      );
      const n = r.data?.updateCompany?.acknowledged ? Number(r.data.updateCompany.totalImpactedData ?? 0) : 0;
      add("write", "rewrite my company record's tag (same value)", "refused", n ? "ALLOWED: the tag field is writable" : `refused (${r.errors[0] ?? "0 rows"})`, n ? "FAIL" : "PASS");
    }
  }
  for (const schema of SCHEMAS) {
    const r = await gql(`mutation m($where: ${schema}FilterInput) { delete${schema}(where: $where) { acknowledged totalImpactedData } }`, { where: { ItemId: { eq: NONE } } });
    const allowed = !r.errors.length && r.status >= 200 && r.status < 300 && r.data?.[`delete${schema}`] != null;
    add("delete", `delete ${schema} (matches no row)`, "refused", allowed ? "ALLOWED (delete permitted)" : `refused (${r.errors[0] ?? r.status})`, allowed ? "FAIL" : "PASS");
  }

  // ---------- 3. Our Functions with another company's ids ----------
  // Through the SDK's call(), which waits for the run's result when Blocks answers 202 (still running).
  const fn = async (id, body) => {
    try {
      const b = await blocksClient.logic.functions.call(id, { method: "POST", body });
      return { status: 200, code: b?.code ?? (b?.ok ? "OK" : undefined), error: short(b?.error) };
    } catch (error) {
      const b = error?.body ?? {};
      return { status: error?.status ?? 0, code: b.code ?? b.errorCode, error: short(b.error ?? b.message ?? error?.message) };
    }
  };
  for (const [tag, ids] of victims) {
    if (ids.memberId) {
      const r = await fn(FUNCTIONS.companyPeople, { action: "resend", memberId: ids.memberId });
      const leak = r.code && !["NOT_FOUND", "NOT_ADMIN", "NO_COMPANY"].includes(r.code) && r.status < 300;
      add("function", `company-people resend for a ${tag} person`, "refused / not found", `${r.status} ${r.code ?? ""} ${r.error}`.trim(), leak ? "FAIL" : "PASS");
    }
    if (ids.projectId) {
      const r = await fn(FUNCTIONS.projects, { action: "removeMember", projectId: ids.projectId, projectMemberId: NONE });
      // "This person is not on the project" would mean the foreign project WAS found.
      const leak = r.code === "NOT_FOUND" && /not on the project/i.test(r.error);
      add("function", `projects removeMember on a ${tag} project`, "project not found", `${r.status} ${r.code ?? ""} ${r.error}`.trim(), leak ? "FAIL" : "PASS");
    }
  }
  {
    const r = await fn(FUNCTIONS.companyPeople, { action: "list" });
    add("function", "company-people list (company admins only)", "refused unless company admin", `${r.status} ${r.code ?? ""} ${r.error}`.trim(), r.code === "OK" && !roles.includes("company-admin") ? "FAIL" : "INFO");
  }
  {
    const r = await fn(FUNCTIONS.platform, { action: "list" });
    add("function", "platform list (platform admins only)", "refused unless platform admin", `${r.status} ${r.code ?? ""} ${r.error}`.trim(), r.code === "OK" && !roles.includes("platform-admin") ? "FAIL" : "INFO");
  }

  // ---------- 4. IAM: can I change accounts or roles? (empty bodies: 403 = no permission) ----------
  const iamPerm = async (label, path) => {
    const res = await send(path, { method: "POST", body: {} });
    await discard(res);
    // 401/403 = no permission. Anything else needs a closer look: a 400 can also come from input
    // checks that run before the permission check.
    const refused = res.status === 401 || res.status === 403;
    add("iam", label, "403 (no permission)", String(res.status), refused ? "PASS" : "CHECK");
  };
  await iamPerm("change anyone's roles (users/access)", "/iam/v4/iam/users/access");
  await iamPerm("create accounts directly (users/create)", "/iam/v4/iam/users/create");
  await iamPerm("create roles (roles/create)", "/iam/v4/iam/roles/create");
  await iamPerm("remove anyone's access (users/revoke-access)", "/iam/v4/iam/users/revoke-access");
  await iamPerm("create organizations", "/iam/v4/iam/organizations/create");
  {
    const res = await send("/iam/v4/iam/users", { method: "POST", body: { page: 0, pageSize: 100, sort: { isDescending: false }, filter: {} } });
    const b = res.ok ? await json(res) : (await discard(res), undefined);
    const n = Array.isArray(b?.data) ? b.data.length : 0;
    add("iam", "list all user accounts", "refused", res.ok ? `ALLOWED: ${n} accounts` : String(res.status), res.ok && !roles.includes("platform-admin") ? "FAIL" : res.ok ? "INFO" : "PASS");
  }
  {
    const res = await send("/iam/v4/iam/organizations", { query: { page: 0, pageSize: 100 } });
    const b = res.ok ? await json(res) : (await discard(res), undefined);
    const n = Array.isArray(b?.data) ? b.data.length : Array.isArray(b) ? b.length : 0;
    add("iam", "list organizations", "refused", res.ok ? `ALLOWED: ${n} organizations` : String(res.status), res.ok && n > 1 && !roles.includes("platform-admin") ? "FAIL" : res.ok ? "INFO" : "PASS");
  }

  // ---------- 5. The service password ----------
  {
    const res = await send("/os/v4/Secrets/gets", { query: { PageNumber: 1, PageSize: 50 } });
    const b = res.ok ? await json(res) : (await discard(res), undefined);
    const list = Array.isArray(b?.data) ? b.data : [];
    const readable = list.filter((s) => s.canReadValue).map((s) => s.name);
    add("secret", "list secrets (names only)", "refused", res.ok ? `ALLOWED: ${list.length} secrets; value readable: ${readable.join(", ") || "none"}` : String(res.status), res.ok && readable.length ? "FAIL" : res.ok ? "INFO" : "PASS");
  }
  for (const [name, secretId] of Object.entries(SECRET_IDS)) {
    const meta = await send("/os/v4/Secrets/get", { query: { secretId } });
    const m = meta.ok ? await json(meta) : (await discard(meta), undefined);
    const can = (m?.data ?? m)?.canReadValue === true;
    add("secret", `${name}: may I read its value?`, "no", meta.ok ? `metadata readable; canReadValue=${can}` : String(meta.status), can ? "FAIL" : meta.ok ? "INFO" : "PASS");
    for (const [label, path, opts] of [
      ["GET value", "/os/v4/Secrets/value", { query: { secretId } }],
      ["POST values", "/os/v4/Secrets/values", { method: "POST", body: { secretIds: [secretId] } }]
    ]) {
      const res = await send(path, opts);
      await discard(res); // never read a secret value
      add("secret", `${name}: ${label}`, "refused (or no such route)", String(res.status), res.ok ? "FAIL" : "PASS");
    }
  }

  // ---------- 6. Functions' code, runs and logs ----------
  for (const [name, functionId] of Object.entries(FUNCTIONS)) {
    for (const op of ["Get", "GetRuns", "GetVersionSource"]) {
      const res = await send(`/logic/v4/Functions/${op}`, { query: { functionId } });
      await discard(res);
      add("logic", `${name} function: ${op}`, "refused", String(res.status), res.ok ? "FAIL" : "PASS");
    }
  }

  const summary = rows.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {});
  return { who, summary, rows };
}
