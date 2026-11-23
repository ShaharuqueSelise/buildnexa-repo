// Local test of the documents Function: runs functions/documents/index.js against the same
// in-memory fake of the Blocks token, Data Gateway and Storage endpoints as tools/test-rfis.mjs,
// so folder rules, versions and trash are checked without touching any environment.
//   node tools/test-documents.mjs
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


const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "documents", "index.js")).href);

// ---------- seed: one company, two projects, one person per role ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active" });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Old", status: "archived" });
const people = {
  pm: { role: "project-manager", account: "staff" },
  supt: { role: "superintendent", account: "staff" },
  dc: { role: "document-controller", account: "staff" },
  sub: { role: "field-user", account: "external" },
  design: { role: "design-reviewer", account: "external" },
  owner: { role: "owner-viewer", account: "external" },
  admin: { role: null, account: "company-admin" }
};
for (const [userId, p] of Object.entries(people)) {
  if (!p.role) continue;
  for (const projectId of [P, "p2"]) {
    rows("ProjectMember").push({ ItemId: `${projectId}-${userId}`, tenantRole: T, projectId, userId, displayName: userId.toUpperCase(), companyId: "c", role: p.role, status: "active" });
  }
}
// Another company's file in the same project id must never show.
rows("Document").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, folderId: "x", name: "Not yours.pdf", trashed: false });

