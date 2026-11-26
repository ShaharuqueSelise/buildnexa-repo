// Local test of the daily-logs Function: runs functions/daily-logs/index.js against the same
// in-memory fake of the Blocks token and Data Gateway as tools/test-punch.mjs, so who opens, fills,
// submits and corrects a day's log, and what each role sees, is checked without touching any
// environment.
//   node tools/test-daily-logs.mjs
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
const rows = (schema) => (store[schema] ??= []);
// The gateway stamps CreatedDate on every insert; each one a little later than the last.
let clock = Date.parse("2026-11-01T08:00:00Z");

// Open-Meteo behind the two proxies: two towns called Hamburg (the German one is not the first
// answer, so the country has to pick it), then the day's figures. `wx.down` makes both fail.
const wx = { down: false, calls: [] };
function fakeProxy(url) {
  const u = new URL(url);
  wx.calls.push(u.pathname.replace("/logic/v4/proxy/gateway/", "") + u.search);
  if (wx.down) return { ok: false, status: 503, json: async () => ({ code: "PROXY_GATEWAY_UNAVAILABLE" }) };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.pathname.endsWith("/gateway/geocoding")) {
    return json({ results: [
      { name: "Hamburg", latitude: 42.71, longitude: -78.83, country: "United States", country_code: "US", timezone: "America/New_York" },
      { name: "Hamburg", latitude: 53.55, longitude: 9.99, country: "Germany", country_code: "DE", timezone: "Europe/Berlin" }
    ] });
  }
  if (u.pathname.endsWith("/gateway/weather")) {
    const date = u.searchParams.get("start_date");
    return json({ daily: { time: [date], weather_code: [63], temperature_2m_max: [7.24], temperature_2m_min: [2.06], precipitation_sum: [4.5], wind_speed_10m_max: [55.38] } });
  }
  return { ok: false, status: 403, json: async () => ({}) };
}

globalThis.fetch = async (url, init) => {
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (String(url).includes("/oidc/token")) return json({ access_token: "test-token" });
  if (String(url).includes("/proxy/gateway/")) return fakeProxy(String(url));
  if (String(url).includes("/logic/v4/")) return json({ isSuccess: true });
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
    clock += 1000;
    rows(m[1]).push({ ...structuredClone(variables.input), ItemId: itemId, CreatedDate: new Date(clock).toISOString() });
    return json({ data: { [`insert${m[1]}`]: { acknowledged: true, itemId } } });
  }
  if ((m = /update(\w+)\(/.exec(query))) {
    const hit = rows(m[1]).filter((r) => Object.entries(variables.where).every(([k, cond]) => r[k] === cond.eq));
    for (const r of hit) Object.assign(r, structuredClone(variables.input));
    return json({ data: { [`update${m[1]}`]: { acknowledged: hit.length > 0, totalImpactedData: hit.length } } });
  }
  throw new Error(`fake gateway: unknown query ${query.slice(0, 60)}`);
};

const { default: handler } = await import(pathToFileURL(join(here, "..", "functions", "daily-logs", "index.js")).href);

