// Local test of the punch Function: runs functions/punch/index.js against the same in-memory fake
// of the Blocks token, Data Gateway and Storage endpoints as tools/test-drawings.mjs, so who
// creates, starts, marks ready, closes, sends back, voids and reassigns punch items is checked
// without touching any environment.
//   node tools/test-punch.mjs
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
const rows = (schema) => (store[schema] ??= []);
const files = [];
const sent = [];

globalThis.fetch = async (url, init) => {
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (String(url).includes("/oidc/token")) return json({ access_token: "test-token" });
  if (String(url).includes("/logic/v4/")) {
    // The bell (Notifier) and email (Mail): recorded in `sent` instead of going anywhere.
    const b = JSON.parse(init.body);
    if (String(url).includes("Notifier")) sent.push({ type: "bell", userIds: b.userIds, payload: JSON.parse(b.denormalizedPayload) });
    else if (String(url).includes("Mail")) sent.push({ type: "mail", to: b.to, subject: b.subjectDataContext.Subject, data: b.bodyDataContext });
    return json({ isSuccess: true });
  }
  if (String(url).includes("/data/v4/files/get-files")) {
    const b = JSON.parse(init.body);
    return json({ isSuccess: true, data: b.FileIds.map((id) => ({ fileId: id, url: `https://blob.test/${id}?read=1` })) });
  }
  const { query, variables } = JSON.parse(init.body);
  let m;
  if ((m = /\{\s*get(\w+)s\(/.exec(query))) {
    const filter = JSON.parse(variables.input.filter ?? "{}");
    const at = query.indexOf("{", query.indexOf("items"));
    let depth = 0;
    let end = at;
    for (; end < query.length; end += 1) {
      if (query[end] === "{") depth += 1;
      if (query[end] === "}" && --depth === 0) break;
    }
    const wanted = query.slice(at + 1, end).replace(/\{[^{}]*\}/g, " ").trim().split(/\s+/);
    const items = rows(m[1])
      .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
      .map((r) => Object.fromEntries(wanted.filter((f) => f in r).map((f) => [f, structuredClone(r[f])])));
    return json({ data: { [`get${m[1]}s`]: { items } } });
  }
  if ((m = /insert(\w+)\(/.exec(query))) {
    const itemId = randomUUID();
    rows(m[1]).push({ ...structuredClone(variables.input), ItemId: itemId });
    return json({ data: { [`insert${m[1]}`]: { acknowledged: true, itemId } } });
  }
  if ((m = /update(\w+)\(/.exec(query))) {
    const hit = rows(m[1]).filter((r) => Object.entries(variables.where).every(([k, cond]) => r[k] === cond.eq));
    for (const r of hit) Object.assign(r, structuredClone(variables.input));
    return json({ data: { [`update${m[1]}`]: { acknowledged: hit.length > 0, totalImpactedData: hit.length } } });
  }
  throw new Error(`fake gateway: unknown query ${query.slice(0, 60)}`);
};

const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "punch", "index.js")).href);

// ---------- seed: the GC with one person per role, two subcontractors, design and owner ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active", timezone: "Europe/Berlin" });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Old", status: "archived", timezone: "Europe/Berlin" });
const people = {
  pm: { role: "project-manager", account: "staff", company: "gc", companyName: "West Build", joined: "2026-01-01" },
  supt: { role: "superintendent", account: "staff", company: "gc", companyName: "West Build", joined: "2026-01-02" },
  dc: { role: "document-controller", account: "staff", company: "gc", companyName: "West Build", joined: "2026-01-03" },
  sub: { role: "field-user", account: "external", company: "sub-co", companyName: "Dry Walls Ltd", trade: "Drywall", joined: "2026-02-01" },
  sub2: { role: "field-user", account: "external", company: "sub-co", companyName: "Dry Walls Ltd", trade: "Drywall", joined: "2026-03-01" },
  other: { role: "field-user", account: "external", company: "paint-co", companyName: "Paint & Co", trade: "Painting", joined: "2026-02-05" },
  design: { role: "design-reviewer", account: "external", company: "design-co", companyName: "Arch Studio", joined: "2026-01-05" },
  owner: { role: "owner-viewer", account: "external", company: "owner-co", companyName: "Owner AG", joined: "2026-01-06" },
  stranger: { role: null, account: "staff", company: "gc" }
};
for (const [userId, p] of Object.entries(people)) {
  if (!p.role) continue;
  for (const projectId of [P, "p2"]) {
    rows("ProjectMember").push({
      ItemId: `${projectId}-${userId}`, tenantRole: T, projectId, userId, displayName: userId.toUpperCase(), email: `${userId}@test.example`,
      companyId: p.company, companyName: p.companyName, companyRelation: p.company === "gc" ? "self" : "sub", trade: p.trade ?? "", role: p.role, status: "active", joinedAt: p.joined
    });
  }
}
// The owner company has an owner but no field user: items can't go to it.
// A sheet for pins (current revision 2), and another company's punch item with the same project id.
rows("Sheet").push({ ItemId: "sheet-a", tenantRole: T, projectId: P, sheetNumber: "A-101", currentRevisionIndex: 2, currentRevisionLabel: "B", isVoided: false });
rows("PunchItem").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, number: "PI-999", title: "Not yours", status: "open", assigneeCompanyId: "sub-co", createdByUserId: "x", seq: 999, version: 0 });

