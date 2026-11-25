// Local test of the drawings Function: runs functions/drawings/index.js against the same in-memory
// fake of the Blocks token, Data Gateway and Storage endpoints as tools/test-photos.mjs, so who
// publishes, revises, voids and pins drawings is checked without touching any environment.
//   node tools/test-drawings.mjs
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
const rows = (schema) => (store[schema] ??= []);
const sent = [];
const files = [];
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
  // Storage: every file the service asks for gets an id and a fake upload link.
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
    // Like the real gateway, answer only the fields the query asks for (top level; a nested
    // selection such as attachments { … } returns the whole value).
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


const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "drawings", "index.js")).href);

// ---------- seed: the GC company with one person per role; the subcontractor works for "sub-co" ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active", timezone: "Europe/Berlin" });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Old", status: "archived" });
const people = {
  pm: { role: "project-manager", account: "staff", company: "gc" },
  supt: { role: "superintendent", account: "staff", company: "gc" },
  dc: { role: "document-controller", account: "staff", company: "gc" },
  sub: { role: "field-user", account: "external", company: "sub-co" },
  design: { role: "design-reviewer", account: "external", company: "design-co" },
  owner: { role: "owner-viewer", account: "external", company: "owner-co" },
  admin: { role: null, account: "company-admin", company: "gc" }
};
for (const [userId, p] of Object.entries(people)) {
  if (!p.role) continue;
  for (const projectId of [P, "p2"]) {
    rows("ProjectMember").push({ ItemId: `${projectId}-${userId}`, tenantRole: T, projectId, userId, displayName: userId.toUpperCase(), email: `${userId}@test.example`, companyId: p.company, role: p.role, status: "active" });
  }
}
// Email turned off for the owner.
rows("NotificationPreference").push({ ItemId: "pref-owner", tenantRole: T, userId: "owner", emailEnabled: false });
// RFIs: one the subcontractor is involved in, one they are not, a draft, and a voided one.
rows("Rfi").push(
  { ItemId: "rfi-sub", tenantRole: T, projectId: P, number: "RFI-001", subject: "Anchor bolts", status: "open", createdByUserId: "supt", createdByCompanyId: "gc", ballInCourtUserId: "sub", ballInCourtName: "SUB", assigneeUserIds: ["sub"], distributionUserIds: [] },
  { ItemId: "rfi-gc", tenantRole: T, projectId: P, number: "RFI-002", subject: "Pump spec", status: "answered", createdByUserId: "pm", createdByCompanyId: "gc", ballInCourtUserId: "design", ballInCourtName: "DESIGN", assigneeUserIds: ["design"], distributionUserIds: [] },
  { ItemId: "rfi-draft", tenantRole: T, projectId: P, number: "", subject: "Draft", status: "draft", createdByUserId: "supt", createdByCompanyId: "gc", assigneeUserIds: [], distributionUserIds: [] },
  { ItemId: "rfi-void", tenantRole: T, projectId: P, number: "RFI-003", subject: "Voided", status: "open", isVoided: true, createdByUserId: "pm", createdByCompanyId: "gc", assigneeUserIds: [], distributionUserIds: [] }
);
// Punch items: one for the subcontractor's company, one for another company, a closed and a voided one.
rows("PunchItem").push(
  { ItemId: "pi-sub", tenantRole: T, projectId: P, number: "PI-001", title: "Paint run", status: "open", assigneeCompanyId: "sub-co", assigneeCompanyName: "Sub Co", ballInCourtName: "SUB", createdByUserId: "supt", dueDate: "2026-12-04" },
  { ItemId: "pi-other", tenantRole: T, projectId: P, number: "PI-002", title: "Loose tile", status: "inProgress", assigneeCompanyId: "other-co", assigneeCompanyName: "Other Co", createdByUserId: "pm" },
  { ItemId: "pi-closed", tenantRole: T, projectId: P, number: "PI-003", title: "Done", status: "closed", assigneeCompanyId: "sub-co", createdByUserId: "pm" },
  { ItemId: "pi-void", tenantRole: T, projectId: P, number: "PI-004", title: "Wrong", status: "void", isVoided: true, assigneeCompanyId: "sub-co", createdByUserId: "pm" }
);
// Another company's sheet with the same project id must never show.
rows("Sheet").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, sheetNumber: "X-999", sheetNumberKey: "X-999", sortKey: "X-000999", title: "Not yours", isVoided: false, currentRevisionIndex: 1 });

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
const sheetBy = (n) => mine("Sheet").find((s) => s.sheetNumber === n && !s.isVoided);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// Publishes sheets the way the browser does: upload links (PDF + thumbnail), the PUTs are skipped, then publish.
async function publish(user, list, { sizeBytes = 8_000_000, thumb = true, tamper, projectId = P, name } = {}) {
  const files = list.map((x) => ({ name: name ?? x.fileName ?? `${x.sheetNumber}.pdf`, sizeBytes, ...(thumb ? { thumb: { contentType: "image/png", sizeBytes: 60_000 } } : {}) }));
  const links = await call(user, { action: "uploadLinks", files }, projectId);
  if (!links.ok) return links;
  const sheets = links.uploads.map(({ uploadUrl: _u, thumbUploadUrl: _t, ...a }, i) => ({
    ...a,
    title: "Ground floor plan",
    discipline: "Architectural",
    setName: "Issued for Construction",
    revisionLabel: "0",
    issuedDate: today,
    pageWidthPt: 3370,
    pageHeightPt: 2384,
    ...list[i],
    ...(tamper ?? {})
  }));
  return call(user, { action: "publish", sheets }, projectId);
}
const bells = (kind) => sent.filter((s) => s.type === "bell" && s.payload.kind === kind);

