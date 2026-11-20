// Seeds one customer company into the selected Blocks environment (operator tool, MVP onboarding).
//
//   node tools/seed-company.mjs tools/seed/demo-builder.json          # preview, changes nothing
//   node tools/seed-company.mjs tools/seed/demo-builder.json --yes    # apply
//
// Steps (each skipped when it already exists, so re-running is safe):
//   1. shared roles company-admin, staff, external (no IAM permissions: company admins invite
//      through Functions, never by granting roles themselves)
//   2. the company's own role co-<slug>, which every one of its records carries as tenantRole
//   3. the company's Blocks organization
//   4. people: the first company admin [company-admin, co-<slug>] and every seed.people entry
//      [staff|external, co-<slug>], each invited into that organization (IAM emails the invite)
//   5. records, written by the platform-seed-company Function with the service identity (the
//      Data Gateway rules let only the service write): Company rows (self + partners), OrgMember
//      rows, Projects and their ProjectMembers (project roles)
// Needs multi-organization on (done on dev 19 Nov 2026) and a CLI login to the project.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_FUNCTION_ID = "af0965e1-b6f5-41a1-92ba-63024e5407f1"; // platform-seed-company (dev)
const SHARED_ROLES = [
  { slug: "company-admin", name: "Company admin", description: "Administers one customer company in Buildnexa" },
  { slug: "staff", name: "Staff", description: "Employee of the customer company" },
  { slug: "external", name: "External", description: "Outside party (subcontractor, designer, owner) invited by the company" }
];
const PROJECT_ROLES = ["project-manager", "superintendent", "document-controller", "field-user", "design-reviewer", "owner-viewer"];

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/seed-company.mjs <seed.json> [--yes]");
  process.exit(1);
}
const apply = flags.includes("--yes");
const seed = JSON.parse(readFileSync(file, "utf8"));
if (!/^co-[a-z0-9-]{3,40}$/.test(seed.tenantRole ?? "")) throw new Error("tenantRole must look like co-<slug>");
const partners = seed.partners ?? [];
const projects = seed.projects ?? [];
for (const p of seed.people ?? []) {
  if (!["staff", "external"].includes(p.orgRole)) throw new Error(`${p.key}: orgRole must be staff or external`);
  if (p.partner && !partners.some((x) => x.key === p.partner)) throw new Error(`${p.key}: unknown partner ${p.partner}`);
}
for (const pr of projects) {
  for (const m of pr.members) {
    if (!PROJECT_ROLES.includes(m.role)) throw new Error(`${pr.number}: unknown project role ${m.role}`);
    if (!(seed.people ?? []).some((x) => x.key === m.person)) throw new Error(`${pr.number}: unknown person ${m.person}`);
  }
}