const call = (user, body, projectId = P) =>
  handler({ method: "POST", body: { projectId, ...body } }, {
    context: { tenantId: "TEN", userId: user, organizationId: "ORG", roles: [T, people[user].account] },
    env: { CLIENT_ID: "id", CLIENT_SECRET: "secret" },
    log: { error: (...a) => console.error("  [function error]", ...a), warn() {}, info() {} }
  });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const ok = (r, what) => expect(r.ok === true, `${what}: expected ok, got ${r.code} ${r.error}`);
const refused = (r, code, what) => expect(r.ok === false && r.code === code, `${what}: expected ${code}, got ${r.ok ? "ok" : `${r.code} ${r.error}`}`);
const mine = (schema) => rows(schema).filter((x) => x.tenantRole === T);
const row = (id) => mine("PunchItem").find((x) => x.ItemId === id);
const tz = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const today = tz(new Date());
const dayPlus = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekendDay = () => {
  for (let n = 1; n < 9; n += 1) if ([0, 6].includes(new Date(`${dayPlus(n)}T12:00:00Z`).getUTCDay())) return dayPlus(n);
  return dayPlus(6);
};
const workingDaysAhead = (n) => {
  let d = today;
  let left = n;
  while (left > 0) {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    d = x.toISOString().slice(0, 10);
    if (![0, 6].includes(x.getUTCDay())) left -= 1;
  }
  return d;
};
let rq = 0;
const create = (user, body = {}) =>
  call(user, { action: "create", clientRequestId: `rq-${++rq}`, title: "Gap at door frame", assigneeCompanyId: "sub-co", withPhoto: true, location: "Level 2 · Room 204", ...body });
// The photos Function's part: a photo linked to the item (before or after), uploaded now (each one
// a little later than the last, never in the future).
let tick = 0;
function addPhoto(itemId, role, by = "sub") {
  tick = Math.max(tick + 1, Date.now());
  rows("Photo").push({
    ItemId: randomUUID(), tenantRole: T, projectId: P, linkedRecordType: "punchItem", linkedRecordId: itemId, linkRole: role,
    fileId: `f-${randomUUID().slice(0, 6)}`, previewFileId: `pv-${randomUUID().slice(0, 6)}`, thumbFileId: `th-${randomUUID().slice(0, 6)}`,
    uploadedAt: new Date(tick).toISOString(), uploadedByUserId: by, uploadedByName: by.toUpperCase(), isVoided: false
  });
}
const events = (itemId) => mine("ActivityEvent").filter((e) => e.recordId === itemId).map((e) => e.action);

console.log("punch Function");
let first;

await test("only the PM and the superintendent create items", async () => {
  for (const u of ["dc", "sub", "design", "owner"]) refused(await create(u), "NOT_ALLOWED", u);
  refused(await create("stranger"), "NOT_ON_PROJECT", "not on the team");
});

await test("the superintendent creates PI-001 with a photo coming: open, ball with the company's first field user, due in 7 working days", async () => {
  const r = await create("supt");
  ok(r, "create");
  first = r.item.ItemId;
  expect(r.created === true, "created flag");
  expect(r.item.number === "PI-001", `number ${r.item.number}`);
  expect(r.item.status === "open", r.item.status);
  expect(r.item.ballInCourtUserId === "sub" && r.item.ballInCourtRole === "assignee", `ball ${r.item.ballInCourtUserId}`);
  expect(r.item.assigneeCompanyName === "Dry Walls Ltd" && r.item.trade === "Drywall", "company and trade");
  expect(r.item.dueDate === workingDaysAhead(7), `due ${r.item.dueDate}, wanted ${workingDaysAhead(7)}`);
  expect(r.item.photoMissing === true, "photo missing until the upload lands");
  expect(row(first).notifyPending === true, "batched notice pending");
  expect(!("tenantRole" in r.item) && !("clientRequestId" in r.item) && !("notifyPending" in r.item), "internal fields hidden");
  expect(r.can.start && r.can.markReady && r.can.close && r.can.void && r.can.edit, "the superintendent can work it");
  expect(events(first).includes("created"), "history line");
});

