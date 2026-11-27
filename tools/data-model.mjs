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
// - `blocks data rules deploy` matches live policies by schema + policy NAME and never deletes a
//   live policy that is not in rules.json. When a policy is dropped or renamed here, delete the old
//   one by id (`blocks data rules policy get <schema>` → `blocks data rules policy delete <id>`),
//   then deploy again, and compare with `blocks data rules pull` (it overwrites rules.json, so
//   regenerate after). Seen 2026-11-22: old "company-member" reads and the Company admin edit stayed live.
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
  ],
  // Revision impact (docs/architecture/02-drawings.md §4.7): one area of a sheet that changed
  // between two revisions, as fractions 0..1 of the page (origin top left, like pins).
  ChangeArea: [f("x", "Float"), f("y", "Float"), f("w", "Float"), f("h", "Float")],
  // One version of a document (newest last). A restored version points at the same file.
  DocVersion: [
    ...int("versionNo"),
    ...id("fileId"),
    ...str("fileName", "contentType"),
    ...int("sizeBytes"),
    ...id("uploadedBy"),
    ...str("uploadedByName", "note"),
    ...date("uploadedAt"),
    ...int("restoredFrom")
  ],
  // Daily logs (docs/architecture/05-daily-logs.md). Rows carry a client-made `rowId`.
  WeatherSnapshot: [
    ...str("source", "place", "condition", "summary"), // source: open-meteo | manual; condition: clear | partlyCloudy | cloudy | fog | drizzle | rain | snow | thunderstorm
    ...date("fetchedAt"),
    f("tempMinC", "Float"),
    f("tempMaxC", "Float"),
    f("precipitationMm", "Float"),
    f("windMaxKph", "Float")
  ],
  ManpowerEntry: [
    ...str("rowId"),
    ...id("companyId"),
    ...str("companyName", "trade"),
    ...int("headcount"),
    f("hours", "Float"),
    ...str("workDone", "location")
  ],
  EquipmentEntry: [...str("rowId", "name"), ...int("quantity"), f("hoursUsed", "Float"), ...str("status", "notes")], // status: working | idle | broken
  DeliveryEntry: [...str("rowId", "time", "supplier", "material", "quantity", "deliveryNoteNo")],
  VisitorEntry: [...str("rowId", "name", "organisation", "purpose", "timeIn", "timeOut")],
  DelayEntry: [...str("rowId", "type", "description"), f("durationHours", "Float")], // type: weather | material | labour | design | owner | inspection | access | other
  SafetyObservation: [...str("rowId", "type", "description", "actionTaken")] // type: observation | nearMiss | incident | toolboxTalk | inspection
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
  // RFIs (docs/architecture/03-rfis.md, part 1). Written only by the rfis Function, so the
  // creator is stored in createdByUserId (Blocks' own CreatedBy is the service identity).
  // Dates without a time (dueDate) are "yyyy-MM-dd" strings in the project's timezone.
  Rfi: [
    ...PROJECT,
    ...str("number"), // RFI-007; empty while a draft (numbered on submit)
    ...int("seq", "version"), // version: +1 on every update, the compare-and-set guard
    ...str("clientRequestId", "subject", "question", "suggestedAnswer"),
    ...str("status", "priority"), // status: draft | open | answered | closed | void; priority: low | normal | high
    ...str("discipline", "location", "dueDate"),
    ...id("managerUserId"),
    f("assigneeUserIds", "ID", true),
    f("distributionUserIds", "ID", true),
    ...id("ballInCourtUserId", "ballInCourtCompanyId"),
    ...str("ballInCourtName", "ballInCourtRole"), // role: creator | manager | assignee | none
    ...id("createdByUserId", "createdByCompanyId"),
    ...str("createdByName"),
    ...date("createdAt", "openedDate", "answeredDate", "closedDate"),
    ...id("closedByUserId", "officialResponseId"),
    ...str("officialAnswerText"),
    ...str("costImpact", "scheduleImpact"), // no | yes | tbd
    f("costImpactAmount", "Float"),
    ...int("scheduleImpactDays", "responseCount"),
    ...str("internalNote"),
    ...date("lastResponseAt"),
    f("attachments", "Attachment", true), // files of the question (Part 3); kept once submitted
    // Reminders (Part 4): the due date the "due soon" reminder was sent for, and the project-local
    // day ("yyyy-MM-dd") of the last overdue reminder. Written only by the reminder run.
    ...str("dueSoonNotifiedFor", "overdueNoticeLastDate"),
    f("lastChange", "LastChange"),
    ...bool("isVoided"),
    ...str("voidReason", "searchText")
  ],
  RfiResponse: [
    ...PROJECT,
    ...id("rfiId"),
    ...str("rfiNumber", "body"),
    ...id("authorUserId", "authorCompanyId"),
    ...str("authorName", "authorRole"),
    ...date("postedAt"),
    ...bool("isOfficial"),
    ...id("markedOfficialByUserId"),
    ...date("markedOfficialAt"),
    ...str("source"), // app | email (R3)
    f("attachments", "Attachment", true),
    ...bool("isVoided"),
    ...str("voidReason")
  ],
  // A person's notification settings in one company (docs/architecture/10 §2, simplified for the
  // MVP: email on or off; the bell is always on). Written and read only by the Functions.
  NotificationPreference: [
    ...TENANT,
    ...id("userId"),
    ...bool("emailEnabled"),
    ...bool("reminderEmails"), // due-soon and overdue reminders by email (only while emailEnabled); unset = on
    ...date("updatedAt")
  ],
  // Documents (docs/architecture/09-photos-and-documents.md, changed: files belong to the service
  // identity, so folders, versions and trash are records here, written only by the documents
  // Function). A project gets the seven standard folders on first open.
  DocFolder: [
    ...PROJECT,
    ...str("key", "name"), // key: contracts | specifications | … for the standard folders, "" for new ones
    ...int("sortOrder", "version"),
    f("viewRoles", "String", true), // project roles that see it (PM and DC always do)
    f("uploadRoles", "String", true), // project roles that upload, version, move and rename in it
    ...id("createdByUserId"),
    ...date("createdAt"),
    f("lastChange", "LastChange"),
    ...bool("isVoided")
  ],
  Document: [
    ...PROJECT,
    ...id("folderId"),
    ...str("name", "nameKey", "ext", "contentType"), // nameKey: lower-case name, one live file per name per folder
    ...int("currentVersion", "sizeBytes", "version"), // version: compare-and-set guard
    f("versions", "DocVersion", true),
    ...id("createdByUserId", "createdByCompanyId", "updatedByUserId"),
    ...str("createdByName", "updatedByName"),
    ...date("createdAt", "updatedAt"),
    ...bool("trashed"), // never deleted: trash keeps it restorable
    ...date("trashedAt"),
    ...id("trashedByUserId", "trashedFromFolderId"),
    ...str("trashedByName"),
    f("lastChange", "LastChange"),
    ...str("searchText")
  ],
  // Photos (docs/architecture/09 §2, DOC-01): one record per photo, written only by the photos
  // Function. Three files: the original as taken (EXIF kept), a 1600 px copy for viewing and a
  // 320 px copy for the grid, both made in the browser (a type the browser can't draw, such as
  // HEIC on most desktops, has only the original). Sheet pins come with the Drawings step.
  // Drawings (docs/architecture/02-drawings.md, changed like the other modules: files belong to
  // the service identity and every record is written only by the drawings Function).
  // One register row per sheet number; its revisions are never overwritten.
  Sheet: [
    ...PROJECT,
    ...str("sheetNumber", "sheetNumberKey", "sortKey", "title", "discipline", "setName"), // key: upper case, no spaces
    ...int("version", "revisionCount"), // version: compare-and-set guard (every publish and edit)
    ...id("currentRevisionId", "currentFileId", "currentThumbFileId"),
    ...str("currentRevisionLabel", "lastIssuedDate"), // lastIssuedDate: yyyy-MM-dd
    ...int("currentRevisionIndex"),
    ...id("createdByUserId"),
    ...date("createdAt", "updatedAt"),
    f("lastChange", "LastChange"),
    ...bool("isVoided"),
    ...str("voidReason", "searchText")
  ],
  SheetRevision: [
    ...PROJECT,
    ...id("sheetId"),
    ...str("sheetNumber", "revisionLabel", "issuedDate", "note", "status"), // status: current | superseded | void
    ...int("revisionIndex", "sizeBytes"), // revisionIndex: 1..n in order of issue
    ...id("fileId", "thumbFileId"),
    ...str("fileName"),
    f("pageWidthPt", "Float"), // page size after rotation, from pdf.js in the browser
    f("pageHeightPt", "Float"),
    ...id("uploadedByUserId", "uploadedByCompanyId"),
    ...str("uploadedByName"),
    ...date("uploadedAt", "supersededAt", "voidedAt"),
    ...id("voidedByUserId"),
    f("lastChange", "LastChange"),
    ...bool("isVoided"),
    ...str("voidReason"),
    // Revision impact: the browser compares this revision with the previous one and saves where
    // the drawing changed. changesStatus: first | pending | compared | redrawn | notComparable | failed
    ...str("changesStatus"),
    f("changeAreas", "ChangeArea", true),
    ...date("changesComparedAt"),
    ...id("changesComparedByUserId")
  ],
  // A pin belongs to the sheet and shows on every revision from fromRevisionIndex up to
  // toRevisionIndex (0 = still open). Moving a pin on a newer revision closes the old row.
  Pin: [
    ...PROJECT,
    ...id("sheetId"),
    ...int("fromRevisionIndex", "toRevisionIndex", "version"),
    f("x", "Float"), // 0..1 of the rotated page, origin top left
    f("y", "Float"),
    ...str("linkedRecordType", "linkedRecordNumber"), // rfi | punchItem
    ...id("linkedRecordId", "createdByUserId", "createdByCompanyId", "movedFromPinId"),
    ...str("createdByName"),
    ...date("createdAt", "voidedAt"),
    ...id("voidedByUserId"),
    f("lastChange", "LastChange"),
    ...bool("isVoided"),
    // Revision impact: someone checked that the pin still fits the revision with this index.
    ...int("checkedRevisionIndex"),
    ...id("checkedByUserId"),
    ...str("checkedByName"),
    ...date("checkedAt")
  ],
  // Revision impact: one row per subcontractor company and revision. "opened" when someone of the
  // company first opens the revision, "confirmed" when they confirm they build to it.
  RevisionAck: [
    ...PROJECT,
    ...id("sheetId", "revisionId", "companyId"),
    ...int("revisionIndex", "version"),
    ...str("sheetNumber", "revisionLabel", "companyName", "status"), // status: opened | confirmed
    ...date("openedAt", "confirmedAt", "remindedAt"),
    ...id("openedByUserId", "confirmedByUserId"),
    ...str("confirmedByName"),
    f("lastChange", "LastChange")
  ],
  Photo: [
    ...PROJECT,
    ...id("fileId", "previewFileId", "thumbFileId"),
    ...str("fileName", "contentType"),
    ...int("sizeBytes", "width", "height", "version"), // version: compare-and-set guard
    ...date("takenAt", "uploadedAt"), // takenAt: EXIF date when the photo has one, else the file date
    ...str("yearMonth", "caption", "locationLabel"),
    f("tags", "String", true), // lower case
    ...str("linkedRecordType", "linkedRecordNumber", "linkedRecordLabel", "linkRole"), // type: rfi | punchItem | dailyLog | none; role: general | before | after
    ...id("linkedRecordId", "uploadedByUserId", "uploaderCompanyId"),
    ...str("uploadedByName", "clientRequestId"), // clientRequestId: on the server already, unused
    ...bool("isVoided"), // removed photos stay restorable by the PM and document controller
    ...date("voidedAt"),
    ...id("voidedByUserId"),
    f("lastChange", "LastChange"),
    ...str("searchText")
  ],
  // Punch list (docs/architecture/06-punch-list.md, changed like the other modules: written and
  // read only by the punch Function, which checks the caller's company itself, so no
  // assigneeCompanyUserIds copy and no PunchNotifyMarker). Before and after photos are Photo
  // records linked with linkRole before | after (the photos Function); the item stores none.
  PunchItem: [
    ...PROJECT,
    ...str("number"), // PI-014
    ...int("seq", "version"), // version: +1 on every update, the compare-and-set guard
    ...str("clientRequestId", "title", "description"),
    ...str("status", "priority"), // status: open | inProgress | readyForReview | closed | void; priority: low | normal | high
    ...str("trade", "location", "dueDate"), // dueDate: yyyy-MM-dd in the project's timezone
    ...id("assigneeCompanyId", "assigneeUserId"),
    ...str("assigneeCompanyName", "assigneeName"),
    ...id("ballInCourtUserId"),
    ...str("ballInCourtName", "ballInCourtRole"), // role: assignee | verifier | none
    ...id("createdByUserId", "createdByCompanyId"),
    ...str("createdByName"),
    ...date("createdAt", "startedAt", "readyAt", "closedAt"),
    ...id("readyByUserId", "closedByUserId"),
    ...int("reopenCount"),
    ...str("lastRejectReason"),
    // After photos count only from this moment on: sending an item back asks for a new one.
    ...date("afterPhotoSince"),
    // Created with a photo still uploading: the item says "photo missing" until one arrives.
    ...bool("photoExpected"),
    ...id("sheetId", "pinId"),
    // Batched "assigned to your company" notice (every 15 minutes, Part 4).
    ...bool("notifyPending"),
    ...date("notifyPendingSince"),
    ...str("overdueNoticeLastDate"),
    f("lastChange", "LastChange"),
    ...bool("isVoided"),
    ...date("voidedAt"),
    ...id("voidedByUserId"),
    ...str("voidReason", "searchText")
  ],
  // Comments on a record (punch items first). Written by the module's Function, so the author is
  // stored here (Blocks' own CreatedBy is the service identity).
  Comment: [
    ...PROJECT,
    ...str("recordType"),
    ...id("recordId"),
    ...str("recordNumber", "body"),
    f("attachments", "Attachment", true),
    ...id("authorUserId", "authorCompanyId"),
    ...str("authorName"),
    ...date("postedAt"),
    ...str("visibility"), // all | gcOnly
    f("mentionUserIds", "ID", true),
    ...bool("isVoided"),
    ...str("voidReason")
  ],
  // The site diary: one per project per day (05-daily-logs.md). The general contractor's sections
  // live here; each company's crew lives in its own DailyLogCrew, so companies never overwrite each
  // other. Blocks has no unique index: when two people open an empty day at once, the log saved
  // first (CreatedDate, then ItemId) is the day's log and the other gets `duplicateOf`.
  DailyLog: [
    ...PROJECT,
    ...str("logDate", "status"), // logDate: yyyy-MM-dd in the project's timezone; status: draft | submitted
    ...int("version"), // +1 on every update, the compare-and-set guard
    ...bool("isWorkingDay"),
    f("weather", "WeatherSnapshot"),
    f("weatherOverride", "WeatherSnapshot"),
    ...str("siteConditions"), // normal | wet | frozen | flooded | noAccess
    f("equipment", "EquipmentEntry", true),
    f("deliveries", "DeliveryEntry", true),
    f("visitors", "VisitorEntry", true),
    f("delays", "DelayEntry", true),
    f("safety", "SafetyObservation", true),
    ...str("notes"),
    f("manpowerSummary", "ManpowerEntry", true), // every company's crew, frozen at submit
    ...int("totalHeadcount"),
    f("totalHours", "Float"),
    ...date("createdAt", "submittedAt"),
    ...id("createdByUserId", "submittedByUserId"),
    ...str("submittedByName"),
    ...int("correctionCount"),
    ...id("duplicateOf"),
    f("lastChange", "LastChange")
  ],
  // One company's crew and notes for one log (05 §2, option C).
  DailyLogCrew: [
    ...PROJECT,
    ...id("dailyLogId"),
    ...str("logDate"),
    ...id("companyId"),
    ...str("companyName", "status"), // status: open | locked (at submit)
    ...int("version"),
    f("manpower", "ManpowerEntry", true),
    ...str("notes"),
    ...id("lastEditedByUserId"),
    ...str("lastEditedByName"),
    ...date("lastEditedAt"),
    ...id("duplicateOf")
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

// Rule sets per schema and operation (docs/permissions/PERMISSIONS.md).
// - The company's own staff and admins read the company's projects, teams, people and partner
//   companies directly. Partners (role `external`) do NOT: they see only their own projects,
//   through the projects Function's `workspace` action (spec: subcontractors never see unrelated
//   project information).
// - Project content (activity history, comments, and every module after them) is read through
//   Functions that check the person's role on that project, so nobody reads it directly.
// - Every write goes through a Function (the service identity). Company admins have no direct edit
//   on Company: the rule only looked at the stored row, so it let them rewrite the company tag
//   (isolation finding F1).
const SERVICE = ["service", [hasRole("cpm-service")]];
const STAFF = ["company-staff", [inTenant, hasRole("staff")]];
const ADMIN = ["company-admin", [inTenant, hasRole("company-admin")]];

const access = {
  Company: { view: [STAFF, ADMIN, SERVICE], create: [SERVICE], edit: [SERVICE] },
  OrgMember: { view: [STAFF, ADMIN, SERVICE], create: [SERVICE], edit: [SERVICE] },
  Project: { view: [STAFF, ADMIN, SERVICE], create: [SERVICE], edit: [SERVICE] },
  ProjectMember: { view: [STAFF, ADMIN, SERVICE], create: [SERVICE], edit: [SERVICE] },
  Sequence: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  ActivityEvent: { view: [SERVICE], create: [SERVICE] },
  Comment: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Project content: only through the rfis Function, which checks the caller's project role.
  Rfi: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  RfiResponse: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Documents: only through the documents Function (folder rules per project role).
  DocFolder: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  Document: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Drawings: only through the drawings Function (subcontractors see only the pins they can open).
  Sheet: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  SheetRevision: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  RevisionAck: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  Pin: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Photos: only through the photos Function (subcontractors see their company's photos and
  // photos on records they can open).
  Photo: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Punch list: only through the punch Function (subcontractors see their company's items).
  PunchItem: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Daily logs: only through the daily-logs Function (subcontractors see the day's header and their
  // own company's crew; owners see submitted logs only).
  DailyLog: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  DailyLogCrew: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] },
  // Own settings, read and saved through the projects Function (the caller's id from their token).
  NotificationPreference: { view: [SERVICE], create: [SERVICE], edit: [SERVICE] }
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
