// Local test of the rfis Function: runs functions/rfis/index.js against an in-memory fake of the
// Blocks token and Data Gateway endpoints, so permissions and status changes are checked without
// touching any environment.   node tools/test-rfis.mjs
//
// The fake understands what the shared client sends: get<Schema>s with a JSON equality filter,
// insert<Schema>, and update<Schema> with { field: { eq } } where clauses. Bell (Notifier) and
// email (Mail) sends are recorded in `sent` instead of going anywhere.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
const rows = (schema) => (store[schema] ??= []);
const sent = [];
let failSends = 0;

globalThis.fetch = async (url, init) => {
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (String(url).includes("/oidc/token")) return json({ access_token: "test-token" });
  if (String(url).includes("/logic/v4/Notifier/Notify") || String(url).includes("/logic/v4/Mail/Send")) {
    if (failSends > 0) {
      failSends -= 1;
      return { ok: false, status: 500, json: async () => ({ isSuccess: false, errors: { server: "down" } }) };
    }
    const b = JSON.parse(init.body);
    if (String(url).includes("Notifier")) sent.push({ type: "bell", userIds: b.userIds, config: b.configurationName, payload: JSON.parse(b.denormalizedPayload) });
    else sent.push({ type: "mail", to: b.to, template: b.purpose, language: b.language, subject: b.subjectDataContext.Subject, data: b.bodyDataContext });
    return json({ isSuccess: true });
  }
  const { query, variables } = JSON.parse(init.body);
  let m;
  if ((m = /\{\s*get(\w+)s\(/.exec(query))) {
    const filter = JSON.parse(variables.input.filter ?? "{}");
    // Like the real gateway, answer only the fields the query asks for.
    const wanted = /items\s*\{([^}]*)\}/.exec(query)[1].trim().split(/\s+/);
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

const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "rfis", "index.js")).href);

// ---------- seed: one company, one project, one person per role ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active", timezone: "Europe/Berlin" });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Other", status: "archived", timezone: "Europe/Berlin" });
const people = {
  pm: { role: "project-manager", company: "west", account: "staff" },
  supt: { role: "superintendent", company: "west", account: "staff" },
  dc: { role: "document-controller", company: "west", account: "staff" },
  sub: { role: "field-user", company: "braun", account: "external" },
  subMate: { role: "field-user", company: "braun", account: "external" },
  sub2: { role: "field-user", company: "other", account: "external" },
  design: { role: "design-reviewer", company: "nordplan", account: "external" },
  owner: { role: "owner-viewer", company: "hafen", account: "external" },
  admin: { role: null, company: "west", account: "company-admin" }
};
for (const [userId, p] of Object.entries(people)) {
  if (!p.role) continue;
  rows("ProjectMember").push({ ItemId: `pm-${userId}`, tenantRole: T, projectId: P, userId, displayName: userId.toUpperCase(), email: `${userId}@test.local`, companyId: p.company, companyName: p.company, role: p.role, status: "active" });
  rows("ProjectMember").push({ ItemId: `pm2-${userId}`, tenantRole: T, projectId: "p2", userId, displayName: userId.toUpperCase(), companyId: p.company, role: p.role, status: "active" });
}
// Someone in another company must never be visible.
rows("Rfi").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, status: "open", subject: "Not yours", createdByUserId: "x" });

const call = (user, body) =>
  handler({ method: "POST", body: { projectId: P, ...body } }, {
    context: { tenantId: "TEN", userId: user, organizationId: "ORG", roles: [T, people[user].account] },
    env: { CLIENT_ID: "id", CLIENT_SECRET: "secret" },
    log: { error: (...a) => console.error("  [function error]", ...a), warn() {}, info() {} }
  });

// ---------- tiny test runner ----------
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
const DUE = "2030-01-07"; // a Monday
const base = { subject: "Duct clash at grid C/5", question: "Which beam size?", dueDate: DUE, assigneeUserIds: ["design"], distributionUserIds: ["owner"] };
let n = 0;
const create = (user, extra = {}) => call(user, { action: "create", clientRequestId: `req-${++n}`, submit: true, ...base, ...extra });
const numbers = (r) => r.rfis.map((x) => x.number).filter(Boolean).sort();