await test("a retried create returns the same item and makes no second one", async () => {
  const body = { action: "create", clientRequestId: "same-rq", title: "Paint scratch", assigneeCompanyId: "paint-co", withPhoto: true };
  const a = await call("supt", body);
  const b = await call("supt", body);
  ok(a, "first");
  ok(b, "retry");
  expect(b.created === false && b.item.ItemId === a.item.ItemId, "same item");
  expect(mine("PunchItem").filter((x) => x.clientRequestId === "same-rq").length === 1, "one row");
  expect(a.item.number === "PI-002", a.item.number);
});

await test("create checks title, company, person, photo-or-pin and due date", async () => {
  refused(await create("supt", { title: "ab" }), "BAD_TITLE", "short title");
  refused(await create("supt", { assigneeCompanyId: "owner-co" }), "COMPANY_NOT_ON_PROJECT", "company without field users");
  refused(await create("supt", { assigneeCompanyId: "gc" }), "COMPANY_NOT_ON_PROJECT", "the GC itself");
  refused(await create("supt", { assigneeUserId: "other" }), "ASSIGNEE_NOT_IN_COMPANY", "person of another company");
  refused(await create("supt", { withPhoto: false }), "PHOTO_OR_PIN", "no photo, no pin");
  refused(await create("supt", { dueDate: dayPlus(-1) }), "DUE_DATE_IN_PAST", "past due date");
  refused(await create("supt", { priority: "urgent" }), "BAD_PRIORITY", "priority");
  const w = await create("supt", { dueDate: weekendDay(), assigneeUserId: "sub2" });
  ok(w, "weekend due date");
  expect(![0, 6].includes(new Date(`${w.item.dueDate}T12:00:00Z`).getUTCDay()), `moved to a working day: ${w.item.dueDate}`);
  expect(w.item.ballInCourtUserId === "sub2", "the named person holds the ball");
});

await test("create from a sheet pin: the pin links to the item, on the current revision only", async () => {
  refused(await create("supt", { withPhoto: false, pin: { sheetId: "sheet-a", revisionIndex: 1, x: 0.5, y: 0.5 } }), "NOT_CURRENT", "old revision");
  refused(await create("supt", { withPhoto: false, pin: { sheetId: "sheet-a", revisionIndex: 2, x: 1.5, y: 0.5 } }), "BAD_POINT", "off the sheet");
  const r = await create("supt", { withPhoto: false, pin: { sheetId: "sheet-a", revisionIndex: 2, x: 0.25, y: 0.75 } });
  ok(r, "pinned create");
  const pin = mine("Pin").find((p) => p.linkedRecordId === r.item.ItemId);
  expect(pin && pin.linkedRecordType === "punchItem" && pin.fromRevisionIndex === 2 && pin.x === 0.25, "pin row");
  expect(r.item.pinId === pin.ItemId && r.item.sheetId === "sheet-a", "item points at its pin");
  expect(r.item.photoMissing === false, "a pinned item without a photo is fine");
});

await test("the item follows its live pin: moved to another sheet, removed, or on a removed sheet", async () => {
  const r = await create("supt", { withPhoto: false, title: "Pin follower", pin: { sheetId: "sheet-a", revisionIndex: 2, x: 0.4, y: 0.6 } });
  ok(r, "pinned create");
  expect(r.pin && r.pin.sheetNumber === "A-101" && r.pin.x === 0.4 && r.item.sheetNumber === "A-101", `detail pin ${JSON.stringify(r.pin)}`);
  const id = r.item.ItemId;
  const first = mine("Pin").find((p) => p.linkedRecordId === id);
  // The drawings Function moved it to another sheet: the old row ends, a new one starts there.
  rows("Sheet").push({ ItemId: "sheet-b", tenantRole: T, projectId: P, sheetNumber: "A-102", title: "Level 2", currentRevisionIndex: 1, currentRevisionLabel: "A", isVoided: false });
  first.toRevisionIndex = 1;
  rows("Pin").push({ ItemId: "pin-b", tenantRole: T, projectId: P, sheetId: "sheet-b", fromRevisionIndex: 1, toRevisionIndex: 0, x: 0.1, y: 0.2, linkedRecordType: "punchItem", linkedRecordId: id, isVoided: false, createdAt: new Date().toISOString() });
  let d = await call("pm", { action: "get", itemId: id });
  expect(d.item.sheetId === "sheet-b" && d.item.pinId === "pin-b" && d.pin.sheetNumber === "A-102" && d.pin.sheetTitle === "Level 2", `moved ${JSON.stringify(d.pin)}`);
  const l = await call("pm", { action: "list" });
  expect(l.items.find((i) => i.ItemId === id).sheetNumber === "A-102", "list row shows the sheet");
  // Removed: no pin any more.
  mine("Pin").find((p) => p.ItemId === "pin-b").isVoided = true;
  d = await call("pm", { action: "get", itemId: id });
  expect(!d.item.sheetId && !d.item.pinId && d.pin === null, "no pin after removal");
  // A pin on a sheet that was removed doesn't count either.
  rows("Pin").push({ ItemId: "pin-c", tenantRole: T, projectId: P, sheetId: "sheet-gone", fromRevisionIndex: 1, toRevisionIndex: 0, x: 0.5, y: 0.5, linkedRecordType: "punchItem", linkedRecordId: id, isVoided: false, createdAt: new Date().toISOString() });
  rows("Sheet").push({ ItemId: "sheet-gone", tenantRole: T, projectId: P, sheetNumber: "A-999", isVoided: true });
  d = await call("pm", { action: "get", itemId: id });
  expect(d.pin === null, "removed sheet ignored");
});