// ---------- seed: the GC with one person per role, two subcontractors, design and owner ----------
const T = "company-west";
const P = "p1";
rows("Project").push({ ItemId: P, tenantRole: T, number: "PRJ-001", name: "Tank Farm", status: "active", timezone: "Europe/Berlin", address: { street: "Kai 1", city: "Hamburg", country: "Germany" } });
rows("Project").push({ ItemId: "p2", tenantRole: T, number: "PRJ-002", name: "Old", status: "archived", timezone: "Europe/Berlin" });
const people = {
  pm: { role: "project-manager", account: "staff", company: "gc", companyName: "West Build" },
  supt: { role: "superintendent", account: "staff", company: "gc", companyName: "West Build" },
  dc: { role: "document-controller", account: "staff", company: "gc", companyName: "West Build" },
  sub: { role: "field-user", account: "external", company: "sub-co", companyName: "Dry Walls Ltd", trade: "Drywall" },
  sub2: { role: "field-user", account: "external", company: "sub-co", companyName: "Dry Walls Ltd", trade: "Drywall" },
  other: { role: "field-user", account: "external", company: "paint-co", companyName: "Paint & Co", trade: "Painting" },
  design: { role: "design-reviewer", account: "external", company: "design-co", companyName: "Arch Studio" },
  owner: { role: "owner-viewer", account: "external", company: "owner-co", companyName: "Owner AG" },
  stranger: { role: null, account: "staff", company: "gc" }
};
for (const [userId, p] of Object.entries(people)) {
  if (!p.role) continue;
  for (const projectId of [P, "p2"]) {
    rows("ProjectMember").push({
      ItemId: `${projectId}-${userId}`, tenantRole: T, projectId, userId, displayName: userId.toUpperCase(), email: `${userId}@test.example`,
      companyId: p.company, companyName: p.companyName, companyRelation: p.company === "gc" ? "self" : p.company === "design-co" ? "design" : p.company === "owner-co" ? "owner" : "sub",
      trade: p.trade ?? "", role: p.role, status: "active", joinedAt: "2026-01-01"
    });
  }
}
// Another company's log on the same project id and day: never seen.
const tz = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const today = tz(new Date());
const dayPlus = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWeekend = (iso) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());
rows("DailyLog").push({ ItemId: "foreign", tenantRole: "company-other", projectId: P, logDate: today, status: "submitted", version: 3, notes: "Not yours", CreatedDate: "2020-01-01T00:00:00Z" });

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
const logsOn = (date) => mine("DailyLog").filter((l) => l.projectId === P && l.logDate === date);
const events = (logId) => mine("ActivityEvent").filter((e) => e.recordId === logId).map((e) => e.action);
const truck = { supplier: "Beton Nord", material: "C30/37 concrete", quantity: "12 m³", time: "07:30", deliveryNoteNo: "LS-4711" };
const crane = { name: "Mobile crane 50 t", quantity: 1, hoursUsed: 6.5, status: "working" };

console.log("daily-logs Function");
let logId;

await test("designers and people off the team get no daily logs", async () => {
  refused(await call("design", { action: "month" }), "NOT_ALLOWED", "designer month");
  refused(await call("design", { action: "get", date: today }), "NOT_ALLOWED", "designer get");
  refused(await call("stranger", { action: "month" }), "NOT_ON_PROJECT", "not on the team");
});

await test("the document controller and the owner never open a day; subcontractors only today", async () => {
  refused(await call("dc", { action: "open", date: today }), "NOT_ALLOWED", "dc");
  refused(await call("owner", { action: "open", date: today }), "NOT_ALLOWED", "owner");
  refused(await call("sub", { action: "open", date: dayPlus(-1) }), "NOT_ALLOWED", "sub, yesterday");
  expect(logsOn(today).length === 0 && logsOn(dayPlus(-1)).length === 0, "nothing created");
});

await test("the superintendent opens today: a draft, weekday flag, history line; opening again returns the same log", async () => {
  const r = await call("supt", { action: "open", date: today });
  ok(r, "open");
  logId = r.log.id;
  expect(r.log.status === "draft" && r.log.date === today && r.log.version === 0, JSON.stringify(r.log));
  expect(r.log.isWorkingDay === !isWeekend(today), "working day flag");
  expect(r.log.notes === "" && Array.isArray(r.log.equipment) && r.log.equipment.length === 0, "empty sections");
  expect(r.place === "Hamburg" && r.today === today && r.role === "superintendent", "header");
  expect(r.can.editSections && r.can.submit && r.can.editAnyCrew && !r.can.correct && !r.can.open, JSON.stringify(r.can));
  expect(events(logId).includes("created"), "history");
  const again = await call("pm", { action: "open", date: today });
  ok(again, "again");
  expect(again.log.id === logId && logsOn(today).length === 1, "one log");
  expect(!JSON.stringify(again).includes("Not yours"), "another company's log never shows");
});

await test("open: up to one day ahead; a weekend day is not a working day", async () => {
  refused(await call("pm", { action: "open", date: dayPlus(2) }), "FUTURE_DATE", "two days ahead");
  refused(await call("pm", { action: "open", date: "2026-02-30" }), "BAD_DATE", "no such date");
  const t = await call("pm", { action: "open", date: dayPlus(1) });
  ok(t, "tomorrow");
  expect(t.log.isWorkingDay === !isWeekend(dayPlus(1)), "flag");
  const sat = "2026-11-21"; // a Saturday in the past
  const s = await call("supt", { action: "open", date: sat });
  ok(s, "saturday");
  expect(s.log.isWorkingDay === false, "weekend");
});