const ids = {};

console.log("rfis Function, local test");

await test("company admin not on the team gets no RFIs", async () => {
  refused(await call("admin", { action: "list" }), "NOT_ON_PROJECT", "admin list");
});
await test("owner can't raise an RFI", async () => {
  refused(await create("owner"), "NOT_ALLOWED", "owner create");
});
await test("designer can't raise an RFI", async () => {
  refused(await create("design"), "NOT_ALLOWED", "design create");
});
await test("subcontractor can't send cost impact or internal notes", async () => {
  refused(await create("sub", { costImpact: "yes" }), "FORBIDDEN_FIELD", "sub cost");
  refused(await create("sub", { internalNote: "secret" }), "FORBIDDEN_FIELD", "sub internal note");
});
await test("submit needs an assignee, a question and a future due date", async () => {
  refused(await create("supt", { assigneeUserIds: [] }), "NO_ASSIGNEE", "no assignee");
  refused(await create("supt", { question: "" }), "BAD_QUESTION", "no question");
  refused(await create("supt", { dueDate: "2020-01-01" }), "DUE_DATE_IN_PAST", "past due");
  refused(await create("supt", { assigneeUserIds: ["owner"] }), "ASSIGNEE_NOT_ALLOWED", "owner as assignee");
  refused(await create("supt", { assigneeUserIds: ["nobody"] }), "ASSIGNEE_NOT_MEMBER", "stranger as assignee");
});
await test("a draft has no number and is seen only by its creator and the PM", async () => {
  const r = await create("supt", { submit: false, costImpact: "yes", internalNote: "check budget" });
  ok(r, "draft create");
  ids.draft = r.rfi.ItemId;
  expect(r.rfi.status === "draft" && r.rfi.number === "", `draft: status ${r.rfi.status} number "${r.rfi.number}"`);
  expect(r.rfi.ballInCourtUserId === "supt", "draft ball should be with the creator");
  expect((await call("pm", { action: "list" })).rfis.some((x) => x.ItemId === ids.draft), "PM should see the draft");
  expect(!(await call("design", { action: "list" })).rfis.some((x) => x.ItemId === ids.draft), "designer must not see the draft");
  expect(!(await call("dc", { action: "list" })).rfis.some((x) => x.ItemId === ids.draft), "DC must not see someone else's draft");
});
await test("submitting the draft numbers it RFI-001 and passes the ball to the first assignee", async () => {
  const r = await call("supt", { action: "submit", rfiId: ids.draft });
  ok(r, "submit");
  expect(r.rfi.number === "RFI-001" && r.rfi.status === "open", `got ${r.rfi.number} ${r.rfi.status}`);
  expect(r.rfi.ballInCourtUserId === "design" && r.rfi.ballInCourtRole === "assignee", `ball ${r.rfi.ballInCourtUserId}/${r.rfi.ballInCourtRole}`);
  expect(r.rfi.managerUserId === "pm", `manager ${r.rfi.managerUserId}`);
});
await test("a GC RFI submitted directly gets RFI-002; a subcontractor's goes to the manager first", async () => {
  const a = await create("dc");
  ok(a, "dc create");
  ids.dc = a.rfi.ItemId;
  expect(a.rfi.number === "RFI-002", `dc got ${a.rfi.number}`);
  const b = await create("sub", { distributionUserIds: [] });
  ok(b, "sub create");
  ids.sub = b.rfi.ItemId;
  expect(b.rfi.number === "RFI-003" && b.rfi.ballInCourtUserId === "pm" && b.rfi.ballInCourtRole === "manager", `sub RFI ${b.rfi.number} ball ${b.rfi.ballInCourtUserId}`);
});
await test("subcontractors see their own and their company's RFIs, not other trades'", async () => {
  expect(JSON.stringify(numbers(await call("sub", { action: "list" }))) === '["RFI-003"]', "sub list");
  expect(JSON.stringify(numbers(await call("subMate", { action: "list" }))) === '["RFI-003"]', "colleague from the same company sees it");
  expect(numbers(await call("sub2", { action: "list" })).length === 0, "another trade sees nothing");
  refused(await call("sub2", { action: "get", rfiId: ids.sub }), "NOT_FOUND", "another trade opening it directly");
});
await test("another company's RFI never appears", async () => {
  expect(!(await call("pm", { action: "list" })).rfis.some((x) => x.ItemId === "foreign"), "foreign row leaked");
});
await test("cost fields and internal notes are removed for roles that may not see them", async () => {
  const d = (await call("design", { action: "get", rfiId: ids.draft })).rfi;
  expect(d.costImpact === undefined && d.internalNote === undefined, "designer sees cost or internal note");
  const o = (await call("owner", { action: "get", rfiId: ids.draft })).rfi;
  expect(o.costImpact === "yes" && o.internalNote === undefined, `owner: cost ${o.costImpact} note ${o.internalNote}`);
  const p = (await call("pm", { action: "get", rfiId: ids.draft })).rfi;
  expect(p.internalNote === "check budget", "PM should see the internal note");
});
await test("owner and an unassigned subcontractor can't respond", async () => {
  refused(await call("owner", { action: "respond", rfiId: ids.draft, body: "hi" }), "NOT_ALLOWED_TO_RESPOND", "owner respond");
  refused(await call("sub2", { action: "respond", rfiId: ids.draft, body: "hi" }), "NOT_FOUND", "sub2 respond");
});
await test("the designer answers: the ball goes to the manager, status stays open", async () => {
  const r = await call("design", { action: "respond", rfiId: ids.draft, body: "Use HEB 300." });
  ok(r, "respond");
  ids.response = r.responses[0].ItemId;
  expect(r.rfi.status === "open" && r.rfi.ballInCourtUserId === "pm" && r.rfi.responseCount === 1, `status ${r.rfi.status} ball ${r.rfi.ballInCourtUserId} count ${r.rfi.responseCount}`);
});
await test("close needs an official answer", async () => {
  refused(await call("pm", { action: "close", rfiId: ids.draft }), "NOT_ALLOWED", "close while open");
});
await test("a designer can't mark someone else's response official", async () => {
  const pmReply = await call("pm", { action: "respond", rfiId: ids.draft, body: "Checking with the engineer." });
  ok(pmReply, "pm respond");
  const other = pmReply.responses.find((x) => x.authorUserId === "pm").ItemId;
  refused(await call("design", { action: "markOfficial", rfiId: ids.draft, responseId: other }), "OFFICIAL_NOT_ALLOWED", "design marks PM's");
});
await test("the designer marks their own answer official: answered, ball to the manager", async () => {
  const r = await call("design", { action: "markOfficial", rfiId: ids.draft, responseId: ids.response });
  ok(r, "mark official");
  expect(r.rfi.status === "answered" && r.rfi.officialResponseId === ids.response && r.rfi.officialAnswerText === "Use HEB 300.", `status ${r.rfi.status}`);
  expect(r.responses.filter((x) => x.isOfficial).length === 1, "exactly one official response");
});
await test("the PM asks again (needs a reason), then the designer answers officially in one step", async () => {
  refused(await call("pm", { action: "askAgain", rfiId: ids.draft }), "REASON_REQUIRED", "ask again without reason");
  const a = await call("pm", { action: "askAgain", rfiId: ids.draft, reason: "Need the connection detail too" });
  ok(a, "ask again");
  expect(a.rfi.status === "open" && a.rfi.ballInCourtUserId === "design" && !a.rfi.officialResponseId, "after ask again");
  expect(a.responses.every((x) => !x.isOfficial), "official flag cleared");
  const b = await call("design", { action: "respond", rfiId: ids.draft, body: "HEB 300 with end plate.", asOfficial: true });
  ok(b, "respond as official");
  expect(b.rfi.status === "answered" && b.rfi.officialAnswerText === "HEB 300 with end plate.", `status ${b.rfi.status}`);
});
await test("the creator (Superintendent) closes their answered RFI; a double click is harmless", async () => {
  const r = await call("supt", { action: "close", rfiId: ids.draft });
  ok(r, "close");
  expect(r.rfi.status === "closed" && r.rfi.ballInCourtRole === "none", `status ${r.rfi.status}`);
  ok(await call("supt", { action: "close", rfiId: ids.draft }), "second close");
});
await test("only the PM reopens, with a reason", async () => {
  refused(await call("supt", { action: "reopen", rfiId: ids.draft, reason: "x" }), "NOT_ALLOWED", "supt reopen");
  refused(await call("pm", { action: "reopen", rfiId: ids.draft }), "REASON_REQUIRED", "reopen without reason");
  const r = await call("pm", { action: "reopen", rfiId: ids.draft, reason: "Detail missing on site" });
  ok(r, "reopen");
  expect(r.rfi.status === "open" && !r.rfi.officialResponseId && r.rfi.ballInCourtUserId === "design", "after reopen");
});
await test("void: creator only for drafts; a submitted RFI only by the PM, with a reason", async () => {
  refused(await call("dc", { action: "void", rfiId: ids.dc, reason: "dup" }), "NOT_ALLOWED", "dc voids own submitted RFI");
  const d = await create("dc", { submit: false });
  ok(await call("dc", { action: "void", rfiId: d.rfi.ItemId, reason: "Mistake" }), "dc voids own draft");
  const r = await call("pm", { action: "void", rfiId: ids.dc, reason: "Duplicate of RFI-001" });
  ok(r, "pm void");
  expect(r.rfi.status === "void" && r.rfi.isVoided === true, "after void");
  refused(await call("pm", { action: "respond", rfiId: ids.dc, body: "x" }), "NOT_ALLOWED_TO_RESPOND", "respond on void");
});
await test("edit: designer can't; PM can; weekend due date moves to Monday", async () => {
  refused(await call("design", { action: "edit", rfiId: ids.sub, changes: { subject: "Changed" } }), "NOT_ALLOWED", "design edit");
  const r = await call("pm", { action: "edit", rfiId: ids.sub, changes: { dueDate: "2030-01-05", assigneeUserIds: ["design"] } });
  ok(r, "pm edit");
  expect(r.rfi.dueDate === "2030-01-07", `due ${r.rfi.dueDate}`);
});
await test("reassign: PM passes the ball; an owner can't receive it", async () => {
  refused(await call("pm", { action: "reassign", rfiId: ids.sub, toUserId: "owner" }), "ASSIGNEE_NOT_ALLOWED", "to owner");
  refused(await call("sub", { action: "reassign", rfiId: ids.sub, toUserId: "design" }), "NOT_ALLOWED", "sub reassign");
  const r = await call("pm", { action: "reassign", rfiId: ids.sub, toUserId: "design", note: "Please answer" });
  ok(r, "reassign");
  expect(r.rfi.ballInCourtUserId === "design", "ball moved");
});
await test("the subcontractor assigned the ball can now respond", async () => {
  const r = await call("pm", { action: "reassign", rfiId: ids.sub, toUserId: "sub2" });
  ok(r, "to sub2");
  ok(await call("sub2", { action: "respond", rfiId: ids.sub, body: "On it" }), "sub2 responds when holding the ball");
});
await test("a subcontractor who answered still sees the RFI after the ball moves on", async () => {
  const r = await call("pm", { action: "reassign", rfiId: ids.sub, toUserId: "design" });
  ok(r, "ball away from sub2");
  expect(numbers(await call("sub2", { action: "list" })).includes("RFI-003"), "sub2 lost the RFI they answered");
  ok(await call("sub2", { action: "get", rfiId: ids.sub }), "sub2 opens it directly");
  refused(await call("sub2", { action: "respond", rfiId: ids.sub, body: "again" }), "NOT_ALLOWED_TO_RESPOND", "sub2 responds without the ball");
});
await test("a retried create returns the same RFI", async () => {
  const a = await call("supt", { action: "create", clientRequestId: "same", submit: true, ...base });
  const b = await call("supt", { action: "create", clientRequestId: "same", submit: true, ...base });
  ok(a, "first");
  ok(b, "second");
  expect(a.rfi.ItemId === b.rfi.ItemId && b.created === false, "retry created a second RFI");
});
await test("two changes at the same moment: one wins, the other is told to reload", async () => {
  const [a, b] = await Promise.all([
    call("pm", { action: "reassign", rfiId: ids.sub, toUserId: "dc" }),
    call("pm", { action: "reassign", rfiId: ids.sub, toUserId: "supt" })
  ]);
  const codes = [a, b].map((x) => (x.ok ? "ok" : x.code)).sort().join(",");
  expect(codes === "STATE_CHANGED,ok" || codes === "ok,ok", `got ${codes}`);
  const row = rows("Rfi").find((x) => x.ItemId === ids.sub);
  expect(codes === "ok,ok" ? true : ["dc", "supt"].includes(row.ballInCourtUserId), "ball holder");
});
await test("10 RFIs submitted at once get 10 different numbers in a row", async () => {
  const before = numbers(await call("pm", { action: "list" })).length;
  const results = await Promise.all(Array.from({ length: 10 }, () => create("supt")));
  results.forEach((r, i) => ok(r, `create ${i}`));
  const got = results.map((r) => r.rfi.seq).sort((x, y) => x - y);
  const first = before + 1;
  expect(JSON.stringify(got) === JSON.stringify(Array.from({ length: 10 }, (_, i) => first + i)), `numbers ${got.join(",")}`);
});
await test("history records every step and shows no cost figures", async () => {
  const r = await call("design", { action: "get", rfiId: ids.draft });
  const actions = r.history.map((h) => h.action);
  for (const a of ["draftCreated", "submitted", "responded", "officialAnswer", "askedAgain", "answeredOfficially", "closed", "reopened"]) expect(actions.includes(a), `missing ${a}`);
  expect(!JSON.stringify(r.history).includes("check budget"), "internal note leaked into history");
});
await test("an archived project is read-only", async () => {
  refused(await call("pm", { action: "create", projectId: "p2", clientRequestId: "z", submit: true, ...base }), "ARCHIVED", "create on archived");
});

