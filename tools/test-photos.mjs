// Local test of the photos Function: runs functions/photos/index.js against the same in-memory
// fake of the Blocks token, Data Gateway and Storage endpoints as tools/test-documents.mjs, so who
// sees, adds, tags and removes photos is checked without touching any environment.
//   node tools/test-photos.mjs
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



// ---------- seed: one company, two projects, one person per role ----------

const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "photos", "index.js")).href);

// ---------- seed: the GC company with one person per role; the subcontractor works for "sub-co" ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active" });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Old", status: "archived" });
const people = {
  pm: { role: "project-manager", account: "staff", company: "gc" },
  supt: { role: "superintendent", account: "staff", company: "gc" },
  dc: { role: "document-controller", account: "staff", company: "gc" },
  sub: { role: "field-user", account: "external", company: "sub-co" },
  sub2: { role: "field-user", account: "external", company: "other-sub" },
  design: { role: "design-reviewer", account: "external", company: "design-co" },
  owner: { role: "owner-viewer", account: "external", company: "owner-co" },
  admin: { role: null, account: "company-admin", company: "gc" }
};
for (const [userId, p] of Object.entries(people)) {
  if (!p.role) continue;
  for (const projectId of [P, "p2"]) {
    rows("ProjectMember").push({ ItemId: `${projectId}-${userId}`, tenantRole: T, projectId, userId, displayName: userId.toUpperCase(), companyId: p.company, role: p.role, status: "active" });
  }
}
// RFIs: one the subcontractor is involved in, one they are not, a draft, and a voided one.
rows("Rfi").push(
  { ItemId: "rfi-sub", tenantRole: T, projectId: P, number: "RFI-001", subject: "Anchor bolts", status: "open", createdByUserId: "supt", createdByCompanyId: "gc", ballInCourtUserId: "sub", assigneeUserIds: ["sub"], distributionUserIds: [] },
  { ItemId: "rfi-gc", tenantRole: T, projectId: P, number: "RFI-002", subject: "Pump spec", status: "answered", createdByUserId: "pm", createdByCompanyId: "gc", ballInCourtUserId: "design", assigneeUserIds: ["design"], distributionUserIds: [] },
  { ItemId: "rfi-draft", tenantRole: T, projectId: P, number: "", subject: "Draft", status: "draft", createdByUserId: "supt", createdByCompanyId: "gc", assigneeUserIds: [], distributionUserIds: [] },
  { ItemId: "rfi-void", tenantRole: T, projectId: P, number: "RFI-003", subject: "Voided", status: "open", isVoided: true, createdByUserId: "pm", createdByCompanyId: "gc", assigneeUserIds: [], distributionUserIds: [] }
);
// Punch items: one for the subcontractor's company, one for another company, a closed, a ready and a void one.
rows("PunchItem").push(
  { ItemId: "pi-sub", tenantRole: T, projectId: P, number: "PI-001", title: "Drywall crack", status: "open", isVoided: false, assigneeCompanyId: "sub-co", createdByUserId: "supt" },
  { ItemId: "pi-other", tenantRole: T, projectId: P, number: "PI-002", title: "Paint run", status: "inProgress", isVoided: false, assigneeCompanyId: "other-sub", createdByUserId: "pm" },
  { ItemId: "pi-closed", tenantRole: T, projectId: P, number: "PI-003", title: "Closed one", status: "closed", isVoided: false, assigneeCompanyId: "sub-co", createdByUserId: "supt" },
  { ItemId: "pi-ready", tenantRole: T, projectId: P, number: "PI-004", title: "Ready one", status: "readyForReview", isVoided: false, assigneeCompanyId: "sub-co", createdByUserId: "supt" },
  { ItemId: "pi-void", tenantRole: T, projectId: P, number: "PI-005", title: "Void one", status: "void", isVoided: true, assigneeCompanyId: "sub-co", createdByUserId: "supt" }
);
// Daily logs: today's draft, an older submitted one, and a duplicate that lost the race.
rows("DailyLog").push(
  { ItemId: "log-draft", tenantRole: T, projectId: P, logDate: "2026-11-25", status: "draft" },
  { ItemId: "log-done", tenantRole: T, projectId: P, logDate: "2026-11-24", status: "submitted" },
  { ItemId: "log-dup", tenantRole: T, projectId: P, logDate: "2026-11-25", status: "draft", duplicateOf: "log-draft" }
);
// Another company's photo with the same project id must never show.
rows("Photo").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, fileId: "f", fileName: "Not yours.jpg", uploadedAt: new Date().toISOString(), isVoided: false });

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
const mine = () => rows("Photo").filter((p) => p.tenantRole === T);
const named = (name) => mine().find((p) => p.fileName === name);