console.log("drawings Function, local test");

await test("company admin not on the team gets nothing; what each role may do", async () => {
  refused(await call("admin", { action: "list" }), "NOT_ON_PROJECT", "admin");
  const r = await call("pm", { action: "list" });
  ok(r, "pm list");
  expect(r.sheets.length === 0, "foreign sheet hidden");
  expect(r.disciplines.some((d) => d.name === "Architectural"), "default disciplines");
  const want = {
    pm: "upload manage pin createRfi createPunch",
    dc: "upload manage",
    design: "upload",
    supt: "pin createRfi createPunch",
    sub: "pin createRfi",
    owner: ""
  };
  for (const [u, w] of Object.entries(want)) {
    const x = await call(u, { action: "list" });
    ok(x, `${u} list`);
    const got = Object.entries(x.can).filter(([, v]) => v).map(([k]) => k).join(" ");
    expect(got === w, `${u} can: ${got} (want ${w})`);
  }
});

await test("publish: new sheets with thumbnails; the team gets a bell, no email for new sheets", async () => {
  sent.length = 0;
  const r = await publish("pm", [{ sheetNumber: "A-101" }, { sheetNumber: "s-201", title: "Foundation plan", discipline: "structural", revisionLabel: "a" }]);
  ok(r, "pm publishes two");
  expect(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const a = sheetBy("A-101");
  const s = sheetBy("s-201");
  expect(a && a.currentRevisionIndex === 1 && a.currentRevisionLabel === "0" && a.currentFileId && a.currentThumbFileId, JSON.stringify(a));
  expect(s.sheetNumberKey === "S-201" && s.sortKey === "S-000201" && s.discipline === "Structural" && s.currentRevisionLabel === "A", JSON.stringify(s));
  const list = await call("owner", { action: "list" });
  expect(list.sheets.map((x) => x.sheetNumber).join(",") === "A-101,s-201", "sorted register");
  expect(list.sheets.every((x) => x.current?.thumbUrl && x.current.status === "current"), "thumbnails with the register");
  const b = bells("drawing.revision_published");
  expect(b.length === 1 && b[0].userIds.length === 5 && !b[0].userIds.includes("pm"), `bell ${JSON.stringify(b)}`);
  expect(b[0].payload.title === "2 drawing revisions issued", b[0].payload.title);
  expect(!sent.some((x) => x.type === "mail"), "no email for new sheets");
});

await test("publish refusals: roles, files, tickets, fields", async () => {
  refused(await publish("owner", [{ sheetNumber: "A-102" }]), "NOT_ALLOWED", "owner");
  refused(await publish("supt", [{ sheetNumber: "A-102" }]), "NOT_ALLOWED", "supt");
  refused(await publish("sub", [{ sheetNumber: "A-102" }]), "NOT_ALLOWED", "sub");
  refused(await publish("pm", [{ sheetNumber: "A-102" }], { name: "plan.dwg" }), "FILE_TYPE_NOT_ALLOWED", "dwg");
  refused(await publish("pm", [{ sheetNumber: "A-102" }], { sizeBytes: 51 * 1024 * 1024 }), "FILE_TOO_LARGE", "51 MB");
  refused(await publish("pm", "abcdefghijk".split("").map((x) => ({ sheetNumber: `A-1${x}` }))), "TOO_MANY_FILES", "11 at once");
  refused(await publish("pm", [{ sheetNumber: "A-102" }], { projectId: "p2" }), "ARCHIVED", "archived");
  refused(await publish("pm", [{ sheetNumber: "A-102" }], { tamper: { sizeBytes: 1 } }), "BAD_FILE_TICKET", "tampered ticket");
  refused(await publish("pm", [{ sheetNumber: "A-102" }, { sheetNumber: "a-102 " }]), "SAME_SHEET_TWICE", "same sheet twice");
  refused(await publish("pm", [{ sheetNumber: "A-102", discipline: "Plumbing art" }]), "BAD_DISCIPLINE", "discipline");
  refused(await publish("pm", [{ sheetNumber: "A-102", issuedDate: "2999-01-01" }]), "BAD_DATE", "future date");
  refused(await publish("pm", [{ sheetNumber: "A-102", pageWidthPt: 0 }]), "BAD_PAGE", "no page size");
  refused(await publish("pm", [{ sheetNumber: "<b>" }]), "BAD_SHEET_NUMBER", "sheet number");
  refused(await publish("pm", [{ sheetNumber: "A-102", revisionLabel: "" }]), "BAD_REVISION", "label");
  expect(!sheetBy("A-102"), "nothing written");
});

await test("revision: supersedes the old one, emails the team, designer can't rename, labels unique, retry safe", async () => {
  sent.length = 0;
  const r = await publish("design", [{ sheetNumber: "A-101", title: "Renamed by designer", revisionLabel: "A", note: "Pump room moved" }]);
  ok(r, "designer publishes rev A");
  const a = sheetBy("A-101");
  expect(a.currentRevisionIndex === 2 && a.currentRevisionLabel === "A" && a.title === "Ground floor plan", JSON.stringify(a));
  const revs = mine("SheetRevision").filter((x) => x.sheetId === a.ItemId).sort((x, y) => x.revisionIndex - y.revisionIndex);
  expect(revs.map((x) => `${x.revisionLabel}:${x.status}`).join(",") === "0:superseded,A:current", revs.map((x) => `${x.revisionLabel}:${x.status}`).join(","));
  const mails = sent.filter((x) => x.type === "mail");
  expect(mails.length === 4 && !mails.some((m) => m.to[0].startsWith("owner") || m.to[0].startsWith("design")), `mails ${mails.map((m) => m.to[0])}`);
  expect(mails[0].subject === "[PRJ-001] A-101 revised to rev A", mails[0].subject);
  const dup = await publish("pm", [{ sheetNumber: "a-101", revisionLabel: "a" }]);
  ok(dup, "call itself is ok");
  expect(dup.results[0].ok === false && dup.results[0].code === "DUPLICATE_LABEL", JSON.stringify(dup.results));
  // A retry of the same upload (lost answer) is not a second revision.
  const links = await call("pm", { action: "uploadLinks", files: [{ name: "A-101.pdf", sizeBytes: 1000 }] });
  const once = { ...links.uploads[0], sheetNumber: "A-101", title: "Ground floor plan", discipline: "Architectural", revisionLabel: "B", pageWidthPt: 3370, pageHeightPt: 2384 };
  delete once.uploadUrl;
  ok(await call("pm", { action: "publish", sheets: [once] }), "rev B");
  const again = await call("pm", { action: "publish", sheets: [once] });
  expect(again.results[0].ok && again.results[0].repeated, "repeated");
  expect(sheetBy("A-101").currentRevisionIndex === 3, "still rev 3");
  // void rev B again so the pin tests start from rev A
  ok(await call("pm", { action: "voidRevision", revisionId: again.results[0].revisionId, reason: "test" }), "void B");
  expect(sheetBy("A-101").currentRevisionLabel === "A" && sheetBy("A-101").currentRevisionIndex === 2, "A current again");
});

let a101;
let supPin;
let subPin;
await test("pins: on the current revision only, for records the person can open; subs see only theirs", async () => {
  a101 = sheetBy("A-101");
  const at = { sheetId: a101.ItemId, revisionIndex: 2, recordType: "rfi" };
  const r = await call("supt", { action: "pin", ...at, x: 0.4, y: 0.5, recordId: "rfi-gc" });
  ok(r, "supt pins RFI-002");
  supPin = r.pin;
  expect(supPin.number === "RFI-002" && supPin.fromRevisionIndex === 2 && supPin.canMove, JSON.stringify(supPin));
  refused(await call("supt", { action: "pin", ...at, revisionIndex: 1, x: 0.1, y: 0.1, recordId: "rfi-sub" }), "NOT_CURRENT", "old revision");
  refused(await call("supt", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "rfi-gc" }), "ALREADY_PINNED", "twice");
  refused(await call("supt", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "rfi-draft" }), "NOT_FOUND", "draft");
  refused(await call("supt", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "rfi-void" }), "NOT_FOUND", "voided");
  refused(await call("supt", { action: "pin", ...at, x: 1.5, y: 0.1, recordId: "rfi-sub" }), "BAD_POINT", "off the sheet");
  refused(await call("owner", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "rfi-sub" }), "NOT_ALLOWED", "owner");
  refused(await call("dc", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "rfi-sub" }), "NOT_ALLOWED", "dc");
  refused(await call("sub", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "rfi-gc" }), "NOT_FOUND", "sub on an RFI they can't open");
  const s = await call("sub", { action: "pin", ...at, x: 0.7, y: 0.3, recordId: "rfi-sub" });
  ok(s, "sub pins RFI-001");
  subPin = s.pin;
  const forSub = await call("sub", { action: "sheet", sheetId: a101.ItemId });
  ok(forSub, "sub opens the sheet");
  expect(forSub.pins.map((p) => p.number).join(",") === "RFI-001" && forSub.hiddenPins === 1, `sub pins ${forSub.pins.map((p) => p.number)} hidden ${forSub.hiddenPins}`);
  expect(forSub.revisions.every((x) => x.pdfUrl) && forSub.revisions.length === 2, "pdf links, void revision hidden from the sub");
  expect(forSub.rfis.map((x) => x.number).join(",") === "RFI-001", `sub pinnable ${forSub.rfis.map((x) => x.number)}`);
  const forPm = await call("pm", { action: "sheet", sheetId: a101.ItemId });
  expect(forPm.pins.length === 2 && forPm.hiddenPins === 0 && forPm.revisions.length === 3, `pm ${forPm.pins.length} pins, ${forPm.revisions.length} revisions`);
  expect(forPm.sheet.pins === 2, `open pins ${forPm.sheet.pins}`);
  const reg = await call("sub", { action: "list" });
  const row = reg.sheets.find((x) => x.sheetNumber === "A-101");
  expect(row.pins === 1 && row.hiddenPins === 1, `register for sub ${row.pins}/${row.hiddenPins}`);
});