await test("get never creates; subcontractors open today and see the existing log", async () => {
  const g = await call("pm", { action: "get", date: dayPlus(-3) });
  ok(g, "get");
  expect(g.log === null && logsOn(dayPlus(-3)).length === 0 && g.can.open === true, "empty day");
  const s = await call("sub", { action: "open", date: today });
  ok(s, "sub opens today");
  expect(s.log.id === logId, "the same log");
});

await test("two people opening an empty day at once: one log wins, the other is marked a duplicate", async () => {
  const d = dayPlus(-4);
  const [a, b] = await Promise.all([call("pm", { action: "open", date: d }), call("supt", { action: "open", date: d })]);
  ok(a, "a");
  ok(b, "b");
  expect(a.log.id === b.log.id, `same log: ${a.log.id} vs ${b.log.id}`);
  const all = logsOn(d);
  expect(all.length === 2 && all.filter((l) => !l.duplicateOf).length === 1, `rows ${all.length}, live ${all.filter((l) => !l.duplicateOf).length}`);
  expect(all.find((l) => l.duplicateOf).duplicateOf === a.log.id, "duplicate points at the winner");
  const m = await call("pm", { action: "month", month: d.slice(0, 7) });
  expect(m.days.filter((x) => x.date === d).length === 1, "the month shows the day once");
});

await test("sections: the GC only, checked row by row", async () => {
  refused(await call("sub", { action: "saveSection", date: today, section: "notes", value: "hi" }), "NOT_ALLOWED", "sub");
  refused(await call("dc", { action: "saveSection", date: today, section: "notes", value: "hi" }), "NOT_ALLOWED", "dc");
  refused(await call("owner", { action: "saveSection", date: today, section: "notes", value: "hi" }), "NOT_ALLOWED", "owner");
  refused(await call("supt", { action: "saveSection", date: today, section: "budget", value: 1 }), "BAD_SECTION", "unknown section");
  refused(await call("supt", { action: "saveSection", date: today, section: "equipment", value: [{ quantity: 1 }] }), "VALIDATION", "no name");
  refused(await call("supt", { action: "saveSection", date: today, section: "equipment", value: [{ name: "Crane", quantity: -1 }] }), "VALIDATION", "negative quantity");
  refused(await call("supt", { action: "saveSection", date: today, section: "delays", value: [{ type: "weather", description: "Rain", durationHours: 30 }] }), "VALIDATION", "30 h lost");
  refused(await call("supt", { action: "saveSection", date: today, section: "siteConditions", value: "lava" }), "VALIDATION", "condition");
  refused(await call("supt", { action: "saveSection", date: dayPlus(3), section: "notes", value: "early" }), "FUTURE_DATE", "far ahead");
  const r = await call("supt", { action: "saveSection", date: today, section: "equipment", value: [crane, { name: "Excavator", status: "exploded" }], base: [] });
  ok(r, "equipment");
  expect(r.log.equipment.length === 2 && r.log.equipment[0].rowId && r.log.equipment[0].hoursUsed === 6.5, JSON.stringify(r.log.equipment));
  expect(r.log.equipment[1].status === "working" && !("quantity" in r.log.equipment[1]), "unknown status falls back, empty number stays empty");
  expect(r.log.version === 1 && events(logId).includes("edited"), "version and history");
  const same = await call("supt", { action: "saveSection", date: today, section: "equipment", value: r.log.equipment });
  expect(same.ok && same.log.version === 1, "saving the same rows changes nothing");
});

await test("two people on different cards never block each other; the same card with an old base is a conflict", async () => {
  const before = (await call("pm", { action: "get", date: today })).log;
  const a = await call("supt", { action: "saveSection", date: today, section: "deliveries", value: [truck], base: before.deliveries });
  ok(a, "supt saves deliveries");
  const b = await call("pm", { action: "saveSection", date: today, section: "visitors", value: [{ name: "Dr. Weber", organisation: "TÜV Nord", purpose: "Crane inspection", timeIn: "09:00", timeOut: "10:15" }], base: before.visitors });
  ok(b, "pm saves visitors from the same starting point");
  expect(b.log.deliveries.length === 1 && b.log.visitors.length === 1, "both kept");
  refused(await call("pm", { action: "saveSection", date: today, section: "deliveries", value: [], base: before.deliveries }), "CONFLICT", "stale deliveries");
  expect((await call("pm", { action: "get", date: today })).log.deliveries.length === 1, "the delivery is still there");
});

