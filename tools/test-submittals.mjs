// Local test of the submittals Function: runs functions/submittals/index.js against the same
// in-memory fake of the Blocks token, Data Gateway, Storage and logic endpoints as
// tools/test-punch.mjs, so who creates, sends, submits, forwards, returns, decides, re-opens,
// voids, comments on and distributes submittals is checked without touching any environment.
//   node tools/test-submittals.mjs
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
    const b = JSON.parse(init.body);
    if (String(url).includes("Notifier")) sent.push({ type: "bell", userIds: b.userIds, payload: JSON.parse(b.denormalizedPayload) });
    else if (String(url).includes("Mail")) sent.push({ type: "mail", to: b.to, subject: b.subjectDataContext.Subject, data: b.bodyDataContext });
    return json({ isSuccess: true });
  }
  if (String(url).includes("/data/v4/files/get-pre-signed-url-for-upload")) {
    const b = JSON.parse(init.body);
    const fileId = `file-${randomUUID().slice(0, 8)}`;
    files.push({ fileId, name: b.Name, props: b.AdditionalProperties, access: b.AccessModifier });
    return json({ isSuccess: true, data: { fileId, uploadUrl: `https://blob.test/${fileId}?sig=x` } });
  }
  if (String(url).includes("/data/v4/files/get-files")) {
    const b = JSON.parse(init.body);
    return json({ isSuccess: true, data: b.FileIds.filter((id) => files.some((f) => f.fileId === id)).map((id) => ({ fileId: id, url: `https://blob.test/${id}?read=1` })) });
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

const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "submittals", "index.js")).href);

// ---------- seed: the GC with one person per role, two subcontractors, two designers, the owner ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active", timezone: "Europe/Berlin", settings: { submittalReviewWorkingDays: 10 } });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Old", status: "archived", timezone: "Europe/Berlin" });
const people = {
  pm: { role: "project-manager", account: "staff", company: "gc", companyName: "West Build", joined: "2026-01-01" },
  supt: { role: "superintendent", account: "staff", company: "gc", companyName: "West Build", joined: "2026-01-02" },
  dc: { role: "document-controller", account: "staff", company: "gc", companyName: "West Build", joined: "2026-01-03" },
  sub: { role: "field-user", account: "external", company: "sub-co", companyName: "Dry Walls Ltd", trade: "Drywall", joined: "2026-02-01" },
  sub2: { role: "field-user", account: "external", company: "sub-co", companyName: "Dry Walls Ltd", trade: "Drywall", joined: "2026-03-01" },
  other: { role: "field-user", account: "external", company: "paint-co", companyName: "Paint & Co", trade: "Painting", joined: "2026-02-05" },
  design: { role: "design-reviewer", account: "external", company: "design-co", companyName: "Arch Studio", joined: "2026-01-05" },
  design2: { role: "design-reviewer", account: "external", company: "design-co", companyName: "Arch Studio", joined: "2026-01-07" },
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
// Another company's submittal with the same project id: never seen.
rows("Submittal").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, number: "SUB-999", title: "Not yours", status: "awaitingSubmission", responsibleCompanyId: "sub-co", seq: 999, version: 0 });

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
const row = (id) => mine("Submittal").find((x) => x.ItemId === id);
const events = (id) => mine("ActivityEvent").filter((e) => e.recordId === id);
const steps = (id) => mine("SubmittalReview").filter((e) => e.submittalId === id);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
const bellsTo = (u) => sent.filter((x) => x.type === "bell" && x.userIds.includes(u));
const mailsTo = (u) => sent.filter((x) => x.type === "mail" && x.to.includes(`${u}@test.example`));
const toldOnly = (wanted, what) => {
  const got = [...new Set(sent.filter((x) => x.type === "bell").flatMap((x) => x.userIds))].sort();
  expect(JSON.stringify(got) === JSON.stringify([...wanted].sort()), `${what}: bell went to ${got.join(", ") || "nobody"}, wanted ${wanted.join(", ")}`);
};

