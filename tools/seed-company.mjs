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
//   4. the first company admin: invited into that organization with [company-admin, co-<slug>]
//   5. the Company row and the admin's OrgMember row, written by the platform-seed-company
//      Function with the service identity (the Data Gateway rules let only the service write)
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

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/seed-company.mjs <seed.json> [--yes]");
  process.exit(1);
}
const apply = flags.includes("--yes");
const seed = JSON.parse(readFileSync(file, "utf8"));
if (!/^co-[a-z0-9-]{3,40}$/.test(seed.tenantRole ?? "")) throw new Error("tenantRole must look like co-<slug>");

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

// 4: first company admin
const adminRoles = ["company-admin", seed.tenantRole];
const found = blocks(["iam", "users", "list", "--email", seed.admin.email]).data ?? [];
let admin = found.find((u) => (u.email ?? "").toLowerCase() === seed.admin.email.toLowerCase());
const userId = () => admin?.itemId ?? admin?.userId ?? admin?.id;
step(`admin ${seed.admin.email} [${adminRoles.join(", ")}]${admin ? ` ${userId()}` : ""}`, Boolean(admin));
if (apply && org) {
  if (!admin) {
    const created = blocks([
      "iam", "users", "create",
      "--email", seed.admin.email,
      "--first-name", quote(seed.admin.firstName),
      "--last-name", quote(seed.admin.lastName),
      "--organization-id", org.itemId,
      "--roles", quote(adminRoles.join(",")),
      "--yes"
    ]);
    admin = { itemId: created.itemId ?? created.id ?? created.userId ?? created.data?.itemId ?? created.data };
    if (typeof userId() !== "string") throw new Error(`user id not found in ${JSON.stringify(created).slice(0, 300)}`);
    console.log(`         -> ${userId()} (invite email sent)`);
  } else {
    // Existing user (e.g. from another company): add this organization with the admin roles.
    blocks(["iam", "users", "access", "grant", userId(), "--organization-id", org.itemId, "--roles", quote(adminRoles.join(",")), "--yes"]);
    console.log(`         -> granted [${adminRoles.join(", ")}] in ${org.itemId}`);
  }
}

// 5: Company + OrgMember rows (service identity, through the Function)
step(`records Company (self) + OrgMember for the admin, via Function ${SEED_FUNCTION_ID.slice(0, 8)}`, false);
if (apply) {
  const inputFile = join(tmpdir(), `seed-${seed.tenantRole}.json`);
  writeFileSync(inputFile, JSON.stringify({
    tenantRole: seed.tenantRole,
    company: seed.company,
    admin: { userId: userId(), email: seed.admin.email, firstName: seed.admin.firstName, lastName: seed.admin.lastName }
  }));
  try {
    const run = blocks(["logic", "function", "test", SEED_FUNCTION_ID, "--input-file", inputFile, "--wait-timeout", "120"]);
    console.log(`         -> run ${run.runId} ${run.status}`, run.result ?? run.errorMessage ?? "");
  } finally {
    rmSync(inputFile, { force: true });
  }
}

if (!apply) console.log("\nPreview only. Re-run with --yes to apply.");