await test("subcontractors see only their company's items; owners and designers see all but change nothing", async () => {
  const s = await call("sub", { action: "list" });
  ok(s, "sub list");
  expect(s.items.length > 0 && s.items.every((i) => i.assigneeCompanyId === "sub-co"), "only sub-co items");
  expect(!s.items.some((i) => i.ItemId === "foreign"), "never another company's rows");
  expect(s.can.create === false && s.can.bulk === false && s.companies.length === 0, "sub can't create");
  const o = await call("other", { action: "list" });
  expect(o.items.length === 1 && o.items[0].assigneeCompanyId === "paint-co", "painter sees one");
  const ow = await call("owner", { action: "list" });
  expect(ow.items.length === mine("PunchItem").length, "owner sees all");
  expect(ow.can.create === false, "owner can't create");
  refused(await call("other", { action: "get", itemId: first }), "NOT_FOUND", "painter opens a drywall item");
  const d = await call("owner", { action: "get", itemId: first });
  ok(d, "owner opens it");
  expect(!d.can.start && !d.can.close && !d.can.comment && !d.can.edit, "owner: view only");
  const sup = await call("supt", { action: "list" });
  expect(sup.companies.map((c) => c.companyId).join(",") === "sub-co,paint-co", `companies ${sup.companies.map((c) => c.companyId)}`);
  expect(sup.suggestions.titles.includes("Gap at door frame") && sup.suggestions.locations.includes("Level 2 · Room 204"), "suggestions");
});

await test("start: the assigned company or the GC; never twice", async () => {
  refused(await call("owner", { action: "start", itemId: first }), "NOT_ALLOWED", "owner");
  refused(await call("other", { action: "start", itemId: first }), "NOT_FOUND", "another company");
  const r = await call("sub2", { action: "start", itemId: first });
  ok(r, "sub2 starts");
  expect(r.item.status === "inProgress" && row(first).startedAt, "in progress");
  refused(await call("sub", { action: "start", itemId: first }), "INVALID_TRANSITION", "again");
});

await test("mark ready needs an after photo; the ball goes to the creator who verifies", async () => {
  refused(await call("sub", { action: "markReady", itemId: first }), "AFTER_PHOTO_REQUIRED", "no after photo");
  addPhoto(first, "before", "supt");
  addPhoto(first, "after", "sub");
  const r = await call("sub", { action: "markReady", itemId: first });
  ok(r, "mark ready");
  expect(r.item.status === "readyForReview" && r.item.ballInCourtUserId === "supt" && r.item.ballInCourtRole === "verifier", `ball ${r.item.ballInCourtUserId}`);
  expect(r.item.photoMissing === false && r.item.beforePhotos === 1 && r.item.afterPhotos === 1, "photo counts");
  expect(r.photos.length === 2 && r.photos.every((p) => p.thumbUrl && p.previewUrl), "photo links in the detail");
});

await test("subcontractors don't close or send back", async () => {
  refused(await call("sub", { action: "close", itemId: first }), "NOT_ALLOWED", "close");
  refused(await call("sub", { action: "sendBack", itemId: first, reason: "nope" }), "NOT_ALLOWED", "send back");
});

await test("send back needs a reason and asks for a NEW after photo", async () => {
  refused(await call("supt", { action: "sendBack", itemId: first }), "REASON_REQUIRED", "no reason");
  const r = await call("supt", { action: "sendBack", itemId: first, reason: "Gap still visible at the head" });
  ok(r, "send back");
  expect(r.item.status === "inProgress" && r.item.reopenCount === 1 && r.item.lastRejectReason === "Gap still visible at the head", "back in progress");
  expect(r.item.ballInCourtUserId === "sub" && r.item.afterPhotos === 0, "ball back with the company; old after photo no longer counts");
  refused(await call("sub", { action: "markReady", itemId: first }), "AFTER_PHOTO_REQUIRED", "old photo");
  addPhoto(first, "after", "sub");
  ok(await call("sub", { action: "markReady", itemId: first }), "ready again");
});