await test("a new revision carries the pins and tells the RFI's ball holder to check them", async () => {
  sent.length = 0;
  ok(await publish("dc", [{ sheetNumber: "A-101", revisionLabel: "C", pageWidthPt: 2384, pageHeightPt: 3370 }]), "dc publishes rev C");
  const forPm = await call("pm", { action: "sheet", sheetId: a101.ItemId });
  const cur = forPm.sheet.current.revisionIndex;
  expect(cur === 4, `current index ${cur}`);
  expect(forPm.pins.every((p) => p.fromRevisionIndex <= cur && !p.toRevisionIndex), "both pins still on the current revision");
  const told = bells("drawing.pinned_sheet_revised");
  expect(told.map((b) => b.userIds[0]).sort().join(",") === "design,sub", `told ${told.map((b) => b.userIds)}`);
});

await test("moving a pin keeps it on the older revisions; only the placer or a manager moves or removes it", async () => {
  refused(await call("sub", { action: "movePin", pinId: supPin.ItemId, revisionIndex: 4, x: 0.2, y: 0.2 }), "NOT_FOUND", "sub can't see supt's pin");
  refused(await call("supt", { action: "movePin", pinId: supPin.ItemId, revisionIndex: 2, x: 0.2, y: 0.2 }), "NOT_CURRENT", "old revision");
  const m = await call("supt", { action: "movePin", pinId: supPin.ItemId, revisionIndex: 4, x: 0.25, y: 0.35 });
  ok(m, "supt moves");
  expect(m.replacedPinId === supPin.ItemId && m.pin.fromRevisionIndex === 4 && m.pin.x === 0.25, JSON.stringify(m));
  const old = mine("Pin").find((p) => p.ItemId === supPin.ItemId);
  expect(old.toRevisionIndex === 3 && old.x === 0.4, `old row ${old.toRevisionIndex} ${old.x}`);
  const again = await call("supt", { action: "movePin", pinId: m.pin.ItemId, revisionIndex: 4, x: 0.3, y: 0.35 });
  expect(again.ok && !again.replacedPinId && again.pin.x === 0.3, "moved in place on the same revision");
  ok(await call("sub", { action: "removePin", pinId: subPin.ItemId }), "sub removes own");
  refused(await call("design", { action: "removePin", pinId: m.pin.ItemId }), "NOT_ALLOWED", "designer");
  ok(await call("dc", { action: "removePin", pinId: m.pin.ItemId }), "dc removes any");
  const forPm = await call("pm", { action: "sheet", sheetId: a101.ItemId });
  expect(forPm.pins.length === 1 && forPm.pins[0].toRevisionIndex === 3, `left: the old placement only (${forPm.pins.length})`);
});

