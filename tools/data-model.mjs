// Source of truth for the Blocks data model: writes blocks/data/schemas/*.json and
// blocks/data/rules.json. Edit this file, run `node tools/data-model.mjs`, then
// `blocks data validate` and `blocks data sync --dry-run`.
//
// Design: docs/architecture/README.md §2-4, 01-projects-and-access.md, 13-cross-cutting.md.
// - One Blocks organization per customer company. Every Entity carries `tenantRole`
//   (= the company's role `co-<slug>`); project-level Entities also carry `projectId`.
// - Every operation is Custom. A rule set for people always starts with
//   `tenantRole In Auth.roles`; the service identity (role `cpm-service`) has its own rule set.
// - Delete is Custom with no rule set: nobody deletes (records are voided).
// - Blocks has no Enum or "required" in the schema file: enums are Strings (values listed in the
//   docs, checked in Functions); required fields are enforced by the Functions that write them.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "blocks", "data");
const schemasDir = join(root, "schemas");

// ---------- field helpers ----------
const f = (name, type, isArray = false) => ({ name, type, isArray });
const str = (...names) => names.map((n) => f(n, "String"));
const id = (...names) => names.map((n) => f(n, "ID"));
const date = (...names) => names.map((n) => f(n, "DateTime"));
const bool = (...names) => names.map((n) => f(n, "Boolean"));
const int = (...names) => names.map((n) => f(n, "Int"));

const TENANT = [f("tenantRole", "String")];
const PROJECT = [...TENANT, f("projectId", "ID")];

// ---------- Dtos (embedded, schemaType 2) ----------
const dtos = {
  Address: [...str("street", "postalCode", "city", "region", "country")],
  Discipline: [...str("code", "name", "sheetPrefix")],
  ProjectSettings: [
    ...int("rfiDefaultDueWorkingDays", "submittalReviewWorkingDays", "punchDefaultDueDays"),
    ...id("rfiManagerUserId"),
    f("drawingDistributionUserIds", "ID", true),
    f("disciplines", "Discipline", true),
    ...str("changeOrderApprover") // owner-viewer | project-manager
  ],
  Holiday: [...date("date"), ...str("name", "source")], // source: preset | custom
  WorkingCalendar: [
    ...str("country", "region"),
    f("weekendDays", "Int", true),
    f("holidays", "Holiday", true),
    ...date("holidaysLoadedUntil")
  ],
  LastChange: [
    ...str("kind", "nonce", "fromStatus", "toStatus"),
    ...id("previousBallUserId", "actorUserId"),
    ...str("reason", "before", "after")
  ],
  Attachment: [
    ...id("fileId"),
    ...str("fileName", "contentType"),
    ...int("sizeBytes"),
    ...id("thumbnailFileId", "uploadedBy"),
    ...date("uploadedAt")
  ]
};

// ---------- Entities (schemaType 1) ----------
const entities = {
  // The customer itself (relation = self, exactly one) and its partner companies.
  Company: [
    ...TENANT,
    ...str("name", "legalName", "vatId", "relation"), // relation: self | sub | design | owner | supplier
    f("tradeCodes", "String", true),
    f("address", "Address"),
    ...str("defaultLanguage", "brandColor", "status"), // status: active | inactive
    ...id("logoFileId"),
    ...bool("isVoided")
  ],
  // One row per person in the company organization (staff and outside parties).
  OrgMember: [
    ...TENANT,
    ...id("userId"),
    ...str("email", "firstName", "lastName", "displayName", "phone", "jobTitle"),
    ...id("companyId"),
    ...str("companyName", "companyRelation", "orgRole"), // orgRole: staff | external
    ...str("defaultRole"), // project role slug used when the person is added to a project
    ...bool("isCompanyAdmin", "canCreateProjects"),
    ...str("status"), // invited | active | deactivated | removed
    ...id("invitedByUserId"),
    ...date("invitedAt", "inviteExpiresAt"),
    ...str("signupLinkId"),
    ...date("joinedAt", "removedAt"),
    ...str("removedReason")
  ],
  Project: [
    ...TENANT,
    ...str("number", "name", "description"),
    f("address", "Address"),
    f("location", "GeoJson"),
    ...str("status"), // active | onHold | completed | archived
    ...date("startDate", "endDate"),
    ...str("currency", "timezone", "locale", "defaultLanguage", "clientName"),
    ...str("stage", "projectType"), // stage: preconstruction | construction | closeout (as on the demo app)
    f("contractValue", "Float"),
    f("settings", "ProjectSettings"),
    f("calendar", "WorkingCalendar"),
    ...str("lastDailyLogDate"),
    ...id("createdByUserId", "logoFileId"),
    ...date("retentionUntil")
  ],
  ProjectMember: [
    ...PROJECT,
    ...id("userId", "orgMemberId"),
    ...str("email", "displayName"),
    ...id("companyId"),
    ...str("companyName", "companyRelation", "trade"),
    ...str("role", "status"), // role: project role slug; status: active | removed
    ...bool("isBallInCourtEligible"),
    ...date("joinedAt", "removedAt"),
    ...str("removedReason", "roleBeforeArchive")
  ],
  Sequence: [
    ...PROJECT,
    ...str("key", "prefix"), // key: rfi | submittal | punchItem | changeEvent | changeOrder
    ...int("padWidth"),
    ...str("targetSchema"),
    ...int("lastValue"),
    ...str("claimRef"),
    ...date("claimedAt")
  ],
  ActivityEvent: [
    ...PROJECT,
    ...str("recordType"),
    ...id("recordId"),
    ...str("recordNumber", "action"),
    ...id("actorUserId"),
    ...str("actorName"),
    ...date("at"),
    ...str("fromStatus", "toStatus"),
    f("changedFields", "String", true),
    ...str("beforeJson", "afterJson", "summary", "reason", "source", "correlationId")
  ],
  Comment: [
    ...PROJECT,
    ...str("recordType"),
    ...id("recordId"),
    ...str("recordNumber", "body"),
    f("attachments", "Attachment", true),
    ...id("authorCompanyId"),
    ...str("visibility"), // all | gcOnly
    f("mentionUserIds", "ID", true),
    ...bool("isVoided"),
    ...str("voidReason")
  ]
};