await test("close by the GC, then reopen with a reason", async () => {
  const r = await call("supt", { action: "close", itemId: first });
  ok(r, "close");
  expect(r.item.status === "closed" && r.item.ballInCourtRole === "none" && row(first).closedByUserId === "supt", "closed");
  refused(await call("supt", { action: "close", itemId: first }), "INVALID_TRANSITION", "close twice");
  refused(await call("pm", { action: "void", itemId: first, reason: "duplicate" }), "INVALID_TRANSITION", "void a closed item");
  refused(await call("pm", { action: "reopen", itemId: first }), "REASON_REQUIRED", "reopen without a reason");
  const o = await call("pm", { action: "reopen", itemId: first, reason: "Paint cracked again" });
  ok(o, "reopen");
  expect(o.item.status === "inProgress" && o.item.reopenCount === 2, "reopened");
  expect(["created", "started", "markedReady", "sentBack", "closed", "reopened"].every((a) => events(first).includes(a)), `history ${events(first)}`);
});

await test("the GC closes straight from open with their own after photo, never without one", async () => {
  const r = await create("supt", { title: "Missing skirting" });
  refused(await call("pm", { action: "close", itemId: r.item.ItemId }), "AFTER_PHOTO_REQUIRED", "no photo");
  addPhoto(r.item.ItemId, "after", "pm");
  ok(await call("pm", { action: "close", itemId: r.item.ItemId }), "close from open");
});

await test("the verifier falls back to the first PM when the creator left the team", async () => {
  const r = await create("supt", { title: "Loose handrail" });
  addPhoto(r.item.ItemId, "after", "sub");
  const supt = rows("ProjectMember").find((m) => m.ItemId === "p1-supt");
  supt.status = "removed";
  const m = await call("sub", { action: "markReady", itemId: r.item.ItemId });
  supt.status = "active";
  ok(m, "mark ready");
  expect(m.item.ballInCourtUserId === "pm", `ball ${m.item.ballInCourtUserId}`);
});

await test("void: the PM always, the creator only while open, with a reason", async () => {
  const a = await create("supt", { title: "Duplicate item" });
  refused(await call("supt", { action: "void", itemId: a.item.ItemId }), "REASON_REQUIRED", "no reason");
  const v = await call("supt", { action: "void", itemId: a.item.ItemId, reason: "Entered twice" });
  ok(v, "creator voids own open item");
  expect(v.item.status === "void" && v.item.isVoided === true && row(a.item.ItemId).notifyPending === false, "void, and no notice goes out");
  const b = await create("supt", { title: "Started item" });
  ok(await call("sub", { action: "start", itemId: b.item.ItemId }), "start");
  refused(await call("supt", { action: "void", itemId: b.item.ItemId, reason: "x x x" }), "NOT_ALLOWED", "creator after open");
  ok(await call("pm", { action: "void", itemId: b.item.ItemId, reason: "Out of scope" }), "PM voids");
  refused(await call("sub", { action: "comment", itemId: b.item.ItemId, body: "hi" }), "NOT_ALLOWED", "comment on void");
});

await test("edit: the GC only, active items only, guarded by version", async () => {
  const r = await create("supt", { title: "Scratch on glass" });
  const id = r.item.ItemId;
  refused(await call("sub", { action: "edit", itemId: id, changes: { title: "Mine now" } }), "NOT_ALLOWED", "sub edits");
  refused(await call("supt", { action: "edit", itemId: id, version: 99, changes: { title: "Late" } }), "STATE_CHANGED", "stale version");
  const e = await call("supt", { action: "edit", itemId: id, version: r.item.version, changes: { title: "Scratch on glass pane", priority: "high", dueDate: dayPlus(14) } });
  ok(e, "edit");
  expect(e.item.title === "Scratch on glass pane" && e.item.priority === "high", "saved");
  expect(e.history[0].action === "edited" && /title, priority, due date/.test(e.history[0].summary), e.history[0].summary);
  refused(await call("supt", { action: "edit", itemId: id, changes: { dueDate: "" } }), "BAD_DUE_DATE", "clear the due date");
});

await test("reassign moves the item to another company and queues their notice", async () => {
  const r = await create("supt", { title: "Wrong trade" });
  const id = r.item.ItemId;
  row(id).notifyPending = false;
  // A caller can't hand in a ready-made assignment: it is always checked again.
  refused(await call("supt", { action: "reassign", itemId: id, assignment: { assigneeCompanyId: "evil", assigneeCompanyName: "Evil" } }), "COMPANY_NOT_ON_PROJECT", "forged assignment");
  const m = await call("supt", { action: "reassign", itemId: id, assigneeCompanyId: "paint-co" });
  ok(m, "reassign");
  expect(m.item.assigneeCompanyId === "paint-co" && m.item.ballInCourtUserId === "other" && m.item.trade === "Painting", "new company, ball and trade");
  expect(row(id).notifyPending === true, "notice queued");
  refused(await call("sub", { action: "get", itemId: id }), "NOT_FOUND", "old company loses it");
  ok(await call("other", { action: "get", itemId: id }), "new company sees it");
  refused(await call("sub", { action: "reassign", itemId: id, assigneeCompanyId: "sub-co" }), "NOT_FOUND", "sub can't even see it now");
});