await test("opening a day fetches its forecast for the project's city; the provider down still opens the log", async () => {
  const w = logsOn(today)[0].weather;
  expect(w?.source === "open-meteo" && w.place === "Hamburg" && w.condition === "rain" && w.summary === "Moderate rain", JSON.stringify(w));
  expect(w.tempMaxC === 7.2 && w.tempMinC === 2.1 && w.precipitationMm === 4.5 && w.windMaxKph === 55.4, "rounded figures");
  const forecast = wx.calls.find((x) => x.startsWith("weather?"));
  expect(forecast.includes("latitude=53.55") && forecast.includes("timezone=Europe%2FBerlin") && forecast.includes(`start_date=${today}`), `the German Hamburg, project timezone: ${forecast}`);
  wx.down = true;
  const r = await call("pm", { action: "open", date: dayPlus(-10) });
  wx.down = false;
  ok(r, "open with the provider down");
  expect(r.log.weather === null, "no weather");
  wx.calls.length = 0;
  ok(await call("pm", { action: "open", date: dayPlus(-120) }), "open long ago");
  expect(wx.calls.length === 0 && logsOn(dayPlus(-120))[0].weather === undefined, "no forecast call outside the provider's range");
});

await test("refresh forecast: the GC on a draft only; a failure says so and changes nothing", async () => {
  refused(await call("sub", { action: "refreshWeather", date: dayPlus(-10) }), "NOT_ALLOWED", "subcontractor");
  refused(await call("dc", { action: "refreshWeather", date: dayPlus(-10) }), "NOT_ALLOWED", "document controller");
  refused(await call("pm", { action: "refreshWeather", date: dayPlus(-11) }), "NO_LOG", "no log");
  wx.down = true;
  refused(await call("supt", { action: "refreshWeather", date: dayPlus(-10) }), "WEATHER_UNAVAILABLE", "provider down");
  wx.down = false;
  expect(!logsOn(dayPlus(-10))[0].weather, "unchanged");
  const project = rows("Project").find((x) => x.ItemId === P);
  project.address.city = "";
  refused(await call("supt", { action: "refreshWeather", date: dayPlus(-10) }), "NO_LOCATION", "no city");
  project.address.city = "Hamburg";
  const r = await call("supt", { action: "refreshWeather", date: dayPlus(-10) });
  ok(r, "refresh");
  expect(r.log.weather.source === "open-meteo" && r.log.weather.condition === "rain" && r.log.version === 1, JSON.stringify(r.log.weather));
});

await test("weather: a manual entry wins over the forecast; clearing it goes back", async () => {
  refused(await call("supt", { action: "saveSection", date: today, section: "weatherOverride", value: { tempMaxC: 99 } }), "VALIDATION", "99 °C");
  refused(await call("supt", { action: "saveSection", date: today, section: "weatherOverride", value: {} }), "VALIDATION", "empty");
  logsOn(today)[0].weather = { source: "open-meteo", place: "Hamburg", condition: "rain", tempMinC: 3, tempMaxC: 7, precipitationMm: 4.2, fetchedAt: new Date().toISOString() };
  const w = await call("supt", { action: "saveSection", date: today, section: "weatherOverride", value: { condition: "drizzle", tempMaxC: 6, summary: "Light drizzle all morning" } });
  ok(w, "manual weather");
  expect(w.log.weather.source === "manual" && w.log.weather.condition === "drizzle" && w.log.weatherForecast.condition === "rain", JSON.stringify(w.log.weather));
  const c = await call("supt", { action: "saveSection", date: today, section: "weatherOverride", value: null });
  ok(c, "clear");
  expect(c.log.weather.source === "open-meteo" && c.log.weatherOverride === null, "forecast again");
});