function blocks(args) {
  const out = execFileSync("blocks", [...args, "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  return JSON.parse(out);
}
const quote = (v) => (process.platform === "win32" && /[\s,]/.test(v) ? `"${v}"` : v);
const step = (label, done) => console.log(`${done ? "exists " : apply ? "create " : "would  "} ${label}`);

// 1 + 2: roles
const roles = blocks(["iam", "roles", "list", "--page-size", "200"]).data ?? [];
for (const role of [...SHARED_ROLES, { slug: seed.tenantRole, name: `Company ${seed.company.name}`, description: `Tenant role of ${seed.company.name}: every record of this company carries it` }]) {
  const exists = roles.some((r) => r.slug === role.slug);
  step(`role ${role.slug}`, exists);
  if (!exists && apply) {
    blocks(["iam", "roles", "create", "--name", quote(role.name), "--slug", role.slug, "--description", quote(role.description), "--yes"]);
  }
}

// 3: organization
const orgs = blocks(["iam", "organizations", "list", "--search", quote(seed.organization.name), "--page-size", "50"]).organizations ?? [];
let org = orgs.find((o) => o.name === seed.organization.name);
step(`organization "${seed.organization.name}"${org ? ` ${org.itemId}` : ""}`, Boolean(org));
if (!org && apply) {
  const created = blocks(["iam", "organizations", "create", "--name", quote(seed.organization.name), "--description", quote(seed.organization.description ?? ""), "--yes"]);
  const id = created.itemId ?? created.id ?? created.organizationId ?? created.data?.itemId ?? created.data;
  if (typeof id !== "string") throw new Error(`organization id not found in ${JSON.stringify(created).slice(0, 300)}`);
  org = { itemId: id, name: seed.organization.name };
  console.log(`         -> ${id}`);
}

// 4: people
function ensureUser(person, userRoles) {
  const found = blocks(["iam", "users", "list", "--email", person.email]).data ?? [];
  const user = found.find((u) => (u.email ?? "").toLowerCase() === person.email.toLowerCase());
  const id = user?.itemId;
  // The list has no organizations; read the user in this organization to see if they're in it.
  let inOrg = false;
  if (id && org) {
    const full = blocks(["iam", "users", "get", id, "--organization-id", org.itemId]);
    inOrg = ((full.data ?? full).organizationIds ?? []).includes(org.itemId);
  }
  step(`user ${person.email} [${userRoles.join(", ")}]${id ? ` ${id}` : ""}`, Boolean(id) && inOrg);
  if (!apply || !org) return id;
  if (!id) {
    const created = blocks([
      "iam", "users", "create",
      "--email", person.email,
      "--first-name", quote(person.firstName),
      "--last-name", quote(person.lastName),
      "--organization-id", org.itemId,
      "--roles", quote(userRoles.join(",")),
      "--yes"
    ]);
    const newId = created.itemId ?? created.id ?? created.userId ?? created.data?.itemId ?? created.data;
    if (typeof newId !== "string") throw new Error(`user id not found in ${JSON.stringify(created).slice(0, 300)}`);
    console.log(`         -> ${newId} (invite email sent)`);
    return newId;
  }
  if (!inOrg) {
    // Existing user (e.g. from another company): add this organization with these roles.
    blocks(["iam", "users", "access", "grant", id, "--organization-id", org.itemId, "--roles", quote(userRoles.join(",")), "--yes"]);
    console.log(`         -> granted [${userRoles.join(", ")}] in ${org.itemId}`);
  }
  return id;
}

const adminId = ensureUser(seed.admin, ["company-admin", seed.tenantRole]);
const people = (seed.people ?? []).map((p) => ({ ...p, userId: ensureUser(p, [p.orgRole, seed.tenantRole]) }));

// 5: records (service identity, through the Function; it skips what already exists)
const places = projects.reduce((n, p) => n + p.members.length, 0);
step(`records: Company self + ${partners.length} partners, ${people.length + 1} members, ${projects.length} projects, ${places} team places (Function ${SEED_FUNCTION_ID.slice(0, 8)})`, false);
for (const pr of projects) {
  console.log(`           ${pr.number} ${pr.name}: ${pr.members.map((m) => `${m.person}=${m.role}`).join(", ")}`);
}
if (apply) {
  const inputFile = join(tmpdir(), `seed-${seed.tenantRole}.json`);
  writeFileSync(inputFile, JSON.stringify({
    tenantRole: seed.tenantRole,
    company: seed.company,
    admin: { userId: adminId, email: seed.admin.email, firstName: seed.admin.firstName, lastName: seed.admin.lastName },
    partners,
    people,
    projects
  }));
  try {
    const run = blocks(["logic", "function", "test", SEED_FUNCTION_ID, "--input-file", inputFile, "--wait-timeout", "120"]);
    console.log(`         -> run ${run.runId} ${run.status}`);
    console.log(JSON.stringify(run.result ?? run.errorMessage ?? "", null, 2));
  } finally {
    rmSync(inputFile, { force: true });
  }
}

if (!apply) console.log("\nPreview only. Re-run with --yes to apply.");