await test("comments: the GC and the assigned company", async () => {
  refused(await call("owner", { action: "comment", itemId: first, body: "Looks fine" }), "NOT_ALLOWED", "owner");
  refused(await call("sub", { action: "comment", itemId: first, body: "   " }), "EMPTY_COMMENT", "empty");
  const r = await call("sub", { action: "comment", itemId: first, body: "Re-sealed with acrylic" });
  ok(r, "sub comments");
  expect(r.comments.length === 1 && r.comments[0].authorName === "SUB" && r.comments[0].body === "Re-sealed with acrylic", "comment shown");
});

await test("bulk: GC only, at most 50, per-item results", async () => {
  const a = await create("supt", { title: "Bulk one" });
  const b = await create("supt", { title: "Bulk two" });
  const closed = await create("supt", { title: "Bulk closed" });
  addPhoto(closed.item.ItemId, "after", "pm");
  ok(await call("pm", { action: "close", itemId: closed.item.ItemId }), "close one");
  refused(await call("sub", { action: "bulk", op: "setDue", itemIds: [a.item.ItemId], dueDate: dayPlus(20) }), "NOT_ALLOWED", "sub");
  refused(await call("pm", { action: "bulk", op: "setDue", itemIds: Array.from({ length: 51 }, (_, i) => `x${i}`), dueDate: dayPlus(20) }), "TOO_MANY_ITEMS", "51 items");
  refused(await call("pm", { action: "bulk", op: "explode", itemIds: [a.item.ItemId] }), "BAD_ACTION", "unknown op");
  refused(await call("pm", { action: "bulk", op: "setDue", itemIds: [a.item.ItemId], dueDate: dayPlus(-3) }), "DUE_DATE_IN_PAST", "bad date refuses the call");
  const due = await call("pm", { action: "bulk", op: "setDue", itemIds: [a.item.ItemId, b.item.ItemId, closed.item.ItemId, "nope"], dueDate: dayPlus(20) });
  ok(due, "bulk due");
  expect(due.updated.length === 2, `updated ${due.updated.length}`);
  expect(due.rejected.some((x) => x.itemId === closed.item.ItemId && x.code === "INVALID_TRANSITION"), "closed one skipped");
  expect(due.rejected.some((x) => x.itemId === "nope" && x.code === "NOT_FOUND"), "unknown one");
  expect(events(a.item.ItemId).includes("edited") && events(b.item.ItemId).includes("edited"), "one history line per item");
  const cl = await call("pm", { action: "bulk", op: "close", itemIds: [a.item.ItemId, b.item.ItemId] });
  expect(cl.updated.length === 0 && cl.rejected.every((x) => x.code === "AFTER_PHOTO_REQUIRED"), "no after photos, nothing closed");
  const re = await call("supt", { action: "bulk", op: "reassign", itemIds: [a.item.ItemId, b.item.ItemId], assigneeCompanyId: "paint-co" });
  expect(re.updated.length === 2 && row(a.item.ItemId).assigneeCompanyId === "paint-co", "bulk reassign");
  refused(await call("pm", { action: "bulk", op: "void", itemIds: [a.item.ItemId] }), "REASON_REQUIRED", "bulk void needs a reason");
});

await test("archived projects are read-only", async () => {
  const l = await call("pm", { action: "list" }, "p2");
  ok(l, "list");
  expect(l.can.create === false && l.can.bulk === false, "no create");
  refused(await call("pm", { action: "create", clientRequestId: "arch", title: "Late find", assigneeCompanyId: "sub-co", withPhoto: true }, "p2"), "ARCHIVED", "create");
});

await test("the document controller reads the list but changes nothing", async () => {
  const l = await call("dc", { action: "list" });
  ok(l, "list");
  expect(l.can.create === false && l.can.bulk === false, "no create");
  refused(await call("dc", { action: "start", itemId: first }), "INVALID_TRANSITION", "first is in progress");
  const fresh = await create("supt", { title: "For the DC" });
  refused(await call("dc", { action: "start", itemId: fresh.item.ItemId }), "NOT_ALLOWED", "dc starts");
});

// ---------- notifications (part 4) ----------
const bellsTo = (u, kind) => sent.filter((x) => x.type === "bell" && x.userIds.includes(u) && (!kind || x.payload.kind === kind)).map((x) => x.payload);
const mailsTo = (u) => sent.filter((x) => x.type === "mail" && x.to.includes(`${u}@test.example`));