await test("crews: a subcontractor writes only their own company's; the GC writes any", async () => {
  const pre = await call("pm", { action: "get", date: today });
  expect(pre.missingCrews.map((x) => x.companyId).join(",") === "sub-co,paint-co", `missing ${JSON.stringify(pre.missingCrews)}`);
  expect(pre.companies[0].companyId === "gc" && pre.companies[0].own === true, "the GC first");
  refused(await call("sub", { action: "saveCrew", date: today, companyId: "paint-co", manpower: [] }), "NOT_ALLOWED", "another company");
  refused(await call("owner", { action: "saveCrew", date: today, manpower: [] }), "NOT_ALLOWED", "owner");
  refused(await call("dc", { action: "saveCrew", date: today, manpower: [] }), "NOT_ALLOWED", "dc");
  refused(await call("sub", { action: "saveCrew", date: today, manpower: [{ trade: "Drywall", headcount: 900 }] }), "VALIDATION", "900 workers");
  refused(await call("sub", { action: "saveCrew", date: dayPlus(-3), manpower: [{ headcount: 2 }] }), "NO_LOG", "a past day without a log");
  const s = await call("sub", { action: "saveCrew", date: today, manpower: [{ trade: "Drywall", headcount: 4, hours: 32, workDone: "Boarding level 2", location: "L2" }], notes: "Waiting for screws" });
  ok(s, "sub saves own crew");
  expect(s.crews.length === 1 && s.crews[0].companyId === "sub-co" && s.crews[0].headcount === 4 && s.crews[0].hours === 32, JSON.stringify(s.crews));
  const g = await call("supt", { action: "saveCrew", date: today, companyId: "paint-co", manpower: [{ trade: "Painting", headcount: 2, hours: 16 }] });
  ok(g, "GC adds the painters' crew");
  const own = await call("supt", { action: "saveCrew", date: today, manpower: [{ trade: "Site management", headcount: 1, hours: 9 }] });
  ok(own, "GC's own crew");
  expect(own.crews.length === 3 && own.missingCrews.length === 0, `crews ${own.crews.length}, missing ${own.missingCrews.length}`);
  refused(await call("sub2", { action: "saveCrew", date: today, manpower: [], version: 99 }), "STATE_CHANGED", "stale crew version");
  const s2 = await call("sub2", { action: "saveCrew", date: today, manpower: [{ trade: "Drywall", headcount: 5, hours: 40 }], notes: "Screws arrived", version: s.crews[0].version });
  ok(s2, "sub2 updates the company's crew");
  expect(mine("DailyLogCrew").filter((x) => x.companyId === "sub-co" && x.dailyLogId === logId).length === 1, "one crew row per company");
});

await test("a subcontractor sees the day's header and their own crew, nothing else", async () => {
  const s = await call("sub", { action: "get", date: today });
  ok(s, "get");
  expect(s.log.status === "draft" && s.log.date === today && s.log.weather?.condition === "rain", "header");
  expect(!("equipment" in s.log) && !("notes" in s.log) && !("deliveries" in s.log) && !("manpowerSummary" in s.log), `sections hidden: ${Object.keys(s.log)}`);
  expect(s.crews.length === 1 && s.crews[0].companyId === "sub-co" && s.history.length === 0 && s.companies.length === 0, "own crew only");
  expect(s.can.editOwnCrew && !s.can.editSections && !s.can.submit, JSON.stringify(s.can));
  const o = await call("other", { action: "get", date: today });
  expect(o.crews.length === 1 && o.crews[0].companyId === "paint-co", "the painter sees the painters");
  const m = await call("sub", { action: "month", month: today.slice(0, 7) });
  expect(m.days.find((x) => x.date === today).headcount === null, "no totals in the calendar");
});

await test("the owner sees a draft only as pending; the document controller reads everything", async () => {
  const o = await call("owner", { action: "get", date: today });
  ok(o, "owner get");
  expect(o.log === null && o.pending === true && o.crews.length === 0, JSON.stringify(o).slice(0, 200));
  const m = await call("owner", { action: "month", month: today.slice(0, 7) });
  expect(m.days.find((x) => x.date === today).status === "pending" && m.can.open === false, "pending in the calendar");
  const d = await call("dc", { action: "get", date: today });
  expect(d.log.equipment.length === 2 && d.crews.length === 3 && d.history.length > 0 && !d.can.editSections && !d.can.submit, "dc reads all");
});