await test("punch pins: existing active items, one live pin each; subs see their company's; history on the item", async () => {
  const at = { sheetId: a101.ItemId, revisionIndex: 4, recordType: "punchItem" };
  const forPm = await call("pm", { action: "sheet", sheetId: a101.ItemId });
  expect(forPm.punchItems.map((i) => i.number).join(",") === "PI-002,PI-001", `pinnable ${forPm.punchItems.map((i) => i.number)}`);
  const r = await call("supt", { action: "pin", ...at, x: 0.6, y: 0.6, recordId: "pi-sub" });
  ok(r, "supt pins PI-001");
  expect(r.pin.type === "punchItem" && r.pin.number === "PI-001" && r.pin.companyName === "Sub Co" && r.pin.canMove, JSON.stringify(r.pin));
  refused(await call("supt", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "pi-sub" }), "ALREADY_PINNED", "one live pin per item");
  refused(await call("supt", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "pi-closed" }), "NOT_ACTIVE", "closed item");
  refused(await call("supt", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "pi-void" }), "NOT_FOUND", "voided item");
  refused(await call("sub", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "pi-other" }), "NOT_FOUND", "sub on another company's item");
  refused(await call("owner", { action: "pin", ...at, x: 0.1, y: 0.1, recordId: "pi-other" }), "NOT_ALLOWED", "owner");
  const o = await call("pm", { action: "pin", ...at, x: 0.2, y: 0.8, recordId: "pi-other" });
  ok(o, "pm pins PI-002");
  const forSub = await call("sub", { action: "sheet", sheetId: a101.ItemId });
  const subPunch = forSub.pins.filter((p) => p.type === "punchItem").map((p) => p.number).join(",");
  expect(subPunch === "PI-001" && forSub.hiddenPins >= 1, `sub sees ${subPunch}, hidden ${forSub.hiddenPins}`);
  expect(forSub.punchItems.length === 0, "nothing left for the sub to pin");
  expect(!forSub.can.createPunch, "subs don't create punch items");
  expect(mine("ActivityEvent").some((e) => e.recordType === "punchItem" && e.recordId === "pi-sub" && e.action === "pinned"), "item history: pinned");
  refused(await call("supt", { action: "removePin", pinId: o.pin.ItemId }), "NOT_ALLOWED", "supt removes the PM's pin");
  ok(await call("pm", { action: "removePin", pinId: o.pin.ItemId }), "pm removes own");
  expect(mine("ActivityEvent").some((e) => e.recordType === "punchItem" && e.recordId === "pi-other" && e.action === "unpinned"), "item history: unpinned");
  const after = await call("pm", { action: "sheet", sheetId: a101.ItemId });
  expect(after.punchItems.map((i) => i.number).join(",") === "PI-002", `pinnable again ${after.punchItems.map((i) => i.number)}`);
  expect(after.pins.some((p) => p.number === "PI-001") && !after.pins.some((p) => p.number === "PI-002"), "PI-001 stays, PI-002 gone");
  const m = await call("supt", { action: "movePin", pinId: r.pin.ItemId, revisionIndex: 4, x: 0.65, y: 0.6 });
  ok(m, "supt moves own punch pin");
  expect(mine("ActivityEvent").some((e) => e.recordType === "punchItem" && e.recordId === "pi-sub" && e.action === "pinMoved"), "item history: moved");
  const reg = await call("pm", { action: "list" });
  expect(reg.sheets.find((x) => x.sheetNumber === "A-101").pins === 1, "register counts the punch pin (the RFI pins were removed)");
});