// Adds photos the way the browser does: links (with the two copies), the PUTs are skipped, then add.
async function addPhotos(user, list, extra = {}, { copies = true, sizeBytes = 3_000_000, contentType = "image/jpeg", tamper, projectId = P } = {}) {
  const files = list.map((name) => ({
    name,
    contentType,
    sizeBytes,
    ...(copies ? { preview: { contentType: "image/jpeg", sizeBytes: 400_000 }, thumb: { contentType: "image/jpeg", sizeBytes: 30_000 } } : {})
  }));
  const links = await call(user, { action: "uploadLinks", files }, projectId);
  if (!links.ok) return links;
  const photos = links.uploads.map(({ uploadUrl: _u, previewUploadUrl: _p, thumbUploadUrl: _t, ...a }) => ({ ...a, takenAt: "2026-11-20T09:15:00Z", width: 4032, height: 3024, ...(tamper ?? {}) }));
  return call(user, { action: "add", photos, ...extra }, projectId);
}
const names = (r) => r.photos.map((p) => p.fileName).sort().join(",");

console.log("photos Function, local test");

await test("company admin not on the team gets nothing; an empty gallery lists the linkable RFIs", async () => {
  refused(await call("admin", { action: "list" }), "NOT_ON_PROJECT", "admin");
  const r = await call("pm", { action: "list" });
  ok(r, "pm list");
  expect(r.photos.length === 0, "foreign photo hidden");
  expect(r.rfis.map((x) => x.number).join(",") === "RFI-002,RFI-001", `linkable ${r.rfis.map((x) => x.number)}`);
  expect(r.can.upload && r.can.manage && r.can.seeRemoved, "pm can");
});

await test("upload: three files per photo, owner refused, non-photos refused, limits", async () => {
  const r = await addPhotos("supt", ["Pour north.jpg", "Pour south.jpg"], { locationLabel: "Tank 3", tags: ["Concrete", " concrete ", "Pour#1"] });
  ok(r, "supt adds two");
  expect(r.photos.length === 2 && r.photos.every((p) => p.thumbUrl && p.previewUrl && p.hasPreview), "links for both copies");
  const row = named("Pour north.jpg");
  expect(row.fileId && row.previewFileId && row.thumbFileId && row.yearMonth === "2026-11" && row.uploaderCompanyId === "gc", JSON.stringify(row));
  expect(JSON.stringify(row.tags) === '["concrete","pour1"]', `tags ${row.tags}`);
  expect(row.searchText.includes("tank 3") && row.searchText.includes("concrete"), "search text");
  refused(await addPhotos("owner", ["x.jpg"]), "NOT_ALLOWED", "owner");
  refused(await addPhotos("pm", ["plan.pdf"], {}, { contentType: "application/pdf" }), "FILE_TYPE_NOT_ALLOWED", "pdf");
  refused(await addPhotos("pm", ["fake.jpg"], {}, { contentType: "text/html" }), "FILE_TYPE_NOT_ALLOWED", "html as jpg");
  refused(await addPhotos("pm", ["huge.jpg"], {}, { sizeBytes: 51 * 1024 * 1024 }), "FILE_TOO_LARGE", "51 MB");
  refused(await addPhotos("pm", "abcdefghijk".split("").map((x) => `${x}.jpg`)), "TOO_MANY_FILES", "11 at once");
  refused(await addPhotos("pm", ["old.jpg"], {}, { projectId: "p2" }), "ARCHIVED", "archived project");
});