const call = (user, body) =>
  handler({ method: "POST", body: { projectId: P, ...body } }, {
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

const folders = {};
const folderNames = (r) => r.folders.map((f) => f.name);
// Uploads a file the way the browser does: links, (the PUT is skipped), then addFiles with the tickets.
async function upload(user, folder, name, sizeBytes = 2048, extra = {}) {
  const links = await call(user, { action: "uploadLinks", folderId: folders[folder], files: [{ name, contentType: "application/pdf", sizeBytes }] });
  if (!links.ok) return links;
  const { uploadUrl: _u, thumbnailUploadUrl: _t, ...a } = links.uploads[0];
  return call(user, { action: "addFiles", folderId: folders[folder], files: [a], ...extra });
}
const docNamed = (r, name) => r.documents.find((d) => d.name === name);

console.log("documents Function, local test");

await test("first open creates the seven standard folders; the PM sees all of them", async () => {
  const r = await call("pm", { action: "list" });
  ok(r, "pm list");
  expect(folderNames(r).join(",") === "Contracts,Specifications,Permits,Correspondence,Meeting minutes,Site,Handover", folderNames(r).join(","));
  for (const f of r.folders) folders[f.name] = f.ItemId;
  expect(r.can.manage && r.can.folderAccess && r.hiddenFolders === 0, "pm can");
  expect(!r.documents.some((d) => d.ItemId === "foreign"), "other company's file hidden");
  expect(rows("DocFolder").length === 7, "created once");
  ok(await call("dc", { action: "list" }), "dc list");
  expect(rows("DocFolder").length === 7, "a second open creates nothing");
});
await test("company admin not on the team gets nothing", async () => {
  refused(await call("admin", { action: "list" }), "NOT_ON_PROJECT", "admin");
});
await test("subcontractor sees only Site; superintendent and designer don't see Contracts; owner sees all", async () => {
  const sub = await call("sub", { action: "list" });
  expect(folderNames(sub).join(",") === "Site" && sub.hiddenFolders === 6, `sub ${folderNames(sub)}`);
  expect(!sub.folders[0].canUpload && !sub.can.manage, "sub can't upload");
  const supt = await call("supt", { action: "list" });
  expect(!folderNames(supt).includes("Contracts") && supt.folders.length === 6, `supt ${folderNames(supt)}`);
  const design = await call("design", { action: "list" });
  expect(!folderNames(design).includes("Contracts"), "design no contracts");
  const owner = await call("owner", { action: "list" });
  expect(owner.folders.length === 7 && owner.folders.every((f) => !f.canUpload), "owner reads all, uploads none");
});
await test("upload rules per folder (spec matrix)", async () => {
  ok(await upload("supt", "Site", "Site rules.pdf"), "supt into Site");
  ok(await upload("supt", "Correspondence", "Letter 01.pdf"), "supt into Correspondence");
  refused(await upload("supt", "Permits", "Permit.pdf"), "NOT_ALLOWED", "supt into Permits");
  ok(await upload("design", "Specifications", "Spec 03 30 00.pdf"), "design into Specs");
  refused(await upload("design", "Site", "x.pdf"), "NOT_ALLOWED", "design into Site");
  refused(await upload("sub", "Site", "x.pdf"), "NOT_ALLOWED", "sub into Site");
  refused(await upload("owner", "Contracts", "x.pdf"), "NOT_ALLOWED", "owner into Contracts");
  refused(await upload("supt", "Contracts", "x.pdf"), "NOT_FOUND", "supt can't even see Contracts");
  ok(await upload("pm", "Contracts", "Main contract.pdf"), "pm into Contracts");
  ok(await upload("dc", "Permits", "Building permit.pdf"), "dc into Permits");
});
await test("blocked and unlisted file types are refused, and files over 50 MB", async () => {
  refused(await upload("pm", "Site", "tool.exe"), "FILE_TYPE_NOT_ALLOWED", "exe");
  refused(await upload("pm", "Site", "page.html"), "FILE_TYPE_NOT_ALLOWED", "html");
  refused(await upload("pm", "Site", "model.ifc"), "FILE_TYPE_NOT_ALLOWED", "not on the list");
  refused(await upload("pm", "Site", "big.pdf", 51 * 1024 * 1024), "FILE_TOO_LARGE", "51 MB");
});
await test("a changed or someone else's ticket is refused", async () => {
  const links = await call("supt", { action: "uploadLinks", folderId: folders.Site, files: [{ name: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }] });
  const { uploadUrl: _u, ...a } = links.uploads[0];
  refused(await call("supt", { action: "addFiles", folderId: folders.Site, files: [{ ...a, sizeBytes: 5 }] }), "BAD_FILE_TICKET", "changed size");
  refused(await call("pm", { action: "addFiles", folderId: folders.Site, files: [a] }), "BAD_FILE_TICKET", "someone else's ticket");
});
await test("the same name in the same folder becomes version 2; versions newest first", async () => {
  const r = await upload("supt", "Site", "site rules.PDF", 4096, { note: "Gate 2 added" });
  ok(r, "second upload");
  const d = docNamed(r, "Site rules.pdf");
  expect(d && d.currentVersion === 2 && d.versions.length === 2 && d.versions[0].versionNo === 2 && d.versions[0].note === "Gate 2 added", JSON.stringify(d));
  expect(r.added[0].versionNo === 2, "added says v2");
  expect(r.documents.filter((x) => x.name.toLowerCase() === "site rules.pdf").length === 1, "still one file");
});
await test("sub sees Site files only; owner downloads a contract; others can't open it by id", async () => {
  const sub = await call("sub", { action: "list" });
  expect(sub.documents.length === 1 && sub.documents[0].name === "Site rules.pdf", sub.documents.map((d) => d.name).join(","));
  const pm = await call("pm", { action: "list" });
  const contract = docNamed(pm, "Main contract.pdf");
  refused(await call("sub", { action: "downloadLink", documentId: contract.ItemId }), "NOT_FOUND", "sub contract link");
  refused(await call("supt", { action: "downloadLink", documentId: contract.ItemId }), "NOT_FOUND", "supt contract link");
  const link = await call("owner", { action: "downloadLink", documentId: contract.ItemId });
  ok(link, "owner link");
  expect(/^https:\/\/blob\.test\//.test(link.url) && link.fileName === "Main contract.pdf", JSON.stringify(link));
  const site = docNamed(pm, "Site rules.pdf");
  const old = await call("sub", { action: "downloadLink", documentId: site.ItemId, versionNo: 1 });
  ok(old, "old version");
  expect(old.fileName === "Site rules_v1.pdf", old.fileName);
  // The list hands out the current version's link, so opening needs no second call.
  const listed = docNamed(pm, "Site rules.pdf");
  const cur = listed.versions.find((v) => v.versionNo === listed.currentVersion);
  expect(listed.url === `https://blob.test/${cur.fileId}?read=1` && Date.parse(pm.linksExpireAt) > Date.now(), `listed link ${listed.url}`);
  expect(sub.documents.every((d) => d.url), "sub gets links for what it sees");
});
await test("new version under another file name keeps the name; an older version can be made current", async () => {
  const pm = await call("pm", { action: "list" });
  const letter = docNamed(pm, "Letter 01.pdf");
  const links = await call("supt", { action: "uploadLinks", folderId: folders.Correspondence, files: [{ name: "Letter 01 signed.pdf", contentType: "application/pdf", sizeBytes: 900 }] });
  const { uploadUrl: _u, ...a } = links.uploads[0];
  let r = await call("supt", { action: "newVersion", documentId: letter.ItemId, file: a, note: "Signed" });
  ok(r, "new version");
  expect(docNamed(r, "Letter 01.pdf").currentVersion === 2, "v2 keeps the name");
  r = await call("supt", { action: "restoreVersion", documentId: letter.ItemId, versionNo: 1 });
  ok(r, "restore v1");
  const d = docNamed(r, "Letter 01.pdf");
  expect(d.currentVersion === 3 && d.versions[0].restoredFrom === 1 && d.versions[0].fileId === d.versions[2].fileId, JSON.stringify(d.versions));
  refused(await call("owner", { action: "restoreVersion", documentId: letter.ItemId, versionNo: 2 }), "NOT_ALLOWED", "owner restore");
});
await test("rename keeps the extension; clashes are refused; the designer can't rename in Site", async () => {
  const pm = await call("pm", { action: "list" });
  const site = docNamed(pm, "Site rules.pdf");
  refused(await call("design", { action: "rename", documentId: site.ItemId, name: "x" }), "NOT_ALLOWED", "design rename in Site");
  const r = await call("supt", { action: "rename", documentId: site.ItemId, name: "Site rules rev B.docx" });
  ok(r, "rename");
  expect(docNamed(r, "Site rules rev B.pdf"), "extension kept");
  ok(await upload("supt", "Site", "Logistics.pdf"), "another file");
  refused(await call("supt", { action: "rename", documentId: site.ItemId, name: "logistics" }), "NAME_TAKEN", "clash");
});
await test("move needs upload rights in both folders", async () => {
  const pm = await call("pm", { action: "list" });
  const logistics = docNamed(pm, "Logistics.pdf");
  refused(await call("supt", { action: "move", documentId: logistics.ItemId, folderId: folders.Permits }), "NOT_ALLOWED", "supt into Permits");
  const r = await call("supt", { action: "move", documentId: logistics.ItemId, folderId: folders.Correspondence });
  ok(r, "supt Site -> Correspondence");
  expect(docNamed(r, "Logistics.pdf").folderId === folders.Correspondence, "moved");
  const sub = await call("sub", { action: "list" });
  expect(!docNamed(sub, "Logistics.pdf"), "the sub no longer sees it");
});
await test("only PM and DC trash and restore; trash is shown to them only; nothing is deleted", async () => {
  const pm = await call("pm", { action: "list" });
  const permit = docNamed(pm, "Building permit.pdf");
  refused(await call("supt", { action: "trash", documentId: docNamed(pm, "Letter 01.pdf").ItemId }), "NOT_ALLOWED", "supt trash");
  let r = await call("dc", { action: "trash", documentId: permit.ItemId });
  ok(r, "dc trash");
  expect(docNamed(r, "Building permit.pdf").trashed === true, "trashed, still listed for managers");
  expect(!docNamed(r, "Building permit.pdf").url, "no link for a trashed file");
  const supt = await call("supt", { action: "list" });
  expect(!docNamed(supt, "Building permit.pdf"), "hidden from the superintendent");
  refused(await call("supt", { action: "downloadLink", documentId: permit.ItemId }), "NOT_FOUND", "supt link to trashed");
  ok(await upload("dc", "Permits", "Building permit.pdf"), "same name again while the first is in the trash");
  refused(await call("pm", { action: "restore", documentId: permit.ItemId }), "NAME_TAKEN", "restore clash");
  const fresh = (await call("pm", { action: "list" })).documents.find((d) => d.name === "Building permit.pdf" && !d.trashed);
  ok(await call("pm", { action: "rename", documentId: fresh.ItemId, name: "Building permit 2" }), "rename the new one");
  r = await call("pm", { action: "restore", documentId: permit.ItemId });
  ok(r, "restore");
  expect(r.documents.find((d) => d.ItemId === permit.ItemId).trashed === false, "restored");
  expect(rows("Document").filter((d) => d.tenantRole === T && d.projectId === P).length === 7, "all 7 files kept");
});
await test("folders: managers create, only the PM changes who sees and uploads", async () => {
  refused(await call("supt", { action: "createFolder", name: "Commissioning", viewRoles: [], uploadRoles: [] }), "NOT_ALLOWED", "supt create");
  refused(await call("dc", { action: "createFolder", name: "site", viewRoles: [], uploadRoles: [] }), "NAME_TAKEN", "duplicate name");
  refused(await call("dc", { action: "createFolder", name: "A/B", viewRoles: [], uploadRoles: [] }), "BAD_NAME", "slash");
  refused(await call("dc", { action: "createFolder", name: "Commissioning", viewRoles: ["owner-viewer"], uploadRoles: ["owner-viewer"] }), "BAD_ROLES", "owner uploads");
  refused(await call("dc", { action: "createFolder", name: "Commissioning", viewRoles: [], uploadRoles: ["superintendent"] }), "BAD_ROLES", "uploads without view");
  let r = await call("dc", { action: "createFolder", name: "Commissioning", viewRoles: ["superintendent"], uploadRoles: ["superintendent"] });
  ok(r, "dc create");
  const f = r.folders.find((x) => x.ItemId === r.folderId);
  expect(f && f.viewRoles.join(",") === "project-manager,superintendent,document-controller" && f.name === "Commissioning", JSON.stringify(f));
  refused(await call("dc", { action: "setFolderAccess", folderId: folders.Site, viewRoles: [], uploadRoles: [] }), "NOT_ALLOWED", "dc access");
  r = await call("pm", { action: "setFolderAccess", folderId: folders.Permits, viewRoles: ["superintendent", "field-user"], uploadRoles: ["field-user"] });
  ok(r, "pm opens Permits to subs");
  const sub = await call("sub", { action: "list" });
  expect(folderNames(sub).join(",") === "Permits,Site" && sub.folders[0].canUpload, `sub ${folderNames(sub)}`);
  const owner = await call("owner", { action: "list" });
  expect(!folderNames(owner).includes("Permits"), "owner lost Permits");
});
await test("archived project: read-only, nothing created", async () => {
  const r = await call("pm", { action: "list", projectId: "p2" });
  ok(r, "list archived");
  expect(r.folders.length === 0 && !r.can.manage, "nothing created on an archived project");
  refused(await call("pm", { action: "createFolder", projectId: "p2", name: "X", viewRoles: [], uploadRoles: [] }), "ARCHIVED", "write archived");
});
await test("two first opens at once: duplicates fold into one folder set", async () => {
  rows("Project").push({ ItemId: "p3", tenantRole: T, number: "PRJ-003", name: "Race", status: "active" });
  rows("ProjectMember").push({ ItemId: "p3-pm", tenantRole: T, projectId: "p3", userId: "pm", displayName: "PM", role: "project-manager", status: "active" });
  const [a, b] = await Promise.all([call("pm", { action: "list", projectId: "p3" }), call("pm", { action: "list", projectId: "p3" })]);
  ok(a, "a");
  ok(b, "b");
  const c = await call("pm", { action: "list", projectId: "p3" });
  expect(c.folders.length === 7, `${c.folders.length} folders`);
  // A file put into whichever copy an answer gave lands in a shown folder.
  for (const first of [a, b]) {
    const site = first.folders.find((f) => f.key === "site");
    const links = await call("pm", { action: "uploadLinks", projectId: "p3", folderId: site.ItemId, files: [{ name: `r${first === a ? 1 : 2}.pdf`, contentType: "application/pdf", sizeBytes: 3 }] });
    ok(links, "links into either copy");
    const { uploadUrl: _u, ...x } = links.uploads[0];
    ok(await call("pm", { action: "addFiles", projectId: "p3", folderId: site.ItemId, files: [x] }), "add");
  }
  const after = await call("pm", { action: "list", projectId: "p3" });
  expect(after.documents.length === 2 && after.documents.every((d) => c.folders.some((f) => f.ItemId === d.folderId && f.key === "site")), "both in the shown Site");
});
await test("activity history is written for each change", async () => {
  const acts = rows("ActivityEvent").map((e) => e.action);
  for (const a of ["uploaded", "version", "version restored", "renamed", "moved", "trashed", "restored", "folder created", "folder access changed"]) expect(acts.includes(a), `missing ${a}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