await test("void: managers only, with a reason; the previous revision is current again; last one removes the sheet", async () => {
  const forPm = await call("pm", { action: "sheet", sheetId: a101.ItemId });
  const c = forPm.revisions.find((x) => x.revisionLabel === "C");
  refused(await call("design", { action: "voidRevision", revisionId: c.ItemId, reason: "x" }), "NOT_ALLOWED", "designer");
  refused(await call("pm", { action: "voidRevision", revisionId: c.ItemId, reason: " " }), "NO_REASON", "no reason");
  const v = await call("dc", { action: "voidRevision", revisionId: c.ItemId, reason: "Uploaded to the wrong sheet" });
  ok(v, "dc voids C");
  expect(v.sheet.current.revisionLabel === "A" && v.revisions.find((x) => x.revisionLabel === "C").status === "void", "A current again");
  expect(v.revisions.find((x) => x.revisionLabel === "C").voidReason === "Uploaded to the wrong sheet", "reason kept");
  const s = sheetBy("s-201");
  const [only] = mine("SheetRevision").filter((x) => x.sheetId === s.ItemId);
  const gone = await call("pm", { action: "voidRevision", revisionId: only.ItemId, reason: "Wrong project" });
  expect(gone.ok && gone.sheetRemoved, JSON.stringify(gone));
  const list = await call("pm", { action: "list" });
  expect(list.sheets.map((x) => x.sheetNumber).join(",") === "A-101", "removed sheet left the register");
  refused(await call("sub", { action: "sheet", sheetId: s.ItemId }), "NOT_FOUND", "sub can't open the removed sheet");
});