await test("submit: the GC only, from a started day; crews are locked and totals frozen", async () => {
  refused(await call("sub", { action: "submit", date: today }), "NOT_ALLOWED", "sub");
  refused(await call("dc", { action: "submit", date: today }), "NOT_ALLOWED", "dc");
  refused(await call("pm", { action: "submit", date: dayPlus(1) }), "FUTURE_DATE", "tomorrow");
  refused(await call("pm", { action: "submit", date: dayPlus(-3) }), "NO_LOG", "no log");
  const r = await call("supt", { action: "submit", date: today });
  ok(r, "submit");
  expect(r.log.status === "submitted" && r.log.submittedByName === "SUPT" && r.log.submittedAt, "submitted");
  expect(r.log.totalHeadcount === 8 && r.log.totalHours === 65 && r.log.manpowerSummary.length === 3, `totals ${r.log.totalHeadcount} / ${r.log.totalHours}`);
  expect(r.log.manpowerSummary.some((x) => x.companyName === "Dry Walls Ltd" && x.headcount === 5), "company on each row");
  expect(mine("DailyLogCrew").filter((x) => x.dailyLogId === logId).every((x) => x.status === "locked"), "crews locked");
  expect(events(logId).includes("submitted") && r.can.correct === false, "history; the superintendent can't correct");
  refused(await call("pm", { action: "submit", date: today }), "INVALID_TRANSITION", "twice");
  refused(await call("pm", { action: "saveSection", date: today, section: "notes", value: "late" }), "LOG_SUBMITTED", "section after submit");
  refused(await call("sub", { action: "saveCrew", date: today, manpower: [{ headcount: 1 }] }), "LOG_SUBMITTED", "crew after submit");
});

await test("the owner reads a submitted log in full", async () => {
  const o = await call("owner", { action: "get", date: today });
  ok(o, "get");
  expect(o.log.status === "submitted" && o.log.equipment.length === 2 && o.crews.length === 3 && o.history.length > 0, "full");
  expect(!o.can.correct && !o.can.editSections, "read only");
  const m = await call("owner", { action: "month", month: today.slice(0, 7) });
  expect(m.days.find((x) => x.date === today).headcount === 8, "headcount in the calendar");
});

await test("corrections: the PM only, submitted logs only, with a reason; history keeps before and after", async () => {
  refused(await call("supt", { action: "correct", date: today, section: "notes", value: "x", reason: "typo fix" }), "NOT_ALLOWED", "supt");
  refused(await call("pm", { action: "correct", date: today, section: "notes", value: "x", reason: "no" }), "REASON_REQUIRED", "short reason");
  refused(await call("pm", { action: "correct", date: dayPlus(1), section: "notes", value: "x", reason: "draft day" }), "INVALID_TRANSITION", "a draft");
  refused(await call("pm", { action: "correct", date: today, section: "equipment", value: (await call("pm", { action: "get", date: today })).log.equipment, reason: "nothing really" }), "NO_CHANGE", "same rows");
  const r = await call("pm", { action: "correct", date: today, section: "notes", value: "Concrete pour moved to Friday.", reason: "Notes were missing" });
  ok(r, "correct notes");
  expect(r.log.notes === "Concrete pour moved to Friday." && r.log.correctionCount === 1 && r.log.status === "submitted", "corrected");
  const h = r.history.find((x) => x.action === "corrected");
  expect(h && h.reason === "Notes were missing" && h.before === "" && h.after === "Concrete pour moved to Friday.", JSON.stringify(h));
  const c = await call("pm", { action: "correct", date: today, crewCompanyId: "paint-co", manpower: [{ trade: "Painting", headcount: 3, hours: 24 }], reason: "One painter was missed" });
  ok(c, "correct a crew");
  expect(c.log.totalHeadcount === 9 && c.log.totalHours === 73 && c.log.correctionCount === 2, `totals ${c.log.totalHeadcount} / ${c.log.totalHours}`);
  const ch = c.history.find((x) => x.summary.includes("Paint & Co"));
  expect(ch && ch.before.manpower[0].headcount === 2 && ch.after.manpower[0].headcount === 3, JSON.stringify(ch));
  expect(mine("DailyLogCrew").filter((x) => x.dailyLogId === logId).every((x) => x.status === "locked"), "still locked");
});

await test("the month: one row per day, newest data, owners and subs see less", async () => {
  const m = await call("pm", { action: "month", month: today.slice(0, 7) });
  ok(m, "month");
  const t = m.days.find((x) => x.date === today);
  expect(t.status === "submitted" && t.headcount === 9 && t.corrections === 2 && t.condition === "rain", JSON.stringify(t));
  expect(m.can.open === true && m.place === "Hamburg", "can open");
  refused(await call("pm", { action: "month", month: "2026-13" }), "BAD_DATE", "bad month");
});

await test("archived projects are read-only", async () => {
  refused(await call("pm", { action: "open", date: today }, "p2"), "ARCHIVED", "open");
  refused(await call("supt", { action: "saveSection", date: today, section: "notes", value: "x" }, "p2"), "ARCHIVED", "save");
  const m = await call("pm", { action: "month" }, "p2");
  ok(m, "month");
  expect(m.can.open === false && m.days.length === 0, "nothing to open");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