// ---------- access rules ----------
// Codes read from portal-made rules (README §2): source 0 Auth / 1 record / 2 static;
// operator 0 equals / 8 in; logicalOperator 0 all / 1 any; operation 0 view .. 3 delete.
const OP = { view: 0, create: 1, edit: 2, delete: 3 };
const inTenant = { leftSource: 1, leftOperand: "tenantRole", operator: 8, rightSource: 0, rightOperand: "roles", rightOperands: ["roles"], staticValue: null, description: null };
const hasRole = (role) => ({ leftSource: 0, leftOperand: "roles", operator: 8, rightSource: 2, rightOperand: "", rightOperands: [], staticValue: role, description: null });

const policy = (schemaName, operation, policyName, rules) => ({
  schemaName,
  policyName,
  policyDescription: "Generated by tools/data-model.mjs",
  policyType: 0,
  operation,
  fieldNames: [],
  ruleGroup: { logicalOperator: 0, rules, nestedGroups: [] },
  priority: 1,
  isAllowPolicy: true
});

// Rule sets per schema and operation. "member" = anyone in this company organization.
const SERVICE = ["service", [hasRole("cpm-service")]];
const MEMBER = ["company-member", [inTenant]];
const ADMIN = ["company-admin", [inTenant, hasRole("company-admin")]];

const access = {
  Company: { view: [MEMBER, SERVICE], create: [SERVICE], edit: [ADMIN, SERVICE] },
  OrgMember: { view: [MEMBER, SERVICE], create: [SERVICE], edit: [SERVICE] },
  Project: { view: [MEMBER, SERVICE], create: [SERVICE], edit: [SERVICE] },
  ProjectMember: { view: [MEMBER, SERVICE], create: [SERVICE], edit: [SERVICE] },
  Sequence: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  ActivityEvent: { view: [MEMBER, SERVICE], create: [SERVICE] },
  Comment: { view: [MEMBER, SERVICE], create: [SERVICE], edit: [SERVICE] }
};

const security = [];
const policies = [];
for (const [schemaName, ops] of Object.entries(access)) {
  for (const [opName, operation] of Object.entries(OP)) {
    // Every operation Custom; an operation with no rule set allows nobody.
    security.push({ schemaName, operation, policyType: 0, accessLevel: 3, fieldNames: [] });
    for (const [policyName, rules] of ops[opName] ?? []) policies.push(policy(schemaName, operation, policyName, rules));
  }
}

// ---------- write ----------
mkdirSync(schemasDir, { recursive: true });
for (const file of readdirSync(schemasDir)) if (file.endsWith(".json")) rmSync(join(schemasDir, file));
const write = (name, schemaType, fields) =>
  writeFileSync(
    join(schemasDir, `${name}.json`),
    JSON.stringify({ schemaName: name, collectionName: `${name}s`, schemaType, fields }, null, 2) + "\n"
  );
// The CLI pushes schema files alphabetically, and an Entity can only use a Dto that already
// exists on the server (Project < ProjectSettings). On a fresh environment run
// `node tools/data-model.mjs --dtos-only` + `blocks data schema push` first, then the full run.
const dtosOnly = process.argv.includes("--dtos-only");
for (const [name, fields] of Object.entries(dtos)) write(name, 2, fields);
if (!dtosOnly) for (const [name, fields] of Object.entries(entities)) write(name, 1, fields);
writeFileSync(join(root, "rules.json"), JSON.stringify({ security, policies }, null, 2) + "\n");

console.log(`schemas: ${Object.keys(dtos).length} Dto + ${Object.keys(entities).length} Entity; security ${security.length}; policies ${policies.length}`);