await test("sheet details: managers only, version checked, numbers unique", async () => {
  const a = sheetBy("A-101");
  refused(await call("design", { action: "updateSheet", sheetId: a.ItemId, version: a.version, title: "x" }), "NOT_ALLOWED", "designer");
  refused(await call("pm", { action: "updateSheet", sheetId: a.ItemId, version: a.version - 1, title: "x" }), "STATE_CHANGED", "stale version");
  ok(await publish("pm", [{ sheetNumber: "A-102", title: "First floor plan" }]), "A-102");
  refused(await call("pm", { action: "updateSheet", sheetId: a.ItemId, version: sheetBy("A-101").version, sheetNumber: "a-102" }), "SHEET_NUMBER_TAKEN", "taken");
  const r = await call("pm", { action: "updateSheet", sheetId: a.ItemId, version: sheetBy("A-101").version, title: "Ground floor plan, tank area", setName: "Bulletin 03" });
  ok(r, "pm edits");
  expect(r.sheet.title === "Ground floor plan, tank area" && r.sheet.setName === "Bulletin 03", JSON.stringify(r.sheet));
  expect(mine("ActivityEvent").some((e) => e.recordType === "sheet" && e.action === "edited"), "history");
});

await test("a new revision also tells who holds the ball on a pinned punch item; closed items stay quiet", async () => {
  const pi = mine("PunchItem").find((i) => i.ItemId === "pi-other");
  Object.assign(pi, { status: "readyForReview", ballInCourtUserId: "supt", ballInCourtName: "SUPT" });
  const s = sheetBy("A-102");
  const at = { sheetId: s.ItemId, revisionIndex: s.currentRevisionIndex, recordType: "punchItem" };
  ok(await call("pm", { action: "pin", ...at, x: 0.3, y: 0.3, recordId: "pi-other" }), "pm pins PI-002 on A-102");
  sent.length = 0;
  ok(await publish("dc", [{ sheetNumber: "A-102", revisionLabel: "A" }]), "dc publishes A-102 rev A");
  const told = bells("drawing.pinned_sheet_revised");
  expect(told.length === 1 && told[0].userIds.join(",") === "supt", `told ${JSON.stringify(told.map((b) => b.userIds))}`);
  expect(told[0].payload.body === "Check that PI-002 on A-102 still points at the right spot.", told[0].payload.body);
  Object.assign(pi, { status: "closed" });
  sent.length = 0;
  ok(await publish("dc", [{ sheetNumber: "A-102", revisionLabel: "B" }]), "rev B");
  expect(bells("drawing.pinned_sheet_revised").length === 0, "a closed item's pin tells nobody");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