let rq = 0;
const create = (user, body = {}, projectId = P) =>
  call(user, {
    action: "create",
    clientRequestId: `rq-${++rq}`,
    title: "Steel doors, frames and hardware",
    specSection: "08 11 13",
    specSectionTitle: "Hollow metal doors",
    type: "shopDrawing",
    responsibleCompanyId: "sub-co",
    designReviewerUserId: "design",
    requiredOnSiteDate: "2027-03-15",
    leadTimeDays: 14,
    ...body
  }, projectId);

const pdf = { name: "C:\\fakepath\\doors rev 0.pdf", contentType: "application/pdf", sizeBytes: 300_000 };
const uploadsFor = async (user, id, list = [pdf], extra = {}) => {
  const r = await call(user, { action: "uploadLinks", submittalId: id, files: list, ...extra });
  ok(r, `${user} upload links`);
  return r.uploads.map(({ uploadUrl: _u, thumbnailUploadUrl: _t, ...a }) => a);
};
const act = (user, id, action, body = {}) => call(user, { action, submittalId: id, ...body });

console.log("submittals Function");
let first;
let draft;

await test("only the PM and the document controller create submittals", async () => {
  for (const u of ["supt", "sub", "design", "owner"]) refused(await create(u), "NOT_ALLOWED", u);
  refused(await create("stranger"), "NOT_ON_PROJECT", "not on the team");
  refused(await create("pm", {}, "p2"), "ARCHIVED", "archived project");
});

await test("the PM creates and sends SUB-001: waiting for the sub, ball with its first field user, GC check with the DC, submit-by worked out", async () => {
  sent.length = 0;
  const r = await create("pm", { internalNotes: "Long lead: chase weekly" });
  ok(r, "create");
  first = r.submittal.ItemId;
  expect(r.created === true && r.submittal.number === "SUB-001", `number ${r.submittal.number}`);
  expect(r.submittal.status === "awaitingSubmission" && r.submittal.revision === 0, r.submittal.status);
  expect(r.submittal.ballInCourtUserId === "sub" && r.submittal.ballInCourtRole === "sub", `ball ${r.submittal.ballInCourtUserId}`);
  expect(r.submittal.gcReviewerUserId === "dc" && r.submittal.designReviewerUserId === "design", "reviewers");
  // 15 Mar 2027 (Mon) - 14 calendar days = 1 Mar (Mon) - 3 + 10 working days = 10 Feb (Wed).
  expect(r.submittal.submitByDate === "2027-02-10", `submit by ${r.submittal.submitByDate}`);
  expect(r.submittal.dueDate === "2027-02-10", `due ${r.submittal.dueDate}`);
  expect(r.submittal.gcReviewDays === 3 && r.submittal.designReviewDays === 10, "default review days");
  expect(r.submittal.internalNotes === "Long lead: chase weekly", "the PM sees internal notes");
  expect(!("tenantRole" in r.submittal) && !("clientRequestId" in r.submittal), "internal fields hidden");
  expect(r.can.edit && r.can.void && r.can.submit && r.can.onBehalf && !r.can.forward, JSON.stringify(r.can));
  toldOnly(["sub", "sub2"], "sent");
  expect(mailsTo("sub").length === 1 && mailsTo("sub")[0].subject === "[PRJ-001] New submittal SUB-001 for Dry Walls Ltd", JSON.stringify(mailsTo("sub")));
  expect(events(first).some((e) => e.action === "created"), "history line");
});

await test("a retried create returns the same submittal and makes no second one", async () => {
  const body = { clientRequestId: "same-rq", title: "Paint colours", type: "sample", responsibleCompanyId: "paint-co" };
  const a = await create("dc", body);
  const b = await create("dc", body);
  ok(a, "first");
  ok(b, "retry");
  expect(b.created === false && b.submittal.ItemId === a.submittal.ItemId, "same submittal");
  expect(mine("Submittal").filter((x) => x.clientRequestId === "same-rq").length === 1, "one row");
  expect(a.submittal.number === "SUB-002", a.submittal.number);
});