await test("HEIC without copies is stored with the original only", async () => {
  const r = await addPhotos("pm", ["IMG_0001.HEIC"], {}, { copies: false, contentType: "image/heic" });
  ok(r, "heic");
  expect(!r.photos[0].hasPreview && !r.photos[0].thumbUrl, "no copies");
});

await test("copies that are too big or the wrong type get no upload link", async () => {
  const links = await call("pm", { action: "uploadLinks", files: [{ name: "a.jpg", contentType: "image/jpeg", sizeBytes: 10, preview: { contentType: "image/jpeg", sizeBytes: 9 * 1024 * 1024 }, thumb: { contentType: "image/svg+xml", sizeBytes: 10 } }] });
  ok(links, "links");
  expect(!links.uploads[0].previewUploadUrl && !links.uploads[0].thumbUploadUrl && !links.uploads[0].previewFileId, "no copies");
});

await test("a changed or someone else's ticket is refused; a retry returns the same photo", async () => {
  refused(await addPhotos("supt", ["t.jpg"], {}, { tamper: { sizeBytes: 5 } }), "BAD_FILE_TICKET", "changed size");
  refused(await addPhotos("supt", ["t.jpg"], {}, { tamper: { thumbFileId: "file-else" } }), "BAD_FILE_TICKET", "swapped thumb");
  const links = await call("supt", { action: "uploadLinks", files: [{ name: "retry.jpg", contentType: "image/jpeg", sizeBytes: 10 }] });
  const { uploadUrl: _u, ...a } = links.uploads[0];
  refused(await call("pm", { action: "add", photos: [a] }), "BAD_FILE_TICKET", "pm with supt's ticket");
  const first = await call("supt", { action: "add", photos: [a] });
  const again = await call("supt", { action: "add", photos: [a] });
  ok(first, "first");
  ok(again, "again");
  expect(first.photos[0].ItemId === again.photos[0].ItemId && mine().filter((p) => p.fileName === "retry.jpg").length === 1, "added once");
});

await test("taken date: an odd date falls back to the upload time", async () => {
  const r = await addPhotos("pm", ["future.jpg"], {}, { tamper: { takenAt: "2099-01-01T00:00:00Z" } });
  ok(r, "future");
  expect(r.photos[0].takenAt.slice(0, 10) === new Date().toISOString().slice(0, 10), r.photos[0].takenAt);
});

await test("link to an RFI: only ones the person can open, never drafts or voided", async () => {
  ok(await addPhotos("sub", ["Bolts.jpg"], { link: { type: "rfi", id: "rfi-sub" } }), "sub links own RFI");
  refused(await addPhotos("sub", ["x.jpg"], { link: { type: "rfi", id: "rfi-gc" } }), "NOT_FOUND", "sub links an RFI they can't open");
  refused(await addPhotos("supt", ["x.jpg"], { link: { type: "rfi", id: "rfi-draft" } }), "NOT_FOUND", "draft");
  refused(await addPhotos("pm", ["x.jpg"], { link: { type: "rfi", id: "rfi-void" } }), "NOT_FOUND", "voided");
  const r = await addPhotos("pm", ["Pump.jpg"], { link: { type: "rfi", id: "rfi-gc" } });
  ok(r, "pm links RFI-002");
  expect(r.photos[0].link.number === "RFI-002" && r.photos[0].link.label === "Pump spec", JSON.stringify(r.photos[0].link));
  ok(await addPhotos("pm", ["Bolts close-up.jpg"], { link: { type: "rfi", id: "rfi-sub" } }), "pm links RFI-001");
  const sub = await call("sub", { action: "list" });
  expect(sub.rfis.map((x) => x.number).join(",") === "RFI-001", `sub linkable ${sub.rfis.map((x) => x.number)}`);
});