await test("marked ready tells the verifier (bell + email); nobody hears about their own change", async () => {
  const r = await create("supt", { title: "Scuffed wall" });
  const id = r.item.ItemId;
  addPhoto(id, "after", "sub");
  sent.length = 0;
  ok(await call("sub", { action: "start", itemId: id }), "start");
  expect(sent.length === 0, `start tells nobody: ${JSON.stringify(sent)}`);
  const m = await call("sub", { action: "markReady", itemId: id });
  ok(m, "mark ready");
  const b = bellsTo("supt", "punch.ready");
  expect(b.length === 1 && b[0].title === `${r.item.number} is ready for your check` && b[0].link === `/punch/${id}?project=${P}`, JSON.stringify(b));
  expect(mailsTo("supt").length === 1 && mailsTo("supt")[0].subject === `[PRJ-001] ${r.item.number} is ready for your check`, "verifier email");
  expect(mailsTo("supt")[0].data.ButtonLabel === "Open the punch item" && mailsTo("supt")[0].data.ButtonUrl.endsWith(`/punch/${id}?project=${P}`), "email button");
  expect(bellsTo("sub").length === 0 && m.notified.bell === 1 && m.notified.email === 1 && m.notified.failed.length === 0, `notified ${JSON.stringify(m.notified)}`);
});

await test("sent back tells the whole assigned company with the reason; email off means bell only; closed is bell only", async () => {
  const r = await create("supt", { title: "Door rubs" });
  const id = r.item.ItemId;
  addPhoto(id, "after", "sub");
  ok(await call("sub", { action: "markReady", itemId: id }), "ready");
  rows("NotificationPreference").push({ ItemId: "np-sub2", tenantRole: T, userId: "sub2", emailEnabled: false });
  sent.length = 0;
  ok(await call("supt", { action: "sendBack", itemId: id, reason: "Still rubs at the top" }), "send back");
  for (const u of ["sub", "sub2"]) {
    const b = bellsTo(u, "punch.rejected");
    expect(b.length === 1 && b[0].title === `${r.item.number} was sent back: a new after photo is needed` && b[0].body.includes("“Still rubs at the top”"), `${u}: ${JSON.stringify(b)}`);
  }
  expect(mailsTo("sub").length === 1 && mailsTo("sub2").length === 0, "sub2 turned email off");
  expect(bellsTo("other").length === 0 && bellsTo("supt").length === 0, "other company and the actor hear nothing");
  addPhoto(id, "after", "sub");
  sent.length = 0;
  ok(await call("pm", { action: "close", itemId: id }), "pm closes");
  expect(bellsTo("sub", "punch.closed").length === 1 && bellsTo("sub2", "punch.closed").length === 1, "company told it's closed");
  expect(sent.every((x) => x.type === "bell"), "closed: no email");
  sent.length = 0;
  ok(await call("pm", { action: "reopen", itemId: id, reason: "Cracked again" }), "reopen");
  expect(bellsTo("sub", "punch.rejected")[0]?.title === `${r.item.number} was reopened: a new after photo is needed`, "reopened wording");
});

await test("a bulk close sends one notice per person, not one per item", async () => {
  const a = await create("supt", { title: "Bulk notice one" });
  const b = await create("supt", { title: "Bulk notice two" });
  addPhoto(a.item.ItemId, "after", "pm");
  addPhoto(b.item.ItemId, "after", "pm");
  sent.length = 0;
  const r = await call("pm", { action: "bulk", op: "close", itemIds: [a.item.ItemId, b.item.ItemId] });
  expect(r.updated.length === 2, `closed ${r.updated.length}`);
  const told = bellsTo("sub", "punch.closed");
  expect(told.length === 1 && told[0].title === "2 punch items were closed" && told[0].body.startsWith(`${a.item.number}, ${b.item.number}`) && told[0].link === `/punch?project=${P}`, JSON.stringify(told));
  expect(r.notified.bell === 2, `bulk notified ${JSON.stringify(r.notified)}`);
});

const runNotices = (type, input = {}) =>
  handler(input, { context: { tenantId: "TEN", roles: [] }, run: { invokedBy: { type } }, env: { CLIENT_ID: "id", CLIENT_SECRET: "secret" }, log: { error: (...a) => console.error("  [function error]", ...a), warn() {}, info() {} } });

await test("the 15-minute pass can't be started by a person", async () => {
  refused(await call("pm", { action: "notices" }), "BAD_ACTION", "pm asks for it");
  refused(await runNotices("http", { method: "POST", body: { action: "notices" } }), "BAD_ACTION", "an http call is a person's call");
});