await test("create checks title, spec section, type, dates, company, contact and reviewers", async () => {
  refused(await create("pm", { title: "ab" }), "BAD_TITLE", "short title");
  refused(await create("pm", { specSection: " " }), "BAD_SPEC_SECTION", "no spec section");
  refused(await create("pm", { type: "poster" }), "BAD_TYPE", "type");
  refused(await create("pm", { requiredOnSiteDate: "15.03.2027" }), "BAD_DATE", "date format");
  refused(await create("pm", { leadTimeDays: -1 }), "BAD_DAYS", "negative lead");
  refused(await create("pm", { leadTimeDays: undefined }), "BAD_DAYS", "no lead");
  refused(await create("pm", { gcReviewDays: 0 }), "BAD_DAYS", "zero GC days");
  refused(await create("pm", { responsibleCompanyId: "owner-co" }), "COMPANY_NOT_ON_PROJECT", "company without field users");
  refused(await create("pm", { responsibleCompanyId: "gc" }), "COMPANY_NOT_ON_PROJECT", "the GC itself");
  refused(await create("pm", { responsibleUserId: "other" }), "CONTACT_NOT_IN_COMPANY", "contact of another company");
  refused(await create("pm", { designReviewerUserId: "pm" }), "REVIEWER_NOT_ON_PROJECT", "the PM is not a design reviewer");
  refused(await create("pm", { gcReviewerUserId: "supt" }), "GC_REVIEWER_NOT_ALLOWED", "the superintendent does no GC check");
  refused(await create("pm", { clientRequestId: "" }), "BAD_REQUEST", "no request id");
  expect(mine("Submittal").length === 2, `nothing saved: ${mine("Submittal").length}`);
});

await test("a named contact gets the ball; a lead time ending on a weekend still lands on a working day", async () => {
  const r = await create("pm", { responsibleUserId: "sub2", requiredOnSiteDate: "2027-03-15", leadTimeDays: 15, gcReviewDays: 1, designReviewDays: 1, send: false });
  ok(r, "create");
  draft = r.submittal.ItemId;
  // 15 Mar - 15 = Sun 28 Feb, - 2 working days = Thu 25 Feb.
  expect(r.submittal.submitByDate === "2027-02-25", r.submittal.submitByDate);
  expect(r.submittal.status === "draft" && r.submittal.dueDate === "" && r.submittal.ballInCourtUserId === "dc", "a draft waits with the GC");
});

await test("drafts: only the PM and the DC see them; a sub sees only its company's; nobody sees another company's rows", async () => {
  const seen = async (u) => (await call(u, { action: "list" })).submittals.map((s) => s.number).sort().join(",");
  expect((await seen("pm")) === "SUB-001,SUB-002,SUB-003", await seen("pm"));
  expect((await seen("dc")) === "SUB-001,SUB-002,SUB-003", await seen("dc"));
  expect((await seen("supt")) === "SUB-001,SUB-002", await seen("supt"));
  expect((await seen("design")) === "SUB-001,SUB-002", await seen("design"));
  expect((await seen("owner")) === "SUB-001,SUB-002", await seen("owner"));
  expect((await seen("sub")) === "SUB-001", await seen("sub"));
  expect((await seen("other")) === "SUB-002", await seen("other"));
  refused(await act("other", first, "get"), "NOT_FOUND", "other company opens SUB-001");
  refused(await act("sub2", draft, "get"), "NOT_FOUND", "sub opens a draft");
  refused(await act("pm", "foreign", "get"), "NOT_FOUND", "another company's row");
  refused(await call("stranger", { action: "list" }), "NOT_ON_PROJECT", "stranger");
});