await test("who sees what: sub = own company + photos on RFIs they can open; others see all", async () => {
  const sub = await call("sub", { action: "list" });
  expect(names(sub) === "Bolts close-up.jpg,Bolts.jpg", `sub sees ${names(sub)}`);
  expect(!sub.can.manage && sub.can.upload && !sub.can.seeRemoved, "sub can");
  const sub2 = await call("sub2", { action: "list" });
  expect(sub2.photos.length === 0, `other sub sees ${names(sub2)}`);
  ok(await addPhotos("sub2", ["Scaffold.jpg"]), "other sub adds");
  expect(names(await call("sub2", { action: "list" })) === "Scaffold.jpg", "other sub sees own");
  expect(!names(await call("sub", { action: "list" })).includes("Scaffold"), "sub doesn't see other sub's");
  for (const u of ["pm", "supt", "dc", "design", "owner"]) {
    const r = await call(u, { action: "list" });
    expect(r.photos.length === mine().length, `${u} sees ${r.photos.length} of ${mine().length}`);
  }
  const owner = await call("owner", { action: "list" });
  expect(!owner.can.upload && owner.photos.every((p) => !p.canEdit && !p.canRemove), "owner reads only");
});

await test("by id: a sub can't open, edit or download a photo they can't see", async () => {
  const pump = named("Pump.jpg");
  refused(await call("sub", { action: "originalLink", photoId: pump.ItemId }), "NOT_FOUND", "original");
  refused(await call("sub", { action: "update", photoId: pump.ItemId, caption: "x" }), "NOT_FOUND", "update");
  refused(await call("sub", { action: "remove", photoId: pump.ItemId }), "NOT_FOUND", "remove");
  refused(await call("pm", { action: "originalLink", photoId: "foreign" }), "NOT_FOUND", "other company's photo");
  const links = await call("sub", { action: "links", photoIds: [pump.ItemId, named("Bolts.jpg").ItemId] });
  ok(links, "links");
  expect(Object.keys(links.links).length === 1, "links only for photos the sub sees");
  const orig = await call("owner", { action: "originalLink", photoId: pump.ItemId });
  ok(orig, "owner downloads the original");
  expect(orig.url.includes(pump.fileId) && orig.fileName === "Pump.jpg", "original file");
});

await test("edit: the uploader and PM/DC change caption, location and tags; others can't", async () => {
  const north = named("Pour north.jpg");
  refused(await call("design", { action: "update", photoId: north.ItemId, caption: "x" }), "NOT_ALLOWED", "designer on supt's photo");
  refused(await call("pm", { action: "update", photoId: north.ItemId, version: 7, caption: "x" }), "STATE_CHANGED", "stale version");
  const r = await call("supt", { action: "update", photoId: north.ItemId, version: north.version, caption: "  North wall pour,  layer 2 ", tags: ["concrete", "layer 2"] });
  ok(r, "supt edits own");
  expect(r.photos[0].caption === "North wall pour, layer 2" && r.photos[0].tags.join("|") === "concrete|layer 2" && r.photos[0].version === 1, JSON.stringify(r.photos[0]));
  ok(await call("dc", { action: "update", photoId: north.ItemId, locationLabel: "Tank 3, north" }), "dc edits any");
  expect(rows("ActivityEvent").some((e) => e.recordType === "photo" && e.action === "edited"), "history written");
});

await test("bulk tag: changes the ones the person may edit, counts the rest", async () => {
  const ids = mine().map((p) => p.ItemId);
  const r = await call("supt", { action: "tag", photoIds: ids, add: ["Week 47"] });
  ok(r, "supt tags");
  const supts = mine().filter((p) => p.uploadedByUserId === "supt").length;
  expect(r.photos.length === supts && r.skipped === ids.length - supts, `changed ${r.photos.length} skipped ${r.skipped}`);
  expect(r.photos.every((p) => p.tags.includes("week 47")), "tag added");
  const pm = await call("pm", { action: "tag", photoIds: ids, add: ["week 47"] });
  expect(pm.skipped === 0, `pm skipped ${pm.skipped}`);
  const rm = await call("pm", { action: "tag", photoIds: ids, remove: ["week 47"] });
  expect(rm.photos.every((p) => !p.tags.includes("week 47")), "tag removed");
  const owner = await call("owner", { action: "tag", photoIds: ids, add: ["x"] });
  expect(owner.ok && owner.photos.length === 0 && owner.skipped === ids.length, "owner changes nothing");
});