await test("new and reassigned items: one notice per company every 15 minutes; flags cleared; never twice", async () => {
  for (const i of mine("PunchItem")) i.notifyPending = false;
  const a = await create("supt", { title: "Batch one" });
  const b = await create("supt", { title: "Batch two", dueDate: workingDaysAhead(3) });
  const c = await create("supt", { title: "Batch paint", assigneeCompanyId: "paint-co" });
  const gone = await create("supt", { title: "Closed before the run" });
  addPhoto(gone.item.ItemId, "after", "pm");
  ok(await call("pm", { action: "close", itemId: gone.item.ItemId }), "closed before the run");
  expect(row(a.item.ItemId).notifyPending === true && row(gone.item.ItemId).notifyPending === true, "queued");
  sent.length = 0;
  const dry = await runNotices("test", { action: "notices", dryRun: true });
  expect(dry.ok && dry.planned.some((p) => p.title === "2 new punch items for Dry Walls Ltd" && p.people === 2), `dry ${JSON.stringify(dry.planned)}`);
  expect(sent.length === 0 && row(a.item.ItemId).notifyPending === true, "dry run sends and writes nothing");
  const run = await runNotices("workflow");
  expect(run.ok && run.assigned === 3 && run.assignedNotices === 2 && run.cleared === 1 && !run.planned, JSON.stringify(run));
  const subs = bellsTo("sub", "punch.assigned");
  expect(subs.length === 1 && subs[0].title === "2 new punch items for Dry Walls Ltd" && subs[0].body.startsWith(`${a.item.number}, ${b.item.number}`), JSON.stringify(subs));
  expect(subs[0].link === `/punch?project=${P}&company=sub-co`, subs[0].link);
  expect(bellsTo("sub2", "punch.assigned").length === 1, "sub2 too (sub2 has email off)");
  const paint = bellsTo("other", "punch.assigned");
  expect(paint.length === 1 && paint[0].title === `New punch item ${c.item.number} for Paint & Co` && paint[0].link === `/punch/${c.item.ItemId}?project=${P}`, JSON.stringify(paint));
  expect(mailsTo("sub").length === 1 && mailsTo("other").length === 1 && mailsTo("sub2").length === 0, "emails");
  expect(mine("PunchItem").every((i) => i.notifyPending !== true), "all flags cleared");
  sent.length = 0;
  const again = await runNotices("workflow");
  expect(again.ok && again.assigned === 0 && sent.length === 0, `second run ${JSON.stringify(again)}`);
  ok(await call("supt", { action: "reassign", itemId: a.item.ItemId, assigneeCompanyId: "paint-co" }), "reassign to Paint & Co");
  await runNotices("workflow");
  expect(bellsTo("other", "punch.assigned").some((p) => p.title === `New punch item ${a.item.number} for Paint & Co`), "the new company hears about the reassigned item");
});

await test("the daily overdue digest: one per company, the PM copied, once a day; reminder emails respected", async () => {
  for (const i of mine("PunchItem")) if (["open", "inProgress"].includes(i.status)) Object.assign(i, { dueDate: dayPlus(30), overdueNoticeLastDate: "" });
  const late = mine("PunchItem").filter((i) => i.status === "open" && i.assigneeCompanyId === "sub-co" && !i.isVoided)[0];
  const latePaint = mine("PunchItem").filter((i) => ["open", "inProgress"].includes(i.status) && i.assigneeCompanyId === "paint-co" && !i.isVoided)[0];
  late.dueDate = dayPlus(-5);
  latePaint.dueDate = dayPlus(-2);
  const ready = mine("PunchItem").find((i) => i.status === "readyForReview");
  if (ready) ready.dueDate = dayPlus(-9);
  rows("NotificationPreference").push({ ItemId: "np-other", tenantRole: T, userId: "other", reminderEmails: false });
  sent.length = 0;
  const run = await runNotices("test", { action: "notices", anyTime: true });
  expect(run.ok && run.overdue === 2 && run.digests === 3, JSON.stringify(run));
  const s = bellsTo("sub", "punch.overdue");
  expect(s.length === 1 && s[0].title === "1 punch item overdue for Dry Walls Ltd" && s[0].body.startsWith(late.number), JSON.stringify(s));
  expect(s[0].link === `/punch?project=${P}&overdue=1&company=sub-co`, s[0].link);
  expect(bellsTo("other", "punch.overdue").length === 1 && mailsTo("other").length === 0, "reminder emails off: bell only");
  expect(mailsTo("sub").length === 1, "sub emailed");
  const pm = bellsTo("pm", "punch.digest");
  expect(pm.length === 1 && pm[0].title === "2 punch items overdue on PRJ-001" && pm[0].body === "Dry Walls Ltd: 1 · Paint & Co: 1", JSON.stringify(pm));
  expect(late.overdueNoticeLastDate === today, "marker written");
  sent.length = 0;
  const again = await runNotices("test", { action: "notices", anyTime: true });
  expect(again.overdue === 0 && sent.length === 0, "once a day");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