await test("internal notes go only to the PM, the superintendent and the DC; pickers only to managers", async () => {
  for (const u of ["pm", "supt", "dc"]) expect((await act(u, first, "get")).submittal.internalNotes === "Long lead: chase weekly", u);
  for (const u of ["sub", "design", "owner"]) expect(!("internalNotes" in (await act(u, first, "get")).submittal), u);
  const pm = await call("pm", { action: "list" });
  expect(pm.companies.map((c) => c.companyId).join(",") === "sub-co,paint-co" || pm.companies.map((c) => c.companyName).join(",") === "Dry Walls Ltd,Paint & Co", JSON.stringify(pm.companies));
  expect(pm.reviewers.map((x) => x.userId).sort().join(",") === "design,design2", JSON.stringify(pm.reviewers));
  expect(pm.gcReviewers.map((x) => x.userId).sort().join(",") === "dc,pm", JSON.stringify(pm.gcReviewers));
  expect(pm.defaults.gcReviewDays === 3 && pm.defaults.designReviewDays === 10 && pm.can.create, "defaults");
  const sub = await call("sub", { action: "list" });
  expect(!sub.companies.length && !sub.reviewers.length && !sub.can.create, "nothing to pick for a sub");
  refused(await call("design", { action: "create", clientRequestId: "x", title: "x", internalNotes: "x" }), "NOT_ALLOWED", "designer");
});

await test("the DC sends the draft: waiting for the named contact, due on submit-by, the sub's company told", async () => {
  refused(await act("sub", draft, "send"), "NOT_FOUND", "the sub can't even see the draft");
  sent.length = 0;
  const r = await act("dc", draft, "send");
  ok(r, "send");
  expect(r.submittal.status === "awaitingSubmission" && r.submittal.ballInCourtUserId === "sub2", `ball ${r.submittal.ballInCourtUserId}`);
  expect(r.submittal.dueDate === "2027-02-25", r.submittal.dueDate);
  toldOnly(["sub", "sub2"], "sent");
  refused(await act("dc", draft, "send"), "INVALID_TRANSITION", "sent twice");
});

await test("submit: only the sub's company (or the GC on behalf), at least one file, files signed by the uploader", async () => {
  refused(await act("other", first, "submit", { attachments: [] }), "NOT_FOUND", "another company");
  refused(await act("design", first, "submit", { attachments: [] }), "NOT_ALLOWED", "designer");
  refused(await act("sub", first, "submit", { attachments: [] }), "FILE_REQUIRED", "no files");
  const mineFiles = await uploadsFor("sub", first);
  refused(await act("sub2", first, "submit", { attachments: mineFiles }), "BAD_FILE_TICKET", "someone else's upload");
  refused(await act("sub", first, "submit", { attachments: [{ ...mineFiles[0], sizeBytes: 1 }] }), "BAD_FILE_TICKET", "changed size");
  refused(await act("sub", first, "submit", { attachments: mineFiles, version: 7 }), "STATE_CHANGED", "stale version");
  sent.length = 0;
  const r = await act("sub", first, "submit", { attachments: mineFiles, comment: "Rev 0 attached" });
  ok(r, "submit");
  expect(r.submittal.status === "inGcReview" && r.submittal.ballInCourtUserId === "dc" && r.submittal.ballInCourtRole === "gc", r.submittal.status);
  expect(r.submittal.dueDate === workingDaysAhead(3), `due ${r.submittal.dueDate}, wanted ${workingDaysAhead(3)}`);
  expect(r.submittal.files.length === 1 && r.submittal.files[0].fileName === "doors rev 0.pdf" && r.submittal.files[0].uploadedBy === "sub", JSON.stringify(r.submittal.files));
  expect(r.files[r.submittal.files[0].fileId]?.startsWith("https://blob.test/"), "download link");
  expect(r.steps.length === 1 && r.steps[0].stepType === "submit" && r.steps[0].outcome === "submitted" && r.steps[0].comment === "Rev 0 attached", JSON.stringify(r.steps));
  expect(steps(first)[0].dueDate === "2027-02-10", "the finished step keeps its own due date");
  toldOnly(["dc"], "submitted");
  expect(!r.can.submit && !r.can.forward, "the sub waits");
  expect(files.find((f) => f.fileId === r.submittal.files[0].fileId)?.props.record === "submittal", "stored as a submittal file");
});