await test("remove: sub own within 24 h only; PM/DC any; restore by PM/DC; removed hidden from others", async () => {
  const bolts = named("Bolts.jpg");
  bolts.uploadedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
  refused(await call("sub", { action: "remove", photoId: bolts.ItemId }), "NOT_ALLOWED", "sub after 24 h");
  const own = await call("sub2", { action: "remove", photoId: named("Scaffold.jpg").ItemId });
  ok(own, "sub2 within 24 h");
  expect(own.photos[0].removed && !own.photos[0].thumbUrl, "a sub's removed photo comes back without links");
  refused(await call("supt", { action: "remove", photoId: bolts.ItemId }), "NOT_ALLOWED", "supt on someone else's");
  const r = await call("dc", { action: "remove", photoId: bolts.ItemId, reason: "Duplicate" });
  ok(r, "dc removes");
  expect(r.photos[0].removed && r.photos[0].thumbUrl, "removed, a manager still sees the image");
  expect(r.photos[0].removedReason === "Duplicate" && r.photos[0].removedByName, `reason and remover ${r.photos[0].removedReason} / ${r.photos[0].removedByName}`);
  expect(!names(await call("pm", { action: "list" })).includes("Bolts.jpg"), "gone from the gallery");
  refused(await call("supt", { action: "list", removed: true }), "NOT_ALLOWED", "supt can't list removed");
  const removed = await call("pm", { action: "list", removed: true });
  expect(names(removed) === "Bolts.jpg,Scaffold.jpg", `removed list ${names(removed)}`);
  const gone = removed.photos.find((p) => p.fileName === "Bolts.jpg");
  expect(gone.thumbUrl && gone.removedReason === "Duplicate" && gone.removedByName, "removed list: image, reason, remover");
  const links = await call("pm", { action: "links", photoIds: [bolts.ItemId] });
  expect(links.links[bolts.ItemId]?.thumb, "links for a removed photo to a manager");
  const subLinks = await call("sub", { action: "links", photoIds: [bolts.ItemId] });
  expect(!subLinks.links?.[bolts.ItemId], "no links for a removed photo to a sub");
  refused(await call("sub", { action: "originalLink", photoId: bolts.ItemId }), "NOT_FOUND", "sub can't open removed");
  refused(await call("supt", { action: "restore", photoId: bolts.ItemId }), "NOT_ALLOWED", "supt restore");
  ok(await call("pm", { action: "restore", photoId: bolts.ItemId }), "pm restores");
  expect(names(await call("sub", { action: "list" })).includes("Bolts.jpg"), "back for the sub");
  expect(rows("ActivityEvent").some((e) => e.action === "removed" && e.reason === "Duplicate"), "reason in history");
});

await test("punch photos: before by the GC, after by the GC or the assigned company, the right states only", async () => {
  const link = (id, role) => ({ link: { type: "punchItem", id, role } });
  const b = await addPhotos("supt", ["Crack before.jpg"], link("pi-sub", "before"));
  ok(b, "supt before photo");
  expect(b.photos[0].link.type === "punchItem" && b.photos[0].link.role === "before" && b.photos[0].link.number === "PI-001", JSON.stringify(b.photos[0].link));
  ok(await addPhotos("pm", ["Ready before.jpg"], link("pi-ready", "before")), "before photo while ready for review");
  refused(await addPhotos("sub", ["x.jpg"], link("pi-sub", "before")), "NOT_ALLOWED", "sub before photo");
  refused(await addPhotos("dc", ["x.jpg"], link("pi-sub", "before")), "NOT_ALLOWED", "dc before photo");
  refused(await addPhotos("pm", ["x.jpg"], link("pi-closed", "before")), "NOT_ALLOWED", "before on a closed item");
  refused(await addPhotos("supt", ["x.jpg"], link("pi-sub", "general")), "BAD_LINK", "no role");
  ok(await addPhotos("sub", ["Crack after.jpg"], link("pi-sub", "after")), "sub after photo on own company's item");
  refused(await addPhotos("sub", ["x.jpg"], link("pi-other", "after")), "NOT_FOUND", "sub on another company's item");
  refused(await addPhotos("sub", ["x.jpg"], link("pi-ready", "after")), "NOT_ALLOWED", "after photo while ready for review");
  ok(await addPhotos("supt", ["Paint after.jpg"], link("pi-other", "after")), "GC takes the after photo itself");
  refused(await addPhotos("pm", ["x.jpg"], link("pi-void", "after")), "NOT_FOUND", "void item");
  refused(await addPhotos("design", ["x.jpg"], link("pi-sub", "after")), "NOT_ALLOWED", "designer");
  expect(rows("ActivityEvent").some((e) => e.recordType === "punchItem" && e.recordId === "pi-sub" && e.action === "afterPhotoAdded"), "history on the punch item");
  // The other subcontractor never sees the GC's before photo on PI-001; the assigned sub does.
  expect(names(await call("sub", { action: "list" })).includes("Crack before.jpg"), "sub sees the before photo on their item");
  expect(!names(await call("sub2", { action: "list" })).includes("Crack before.jpg"), "sub2 doesn't");
  expect(names(await call("sub2", { action: "list" })).includes("Paint after.jpg"), "sub2 sees the GC's after photo on their item");
});