// ---------- telling people (Part 2) ----------
const bellsTo = (u) => sent.filter((x) => x.type === "bell" && x.userIds.includes(u)).map((x) => x.payload);
const mailsTo = (u) => sent.filter((x) => x.type === "mail" && x.to.includes(`${u}@test.local`));
const nt = {};
await test("raising an RFI: the assignee gets bell + email, the distribution list the bell only, the raiser nothing", async () => {
  sent.length = 0;
  const r = await create("supt", { costImpact: "yes", costImpactAmount: 12500, internalNote: "secret margin note", distributionUserIds: ["owner", "pm"] });
  ok(r, "create");
  nt.id = r.rfi.ItemId;
  const num = r.rfi.number;
  expect(bellsTo("design").some((p) => p.title === `${num} needs your answer` && p.link === `/rfis/${nt.id}?project=${P}` && p.kind === "rfi.turn"), `design bell: ${JSON.stringify(bellsTo("design"))}`);
  expect(mailsTo("design").length === 1 && mailsTo("design")[0].template === "BuildnexaNotice" && mailsTo("design")[0].language === "en-US", "design email");
  expect(mailsTo("design")[0].subject === `[PRJ-001] ${num} needs your answer`, `subject ${mailsTo("design")[0].subject}`);
  expect(mailsTo("design")[0].data.ButtonUrl.endsWith(`/rfis/${nt.id}?project=${P}`), "email link");
  expect(bellsTo("owner").some((p) => p.title === `${num} was raised`) && mailsTo("owner").length === 0, "owner: bell only");
  expect(bellsTo("pm").length === 1 && mailsTo("pm").length === 0, "pm on the distribution list: bell only");
  expect(bellsTo("supt").length === 0 && mailsTo("supt").length === 0, "the raiser got a notice");
  expect(sent.every((x) => x.type !== "bell" || x.config === "cpm-inbox"), "configuration");
  expect(r.notified && r.notified.bell === 3 && r.notified.email === 1 && r.notified.failed.length === 0, `notified ${JSON.stringify(r.notified)}`);
});
await test("notices never carry cost figures or internal notes", async () => {
  const all = JSON.stringify(sent);
  expect(!all.includes("12500") && !all.includes("12,500") && !all.includes("secret margin note"), "cost or internal note in a notice");
});
await test("a draft tells nobody; voiding a draft tells nobody", async () => {
  sent.length = 0;
  const d = await create("dc", { submit: false });
  ok(await call("dc", { action: "void", rfiId: d.rfi.ItemId, reason: "Mistake" }), "void draft");
  expect(sent.length === 0, `sent ${sent.length}`);
});
await test("the designer answers officially: manager to review (bell + email), creator told (bell + email), list told (bell)", async () => {
  sent.length = 0;
  const r = await call("design", { action: "respond", rfiId: nt.id, body: "Use HEB 300.", asOfficial: true });
  ok(r, "answer");
  const num = r.rfi.number;
  expect(bellsTo("pm").some((p) => p.title === `${num} was answered: please review and close`) && mailsTo("pm").length === 1, `pm: ${JSON.stringify(bellsTo("pm"))}`);
  expect(bellsTo("supt").some((p) => p.title === `Your ${num} was answered` && p.kind === "rfi.decided") && mailsTo("supt").length === 1, "creator told");
  expect(bellsTo("owner").some((p) => p.title === `${num} was answered`) && mailsTo("owner").length === 0, "owner bell only");
  expect(bellsTo("design").length === 0, "the answerer got a notice");
});
await test("each person gets one notice per change", async () => {
  const counts = {};
  for (const x of sent.filter((y) => y.type === "bell")) for (const u of x.userIds) counts[u] = (counts[u] ?? 0) + 1;
  expect(Object.values(counts).every((v) => v === 1), `counts ${JSON.stringify(counts)}`);
});
await test("closing: the creator is told by email; assignees and the list in the bell", async () => {
  sent.length = 0;
  ok(await call("pm", { action: "close", rfiId: nt.id }), "close");
  expect(mailsTo("supt").length === 1 && bellsTo("supt").some((p) => p.title.startsWith("Your ")), "creator");
  expect(bellsTo("design").length === 1 && mailsTo("design").length === 0, "assignee bell only");
  expect(bellsTo("pm").length === 0, "the closer got a notice");
});
await test("someone who turned email off still gets the bell", async () => {
  rows("NotificationPreference").push({ ItemId: "np-pm", tenantRole: T, userId: "pm", emailEnabled: false });
  sent.length = 0;
  const r = await create("dc", { distributionUserIds: [] });
  ok(r, "create");
  ok(await call("design", { action: "respond", rfiId: r.rfi.ItemId, body: "See detail 4." }), "design responds");
  expect(bellsTo("pm").some((p) => p.title.endsWith("is waiting for you")), `pm bell: ${JSON.stringify(bellsTo("pm"))}`);
  expect(mailsTo("pm").length === 0, "pm got an email although it is off");
  rows("NotificationPreference").length = 0;
});
await test("passing the ball tells the new holder with the note; a response that leaves the ball tells the holder (bell)", async () => {
  sent.length = 0;
  const r = await create("supt", { distributionUserIds: [] });
  ok(await call("pm", { action: "reassign", rfiId: r.rfi.ItemId, toUserId: "dc", note: "Check the spec" }), "pass");
  expect(bellsTo("dc").some((p) => p.title.endsWith("needs your answer") && p.body.includes("Check the spec")) && mailsTo("dc").length === 1, "dc told with note");
  sent.length = 0;
  ok(await call("pm", { action: "respond", rfiId: r.rfi.ItemId, body: "Adding a sketch." }), "pm responds");
  expect(bellsTo("dc").some((p) => p.title.startsWith("New response on")) && mailsTo("dc").length === 0, `dc: ${JSON.stringify(sent)}`);
});
await test("a send that fails never fails the change", async () => {
  sent.length = 0;
  failSends = 10;
  const r = await create("supt", { distributionUserIds: ["owner"] });
  failSends = 0;
  ok(r, "create still works");
  expect(r.notified.failed.length > 0 && r.notified.bell === 0, `notified ${JSON.stringify(r.notified)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