await test("the GC returns it with a comment: back to the sub (same revision, files kept), 5 working days", async () => {
  refused(await act("sub", first, "returnToSub", { comment: "Missing" }), "NOT_ALLOWED", "the sub");
  refused(await act("supt", first, "returnToSub", { comment: "Missing" }), "NOT_ALLOWED", "the superintendent");
  refused(await act("dc", first, "returnToSub", { comment: " " }), "COMMENT_REQUIRED", "no comment");
  sent.length = 0;
  const r = await act("dc", first, "returnToSub", { comment: "Hardware schedule is missing" });
  ok(r, "return");
  expect(r.submittal.status === "awaitingSubmission" && r.submittal.revision === 0 && r.submittal.ballInCourtUserId === "sub", r.submittal.status);
  expect(r.submittal.dueDate === workingDaysAhead(5) && r.submittal.files.length === 1, `due ${r.submittal.dueDate}`);
  expect(r.steps.at(-1).outcome === "returnedIncomplete", r.steps.at(-1).outcome);
  toldOnly(["sub", "sub2"], "returned");
  expect(bellsTo("sub")[0].payload.body.includes("Hardware schedule is missing"), JSON.stringify(bellsTo("sub")[0].payload));
});

await test("the PM submits on the sub's behalf, keeping the file and adding one", async () => {
  const kept = row(first).files;
  const added = await uploadsFor("pm", first, [{ ...pdf, name: "hardware schedule.pdf" }]);
  const r = await act("pm", first, "submit", { attachments: [...kept.map((a) => ({ fileId: a.fileId })), ...added] });
  ok(r, "submit on behalf");
  expect(r.submittal.files.length === 2 && r.submittal.status === "inGcReview", `${r.submittal.files.length} files`);
  expect(events(first).some((e) => e.action === "submitted" && e.summary.includes("on behalf of Dry Walls Ltd")), "history says on behalf");
});

await test("the DC forwards it to the design reviewer: 10 working days, the reviewer told", async () => {
  refused(await act("sub", first, "forward"), "NOT_ALLOWED", "the sub");
  refused(await act("design", first, "forward"), "NOT_ALLOWED", "the designer");
  sent.length = 0;
  const r = await act("dc", first, "forward", { comment: "Complete now" });
  ok(r, "forward");
  expect(r.submittal.status === "inDesignReview" && r.submittal.ballInCourtUserId === "design" && r.submittal.ballInCourtRole === "reviewer", r.submittal.status);
  expect(r.submittal.dueDate === workingDaysAhead(10), `due ${r.submittal.dueDate}`);
  toldOnly(["design"], "forwarded");
  expect(mailsTo("design")[0]?.subject === "[PRJ-001] SUB-001 is with you for review", JSON.stringify(mailsTo("design")));
});

await test("decide: only the assigned reviewer (or the PM); markup required except Approved; comment for revise and reject", async () => {
  refused(await act("dc", first, "decide", { decision: "approved" }), "NOT_ALLOWED", "the DC");
  refused(await act("sub", first, "decide", { decision: "approved" }), "NOT_ALLOWED", "the sub");
  refused(await act("design2", first, "decide", { decision: "approved" }), "NOT_ALLOWED", "another designer");
  refused(await act("owner", first, "decide", { decision: "approved" }), "NOT_ALLOWED", "the owner");
  refused(await act("design", first, "decide", { decision: "maybe" }), "BAD_DECISION", "bad decision");
  refused(await act("design", first, "decide", { decision: "approvedAsNoted" }), "FILE_REQUIRED", "as noted without markup");
  const markup = await uploadsFor("design", first, [{ ...pdf, name: "markup.pdf" }]);
  refused(await act("design", first, "decide", { decision: "reviseResubmit", attachments: markup }), "COMMENT_REQUIRED", "revise without comment");
  expect(row(first).status === "inDesignReview", "nothing changed");
});