await test("daily log photos: GC and subs on a draft log; seen as the log is; a submitted log's photos stay", async () => {
  const link = (id) => ({ link: { type: "dailyLog", id } });
  const a = await addPhotos("supt", ["Log crane.jpg"], link("log-draft"));
  ok(a, "supt adds to the draft log");
  expect(a.photos[0].link.type === "dailyLog" && a.photos[0].link.number === "2026-11-25" && a.photos[0].link.label === "Daily log Wed, 25 Nov 2026", JSON.stringify(a.photos[0].link));
  ok(await addPhotos("sub", ["Log drywall.jpg"], link("log-draft")), "sub adds their company's photo");
  refused(await addPhotos("dc", ["x.jpg"], link("log-draft")), "NOT_FOUND", "document controller (reads logs only)");
  refused(await addPhotos("design", ["x.jpg"], link("log-draft")), "NOT_FOUND", "designer (no daily logs)");
  refused(await addPhotos("pm", ["x.jpg"], link("log-done")), "LOG_SUBMITTED", "submitted log");
  refused(await addPhotos("pm", ["x.jpg"], link("log-dup")), "NOT_FOUND", "a duplicate log");
  refused(await addPhotos("pm", ["x.jpg"], link("nope")), "NOT_FOUND", "no such log");
  expect(rows("ActivityEvent").some((e) => e.recordType === "dailyLog" && e.recordId === "log-draft" && e.action === "photoAdded"), "history on the log");
  const sees = async (user) => names(await call(user, { action: "list" }));
  const dc = await sees("dc");
  expect(dc.includes("Log crane.jpg") && dc.includes("Log drywall.jpg"), "DC sees every log photo");
  const sub = await sees("sub");
  expect(!sub.includes("Log crane.jpg") && sub.includes("Log drywall.jpg"), "sub: own company's only");
  expect(!(await sees("sub2")).includes("Log drywall.jpg"), "another sub: none");
  expect(!(await sees("design")).includes("Log crane.jpg"), "designer: none");
  expect(!(await sees("owner")).includes("Log crane.jpg"), "owner: not while the log is a draft");
  const leak = await call("design", { action: "links", photoIds: [named("Log crane.jpg").ItemId] });
  expect(leak.ok && Object.keys(leak.links).length === 0, "designer gets no image link");
  // Submitted: the owner sees them; the uploader can no longer remove theirs, the PM can.
  rows("DailyLog").find((l) => l.ItemId === "log-draft").status = "submitted";
  expect((await sees("owner")).includes("Log crane.jpg"), "owner sees them once submitted");
  refused(await call("supt", { action: "remove", photoId: named("Log crane.jpg").ItemId }), "NOT_ALLOWED", "uploader on a submitted log");
  ok(await call("pm", { action: "remove", photoId: named("Log crane.jpg").ItemId, reason: "TEST" }), "PM removes");
  rows("DailyLog").find((l) => l.ItemId === "log-draft").status = "draft";
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