await test("Revise and resubmit opens rev 1 for the sub: package cleared, markup kept, company + DC emailed, superintendent bell only", async () => {
  const markup = await uploadsFor("design", first, [{ ...pdf, name: "markup.pdf" }]);
  sent.length = 0;
  const r = await act("design", first, "decide", { decision: "reviseResubmit", attachments: markup, comment: "Fire rating label missing" });
  ok(r, "decide");
  expect(r.submittal.status === "awaitingSubmission" && r.submittal.revision === 1 && r.submittal.decision === "reviseResubmit", `${r.submittal.status} rev ${r.submittal.revision}`);
  expect(r.submittal.files.length === 0 && r.submittal.decisionFiles.length === 1 && r.submittal.decisionComment === "Fire rating label missing", "files");
  expect(r.submittal.ballInCourtUserId === "sub" && r.submittal.dueDate === workingDaysAhead(5), `ball ${r.submittal.ballInCourtUserId}`);
  const rev0 = r.steps.filter((x) => x.revision === 0).map((x) => x.outcome).join(",");
  expect(rev0 === "submitted,returnedIncomplete,submitted,forwarded,reviseResubmit", rev0);
  expect(r.steps.find((x) => x.outcome === "submitted" && x.attachments.length === 2), "rev 0's package is kept on its step");
  toldOnly(["sub", "sub2", "dc", "supt"], "decided");
  expect(mailsTo("supt").length === 0 && mailsTo("dc").length === 1 && mailsTo("sub").length === 1, "superintendent: bell only");
  expect(mailsTo("sub")[0].subject === "[PRJ-001] SUB-001: Revise and resubmit", mailsTo("sub")[0].subject);
  expect(bellsTo("sub")[0].payload.body.includes("rev 1 is open"), bellsTo("sub")[0].payload.body);
});

async function round(user, id, decision, decider = "design", extra = {}) {
  ok(await act(user, id, "submit", { attachments: await uploadsFor(user, id) }), `${user} submits`);
  ok(await act("dc", id, "forward"), "forward");
  const markup = decision === "approved" ? [] : await uploadsFor(decider, id, [{ ...pdf, name: "markup.pdf" }]);
  return act(decider, id, "decide", { decision, attachments: markup, comment: "See markup", ...extra });
}

await test("Rejected closes it; only the PM or DC opens a new revision, with a reason", async () => {
  const r = await round("sub2", first, "rejected");
  ok(r, "reject");
  expect(r.submittal.status === "closed" && r.submittal.decision === "rejected" && r.submittal.ballInCourtRole === "none" && r.submittal.dueDate === "", r.submittal.status);
  expect(r.can.newRevision === false && r.can.void === false, "the designer can't reopen");
  refused(await act("sub", first, "newRevision", { reason: "Again" }), "NOT_ALLOWED", "the sub");
  refused(await act("dc", first, "newRevision", { reason: "" }), "COMMENT_REQUIRED", "no reason");
  sent.length = 0;
  const n = await act("dc", first, "newRevision", { reason: "Use the other manufacturer" });
  ok(n, "new revision");
  expect(n.submittal.status === "awaitingSubmission" && n.submittal.revision === 2 && n.submittal.files.length === 0, `rev ${n.submittal.revision}`);
  toldOnly(["sub", "sub2"], "new revision");
  refused(await act("dc", first, "newRevision", { reason: "Again please" }), "INVALID_TRANSITION", "not after a rejection");
});

await test("the PM decides Approved for the design team: no markup needed, closed, ball with nobody", async () => {
  const r = await round("sub", first, "approved", "pm", { comment: "" });
  ok(r, "approve");
  expect(r.submittal.status === "closed" && r.submittal.decision === "approved" && r.submittal.revision === 2, r.submittal.status);
  expect(r.submittal.decidedByUserId === "pm" && r.submittal.decisionFiles.length === 0, "decided by the PM");
  expect(events(first).some((e) => e.action === "decided" && e.summary.startsWith("PM for DESIGN decided SUB-001 rev 2: Approved")), events(first).map((e) => e.summary).join(" | "));
  expect(r.can.distribute && !r.can.edit && !r.can.void && !r.can.newRevision, JSON.stringify(r.can));
});

await test("distribute: managers send the decision to people who can open it", async () => {
  refused(await act("sub", first, "distribute", { userIds: ["owner"] }), "NOT_ALLOWED", "the sub");
  refused(await act("dc", draft, "distribute", { userIds: ["owner"] }), "INVALID_TRANSITION", "not decided yet");
  refused(await act("dc", first, "distribute", { userIds: [] }), "NO_RECIPIENTS", "nobody");
  refused(await act("dc", first, "distribute", { userIds: ["other"] }), "RECIPIENT_NOT_ALLOWED", "another company's sub");
  refused(await act("dc", first, "distribute", { userIds: ["stranger"] }), "RECIPIENT_NOT_ALLOWED", "not on the team");
  sent.length = 0;
  const r = await act("dc", first, "distribute", { userIds: ["owner", "supt", "owner"], note: "For your records" });
  ok(r, "distribute");
  expect(r.sentTo === 2, `${r.sentTo}`);
  toldOnly(["owner", "supt"], "distributed");
  expect(mailsTo("owner")[0]?.subject === "[PRJ-001] SUB-001: Approved", JSON.stringify(mailsTo("owner")));
  expect(events(first).some((e) => e.action === "distributed"), "history");
});

await test("comments: the team and the sub's own company, not the owner; empty refused", async () => {
  refused(await act("owner", first, "comment", { body: "Nice" }), "NOT_ALLOWED", "the owner");
  refused(await act("other", first, "comment", { body: "Hi" }), "NOT_FOUND", "another company");
  refused(await act("sub", first, "comment", { body: "  " }), "EMPTY_COMMENT", "empty");
  const r = await act("sub", first, "comment", { body: "Delivery booked for week 10" });
  ok(r, "comment");
  expect(r.comments.length === 1 && r.comments[0].authorName === "SUB", JSON.stringify(r.comments));
  ok(await act("design", first, "comment", { body: "Thanks" }), "designer");
});

await test("edit: dates move submit-by (and the first due date); the company only before submission; a new reviewer gets the ball and is told", async () => {
  refused(await act("supt", draft, "edit", { changes: { title: "New title" } }), "NOT_ALLOWED", "the superintendent");
  const r = await act("pm", draft, "edit", { changes: { requiredOnSiteDate: "2027-03-22" } });
  ok(r, "edit date");
  expect(r.submittal.submitByDate === "2027-03-04" && r.submittal.dueDate === "2027-03-04", `${r.submittal.submitByDate} / ${r.submittal.dueDate}`);
  expect(events(draft).some((e) => e.action === "edited" && e.beforeJson.includes("2027-03-15") && e.afterJson.includes("2027-03-22")), "before/after in history");
  const same = await act("pm", draft, "edit", { changes: { requiredOnSiteDate: "2027-03-22" } });
  expect(same.ok && events(draft).filter((e) => e.action === "edited").length === 1, "no change, no history line");
  ok(await act("sub2", draft, "submit", { attachments: await uploadsFor("sub2", draft) }), "submit");
  refused(await act("pm", draft, "edit", { changes: { responsibleCompanyId: "paint-co" } }), "INVALID_TRANSITION", "company after submission");
  ok(await act("dc", draft, "forward"), "forward");
  refused(await act("pm", draft, "edit", { changes: { designReviewerUserId: "owner" } }), "REVIEWER_NOT_ON_PROJECT", "owner as reviewer");
  sent.length = 0;
  const moved = await act("pm", draft, "edit", { changes: { designReviewerUserId: "design2" } });
  ok(moved, "reassign");
  expect(moved.submittal.ballInCourtUserId === "design2" && moved.submittal.designReviewerName === "DESIGN2", moved.submittal.ballInCourtUserId);
  toldOnly(["design2"], "reassigned");
  refused(await act("design", draft, "decide", { decision: "approved" }), "NOT_ALLOWED", "the old reviewer");
});

await test("void: the PM only, with a reason, from an open state; a voided draft tells nobody", async () => {
  refused(await act("dc", draft, "void", { reason: "Duplicate" }), "NOT_ALLOWED", "the DC");
  refused(await act("pm", draft, "void", { reason: "" }), "COMMENT_REQUIRED", "no reason");
  sent.length = 0;
  const r = await act("pm", draft, "void", { reason: "Covered by SUB-001" });
  ok(r, "void");
  expect(r.submittal.status === "void" && r.submittal.ballInCourtRole === "none" && r.submittal.voidReason === "Covered by SUB-001", r.submittal.status);
  toldOnly(["sub", "sub2", "design2"], "voided");
  expect(sent.every((x) => x.type === "bell"), "void: bell only");
  refused(await act("pm", draft, "void", { reason: "Again" }), "INVALID_TRANSITION", "twice");
  refused(await act("pm", first, "void", { reason: "Closed" }), "INVALID_TRANSITION", "a closed one");
  refused(await act("sub2", draft, "comment", { body: "Why?" }), "NOT_ALLOWED", "comment on void");
  const d = await create("pm", { send: false });
  sent.length = 0;
  ok(await act("pm", d.submittal.ItemId, "void", { reason: "Made by mistake" }), "void a draft");
  expect(sent.length === 0, "a draft's void tells nobody");
});

await test("overdue and submit-late flags come from today's date in the project's timezone", async () => {
  const r = await create("pm", { requiredOnSiteDate: "2020-01-15", leadTimeDays: 0 });
  ok(r, "create late");
  expect(r.submittal.submitLate === true && r.submittal.overdue === true, `late ${r.submittal.submitLate} overdue ${r.submittal.overdue}`);
  const list = await call("pm", { action: "list" });
  const closed = list.submittals.find((s) => s.ItemId === first);
  expect(closed.overdue === false && closed.submitLate === false, "a closed one is never overdue");
});

await test("upload links: only while it's your turn or to comment; never for another company or the owner", async () => {
  refused(await call("owner", { action: "uploadLinks", submittalId: first, files: [pdf] }), "NOT_ALLOWED", "owner");
  refused(await call("other", { action: "uploadLinks", submittalId: first, files: [pdf] }), "NOT_FOUND", "other company");
  refused(await call("sub", { action: "uploadLinks", submittalId: first, files: [{ ...pdf, name: "run.exe" }] }), "FILE_TYPE_NOT_ALLOWED", "exe");
  refused(await call("sub", { action: "uploadLinks", submittalId: first, files: [{ ...pdf, sizeBytes: 51 * 1024 * 1024 }] }), "FILE_TOO_LARGE", "51 MB");
  const links = await call("sub", { action: "fileLinks", submittalId: first });
  ok(links, "file links");
  expect(Object.keys(links.files).length >= 3 && links.linksExpireAt, `${Object.keys(links.files).length} links`);
});

await test("two people acting at once: the second gets STATE_CHANGED", async () => {
  const r = await create("pm");
  const id = r.submittal.ItemId;
  const up = await uploadsFor("sub", id);
  const real = globalThis.fetch;
  // Between the read and the write, someone else bumps the version.
  globalThis.fetch = async (url, init) => {
    if (String(init?.body ?? "").includes("updateSubmittal")) row(id).version = Number(row(id).version) + 1;
    return real(url, init);
  };
  try {
    refused(await act("sub", id, "submit", { attachments: up }), "STATE_CHANGED", "lost race");
  } finally {
    globalThis.fetch = real;
  }
  expect(row(id).status === "awaitingSubmission", "nothing changed");
});

await test("unknown actions are refused", async () => {
  refused(await call("pm", { action: "explode" }), "BAD_ACTION", "unknown");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
