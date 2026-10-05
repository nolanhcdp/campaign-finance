// Tally (campaigntally.com) — candidate app
// Saves every change to the server under the candidate's report code (and a copy on this device).
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const fmtDate = (d) => { if (!d) return "—"; const [y, m, dd] = d.split("-"); return `${+m}/${+dd}/${y}`; };
const today = () => new Date().toLocaleDateString("en-CA");
const uid = () => "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- Vocabulary ----------
const KINDS = {
  contribution: { label: "Donation (money)", group: "in" },
  inkind: { label: "Donated goods or services", group: "in" },
  loan: { label: "Loan to the campaign", group: "in" },
  interest: { label: "Bank interest", group: "in" },
  misc: { label: "Other money in (refund, sale…)", group: "in" },
  expense: { label: "Campaign expense", group: "out" },
  debt_payment: { label: "Paying back a loan or old bill", group: "out" },
  refund: { label: "Returned a donation", group: "out" },
  transfer_out: { label: "Gave to another campaign or group", group: "out" },
  unpaid_bill: { label: "Bill not paid yet", group: "owed" },
};
const SOURCES = {
  individual: "A person",
  candidate: "Me (the candidate)",
  corporation: "A corporation (Inc. or Corp.)",
  other: "An LLC, partnership or other business (not Inc.)",
  labor: "A union",
  pac: "A PAC",
  committee: "A party or another candidate's committee",
};
const CODES = {
  A: "A — Advertising: signs, printing, shirts, ads, website, mailers",
  F: "F — Fundraising: event space, food, entertainment",
  O: "O — Operations: fees, postage, office, travel, bank fees",
  C: "C — Contribution to another campaign, party or charity",
};
const STEPS = [
  { id: "about", t: "About your campaign" },
  { id: "prior", t: "Your last report" },
  { id: "add", t: "Add your records" },
  { id: "list", t: "Check each entry" },
  { id: "review", t: "Fix problems" },
  { id: "print", t: "Print and file" },
];
const STARTERS = [
  { label: "Someone gave money", text: "[Name] of [street, city, ZIP], who works as [job], gave $[amount] by [check # / cash / card] on [date]." },
  { label: "I paid for something", text: "Paid [who] $[amount] for [what it was for] on [date] by [check # / card / cash]." },
  { label: "I put in my own money", text: "I put in $[amount] of my own money on [date] as a [gift / loan I want paid back]." },
  { label: "I paid a campaign bill myself", text: "I paid [who] $[amount] for [what it was for] on [date] with my personal money." },
  { label: "Someone donated goods or services", text: "[Name] of [street, city, ZIP] donated [what they gave], worth about $[amount], on [date]." },
  { label: "A bill I haven't paid yet", text: "I owe [who] $[amount] for [what it was for], billed on [date]." },
];

// ---------- State ----------
let S = null;            // the report data
let CODE = null;         // resume code
let REV = 0;             // server revision we last saw
let dirty = false, saving = false, saveTimer = null, lastSaved = null, offline = false;
let busy = {};           // in-flight AI jobs by id
let justAdded = [];      // ids added by the last read
let noteErr = "";        // last error from the typing box
let confirmRemove = -1;  // index in S.files awaiting a remove confirmation
let bankErr = "";
let stateMsg = "";
let lastAskId = null;    // the answer currently shown in the question box
let showAllFlags = false;
let showHistory = false;

const isParty = () => S && S.about && S.about.committeeType === "party";
function blank() {
  return {
    v: 2, step: "add", cur: null,
    about: { candidate: "", committee: "", acronym: "", office: "", county: "Howard", party: "", treasurer: "", treasurerTitle: "Treasurer", phone: "", street: "", city: "", state: "IN", zip: "", fileNumber: "", report: "", amendment: false, filesWith: "county" },
    // One committee, one running ledger. Reports are date ranges sliced out of it.
    year: {},        // "2026": { opening: { ledgerFrom, mode, cashBegin, cashJan1, rec15aB, rec15bB, exp17aB, exp17bB }, plan: { status: running|not|closing, office } }
    reports: [],     // { id, type, start, end, due, supp, status: open|filed, external, filedAt, bankBalance, amendment, snapshot }
    cfa11: [],       // 48-hour reports filed: { id, window, key, entryIds, filedAt }
    entries: [], priorDebts: [], files: [], draft: "", aiFlags: null, mustFix: null,
    bank: { statements: [], lines: [] }, ask: [], dismissed: {}, published: {},
  };
}
// Older drafts held one report with "numbers from your last report". Those numbers become the year's opening
// balance, the report becomes the open report, and the April report (filed before Tally) is listed as filed.
function upgrade(d) {
  d = Object.assign(blank(), d || {});
  if (!d.bank) d.bank = { statements: [], lines: [] };
  if (!d.year) d.year = {}; if (!d.reports) d.reports = []; if (!d.cfa11) d.cfa11 = []; if (!d.dismissed) d.dismissed = {}; if (!d.published) d.published = {};
  if (d.v >= 2) return d;
  const type = d.about.report || "Pre-Election", P = CFA.PERIODS_2026[type] || CFA.PERIODS_2026["Pre-Election"];
  const p = d.prior || {}, typed = p.mode === "typed" || p.mode === "upload";
  const n = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
  const opening = typed
    ? { ledgerFrom: P.start, mode: p.mode, readFrom: p.readFrom || "", cashBegin: n(p.cashBegin), cashJan1: n(p.cashJan1), rec15aB: n(p.rec15aB), rec15bB: n(p.rec15bB), exp17aB: n(p.exp17aB), exp17bB: n(p.exp17bB) }
    : p.mode === "first" ? { ledgerFrom: "2026-01-01", mode: "first", cashBegin: 0, cashJan1: 0, rec15aB: 0, rec15bB: 0, exp17aB: 0, exp17bB: 0 }
    : null;
  d.year["2026"] = { opening, plan: { status: "running", office: d.about.office || "" } };
  if (typed && type !== "Pre-Primary") {
    const Q = CFA.PERIODS_2026["Pre-Primary"];
    d.reports.push({ id: "r-preprimary-2026", type: "Pre-Primary", start: Q.start, end: Q.end, due: Q.due, status: "filed", external: true, filedAt: null,
      snapshot: { lines: { l18A: n(p.cashBegin), l18B: n(p.cashBegin), l14: n(p.cashJan1), l15aB: n(p.rec15aB), l15bB: n(p.rec15bB), l17aB: n(p.exp17aB), l17bB: n(p.exp17bB) } } });
  }
  const cur = { id: "r-" + type.toLowerCase().replace(/[^a-z]/g, "") + "-2026", type, start: P.start, end: P.end, due: P.due, supp: P.supp || null, status: "open", bankBalance: d.bankBalance || "", amendment: !!d.about.amendment };
  d.reports.push(cur); d.cur = cur.id;
  if (d.step === "prior") d.step = "about";
  delete d.prior; delete d.bankBalance;
  d.v = 2; return d;
}

// ---------- Committee math: opening balances, cash on hand, report periods ----------
const yearOf = (d) => String(d || today()).slice(0, 4);
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
const curReport = () => S.reports.find((r) => r.id === S.cur) || null;
function firstYear() { const ys = Object.keys(S.year).filter((y) => S.year[y]?.opening).sort(); return ys[0] ? +ys[0] : null; }
function openingFor(Y) {
  Y = +Y; const o = S.year[Y]?.opening; if (o) return o;
  const fy = firstYear(); if (fy == null || Y <= fy) return null;           // first year, not answered yet
  const cash = cashEndOf(Y - 1);                                            // carried forward automatically
  return { ledgerFrom: `${Y}-01-01`, mode: "carried", cashBegin: cash, cashJan1: cash, rec15aB: 0, rec15bB: 0, exp17aB: 0, exp17bB: 0 };
}
function cashAt(date) { const o = openingFor(yearOf(date)); return o ? num(num(o.cashBegin) + CFA.netCash(S.entries, o.ledgerFrom, date)) : 0; }
function cashEndOf(Y) { const o = openingFor(Y); return o ? num(num(o.cashBegin) + CFA.netCash(S.entries, o.ledgerFrom, `${+Y + 1}-01-01`)) : 0; }
const cashToday = () => cashAt(new Date(Date.now() + 864e5).toLocaleDateString("en-CA"));
function planFor(Y) { return S.year[Y]?.plan || null; }
// Every report the committee owes in a year, merged with the ones already started or filed.
function reportsForYear(Y) {
  const plan = planFor(Y), running = plan ? plan.status === "running" : !!CFA.CALENDARS[Y];
  const periods = CFA.periodsFor(+Y, running, isParty() ? "party" : "candidate");
  const o = openingFor(Y);
  const out = [];
  for (const [type, P] of Object.entries(periods)) {
    const have = S.reports.find((r) => r.type === type && yearOf(r.end) === String(Y));
    if (have) { out.push(have); continue; }
    if (o && P.end < o.ledgerFrom) continue;                                 // before Tally; filed on paper
    out.push({ id: null, type, start: P.start, end: P.end, due: P.due, supp: P.supp || null, status: "todo" });
  }
  for (const r of S.reports) if (yearOf(r.end) === String(Y) && !out.includes(r)) out.push(r);  // Final, Outgoing Treasurer, etc.
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
function committeeYears() {
  const ys = new Set([...Object.keys(S.year), ...S.reports.map((r) => yearOf(r.end)), yearOf()]);
  const fy = firstYear(); return [...ys].filter((y) => fy == null || +y >= fy).sort();
}
function startReport(type, start, end, due, supp) {
  const r = { id: uid(), type, start, end, due, supp: supp || null, status: "open", bankBalance: "", amendment: false };
  S.reports.push(r); S.cur = r.id; S.about.report = type; S.step = needsPrior(r) ? "about" : "add";
  changed(); render(); window.scrollTo({ top: 0 });
}
function openReport(id, step) { const r = S.reports.find((x) => x.id === id); if (!r) return; S.cur = id; S.about.report = r.type; S.step = step || (r.status === "filed" ? "print" : S.step === "about" || S.step === "add" ? S.step : "add"); changed(); render(); window.scrollTo({ top: 0 }); }
function goDash() { S.cur = null; S.step = "dash"; changed(); render(); window.scrollTo({ top: 0 }); }
// The "numbers from your last report" step is only needed for the committee's first report in Tally.
function needsPrior(rep) {
  const Y = yearOf(rep.end), o = openingFor(Y);
  if (o && o.mode === "carried") return false;
  return !S.reports.some((r) => r.id !== rep.id && !r.external && yearOf(r.end) === Y && r.end < rep.start);
}
// Answer to "did you file a report earlier this year?" for the open report's year.
function setOpening(mode) {
  const rep = curReport(), Y = yearOf(rep.end), cur = S.year[Y]?.opening;
  if (!mode) { if (S.year[Y]) S.year[Y].opening = null; return null; }
  const o = cur && cur.mode !== "first" && mode !== "first" ? cur : { cashBegin: "", cashJan1: "", rec15aB: "", rec15bB: "", exp17aB: "", exp17bB: "", readFrom: "" };
  o.mode = mode; o.ledgerFrom = mode === "first" ? `${Y}-01-01` : rep.start;
  if (mode === "first") Object.assign(o, { cashBegin: 0, cashJan1: 0, rec15aB: 0, rec15bB: 0, exp17aB: 0, exp17bB: 0 });
  S.year[Y] = { ...(S.year[Y] || {}), opening: o }; if (!S.year[Y].plan && CFA.CALENDARS[Y]) S.year[Y].plan = { status: "running", office: S.about.office || "" };
  return o;
}
const reportLabel = (r) => r.type === "Annual" ? `${yearOf(r.end)} annual report` : r.type === "Final" ? "Final report" : `${yearOf(r.end)} ${r.type.toLowerCase()} report`;

// ---------- Sample campaign (sandbox) ----------
// /demo opens a made-up committee. Nothing is saved, and the parts that call the AI are switched off.
const DEMO_CODE = "SAMPLE";
const isDemo = () => CODE === DEMO_CODE;
const DEMO_AI_MSG = "Reading photos and PDFs and answering questions use AI, which is switched off in the sample. Set up your own committee (free) to try them with your own records.";
function startDemo() {
  const wantsImport = /[?&]import=sample\b/.test(location.search);
  CODE = DEMO_CODE; REV = 0; dirty = false; lastSaved = null;
  S = upgrade(window.TALLY_SAMPLE());
  history.replaceState(null, "", "/demo");
  $("#demoBar").hidden = false;
  showApp();
  if (wantsImport) { openReport(S.reports.find((r) => r.status === "open").id, "add"); importSampleSheet(true); }
}
// One-click import of the sample spreadsheet, so visitors can watch a spreadsheet get sorted.
async function importSampleSheet(thenCheck) {
  try {
    const blob = await (await fetch("/samples/messy-donations.xlsx")).blob();
    await readFiles([new File([blob], "messy-donations.xlsx", { type: blob.type })]);
    if (thenCheck) { S.step = "list"; render(); window.scrollTo({ top: 0 }); }
  } catch (e) { alert("Couldn't load the sample sheet: " + e.message); }
}

// ---------- Saving ----------
const LS = (code) => "cfh-draft-" + code;
function localSave() { if (isDemo()) return; try { localStorage.setItem(LS(CODE), JSON.stringify({ data: S, rev: REV, dirty, at: Date.now() })); localStorage.setItem("cfh-last-code", CODE); } catch (e) {} }
function changed() { if (isDemo()) { dirty = false; setSave(); return; } dirty = true; localSave(); setSave(); clearTimeout(saveTimer); saveTimer = setTimeout(pushSave, 1200); }
async function pushSave() {
  if (!dirty || saving || !CODE || isDemo()) return;
  saving = true; setSave();
  const snap = JSON.stringify(S);
  try {
    const r = await fetch("/api/draft", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: CODE, rev: REV, data: S }) });
    const j = await r.json();
    if (r.status === 409) { $("#conflictBar").hidden = false; saving = false; setSave(); return; }
    if (!r.ok) throw new Error(j.error || "save failed");
    REV = j.rev; lastSaved = new Date(j.updatedAt); offline = false;
    if (JSON.stringify(S) === snap) dirty = false;
    localSave();
  } catch (e) { offline = true; }
  saving = false; setSave();
  if (dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(pushSave, offline ? 8000 : 800); }
}
function setSave() {
  const el = $("#saveState"); if (!el) return;
  el.className = "save";
  if (isDemo()) { el.textContent = "Sample campaign · nothing is saved"; return; }
  if (saving) el.innerHTML = '<span class="spinner"></span> Saving…';
  else if (offline) { el.className = "save bad"; el.textContent = "Can't reach the server. Your work is kept on this device and will save when you're back online."; }
  else if (dirty) el.textContent = "Unsaved changes";
  else if (lastSaved) el.textContent = "All changes saved " + lastSaved.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  else el.textContent = "";
}
window.addEventListener("beforeunload", (e) => { if (dirty) { pushSave(); e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("online", () => { offline = false; pushSave(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushSave(); });

async function openCode(code) {
  const r = await fetch("/api/draft?code=" + encodeURIComponent(code));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Couldn't open that report.");
  CODE = j.code; REV = j.rev; lastSaved = j.updatedAt ? new Date(j.updatedAt) : null;
  let local = null; try { local = JSON.parse(localStorage.getItem(LS(CODE)) || "null"); } catch (e) {}
  if (local && local.dirty && local.rev === j.rev && local.data) { S = local.data; dirty = true; }  // finish an offline save
  else S = j.data || blank();
  if (!(S && S.v >= 2)) dirty = true;   // save back in the current shape
  S = upgrade(S);
  history.replaceState(null, "", "/r/" + CODE);
  showApp();
  if (dirty) pushSave();
  publishPriorOnce();
}

// ---------- Support (Venmo) ----------
const CFG = window.CFH || {};
const venmoUrl = (amt) => !CFG.venmo ? "" : amt
  ? `https://venmo.com/${encodeURIComponent(CFG.venmo)}?txn=pay&amount=${amt}&note=${encodeURIComponent("Tally")}`
  : `https://venmo.com/u/${encodeURIComponent(CFG.venmo)}`;
const SUGGESTED = [10, 25, 50];
function supportPanel() {
  if (!CFG.venmo) return "";
  return `<div class="panel thanksbox"><div><b>If Tally saved you an evening</b><p>I run it on my own time and every report costs money to host and process. Send what feels fair on Venmo (@${esc(CFG.venmo)}) if you can.</p></div>
    <a class="btn ghost" href="${venmoUrl()}" target="_blank" rel="noopener">Chip in on Venmo</a></div>`;
}
function wireLanding() {
  document.querySelectorAll("[data-venmo]").forEach((a) => { if (CFG.venmo) a.href = venmoUrl(); else a.closest(".support")?.remove(); });
  document.querySelectorAll("[data-contact]").forEach((a) => { if (CFG.contactEmail) a.href = `mailto:${CFG.contactEmail}?subject=${encodeURIComponent("Tally for our county")}`; else a.closest(".spread")?.remove(); });
}

// ---------- Start screen ----------
function showStart() {
  $("#startView").hidden = false; $("#appView").hidden = true;
  wireLanding(); wireSignup();
  if (location.hash === "#signup") setTimeout(() => $("#signup")?.scrollIntoView(), 50);
  let last = null; try { last = localStorage.getItem("cfh-last-code"); } catch (e) {}
  if (last) $("#resumeCode").value = last;
}
$("#resumeForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const err = $("#resumeErr"); err.hidden = true;
  try { await openCode($("#resumeCode").value); } catch (x) { err.textContent = x.message; err.hidden = false; }
});
$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const err = $("#newErr"); err.hidden = true;
  try {
    const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessCode: $("#signupCode").value }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    CODE = j.code; REV = 0; S = blank(); S.step = "about"; history.replaceState(null, "", "/r/" + CODE);
    showApp(); changed(); showCode(true);
  } catch (x) { err.textContent = x.message; err.hidden = false; }
});
// ---------- Open sign-up ----------
let turnstileKey = "";
async function wireSignup() {
  try { const j = await (await fetch("/api/signup")).json(); turnstileKey = j.turnstileSiteKey || ""; } catch (e) {}
  if (turnstileKey && !window.turnstile) {
    window.onTurnstile = () => window.turnstile.render("#su-turnstile", { sitekey: turnstileKey });
    const sc = document.createElement("script"); sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstile"; sc.async = true; document.head.appendChild(sc);
  }
}
$("#toSignup")?.addEventListener("click", (e) => { e.preventDefault(); $("#signup").scrollIntoView({ behavior: "smooth" }); setTimeout(() => $("#su-candidate").focus(), 400); });
document.addEventListener("change", (e) => {
  if (e.target.name === "su-kind") {
    const party = e.target.value === "party";
    $("#su-candidate-label").textContent = party ? "Your name" : "Candidate's name";
    $("#su-office-wrap").hidden = party;
    document.querySelector('.su-where:not(.su-kind)').hidden = party;   // party committees file with the county
  }
});
document.addEventListener("change", (e) => { if (e.target.name === "su-where") $("#su-county-label").textContent = e.target.value === "state" ? "County you live in" : "County where you file"; });
$("#signupForm")?.addEventListener("submit", async (e) => {
  e.preventDefault(); const err = $("#su-err"); err.hidden = true;
  const v = (id) => ($("#su-" + id)?.value || "").trim();
  const kind = document.querySelector('input[name="su-kind"]:checked')?.value === "party" ? "party" : "candidate";
  const body = { committeeType: kind, candidate: v("candidate"), committee: v("committee"), office: v("office"), county: v("county"), email: v("email"), phone: v("phone"), website: v("website"),
    token: document.querySelector('#su-turnstile input[name="cf-turnstile-response"]')?.value || "" };
  if (!body.candidate || !body.committee || !body.county || !body.email) { err.textContent = `Fill in ${kind === "party" ? "your name" : "the candidate's name"}, committee name, county and email.`; err.hidden = false; return; }
  const btn = $("#su-btn"); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Setting up…';
  try {
    const r = await fetch("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "Something went wrong.");
    CODE = j.code; REV = 0; S = blank(); S.step = "about";
    const where = kind === "party" ? "county" : document.querySelector('input[name="su-where"]:checked')?.value === "state" ? "state" : "county";
    Object.assign(S.about, kind === "party"
      ? { committeeType: "party", candidate: "", contact: body.candidate, committee: body.committee, office: "", county: body.county, phone: body.phone, filesWith: where }
      : { committeeType: "candidate", candidate: body.candidate, committee: body.committee, office: body.office, county: body.county, phone: body.phone, filesWith: where });
    history.replaceState(null, "", "/r/" + CODE);
    showApp(); changed(); showCode(true);
  } catch (x) { err.textContent = x.message; err.hidden = false; window.turnstile?.reset?.(); }
  btn.disabled = false; btn.textContent = "Create my committee";
});
$("#restoreBtn").addEventListener("click", () => $("#restoreIn").click());
$("#restoreIn").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j.code || !j.data) throw new Error();
    CODE = j.code; S = upgrade(j.data);
    const r = await fetch("/api/draft?code=" + encodeURIComponent(CODE)); const k = await r.json();
    REV = r.ok ? k.rev : 0; showApp(); changed();
  } catch (x) { $("#resumeErr").textContent = "That file isn't a backup from this tool."; $("#resumeErr").hidden = false; }
});

function showCode(first) {
  if (isDemo()) { location.href = "/#signup"; return; }
  const link = location.origin + "/r/" + CODE;
  $("#codeBody").innerHTML = `
    <h2>${first ? "Save your report code" : "Your report code"}</h2>
    <p class="muted" style="margin:0">Everything you do saves automatically. To come back later, on this or any other device, open your link or enter this code.</p>
    <div class="bigcode">${CODE}</div>
    <div class="linkbox">${esc(link)}</div>
    <div class="row"><button class="btn" type="button" data-copy="${esc(link)}">Copy my link</button>
      <a class="btn ghost" href="mailto:?subject=${encodeURIComponent("My campaign finance report link")}&body=${encodeURIComponent("Open my report: " + link + "\nReport code: " + CODE)}">Email it to myself</a></div>
    <p class="hint" style="margin:0">Keep this code private. Anyone with it can open your report.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-closedlg>${first ? "I saved it, let's start" : "Close"}</button></div>`;
  $("#codeDlg").showModal();
}
$("#showCodeBtn").addEventListener("click", () => showCode(false));
$("#reloadBtn").addEventListener("click", async () => { dirty = false; $("#conflictBar").hidden = true; await openCode(CODE); });

// ---------- Report math ----------
function buildReport(rep = curReport()) {
  const a = S.about, Y = yearOf(rep.end);
  const o = openingFor(Y) || { ledgerFrom: `${Y}-01-01`, cashBegin: 0, cashJan1: 0, rec15aB: 0, rec15bB: 0, exp17aB: 0, exp17bB: 0 };
  return {
    reportType: rep.type, start: rep.start, end: rep.end, committeeType: isParty() ? "party" : "candidate", period: { start: rep.start, end: rep.end, due: rep.due, supp: rep.supp }, ledgerFrom: o.ledgerFrom,
    fileNumber: a.fileNumber, amendment: !!rep.amendment, treasurerTitle: a.treasurerTitle, treasurer: a.treasurer, today: today(),
    committee: { name: a.committee, acronym: a.acronym, phone: a.phone, street: a.street, city: a.city, state: a.state, zip: a.zip, party: a.party },
    candidate: { name: a.candidate, party: a.party, office: a.office, county: a.county },
    cashBegin: cashAt(rep.start), cashJan1: num(o.cashJan1),
    prior: { rec15aB: num(o.rec15aB), rec15bB: num(o.rec15bB), exp17aB: num(o.exp17aB), exp17bB: num(o.exp17bB) },
    bankBalance: rep.bankBalance,
    entries: S.entries.filter((e) => e.kind !== "unpaid_bill"),
    debts: priorDebtsDeduped().concat(S.entries.filter((e) => e.kind === "unpaid_bill").map((e) => ({ id: e.id, creditor: e.name, address: addr(e), amount: e.amount, nature: e.purpose ? "Unpaid bill: " + e.purpose : "Unpaid bill", date: e.date }))),
  };
}
// A loan read in from the last report's Schedule D is the same loan as the one on its Schedule A; count it once.
function priorDebtsDeduped() {
  const loans = S.entries.filter((e) => e.kind === "loan");
  return S.priorDebts.filter((d) => !loans.some((l) => nameKey(l.name) === nameKey(d.creditor) && Math.abs(num(l.amount) - num(d.amount)) < 0.005));
}
const addr = (e) => [e.street, [e.city, [e.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean);
const inPeriod = (e, rep) => e.date && e.date >= rep.start && e.date <= rep.end;
function results(rep = curReport()) {
  const C = CFA.compute(buildReport(rep));
  const extra = [];
  for (const e of S.entries) {
    if (!inPeriod(e, rep) && e.kind !== "unpaid_bill") continue;   // other reports' entries are checked on their own report
    if (e.question) extra.push({ sev: "check", ids: [e.id], msg: e.question, fix: "Open the entry, fix anything needed, and save it to clear this." });
    if (!(Number(e.amount) > 0)) extra.push({ sev: "must_fix", ids: [e.id], msg: `${e.name || "An entry"} has no amount.`, fix: "Enter the dollar amount.", fields: ["amount"] });
    if (KINDS[e.kind]?.group === "in" && !e.source) extra.push({ sev: "must_fix", ids: [e.id], msg: `What kind of donor is ${e.name || "this"}: a person, a corporation, an LLC, a union, a PAC?`, fix: "The form has a separate page for each kind. Use the “Sort your donors” buttons on the Check Each Entry step.", step: "list", fields: ["source"] });
    if (e.sourceGuessed && e.source) extra.push({ sev: "check", ids: [e.id], msg: `We filed ${e.name} as ${({ corporation: "a corporation", other: "an LLC or other business", labor: "a union", pac: "a PAC", committee: "a party or candidate committee" })[e.source] || e.source} because ${e.sourceGuessed}.`, fix: "If that's right, nothing to do. If not, open the entry and change “Who are they?”", fields: ["source"] });
    if (e.codeGuessed && e.code && KINDS[e.kind]?.group === "out") extra.push({ sev: "check", ids: [e.id], msg: `We coded the ${money(e.amount)} payment to ${e.name || "this vendor"} as O (operations) because “${e.purpose || "no purpose given"}” didn't tell us more.`, fix: "Change the code if it was advertising (A), a fundraiser cost (F) or a gift to another campaign (C).", fields: ["code"] });
  }
  const a = S.about;
  for (const [k, l] of [["committee", "committee name"], ...(isParty() ? [] : [["candidate", "candidate name"], ["office", "office sought"]]), ["treasurer", "treasurer's name"], ["street", "mailing address"], ["city", "city"], ["zip", "ZIP code"]])
    if (!a[k]) extra.push({ sev: "must_fix", ids: [], msg: `The cover page is missing the ${l}.`, fix: "Fill it in on the first step.", step: "about" });
  if (rep.type === "Final" && Math.abs(C.lines.l18A) > 0.009) extra.push({ sev: "must_fix", ids: [], msg: `A final report has to end with $0 in the account; this one ends at ${money(C.lines.l18A)}.`, fix: "Give the surplus to a party committee, another candidate, or a charity (or return it to donors), enter that payment, and the balance will reach zero. Then close the bank account." });
  if (rep.type === "Final" && Math.abs(C.lines.l19) > 0.009) extra.push({ sev: "must_fix", ids: [], msg: `A committee can't close while it still owes ${money(C.lines.l19)}.`, fix: "Pay the debt (or have it forgiven and reported as an in-kind contribution), then enter the payment." });
  const o = openingFor(yearOf(rep.end));
  if (!o) extra.push({ sev: "must_fix", ids: [], msg: "We need the numbers from your last report.", fix: "Go to “Your last report” and fill it in, or say this is your first report.", step: "prior" });
  if (o && (o.mode === "typed" || o.mode === "upload") && rep.start === o.ledgerFrom) {
    const earlierNames = new Set(S.entries.filter((e) => e.date && e.date < rep.start).map((e) => (e.name || "").trim().toLowerCase()));
    if (!earlierNames.size && num(o.rec15aB) > 0 && S.entries.some((e) => KINDS[e.kind]?.group === "in" && e.name && e.date >= rep.start && !isActBlueEntry(e) && Number(e.amount) > 0))
      extra.push({ sev: "tip", ids: [], msg: "Your April report had itemized donors. If any of them gave again this period, add their earlier gifts too (with the earlier dates) so their yearly totals are right.", fix: "Easiest way: upload your April report on the “Your last report” step and we pull those in for you." });
  }
  for (const g of donorGroups()) if (g.list.some((e) => inPeriod(e, rep))) extra.push({ sev: "check", ids: g.list.map((e) => e.id), step: "list", msg: g.v.name.length > 1 ? `${g.v.name.join(" and ")} may be the same person.` : `${g.v.name[0]} is entered with different ${g.v.address.length > 1 ? "addresses" : g.v.occupation.length > 1 ? "jobs" : "donor types"}.`, fix: "Use the merge card at the top of Check Each Entry to make them one person, or mark them as different people." });
  const bk = bankCheck(rep);
  for (const l of bk.lines) extra.push({ sev: "check", ids: [], bankLine: l.id, msg: `Your bank shows ${money(l.amount)} ${l.dir === "in" ? "coming in" : "going out"} on ${fmtDate(l.date)}${l.check ? ", check #" + l.check : ""}${l.desc ? " (" + l.desc.slice(0, 40) + ")" : ""}, and it isn't in your report.`, fix: l.dir === "in" ? "If it's a donation or your own money, add it with who it came from. If it's not campaign money, hide it." : "If the campaign paid this, add it with who was paid and what for. If it's not campaign money, hide it." });
  for (const e of bk.entries) extra.push({ sev: "check", ids: [e.id], msg: `You entered ${money(e.amount)} ${KINDS[e.kind].group === "in" ? "from" : "to"} ${e.name || "someone"} on ${fmtDate(e.date)}, but nothing like it shows on your bank statement.`, fix: "Usually it was deposited later than the date you entered, or it's still in a drawer. If it cleared more than two weeks after that date, check the amount too." });
  for (const m of bk.mismatches) extra.push({ sev: "check", ids: [m.entry.id], msg: `Check #${m.line.check} is ${money(m.entry.amount)} in your report but ${money(m.line.amount)} at the bank.`, fix: "The bank is usually right. Open the entry and fix the amount." });
  for (const b of bk.balance) if (Math.abs(b.bank - b.report) > 0.009) extra.push({ sev: "check", ids: [], msg: `Your statement's ${b.which} balance on ${fmtDate(b.date)} is ${money(b.bank)}, but the report says ${money(b.report)}.`, fix: `The ${money(Math.abs(b.bank - b.report))} difference usually means a missing ${b.bank > b.report ? "deposit" : "payment or fee"}. Clear the bank items above and this should close.` });
  if (bk.actblue && Math.abs(bk.actblue.deposits - bk.actblue.net) > 2) extra.push({ sev: "check", ids: [], msg: `ActBlue deposited ${money(bk.actblue.deposits)} to your bank in this stretch, but your ActBlue entries net to ${money(bk.actblue.net)} after fees and refunds.`, fix: "Usually a timing difference at the edges of the statement, or an export that's out of date. Re-download your ActBlue export and upload it again." });
  const ai = (S.aiFlags || []).filter((f) => f.reportId === rep.id || !f.reportId).map((f) => ({ sev: f.severity, ids: f.item_ids || [], msg: f.message, fix: f.fix, ai: true }));
  const order = { must_fix: 0, check: 1, tip: 2 };
  // One line per cause: the same message for several entries becomes one flag that points at all of them.
  const byMsg = new Map();
  for (const f of [...C.flags, ...extra, ...ai]) {
    const k = f.sev + "|" + f.msg; if (S.dismissed[k]) continue;
    const have = byMsg.get(k);
    if (have) { have.ids = [...new Set([...(have.ids || []), ...(f.ids || [])])]; have.fields = [...new Set([...(have.fields || []), ...(f.fields || [])])]; }
    else byMsg.set(k, { ...f, ids: [...(f.ids || [])] });
  }
  const flags = [...byMsg.values()].sort((x, y) => order[x.sev] - order[y.sev]);
  return { C, flags };
}

// ---------- Render ----------
function showApp() { $("#startView").hidden = true; $("#appView").hidden = false; $("#showCodeBtn").innerHTML = isDemo() ? "Start your own" : `My code: <span id="codeLabel">${esc(CODE)}</span>`; render(); setSave(); }
const stepsFor = (rep) => STEPS.filter((st) => st.id !== "prior" || needsPrior(rep));
function render() {
  const rep = curReport();
  if (!rep) S.cur = null;
  $("#whoLine").textContent = S.about.committee || S.about.candidate || "New committee";
  if (!rep) {
    if (S.step !== "about") S.step = "dash";
    $("#steps").innerHTML = `<li><button type="button" data-dash ${S.step === "dash" ? 'aria-current="step"' : ""}><span class="n">☰</span>Dashboard</button></li><li><button type="button" data-go="about" ${S.step === "about" ? 'aria-current="step"' : ""}><span class="n">i</span>Committee details</button></li>`;
    $("#progressBox").textContent = `${S.entries.length} entr${S.entries.length === 1 ? "y" : "ies"} on file`;
    $("#main").innerHTML = S.step === "about" ? VIEWS.about() : VIEWS.dash();
    return;
  }
  const steps = stepsFor(rep);
  if (!steps.some((st) => st.id === S.step)) S.step = rep.status === "filed" ? "print" : "add";
  const { flags } = results(rep);
  S.mustFix = flags.filter((f) => f.sev === "must_fix").length;
  const idx = steps.findIndex((st) => st.id === S.step);
  $("#steps").innerHTML = `<li><button type="button" data-dash><span class="n">←</span>Dashboard</button></li><li class="repname">${esc(reportLabel(rep))}</li>` +
    steps.map((st, i) => `<li class="${i < idx ? "done" : ""}"><button type="button" data-go="${st.id}" ${st.id === S.step ? 'aria-current="step"' : ""}><span class="n">${i < idx ? "✓" : i + 1}</span>${st.t}</button></li>`).join("");
  const n = S.entries.filter((e) => inPeriod(e, rep)).length;
  $("#progressBox").textContent = `${n} entr${n === 1 ? "y" : "ies"} this report · ${S.mustFix} to fix`;
  $("#main").innerHTML = VIEWS[S.step]();
  if (S.step === "add") { const ta = $("#notes"); if (ta) $("#coach").innerHTML = coach(ta.value); }
}
// Back / Continue buttons that follow the step list of the open report.
function navRow(back, next, nextLabel = "Continue") {
  const rep = curReport();
  if (rep) { const ids = stepsFor(rep).map((st) => st.id), i = ids.indexOf(S.step); if (back !== null && i > 0) back = ids[i - 1]; else if (i === 0) back = "dash"; if (next !== null && i >= 0 && i < ids.length - 1) next = ids[i + 1]; }
  const backBtn = back === "dash" ? `<button class="btn ghost" data-dash type="button">Dashboard</button>` : back ? `<button class="btn ghost" data-go="${back}" type="button">Back</button>` : "<span></span>";
  return `<div class="nav">${backBtn}${next ? `<button class="btn" data-go="${next}" type="button">${nextLabel}</button>` : rep ? "" : `<button class="btn" data-dash type="button">${nextLabel}</button>`}</div>`;
}
const field = (obj, k, label, hint = "", attrs = "") => `<label for="f-${obj}-${k}">${label}${hint ? ` <small>${hint}</small>` : ""}<input id="f-${obj}-${k}" data-bind="${obj}.${k}" value="${esc(S[obj][k])}" ${attrs}></label>`;

const VIEWS = {
about() {
  const rep = curReport();
  const hn = (S.helperNotes || []).length ? `<div class="panel" style="border-color:var(--warn)"><h3>Notes from your helper</h3><p class="muted" style="margin:4px 0 8px">Your April report (or statement of organization) was read in for you. Check these:</p><ul style="margin:0;padding-left:20px">${S.helperNotes.slice(0, 6).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";
  return `<div><h2>About your campaign</h2><p class="lead">This goes on the cover page of every report. Use the committee name and file number from your ${isParty() ? "CFA-3" : "CFA-1"} statement of organization.</p></div>${hn}
  <div class="panel grid">
    ${field("about", "committee", "Committee name", "exactly as on your CFA-1")}
    ${field("about", "fileNumber", S.about.filesWith === "state" ? "Committee ID" : "File number", S.about.filesWith === "state" ? "assigned by the Election Division; it's on your CFA-1" : "from the county election board")}
    <label for="f-committeeType">Type of committee<select id="f-committeeType" data-bind="about.committeeType"><option value="candidate" ${!isParty() ? "selected" : ""}>Candidate's committee</option><option value="party" ${isParty() ? "selected" : ""}>Regular party committee (county or local party)</option></select></label>
    ${isParty() ? "" : field("about", "candidate", "Candidate's full name", "include any nickname on the ballot")}
    ${isParty() ? "" : field("about", "office", "Office sought", "include district, like “County Council, District 2”")}
    ${field("about", "party", "Party", "or “Independent candidate”")}
    ${field("about", "county", "County of residence")}
    ${field("about", "treasurer", "Treasurer's name")}
    ${field("about", "phone", "Committee phone")}
    ${field("about", "street", "Committee mailing address")}
    ${field("about", "city", "City")}
    ${field("about", "state", "State")}
    ${field("about", "zip", "ZIP code", "", 'inputmode="numeric"')}
    <label for="f-filesWith">Where do you file?<select id="f-filesWith" data-bind="about.filesWith"><option value="county" ${S.about.filesWith !== "state" ? "selected" : ""}>County election board (county, city, town, township, school board, judge, prosecutor)</option><option value="state" ${S.about.filesWith === "state" ? "selected" : ""}>Indiana Election Division online (State Representative or State Senator)</option></select></label>
  </div>
  ${rep ? `<p class="muted">This is the <b>${esc(reportLabel(rep))}</b>, covering ${fmtDate(rep.start)} to ${fmtDate(rep.end)}, due ${S.about.filesWith === "state" ? "online at campaignfinance.in.gov" : "to the county election board"} by <b>noon on ${fmtDate(rep.due)}</b>. Late reports are fined $50 a day.</p>` : ""}
  ${navRow(null, rep ? "add" : null, rep ? "Continue" : "Go to my dashboard")}`;
},
prior() {
  const rep = curReport(), Y = yearOf(rep.end), o = S.year[Y]?.opening || null, m = o ? (o.mode === "typed" ? "upload" : o.mode) : "";
  const opt = (k, t, d) => `<button type="button" data-prior="${k}" aria-pressed="${m === k}"><b>${t}</b><small>${d}</small></button>`;
  const hint = (n, t) => `<span class="numchip">${n}</span> ${t}`;
  const numField = (n, k, label) => `<label for="f-opening-${k}"><span>${hint(n, label)}</span><input id="f-opening-${k}" data-bind="opening.${k}" inputmode="decimal" value="${esc(o?.[k] ?? "")}" placeholder="0.00"></label>`;
  let body = "";
  if (m === "first") body = `<div class="panel"><p style="margin:0"><b>Good, that's the easy case.</b> Everything starts at zero, plus whatever you add in the next step.</p></div>`;
  if (m === "upload") body = `
    <div class="panel type">
      <h3>Take a photo of page 1 of your April report</h3>
      <p class="muted" style="margin:0">The first page is all we need. We'll read the six numbers off it and fill them in below for you to check.</p>
      <label class="drop" for="priorIn" style="padding:16px"><strong>Choose a photo or PDF</strong><p>The page with the boxes labeled 13 through 20.</p><input id="priorIn" type="file" multiple hidden accept="image/*,.pdf"></label>
      ${busy.prior ? jobBox("prior") : ""}
      ${o?.readFrom ? `<p class="hint" style="margin:0">Filled in from ${esc(o.readFrom)}. Check the numbers against the page.</p>` : ""}
    </div>
    <div class="or"><span>Or copy the six numbers yourself</span></div>
    <div class="panel" style="display:flex;flex-direction:column;gap:14px">
      <p style="margin:0">On page 1 of your April report, find these six boxes. Copy each one into the matching field.</p>
      <img src="/img-last-report.png" alt="The summary box on page 1 of a CFA-4, with six cells numbered 1 to 6" style="width:100%;border:1px solid var(--line);border-radius:8px">
      <div class="grid">
        ${numField(1, "cashBegin", "Cash at the end of that report (line 18, left column)")}
        ${numField(2, "cashJan1", "Cash on January 1 (line 14)")}
        ${numField(3, "rec15aB", "Itemized contributions (line 15a, right column)")}
        ${numField(4, "rec15bB", "Unitemized contributions (line 15b, right column)")}
        ${numField(5, "exp17aB", "Itemized expenditures (line 17a, right column)")}
        ${numField(6, "exp17bB", "Unitemized expenditures (line 17b, right column)")}
      </div>
      <p class="hint" style="margin:0">Blank boxes on your report mean zero. If your committee started this year, box 2 is usually 0.</p>
    </div>
    ${S.priorDebts.length ? `<div class="panel"><h3>Unpaid debts carried over from that report</h3><ul>${S.priorDebts.map((d) => `<li>${esc(d.creditor)}: ${money(d.amount)} (${esc(d.nature || "")})</li>`).join("")}</ul></div>` : ""}`;
  return `<div><h2>Your last report</h2><p class="lead">This report covers ${fmtDate(rep.start)} to ${fmtDate(rep.end)}. It picks up where your last one left off, so a few numbers carry over, and the form also wants each donor's total for the whole year. You only do this once; later reports carry forward on their own.</p></div>
  <h3>Did you file a campaign finance report (CFA-4) earlier this year?</h3>
  <div class="choice">${opt("upload", "Yes, I filed a report in April", "We'll get six numbers from it")}${opt("first", "No, I haven't filed a CFA-4 yet", "This will be my first one")}</div>
  ${body}
  ${navRow("about", "add")}`;
},
dash() {
  const Y = yearOf(), years = committeeYears(), o = openingFor(Y);
  const todayStr = today();
  // Year-to-date numbers from the ledger (opening numbers + everything since).
  let ytd = null;
  if (o) { const C = CFA.compute(buildReport({ id: "ytd", type: "Annual", start: o.ledgerFrom, end: todayStr, due: "", supp: null })); ytd = C.lines; }
  const tiles = ytd ? [["Cash on hand", money(cashToday())], [`Raised in ${Y}`, money(ytd.l15cB)], [`Spent in ${Y}`, money(ytd.l17cB)], ["Debts you owe", money(ytd.l19)]].map(([l, v]) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`).join("") : "";
  // Things that need attention, one line each.
  const items = [];
  for (const it of cfa11Items()) if (!it.filed) items.push({ cls: "bad", msg: `${it.name} gave ${money(it.total)} since ${fmtDate(it.window.start)}. A CFA-11 “large contribution” report is due ${it.dueText}.`, btn: `<button class="btn small" type="button" data-cfa11="${esc(it.key)}">Build the CFA-11</button><button class="btn ghost small" type="button" data-cfa11filed="${esc(it.key)}">I filed it</button>` });
  for (const r of S.reports) if (r.status === "open" && r.due && daysUntil(r.due) <= 30) {
    const bad = results(r).flags.filter((f) => f.sev === "must_fix").length;
    if (bad) items.push({ cls: "bad", msg: `${reportLabel(r)}: ${bad} item${bad === 1 ? "" : "s"} to fix before you file (due noon ${fmtDate(r.due)}).`, btn: `<button class="btn ghost small" type="button" data-open="${r.id}" data-step="review">Open</button>` });
  }
  for (const r of S.reports) if (r.status === "filed" && !r.external && changedSinceFiled(r)) items.push({ cls: "warn", msg: `Entries dated inside the ${reportLabel(r)} changed after you filed it. If the filed report is now wrong, file an amendment.`, btn: `<button class="btn ghost small" type="button" data-open="${r.id}" data-step="print">Open</button>` });
  if (CFG.corpCheck) for (const c of corpWarnings()) items.push({ cls: "warn", msg: `${c.name} has also given to another candidate using Tally this year. Corporations and unions may give $2,000 total to all local candidates in Indiana combined, so confirm their total with them.`, btn: `<button class="btn ghost small" type="button" data-dismiss="corp|${esc(c.key)}">I checked</button>` });
  const attention = items.length ? `<div class="flags">${items.map((i) => `<div class="flag ${i.cls}"><div class="bar"></div><div><b>${esc(i.msg)}</b></div><div class="row">${i.btn}</div></div>`).join("")}</div>` : "";
  // The yearly question.
  const plan = planFor(Y);
  const planBox = !plan && o && !isParty() ? `<div class="panel type"><h3>What's happening with this committee in ${Y}?</h3>
    <div class="choice">
      <button type="button" data-plan="running"><b>Running for office in ${Y}</b><small>Pre-primary, pre-election and 48-hour reports apply</small></button>
      <button type="button" data-plan="not"><b>Not on the ballot in ${Y}</b><small>Only the annual report, due next January</small></button>
      <button type="button" data-plan="closing"><b>Closing the committee</b><small>Spend down to zero and file a final report</small></button>
    </div></div>` : "";
  const planLine = plan ? `<p class="hint" style="margin:0">${plan.status === "running" ? `Running in ${Y}${CFA.CALENDARS[Y] ? "" : ". The " + Y + " filing dates aren't loaded yet; the annual report is listed until they are"}.` : plan.status === "not" ? `Not on the ballot in ${Y}: the only report due is the annual one.` : `Closing the committee.`} <button class="linkbtn" type="button" data-plan="">Change</button></p>` : "";
  // Reports table across years.
  const rows = years.flatMap((y) => reportsForYear(y).map((r) => {
    const st = r.status === "filed" ? (r.external ? '<span class="pill ok">filed on paper</span>' : `<span class="pill ok">filed ${r.filedAt ? fmtDate(r.filedAt) : ""}</span>`) : r.status === "open" ? '<span class="pill warn">in progress</span>' : r.start > todayStr ? '<span class="pill">not yet</span>' : r.due && r.due < todayStr ? '<span class="pill">not started</span>' : '<span class="pill">not started</span>';
    const note = r.status === "todo" && r.due && r.due < todayStr ? '<div class="src">Due date passed. Skip it if you weren\'t a candidate yet.</div>' : "";
    const act = r.status === "filed" ? (r.external ? "" : `<button class="btn ghost small" type="button" data-open="${r.id}">Open</button>`) : r.status === "open" ? `<button class="btn small" type="button" data-open="${r.id}">Continue</button>` : `<button class="btn ghost small" type="button" data-startreport="${esc(r.type)}|${r.start}|${r.end}|${r.due}|${(r.supp || []).join(",")}">Start</button>`;
    return `<div class="reprow"><div><b>${esc(reportLabel(r))}</b><div class="src">${fmtDate(r.start)} – ${fmtDate(r.end)}${r.due ? ` · due noon ${fmtDate(r.due)}` : ""}</div>${note}</div><div class="row">${st}${act}</div></div>`;
  }));
  // Donors and payees on file this year.
  const people = peopleBook();
  const book = people.donors.length || people.payees.length ? `<details class="tipsbox panel"><summary>Donors and payees on file (${people.donors.length} donors, ${people.payees.length} payees)</summary>
    <p class="muted" style="margin:6px 0 10px">Tap a name to add another entry for them without retyping their details.</p>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Address</th><th class="amt">This year</th><th>Entries</th><th></th></tr></thead><tbody>
    ${people.donors.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.address)}</td><td class="amt">${money(d.total)}</td><td>${d.n}</td><td><button class="btn ghost small" type="button" data-again="${esc(d.id)}">Add a gift</button></td></tr>`).join("")}
    ${people.payees.map((d) => `<tr><td>${esc(d.name)} <span class="src">paid</span></td><td>${esc(d.address)}</td><td class="amt">${money(d.total)}</td><td>${d.n}</td><td><button class="btn ghost small" type="button" data-again="${esc(d.id)}">Add a payment</button></td></tr>`).join("")}
    </tbody></table></div></details>` : "";
  return `<div><h2>${esc(S.about.committee || S.about.candidate || "Your committee")}</h2><p class="lead">${esc([S.about.candidate, S.about.office].filter(Boolean).join(" · "))}${o ? "" : " Start your first report below; it will ask for the numbers from your last filed report."}</p></div>
  ${tiles ? `<div class="summary">${tiles}</div>` : ""}
  ${attention}
  <div class="panel type"><h3>Add to your books</h3><p class="muted" style="margin:0 0 10px">Enter things as they happen. Each report picks up what falls in its dates.</p>
    <div class="choice">
      <button type="button" data-newkind="contribution"><b>Money came in</b><small>A donation, a loan, your own money, or donated goods</small></button>
      <button type="button" data-newkind="expense"><b>Money went out</b><small>Something the campaign paid for, or a bill you owe</small></button>
    </div></div>
  ${planBox}
  <div class="panel"><h3>Reports</h3>${planLine}
    <div class="replist">${rows.join("") || '<p class="empty">Nothing due yet.</p>'}</div>
    ${cfa11Items().some((i) => i.filed) ? `<p class="hint" style="margin:10px 0 0">48-hour reports filed: ${cfa11Items().filter((i) => i.filed).map((i) => `${esc(i.name)} (${fmtDate(i.filedAt)})`).join(", ")}.</p>` : ""}
  </div>
  ${book}
  <div class="row" style="justify-content:space-between"><button class="btn ghost small" type="button" data-go="about">Committee details</button><button class="btn ghost small" type="button" data-act="backup">Download a backup file</button></div>`;
},
add() {
  const recent = justAdded.length ? `<div class="added"><b>Added ${justAdded.length} entr${justAdded.length === 1 ? "y" : "ies"}.</b> <button class="linkbtn" type="button" data-go="list">Check them</button></div>` : "";
  const files = S.files.length ? `<ul class="files">${S.files.slice(-12).reverse().map((f, i) => { const idx = S.files.length - 1 - i; const n = S.entries.filter((e) => e.sourceFile === f.name).length;
    return `<li><span>${esc(f.name)}</span><span class="row" style="justify-content:flex-end">${f.status === "reading" ? '<span class="spinner"></span> Reading' : f.status === "done" ? `<span><span class="pill ok">${f.count} added</span>${f.detail ? `<div class="src">${esc(f.detail)}</div>` : ""}</span>` : f.status === "error" ? `<span class="err">${esc(f.error || "Couldn't read")}</span>` : ""}
    ${f.status !== "reading" ? (confirmRemove === idx ? `<span class="row"><span class="hint">Remove this file and its ${n} entr${n === 1 ? "y" : "ies"}?</span><button class="btn small" type="button" data-removefile="${idx}" data-yes="1">Yes, remove</button><button class="btn ghost small" type="button" data-removefile="${idx}" data-no="1">Keep</button></span>` : `<button class="btn ghost small" type="button" data-removefile="${idx}">Remove</button>`) : ""}</span></li>`; }).join("")}</ul>` : "";
  const allQ = S.ask || [];
  // Show only the answer just given; older ones live behind "Past questions".
  const log = showHistory ? allQ : (lastAskId ? allQ.filter((x) => x.id === lastAskId) : []);
  const rep = curReport();
  return `<div><h2>Add your records</h2><p class="lead">Enter each donation and payment, or upload what you have. This report covers ${fmtDate(rep.start)} to ${fmtDate(rep.end)}; anything dated outside that is kept for the right report. Not sure about something? Ask at the bottom of the page.</p></div>
  ${recent}
  <div class="panel type">
    <h3>Add an entry</h3>
    <div class="choice">
      <button type="button" data-newkind="contribution"><b>Money came in</b><small>A donation, a loan, your own money, or donated goods</small></button>
      <button type="button" data-newkind="expense"><b>Money went out</b><small>Something the campaign paid for, or a bill you owe</small></button>
    </div>
    <details class="tipsbox"><summary>What you'll need for each entry</summary>
      <div class="tipsgrid">
        <div><b>Money in</b><ul><li>Who gave it (full name, or the business or group)</li><li>Street address, city and ZIP</li><li>Their job, once they've given $1,000 this year</li><li>How much, and the date you received it</li><li>Whether a business is an Inc./Corp. or an LLC</li></ul></div>
        <div><b>Money out</b><ul><li>Who you paid, and their address</li><li>What it was for (“yard signs”, “filing fee”)</li><li>How much, and the date you paid</li></ul></div>
        <div><b>Easy to forget</b><ul><li>Your own money put into the campaign</li><li>Campaign bills you paid personally</li><li>Donated food, printing or services</li><li>Bank and online-donation fees</li><li>Bills you owe but haven't paid</li></ul></div>
      </div></details>
  </div>
  <div class="or"><span>Have an ActBlue export, a spreadsheet, or a stack of paper?</span></div>
  <label class="drop" id="drop" for="fileIn"><strong>Upload photos or files</strong><p>Take a picture of each check, receipt or deposit slip, or upload a bank statement or spreadsheet. We'll pull out every entry for you to check.</p>
    <div class="chips"><span class="chip">ActBlue export</span><span class="chip">Phone photos</span><span class="chip">PDF</span><span class="chip">Excel / CSV</span><span class="chip">Screenshots</span></div>
    <input id="fileIn" type="file" multiple hidden accept="image/*,.pdf,.csv,.tsv,.txt,.xlsx,.xls"></label>
  ${files}
  ${isDemo() && !S.files.some((f) => f.name === "messy-donations.xlsx") ? `<div class="panel row" style="justify-content:space-between"><span><b>No spreadsheet handy?</b> <span class="muted">Try importing a sample one.</span></span><button class="btn small" type="button" data-act="samplesheet">Import a sample spreadsheet</button></div>` : ""}
  <details class="tipsbox panel" ${S.files.some((f) => f.ab) ? "" : "open"}>
    <summary>Raise money on ActBlue? Get all of it in three steps.</summary>
    <ol class="abguide">
      <li>Sign in at <b>secure.actblue.com</b>. In the left menu, under <b>Tools</b>, click <b>Downloads</b>.</li>
      <li>Choose the <b>Contributions</b> report, set the dates to <b>January 1 to today</b>, and click <b>Export</b>. Pick <b>CSV</b>. ActBlue emails you the file or shows a download link.</li>
      <li>Drop that file in the box above. Only donations from this report's dates go on the report; the earlier ones let us total each donor for the year, which the form requires. We also list ActBlue's fees as an expense the way the state wants, and record any refunds. Do this again right before you file to catch new donations.</li>
    </ol>
    <p class="hint" style="margin:0">Checks and cash still get entered above. Uploading the same export twice is safe; we skip what's already here.</p>
  </details>
  <div class="panel bankbox">
    <h3>Have your bank statement? <span class="muted" style="font-weight:400;font-size:14px">Optional, but it catches what you forgot.</span></h3>
    <p class="muted" style="margin:4px 0 10px">We don't turn the statement into entries, since the bank doesn't know who a check was from or what it was for. We compare it against your report and point out anything that doesn't line up.</p>
    <label class="drop" for="bankIn" style="padding:16px"><strong>Upload a statement</strong><p>A PDF, photos of each page, or a CSV download from your bank. One month or several.</p><input id="bankIn" type="file" multiple hidden accept="image/*,.pdf,.csv,.txt"></label>
    ${busy.bank ? jobBox("bank", "Usually 30 to 90 seconds for a multi-page statement. Leave this page open; don't refresh.") : ""}
    ${bankErr ? `<p class="err" style="margin:8px 0 0">${esc(bankErr)}</p>` : ""}
    ${S.bank.statements.length ? `<ul class="files" style="margin-top:10px">${S.bank.statements.map((st) => { const n = S.bank.lines.filter((l) => l.stId === st.id).length; return `<li><span>${esc(st.name)}<div class="src">${st.start ? fmtDate(st.start) + " – " + fmtDate(st.end) + " · " : ""}${n} lines${st.closing != null ? " · ends at " + money(st.closing) : ""}</div></span><button class="btn ghost small" type="button" data-removebank="${st.id}">Remove</button></li>`; }).join("")}</ul>` : ""}
  </div>
  <div class="summary">${statTiles()}</div>
  <div class="panel ask">
    <h3>Have a question?</h3>
    <p class="muted" style="margin:4px 0 10px">Ask anything about what counts, what to enter, or how something should be reported. Answers use Indiana's rules and your report so far.</p>
    ${log.map((x) => `<div class="qa"><div class="q">${esc(x.q)}</div><div class="a">${esc(x.a)}${x.items?.length ? `<div class="row" style="margin-top:8px"><button class="btn small" type="button" data-askadd="${esc(x.id)}">Add ${x.items.length === 1 ? "this entry" : x.items.length + " entries"}</button></div>` : ""}</div></div>`).join("")}
    ${allQ.length > (lastAskId && !showHistory ? 1 : 0) || showHistory ? `<div class="row" style="margin-bottom:8px"><button class="linkbtn" type="button" data-act="askhistory">${showHistory ? "Hide past questions" : `Past questions (${allQ.length})`}</button>${showHistory ? `<button class="linkbtn" type="button" data-act="askclear">Clear history</button>` : ""}</div>` : ""}
    <textarea id="askBox" rows="2" placeholder="Example: My cousin bought $200 of yard signs for me. How do I report that?">${esc(S.askDraft || "")}</textarea>
    ${noteErr ? `<p class="err" style="margin:6px 0 0">${esc(noteErr)}</p>` : ""}
    <div class="row" style="margin-top:8px"><button class="btn ghost" type="button" data-act="ask" ${busy.ask ? "disabled" : ""}>${busy.ask ? '<span class="spinner"></span> Thinking…' : "Ask"}</button></div>
  </div>
  ${navRow("prior", "list", "Check my entries")}`;
},
list() {
  const tab = S.tab || "all", rep = curReport(), pStart = rep.start;
  const flagged = new Set(results().flags.filter((f) => f.sev === "must_fix").flatMap((f) => f.ids));
  const isEarlier = (e) => e.date && e.date < rep.start;
  const isLater = (e) => e.date && e.date > rep.end;
  const rows = S.entries.filter((e) => !isEarlier(e) && !isLater(e) && (tab === "all" || KINDS[e.kind]?.group === tab)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const earlier = S.entries.filter(isEarlier).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const later = S.entries.filter(isLater).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const rowHtml = (e) => `<tr><td>${fmtDate(e.date)}</td><td>${KINDS[e.kind]?.label || e.kind}</td>
    <td>${esc(e.name) || "<span class='pill bad'>missing</span>"}<div class="src">${esc(e.sourceFile ? "from " + e.sourceFile : "typed in")}</div></td>
    <td>${esc([SOURCES[e.source] && KINDS[e.kind]?.group === "in" ? SOURCES[e.source] : "", e.code ? "Code " + e.code : "", e.purpose || e.desc, e.occupation].filter(Boolean).join(" · "))}${e.question ? `<div class="q">${esc(e.question)}</div>` : ""}${needsLine(e.id)}</td>
    <td class="amt">${money(e.amount)}</td>
    <td>${flagged.has(e.id) ? '<span class="pill bad">fix</span>' : e.question ? '<span class="pill warn">check</span>' : '<span class="pill ok">ok</span>'} <button class="btn ghost small" type="button" data-edit="${e.id}">Edit</button></td></tr>`;
  const earlierBlock = earlier.length ? `<details class="tipsbox panel"><summary>${earlier.length} entr${earlier.length === 1 ? "y" : "ies"} from earlier this year (not on this report)</summary>
    <p class="muted" style="margin:6px 0 10px">These are dated before ${fmtDate(pStart)}, so they belong to an earlier report, not this one. We keep them because the form asks for each donor's total for the whole year, and whether a donor is itemized depends on that total.</p>
    <div class="tablewrap"><table><thead><tr><th>Date</th><th>What</th><th>Name</th><th>Details</th><th class="amt">Amount</th><th></th></tr></thead><tbody>${earlier.map(rowHtml).join("")}</tbody></table></div></details>` : "";
  const laterBlock = later.length ? `<details class="tipsbox panel"><summary>${later.length} entr${later.length === 1 ? "y" : "ies"} dated after this report ends (saved for the next one)</summary>
    <div class="tablewrap"><table><thead><tr><th>Date</th><th>What</th><th>Name</th><th>Details</th><th class="amt">Amount</th><th></th></tr></thead><tbody>${later.map(rowHtml).join("")}</tbody></table></div></details>` : "";
  const unsorted = [...new Map(S.entries.filter((e) => KINDS[e.kind]?.group === "in" && !e.source && e.name).map((e) => [e.name.trim().toLowerCase(), e.name.trim()])).values()];
  const sortStrip = unsorted.length ? `<div class="panel sortstrip"><h3>Sort your donors</h3>
    <p class="muted" style="margin:4px 0 10px">The form has a separate page for each kind of donor, and corporations and unions have a $2,000 yearly limit. Tap the right kind for each one. <a href="https://inbiz.in.gov/BOS/PublicSearch/Search" target="_blank" rel="noopener">Not sure if a business is a corporation? Look it up</a>.</p>
    ${unsorted.map((n) => `<div class="sortrow"><b>${esc(n)}</b><div class="row">${Object.entries(SOURCES).filter(([k]) => k !== "candidate").map(([k, l]) => `<button type="button" class="starter" data-sort="${esc(n)}" data-source="${k}">${l}</button>`).join("")}</div></div>`).join("")}
  </div>` : "";
  const merges = donorGroups().map(mergeCard).join("");
  return `<div><h2>Check each entry</h2><p class="lead">Everything for this report (${fmtDate(pStart)} – ${fmtDate(rep.end)}), in date order. Tap Edit to fix anything.</p></div>${merges}${sortStrip}
  <div class="row" style="justify-content:space-between"><div class="tabs">${[["all", "All"], ["in", "Money in"], ["out", "Money out"], ["owed", "Unpaid bills"]].map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div><button class="btn ghost small" type="button" data-act="new">Add an entry</button></div>
  <div class="tablewrap"><table><thead><tr><th>Date</th><th>What</th><th>Name</th><th>Details</th><th class="amt">Amount</th><th></th></tr></thead><tbody>
  ${rows.map(rowHtml).join("") || `<tr><td colspan="6" class="empty">Nothing here yet.</td></tr>`}
  </tbody></table></div>
  ${earlierBlock}${laterBlock}
  <div class="panel grid"><label for="f-bank">Bank balance on ${fmtDate(rep.end)}<small>Optional. From your bank statement. We use it to catch anything missing.</small><input id="f-bank" data-bind="report.bankBalance" inputmode="decimal" value="${esc(rep.bankBalance || "")}"></label></div>
  ${navRow("add", "review", "Look for problems")}`;
},
review() {
  const { flags } = results();
  const bad = flags.filter((f) => f.sev === "must_fix").length, warn = flags.filter((f) => f.sev === "check").length;
  const head = bad ? `${bad} thing${bad > 1 ? "s" : ""} to fix before you file` : warn ? "No blockers. A few things to double-check." : "Everything checks out.";
  const cls = { must_fix: "bad", check: "warn", tip: "tip" };
  const bk = bankCheck();
  const bankSummary = bk.covered ? `<div class="panel"><h3>Bank check</h3><p class="muted" style="margin:4px 0 0">Statement${S.bank.statements.length > 1 ? "s cover" : " covers"} ${S.bank.statements.map((st) => fmtDate(st.start) + " – " + fmtDate(st.end)).join(", ")}. ${S.bank.lines.filter((l) => !l.ignored).length - bk.lines.length} bank lines match your report; ${bk.lines.length} don't${bk.lines.length ? " (listed below)" : ""}.${bk.lines.length > 3 ? ` <button class="linkbtn" type="button" data-bankignoreall="1">Hide all ${bk.lines.length} as not campaign money</button>` : ""}</p></div>` : "";
  return `<div><h2>${head}</h2><p class="lead">Red items would make the report wrong or incomplete. Yellow items are worth a second look.</p></div>
  ${bankSummary}
  ${(() => { const yellow = flags.filter((f) => f.sev !== "must_fix"); const cap = showAllFlags ? Infinity : 6; let shownY = 0;
    const html = flags.map((f) => { if (f.sev !== "must_fix" && ++shownY > cap) return ""; return `<div class="flag ${cls[f.sev]}"><div class="bar"></div><div><b>${esc(f.msg)}</b><p>${esc(f.fix)}</p></div><div class="row">${f.bankLine ? `<button class="btn small" type="button" data-bankadd="${f.bankLine}">Add it</button><button class="btn ghost small" type="button" data-bankignore="${f.bankLine}">Not campaign money</button>` : f.step ? `<button class="btn ghost small" type="button" data-go="${f.step}">${f.step === "list" ? "Open" : "Fix"}</button>` : f.ids[0] && S.entries.some((e) => e.id === f.ids[0]) ? `<button class="btn ghost small" type="button" data-edit="${f.ids[0]}">Fix</button>` : ""}${f.sev !== "must_fix" && !f.bankLine ? `<button class="btn ghost small" type="button" data-dismiss="${esc(f.sev + "|" + f.msg)}" title="Hide this; it won't come back">I checked</button>` : ""}</div></div>`; }).join("");
    return `<div class="flags">${html || '<div class="panel empty">No problems found.</div>'}</div>${yellow.length > 6 && !showAllFlags ? `<p class="hint" style="margin:0"><button class="linkbtn" type="button" data-act="allflags">Show ${yellow.length - 6} more yellow item${yellow.length - 6 === 1 ? "" : "s"}</button></p>` : ""}${Object.keys(S.dismissed).some((k) => !k.startsWith("lk:") && !k.startsWith("corp|")) ? `<p class="hint" style="margin:0"><button class="linkbtn" type="button" data-act="undismiss">Show items I marked as checked</button></p>` : ""}`; })()}
  <div class="panel"><h3>Second opinion</h3><p class="muted" style="margin:4px 0 10px">Have the AI look over the whole report for things rules can't catch, like the same donor under two spellings or an expense that looks personal.</p>
  ${busy.ai ? jobBox("ai") : `<div class="row"><button class="btn ghost" type="button" data-act="ai">${S.aiFlags ? "Run the review again" : "Run the review"}</button>${S.aiReviewedAt ? `<span class="hint">Last run ${new Date(S.aiReviewedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${S.aiFlags && S.aiFlags.length ? `, ${S.aiFlags.length} note${S.aiFlags.length === 1 ? "" : "s"} added above` : ", nothing extra found"}</span>` : ""}</div>`}</div>
  ${navRow("list", "print", "Build my report")}`;
},
print() {
  const rep = curReport(); const { C, flags } = results(rep); const L = C.lines;
  const bad = flags.filter((f) => f.sev === "must_fix").length;
  const ln = (n, t, a, b) => `<div class="ln"><span>${n}</span><span>${t}</span><b>${a == null ? "" : money(a)}</b><b>${b == null ? "" : money(b)}</b></div>`;
  const filed = rep.status === "filed", changed_ = filed && changedSinceFiled(rep);
  const county = (CFG.counties || {})[S.about.county] || null;
  const head = filed ? `<div><h2>Filed ${rep.filedAt ? fmtDate(rep.filedAt) : ""}</h2><p class="lead">${changed_ ? "Entries inside this report's dates have changed since you filed. If the filed report is now wrong, download the amended version below, mark it as an amendment, and file it the same way." : "This report is done. You can download the copy you filed any time."}</p></div>`
    : `<div><h2>${bad ? "Almost there" : "Your report is ready"}</h2><p class="lead">${bad ? `There ${bad === 1 ? "is 1 item" : `are ${bad} items`} still marked red. You can print a draft now, but fix those before you file.` : "Download it, print it, sign it, and turn it in."}</p></div>`;
  const summary = `<div class="panel"><div class="lines">
    <div class="ln hd"><span></span><span></span><span style="text-align:right">This period</span><span style="text-align:right">Year to date</span></div>
    ${ln(13, "Cash at start of this period", L.l13)}${ln(14, "Cash on January 1", null, L.l14)}
    ${ln("15a", "Itemized contributions", L.l15aA, L.l15aB)}${ln("15b", "Unitemized contributions", L.l15bA, L.l15bB)}
    ${ln(16, "Total", L.l16A, L.l16B)}
    ${ln("17a", "Itemized expenditures", L.l17aA, L.l17aB)}${ln("17b", "Unitemized expenditures", L.l17bA, L.l17bB)}
    ${ln(18, "Cash at end of this period", L.l18A, L.l18B)}${ln(19, "Debts you owe", L.l19)}${ln(20, "Debts owed to you", L.l20)}
  </div></div>`;
  if (filed) return `${head}${summary}
    <div class="row"><button class="btn" type="button" data-act="pdf-filed" ${busy.pdf ? "disabled" : ""}>${busy.pdf ? '<span class="spinner"></span> Building…' : "Download the report as filed"}</button>
      ${changed_ ? `<button class="btn ghost" type="button" data-act="pdf-amend" ${busy.pdf ? "disabled" : ""}>Download an amended CFA-4</button><button class="btn ghost" type="button" data-act="filed-again">I filed the amendment</button>` : ""}
      <button class="btn ghost small" type="button" data-act="unfile">Mark as not filed</button></div>
    ${navRow("dash", null)}`;
  const fileBox = `<div class="panel"><h3>${S.about.filesWith === "state" ? "How to file online" : "How to file"}</h3>${S.about.filesWith === "state" ? `<ol>
    <li>Sign in at <b>campaignfinance.in.gov</b> and open the <b>Filings</b> tab.</li>
    <li>Choose the import option and upload the file you just downloaded. The system reads your contributions, expenditures and debts and adds up the totals itself.</li>
    <li>Preview the report on screen. Fix anything it rejects, download a fresh file here, and import again; the file replaces nothing until you file.</li>
    <li>File it by <b>noon on ${fmtDate(C.due)}</b>. Keep receipts for every expense over $25 for three years.</li></ol>
    <p class="hint" style="margin:0">This file follows the Election Division's published import layout. If the system rejects it, note the message it gives and tell whoever sent you this tool.${!S.about.fileNumber ? " Your Committee ID is missing on the first step; the state's system needs it." : ""}</p>`
  : `<ol>
    <li>Print every page.</li>
    <li>The treasurer signs and dates the summary page.${isParty() ? "" : " If the candidate isn't the treasurer, the candidate signs too."}</li>
    <li>Turn it in to the county election board${county ? ` (${esc(county.office)}${county.address ? ", " + esc(county.address) : ""})` : " (the Clerk's office)"} by <b>noon on ${fmtDate(C.due)}</b>. ${county?.email ? `They accept email at <b>${esc(county.email)}</b>.` : "Ask the Clerk whether they take email or fax."} A mailed report counts only when it arrives, not by postmark.</li>
    <li>Keep receipts for every expense over $25 for three years.</li></ol>${county?.note ? `<p class="hint" style="margin:0">${esc(county.note)}</p>` : ""}`}</div>`;
  const filedBox = `<div class="panel"><h3>After you file</h3><p class="muted" style="margin:4px 0 10px">Mark it filed so your dashboard knows, and so the next report starts from the right numbers.</p>
    <div class="row"><label style="width:auto">Date filed<input type="date" id="filedDate" value="${today()}" style="width:auto"></label><button class="btn" type="button" data-act="filed">I filed this report</button></div></div>`;
  return `${head}${summary}
  ${S.about.filesWith === "state" ? `
  <div class="row"><button class="btn" type="button" data-act="state" ${busy.state ? "disabled" : ""}>${busy.state ? '<span class="spinner"></span> Building…' : "Download the file for campaignfinance.in.gov"}</button>
    <button class="btn ghost" type="button" data-act="pdf" ${busy.pdf ? "disabled" : ""}>${busy.pdf ? '<span class="spinner"></span> Building…' : "Also download the CFA-4 as a PDF"}</button></div>
  ${stateMsg ? `<p class="hint" style="margin:0">${esc(stateMsg)}</p>` : ""}`
  : `<div class="row"><button class="btn" type="button" data-act="pdf" ${busy.pdf ? "disabled" : ""}>${busy.pdf ? '<span class="spinner"></span> Building…' : bad ? "Download a draft CFA-4" : "Download my CFA-4 (PDF)"}</button>
    <label class="row" style="width:auto;gap:6px;font-size:14px"><input type="checkbox" id="amendBox" style="width:auto" ${rep.amendment ? "checked" : ""}> This is an amendment to a report I already filed</label></div>`}
  ${fileBox}
  ${filedBox}
  ${supportPanel()}
  ${navRow("review", null)}`;
},
};
// What a filed report looked like, so it can be reprinted and so later edits are noticed.
function fingerprint(rep) { return JSON.stringify(S.entries.filter((e) => inPeriod(e, rep) || e.kind === "unpaid_bill").map((e) => [e.id, e.kind, e.name, e.amount, e.date, e.source, e.code, e.street, e.zip, e.occupation]).sort()); }
function changedSinceFiled(rep) { return !!(rep.snapshot && rep.snapshot.fp && rep.snapshot.fp !== fingerprint(rep)); }
function markFiled(rep, date) {
  const R = buildReport(rep), C = CFA.compute(R);
  rep.status = "filed"; rep.filedAt = date || today();
  rep.snapshot = { R, lines: C.lines, fp: fingerprint(rep), at: Date.now() };
  publishFiled(rep);
  S.cur = null; S.step = "dash"; changed(); render(); window.scrollTo({ top: 0 });
}
function statTiles() { const { C } = results(); const L = C.lines; return [["Entries", S.entries.length], ["Money in", money(L.l15cA)], ["Money out", money(L.l17cA)], ["Ending cash", money(L.l18A)]].map(([l, v]) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`).join(""); }

// ---------- Donor merge: same person entered more than one way ----------
const nameKey = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(mr|mrs|ms|dr|jr|sr|ii|iii)\b/g, "").replace(/\s+/g, " ").trim();
const streetKey = (e) => String(e.street || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|north|n|south|s|east|e|west|w)\b/g, "").replace(/\s+/g, " ").trim();
const looseKey = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ADDR_ABBR = { street: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd", place: "pl", circle: "cir", parkway: "pkwy", highway: "hwy", north: "n", south: "s", east: "e", west: "w", apartment: "apt", suite: "ste", indiana: "in" };
const addrKey = (v) => looseKey(v).split(" ").map((w) => ADDR_ABBR[w] || w).join(" ").replace(/\b(\d{5})\d{4}\b/, "$1");
// "Jim Harper" and "James Harper" are probably one person; the merge card asks rather than assumes.
const NICK = { jim: "james", jimmy: "james", jamie: "james", bob: "robert", bobby: "robert", rob: "robert", bill: "william", billy: "william", will: "william", mike: "michael", tom: "thomas", tommy: "thomas", dan: "daniel", danny: "daniel", dave: "david", chris: "christopher", kate: "katherine", katie: "katherine", kathy: "katherine", cathy: "catherine", liz: "elizabeth", beth: "elizabeth", betty: "elizabeth", sue: "susan", susie: "susan", pat: "patricia", patty: "patricia", steve: "steven", joe: "joseph", ed: "edward", eddie: "edward", rick: "richard", dick: "richard", rich: "richard", ben: "benjamin", sam: "samuel", tony: "anthony", jen: "jennifer", jenny: "jennifer", meg: "margaret", peggy: "margaret", maggie: "margaret", nick: "nicholas", matt: "matthew", andy: "andrew", drew: "andrew", greg: "gregory", larry: "lawrence", ron: "ronald", don: "donald", ken: "kenneth", jerry: "gerald", abby: "abigail", abbie: "abigail", vicky: "victoria", becky: "rebecca", deb: "deborah", debbie: "deborah", cindy: "cynthia", barb: "barbara", terry: "terrence", chuck: "charles", charlie: "charles", hank: "henry", al: "albert", fred: "frederick", jack: "john", johnny: "john", jon: "jonathan", phil: "phillip", tim: "timothy", gene: "eugene" };
const personGroupKey = (n) => { const w = nameKey(n).split(" "); if (w.length > 1 && NICK[w[0]]) w[0] = NICK[w[0]]; return w.join(" "); };
function donorGroups() {
  const groups = new Map();
  for (const e of S.entries) {
    if (KINDS[e.kind]?.group !== "in" || !e.name) continue;
    const k = e.personKey || personGroupKey(e.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    // Differences in capitals, spacing, punctuation or "St" vs "Street" don't count; only real differences do.
    const variants = (f, keyOf = looseKey) => { const m = new Map(); for (const e of list) { const val = String(f(e) || "").replace(/\s+/g, " ").trim(); if (val && !m.has(keyOf(val))) m.set(keyOf(val), val); } return [...m.values()]; };
    const v = { name: variants((e) => e.name), address: variants((e) => [e.street, e.city, e.state, e.zip].filter(Boolean).join(", "), addrKey), occupation: variants((e) => e.occupation), source: variants((e) => e.source) };
    if (v.name.length > 1 || v.address.length > 1 || v.occupation.length > 1 || v.source.length > 1) out.push({ key: k, list, v });
  }
  return out;
}
function mergeCard(g) {
  const total = g.list.reduce((s, e) => s + Number(e.amount || 0), 0);
  const names = g.v.name, label = { name: "Name", address: "Address", occupation: "Job", source: "Kind of donor" };
  const opts = (field, vals) => vals.length > 1 ? `<div class="mergefield"><span class="mergelabel">${label[field]}</span><div class="mergeopts">${vals.map((val, i) => `<label class="mergeopt"><input type="radio" name="m-${esc(g.key)}-${field}" value="${esc(val)}" ${i === 0 ? "checked" : ""}><span>${esc(field === "source" ? (SOURCES[val] || val) : val)}</span></label>`).join("")}</div></div>` : "";
  const title = names.length > 1 ? `${names.slice(0, -1).map(esc).join(", ")} and ${esc(names[names.length - 1])}: one person?` : `${esc(names[0])} is entered with different ${g.v.address.length > 1 ? "addresses" : g.v.occupation.length > 1 ? "jobs" : "details"}`;
  return `<div class="panel mergecard" data-mergekey="${esc(g.key)}">
    <h3>${title}</h3>
    <p class="muted">${g.list.length} gifts, ${money(total)} this year. If it's one person, pick what to keep and every gift will use it.</p>
    ${opts("name", g.v.name)}${opts("address", g.v.address)}${opts("occupation", g.v.occupation)}${opts("source", g.v.source)}
    <div class="row"><button class="btn small" type="button" data-merge="${esc(g.key)}">Same person, combine them</button><button class="btn ghost small" type="button" data-splitdonor="${esc(g.key)}">Different people</button></div>
  </div>`;
}
function applyMerge(key) {
  const g = donorGroups().find((x) => x.key === key); if (!g) return;
  const card = document.querySelector(`[data-mergekey="${CSS.escape(key)}"]`);
  const pick = (f) => card?.querySelector(`input[name="m-${key}-${f}"]:checked`)?.value;
  const name = pick("name") || g.v.name[0], addr = pick("address") || g.v.address[0], occ = pick("occupation") ?? g.v.occupation[0], src = pick("source") || g.v.source[0];
  const ref = g.list.find((e) => [e.street, e.city, e.state, e.zip].filter(Boolean).join(", ").replace(/\s+/g, " ").trim() === addr) || g.list[0];
  for (const e of g.list) { e.name = name; e.street = ref.street; e.city = ref.city; e.state = ref.state; e.zip = ref.zip; if (occ !== undefined) e.occupation = occ || e.occupation; if (src) e.source = src; delete e.sourceGuessed; delete e.personKey; }
  S.aiFlags = null; changed(); render();
}
function splitDonor(key) {
  const g = donorGroups().find((x) => x.key === key); if (!g) return;
  // Keep entries apart by address: same name + same street stays one person; a different street is someone else.
  for (const e of g.list) e.personKey = nameKey(e.name) + "#" + (streetKey(e) || e.zip || e.occupation || "x");
  S.aiFlags = null; changed(); render();
}

// ---------- Typing coach ----------
function lineKind(l) {
  if (/\bowe\b|haven.?t paid|not paid|unpaid|invoice/i.test(l)) return "owed";
  if (/personal money|out of (my )?pocket|paid .* myself|my own card/i.test(l)) return "selfpaid";
  if (/my own money|i put in|loaned the campaign/i.test(l)) return "self";
  if (/donated (?!\$)|worth about|in-kind|in kind/i.test(l)) return "inkind";
  if (/\bpaid\b|bought|spent|purchased|\bfee\b|charged/i.test(l)) return "out";
  if (/\bgave\b|donat|contribut|received|\bgot\b|sent in|chipped in/i.test(l)) return "in";
  return "";
}
function coach(text) {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return `<p class="muted" style="margin:0">As you type, we'll check each line for what the form needs.</p>`;
  const has = {
    amount: (l) => /\$\s?\d|\d+(\.\d{2})?\s*dollars/i.test(l),
    date: (l) => /\b\d{1,2}\/\d{1,2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\btoday\b|\byesterday\b/i.test(l),
    address: (l) => /\d+\s+[\w.]+(\s[\w.]+)*\s(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|pl|pike|pkwy|hwy|cir)\b/i.test(l) && /\b\d{5}\b/.test(l),
    how: (l) => /check|cash|card|venmo|paypal|online|actblue|transfer|zelle|money order/i.test(l),
    purpose: (l) => /\bfor\b/i.test(l),
    what: (l) => /donated \w+/i.test(l),
  };
  const need = {
    in: [["amount", "amount"], ["date", "date"], ["address", "full address + ZIP"], ["how", "check, cash or card"]],
    out: [["amount", "amount"], ["date", "date"], ["purpose", "what it was for"], ["how", "how you paid"]],
    self: [["amount", "amount"], ["date", "date"]],
    selfpaid: [["amount", "amount"], ["purpose", "what it was for"], ["date", "date"]],
    inkind: [["what", "what they gave"], ["amount", "what it's worth"], ["date", "date"], ["address", "full address + ZIP"]],
    owed: [["amount", "amount"], ["purpose", "what it was for"], ["date", "date billed"]],
  };
  const names = { in: "Money in", out: "Money out", self: "Your own money", selfpaid: "You paid a bill", inkind: "Donated goods", owed: "Unpaid bill" };
  return lines.slice(0, 8).map((l, i) => {
    const k = lineKind(l), brackets = /\[[^\]]*\]/.test(l), lc = l.replace(/\[[^\]]*\]/g, "");
    const chips = k ? need[k].map(([key, lab]) => `<span class="ck ${has[key](lc) ? "yes" : "no"}">${has[key](lc) ? "✓" : "○"} ${lab}</span>`).join("")
      : `<span class="ck no">Say whether money came in or went out (“gave”, “paid”, “owe”)</span>`;
    return `<div class="cline"><span class="cn">${k ? names[k] : "Line " + (i + 1)}</span>${brackets ? `<span class="ck no">Fill in the parts in [brackets]</span>` : ""}${chips}</div>`;
  }).join("") + (lines.length > 8 ? `<p class="muted" style="margin:0">…and ${lines.length - 8} more lines</p>` : "");
}

// ---------- Talking to the AI ----------
async function ai(endpoint, payload) {
  if (isDemo()) throw new Error(DEMO_AI_MSG);
  const r = await fetch("/api/" + endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Draft-Code": CODE }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
  return j;
}
function context() {
  const a = S.about, P = curReport() || {};
  return { candidate_name: a.candidate, treasurer: a.treasurer, committee: a.committee, report: P.type || "", period_start: P.start, period_end: P.end, today: today() };
}
function toEntry(it, file) {
  const out = KINDS[it.kind]?.group !== "in";
  const e = {
    id: uid(), kind: KINDS[it.kind] ? it.kind : "expense", source: it.source || "", name: it.name || "",
    street: it.street || "", city: it.city || "", state: it.state || (it.city ? "IN" : ""), zip: it.zip || "",
    occupation: it.occupation || "", amount: Number(it.amount) || 0, date: it.date || "", method: it.method || "",
    check: it.check_number || "", receivedBy: out ? "" : (it.received_by || S.about.treasurer || ""),
    desc: it.desc || (it.kind === "inkind" ? it.purpose || "" : ""), purpose: it.purpose || "",
    code: it.code || "", office: it.office || "", sourceFile: file || it.source_file || "",
    question: it.question || "", fromAI: true,
  };
  if (it.kind === "inkind" && !e.code) e.code = CFA.guessCode(e.desc);
  if (out && e.kind !== "unpaid_bill" && !e.code) { e.code = CFA.guessCode(e.purpose); e.codeGuessed = codeIsWeak(e.purpose, e.code); }
  return applyDonorRules(e);
}
function addItems(items, file) {
  const added = (items || []).filter((i) => Number(i.amount) > 0 || i.name).map((i) => toEntry(i, file));
  S.entries.push(...added); justAdded = added.map((e) => e.id); changed(); return added.length;
}

async function readBank(files) {
  startJob("bank"); bankErr = "";
  try {
    const payload = { files: [], text: "" };
    for (const f of files) {
      if (/\.(csv|txt)$/i.test(f.name)) payload.text += `\n--- ${f.name} ---\n` + (await f.text()).slice(0, 120000);
      else payload.files.push(...((await fileToPayload(f)).files || []));
    }
    const j = await ai("bank", payload);
    const lines = (j.lines || []).filter((l) => Number(l.amount) > 0 && l.date);
    if (!lines.length) throw new Error("We couldn't find any transactions in that. Try a clearer photo, or the PDF from your bank's website.");
    const dates = lines.map((l) => l.date).sort();
    const st = { id: uid(), name: files.map((f) => f.name).join(", "), start: j.period_start || dates[0], end: j.period_end || dates[dates.length - 1], opening: j.opening_balance ?? null, closing: j.closing_balance ?? null, last4: j.account_last4 || "" };
    // Replace an earlier upload of the same period instead of doubling the lines.
    const dup = S.bank.statements.find((x) => x.start === st.start && x.end === st.end);
    if (dup) { S.bank.lines = S.bank.lines.filter((l) => l.stId !== dup.id); S.bank.statements = S.bank.statements.filter((x) => x.id !== dup.id); }
    S.bank.statements.push(st);
    for (const l of lines) S.bank.lines.push({ id: uid(), stId: st.id, date: l.date, amount: Math.round(Number(l.amount) * 100) / 100, dir: l.direction === "in" ? "in" : "out", desc: l.description || "", check: String(l.check_number || "").replace(/^0+/, ""), ignored: false });
    S.bank.lines.sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) { bankErr = e.message; }
  endJob("bank"); changed(); render();
}

// ---------- Bank check: compare the statement to the report ----------
const CASH_KINDS = new Set(["contribution", "loan", "interest", "misc", "expense", "debt_payment", "refund", "transfer_out"]);
const isActBlueEntry = (e) => /actblue/i.test((e.method || "") + " " + (e.name || ""));
function bankCheck(rep = curReport()) {
  const out = { lines: [], entries: [], mismatches: [], balance: [], actblue: null, covered: false };
  const B = S.bank; if (!B || !B.statements.length || !rep) return out;
  const inRange = (d) => B.statements.some((st) => d >= st.start && d <= st.end);
  out.covered = true;
  const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  const entries = S.entries.filter((e) => CASH_KINDS.has(e.kind) && e.date && Number(e.amount) > 0 && !/personal/i.test(e.method || "") && !isActBlueEntry(e))
    .map((e) => ({ e, dir: KINDS[e.kind].group === "in" ? "in" : "out", used: false }));
  const lines = B.lines.filter((l) => !l.ignored && !/actblue/i.test(l.desc));
  const used = new Set();
  // Pass 1: exact amount, same direction, close date; prefer matching check numbers, then nearest date.
  for (const l of lines) {
    let best = null, bestScore = 1e9;
    for (const c of entries) {
      if (c.used || c.dir !== l.dir || Math.abs(Number(c.e.amount) - l.amount) > 0.005) continue;
      const dd = days(c.e.date, l.date); if (dd > 21) continue;
      const score = (l.check && c.e.check && l.check === String(c.e.check).replace(/^0+/, "") ? -100 : 0) + dd;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (best) { best.used = true; used.add(l.id); l.matchId = best.e.id; }
  }
  // Pass 2: same check number but a different amount.
  for (const l of lines) if (!used.has(l.id) && l.check) {
    const c = entries.find((c) => !c.used && c.e.check && String(c.e.check).replace(/^0+/, "") === l.check);
    if (c) { c.used = true; used.add(l.id); out.mismatches.push({ line: l, entry: c.e }); }
  }
  out.lines = lines.filter((l) => !used.has(l.id));
  out.entries = entries.filter((c) => !c.used && inRange(c.e.date)).map((c) => c.e);
  // ActBlue: compare deposits to the export's net total over the covered dates.
  const abDeposits = B.lines.filter((l) => !l.ignored && /actblue/i.test(l.desc) && l.dir === "in");
  const abEntries = S.entries.filter((e) => isActBlueEntry(e) && e.date && inRange(e.date));
  if (abDeposits.length || abEntries.length) {
    const dep = abDeposits.reduce((s, l) => s + l.amount, 0);
    const gross = abEntries.filter((e) => KINDS[e.kind].group === "in").reduce((s, e) => s + Number(e.amount), 0);
    const fees = abEntries.filter((e) => e.kind === "expense").reduce((s, e) => s + Number(e.amount), 0);
    const refunds = abEntries.filter((e) => e.kind === "refund").reduce((s, e) => s + Number(e.amount), 0);
    out.actblue = { deposits: dep, net: gross - fees - refunds, count: abDeposits.length };
  }
  // Balances against the report.
  const P = rep;
  const L = CFA.compute(buildReport(rep)).lines;
  for (const st of B.statements) {
    if (st.closing != null && P.end && st.end >= P.end && st.start <= P.end) out.balance.push({ which: "closing", bank: st.closing, report: L.l18A, date: st.end });
    if (st.opening != null && P.start && st.start <= P.start && st.end >= P.start) out.balance.push({ which: "opening", bank: st.opening, report: L.l13, date: st.start });
  }
  return out;
}
// ---------- Progress for slow jobs ----------
const JOB_STEPS = {
  ai: ["Sending your report for review…", "Reading every entry…", "Checking donor totals and types…", "Looking for duplicates and missing items…", "Writing up what it found…", "Almost done…"],
  bank: ["Reading your statement…", "Picking out each transaction…", "Checking dates and amounts…", "Almost done…"],
  prior: ["Reading your April report…", "Finding the six numbers…", "Almost done…"],
};
let jobStart = {}, jobTimer = null;
function jobBox(key, note) {
  const started = jobStart[key] || Date.now(); const secs = Math.floor((Date.now() - started) / 1000);
  const steps = JOB_STEPS[key] || ["Working…"]; const step = steps[Math.min(steps.length - 1, Math.floor(secs / 8))];
  return `<div class="working" data-job="${key}"><div class="working-bar"><span></span></div>
    <div class="row" style="justify-content:space-between"><b><span class="spinner"></span> ${esc(step)}</b><span class="muted job-secs">${secs}s</span></div>
    <p class="hint" style="margin:6px 0 0">${note || "Usually takes 20 to 60 seconds. Leave this page open; you can scroll, but don't refresh or press back."}</p></div>`;
}
function startJob(key) { jobStart[key] = Date.now(); busy[key] = true; if (!jobTimer) jobTimer = setInterval(tickJobs, 1000); render(); }
function endJob(key) { busy[key] = false; delete jobStart[key]; if (!Object.values(busy).some(Boolean) && jobTimer) { clearInterval(jobTimer); jobTimer = null; } }
function tickJobs() { for (const el of document.querySelectorAll(".working")) { const key = el.dataset.job; const fresh = document.createElement("div"); fresh.innerHTML = jobBox(key, el.querySelector(".hint")?.textContent); el.replaceWith(fresh.firstElementChild); } }
window.addEventListener("beforeunload", (e) => { if (Object.values(busy).some(Boolean)) { e.preventDefault(); e.returnValue = ""; } });

async function askQuestion() {
  const q = ($("#askBox")?.value || "").trim(); if (!q) return;
  busy.ask = true; noteErr = ""; render();
  try {
    const { C, flags } = results();
    const ctx = { ...context(), lines: C.lines, entry_count: S.entries.length, entries: S.entries.slice(-60).map((e) => ({ kind: e.kind, source: e.source, name: e.name, amount: e.amount, date: e.date, purpose: e.purpose || e.desc, code: e.code })), open_problems: flags.filter((f) => f.sev !== "tip").slice(0, 20).map((f) => f.msg) };
    const j = await ai("ask", { question: q, context: ctx, history: (S.ask || []).slice(-3).map((x) => ({ q: x.q, a: x.a })) });
    const rec = { id: uid(), q, a: j.answer || "", items: j.items || [], at: Date.now() };
    S.ask = (S.ask || []).concat([rec]).slice(-30);
    lastAskId = rec.id; showHistory = false;
    S.askDraft = "";
  } catch (e) { noteErr = e.message; }
  busy.ask = false; changed(); render();
}
async function readNotes() {
  const v = $("#notes").value.trim(); if (!v) return;
  busy.notes = true; render();
  try {
    const j = await ai("extract", { text: v, context: context() });
    const n = addItems(j.items, "");
    noteErr = "";
    if (n) S.draft = ""; else noteErr = "We couldn't find a donation or payment in that. Try adding an amount and a name.";
  } catch (e) { noteErr = e.message; }
  busy.notes = false; changed(); render();
}
function alertBox(msg) { const c = $("#coach"); if (c) c.insertAdjacentHTML("afterbegin", `<p class="err" style="margin:0 0 6px">${esc(msg)}</p>`); }

const isSheet = (f) => /\.(csv|tsv|txt|xlsx|xls)$/i.test(f.name);
async function fileToPayload(f) {
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
    if (f.size > 3.2e6) throw new Error("PDF is too large. Try photos of the pages instead.");
    return { files: [{ name: f.name, mediaType: "application/pdf", data: await b64(f) }] };
  }
  if (/^image\//.test(f.type) || /\.(heic|jpe?g|png|webp)$/i.test(f.name)) return { files: [{ name: f.name, mediaType: "image/jpeg", data: await shrink(f) }] };
  throw new Error("This file type can't be read.");
}

// ---------- Spreadsheets (read in the browser; the AI only helps figure out the columns) ----------
function parseCSV(text) {
  const rows = []; let r = [], c = "", q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
    else if (ch === '"') q = true; else if (ch === "," || ch === "\t") { r.push(c); c = ""; } else if (ch === "\n") { r.push(c); rows.push(r); r = []; c = ""; } else if (ch !== "\r") c += ch; }
  if (c || r.length) { r.push(c); rows.push(r); }
  return rows.filter((r) => r.some((v) => String(v).trim()));
}
async function sheetRows(f) {
  let rows;
  if (/\.(xlsx|xls)$/i.test(f.name)) { const wb = XLSX.read(await f.arrayBuffer()); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" }); }
  else rows = parseCSV(await f.text());
  rows = rows.filter((r) => r.some((v) => String(v).trim()));
  // The header is the first row with at least three filled cells (skips a title line above the table).
  const hi = rows.findIndex((r) => r.filter((v) => String(v).trim()).length >= 3);
  if (hi < 0 || rows.length < hi + 2) throw new Error("The spreadsheet looks empty.");
  const headers = rows[hi].map((h, i) => String(h).trim() || `Column ${i + 1}`);
  return { headers, data: rows.slice(hi + 1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "").trim()]))) };
}
function parseAmount(v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : (/\(.*\)/.test(String(v)) ? -Math.abs(n) : n); }
function parseDate(v) {
  v = String(v || "").trim(); if (!v) return "";
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(v); return isNaN(d) ? "" : d.toLocaleDateString("en-CA");
}
// ActBlue "Contributions" CSV (Tools → Downloads). Gross amount goes on Schedule A; fees become expenses; refunds go on Schedule B.
const AB_MARKERS = ["Receipt ID", "Donor First Name", "Amount"];
function abMap(headers) {
  const h = headers.map((x) => x.toLowerCase());
  const has = (n) => h.includes(n.toLowerCase());
  if (!AB_MARKERS.every(has)) return null;
  const col = (n) => headers[h.indexOf(n.toLowerCase())] || "";
  return { ab: true, direction: "in", columns: {
    first_name: col("Donor First Name"), last_name: col("Donor Last Name"), amount: col("Amount"), date: col("Date"),
    street: col("Donor Addr1"), city: col("Donor City"), state: col("Donor State"), zip: col("Donor ZIP"),
    occupation: col("Donor Occupation"), employer: col("Donor Employer"), check_number: "",
    fee: col("Fee"), refundDate: col("Refund Date"), recipient: col("Recipient"), comments: col("Comments") } };
}
// Sorts a donor into the right Schedule A page from the name alone when the name makes it obvious.
// Returns { source, why } for sure things, { source: "" } when a person must decide.
function classifyDonor(name) {
  const n = " " + String(name || "").trim() + " ";
  const t = (re, source, why) => (re.test(n) ? { source, why } : null);
  return (
    t(/\b(inc|corp|corporation|incorporated|co\.|company|ltd)\b\.?/i, "corporation", "its name has “Inc” or “Corp” in it") ||
    t(/\b(l\.?l\.?c|l\.?l\.?p|llp|partners|partnership|associates|& sons|enterprises|group|farms?|realty|properties|holdings)\b/i, "other", "it looks like an LLC, partnership or other business") ||
    t(/\b(uaw|ibew|afscme|afl-cio|seiu|teamsters|steelworkers|usw|ufcw|iuoe|carpenters|laborers|union|local \d+)\b/i, "labor", "it looks like a union") ||
    t(/\b(pac|political action|victory fund|leadership fund)\b/i, "pac", "it looks like a PAC") ||
    t(/\b(committee to elect|friends of|for (council|mayor|sheriff|judge|commissioner|clerk|treasurer|auditor|recorder|assessor|coroner|surveyor|trustee|school board|senate|house|state)|democratic|republican|libertarian|central committee|county party|caucus)\b/i, "committee", "it looks like a party or candidate committee") ||
    t(/\b(church|club|association|society|foundation|lodge|post \d+|chamber of commerce|league)\b/i, "other", "it looks like an organization") ||
    { source: "" }
  );
}
const looksLikeOrg = (name) => /\b(inc|corp|llc|l\.l\.c|llp|ltd|co\.|company|partners|associates|enterprises|group|union|local \d+|pac|committee|club|church|association|foundation|fund|services|solutions|farms?|realty|bank|credit union|store|shop|market|hardware|print|sign)\b/i.test(String(name || ""));
const isJointName = (name) => /(\s&\s|\band\b)/i.test(String(name || "")) && !looksLikeOrg(name);
function applyDonorRules(e) {
  if (KINDS[e.kind]?.group !== "in" || !e.name) return e;
  if (e.source && e.source !== "individual") return e;            // already set to something specific
  const c = classifyDonor(e.name);
  if (c.source) { e.source = c.source; e.sourceGuessed = c.why; }
  else if (looksLikeOrg(e.name)) { e.source = ""; delete e.sourceGuessed; }   // must be decided by a person
  else if (isJointName(e.name) && !e.jointNoted) { e.source = e.source || "individual"; e.jointNoted = true; e.question = e.question || `“${e.name}” looks like two people. The form wants the person who signed the check, or both names if both signed.`; }
  return e;
}
// "1810 S. Webster St, Kokomo, IN 46902" → parts, when a sheet keeps the whole address in one cell.
function splitAddress(street, city, state, zip) {
  if (city || zip || !street) return { street, city, state, zip };
  const m = street.match(/^(.*?)[,\s]+([A-Za-z .'-]+?)(?:,?\s+(IN|Indiana|[A-Z]{2}))?[,\s]+(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return { street, city, state, zip };
  return { street: m[1].replace(/,\s*$/, ""), city: m[2].trim(), state: (m[3] || "IN").replace(/^Indiana$/i, "IN").toUpperCase(), zip: m[4] };
}
function codeIsWeak(purpose, code) {
  if (!code) return true;
  const p = String(purpose || "");
  if (code !== "O") return false;
  return !/fee|postage|stamp|rent|office|travel|gas|mileage|supplies|bank|phone|software|insurance|payroll|wages|salary|filing|utilit|consult|poll|survey|text|dues|processing/i.test(p);
}
const ACTBLUE = { name: "ActBlue Technical Services", street: "PO Box 441146", city: "Somerville", state: "MA", zip: "02144" };
const NB_MARKERS = ["nationbuilder_id", "amount", "signup_full_name"];
function nbMap(headers) {
  if (!NB_MARKERS.every((h) => headers.includes(h))) return null;
  const pick = (...c) => c.find((h) => headers.includes(h)) || "";
  return { nb: true, direction: "mixed", columns: {
    name: "signup_full_name", first_name: "signup_first_name", last_name: "signup_last_name", amount: "amount",
    date: pick("succeeded_at", "posting_date", "created_at"), street: pick("billing_address1", "signup_primary_address1", "signup_billing_address1"),
    city: pick("billing_city", "signup_primary_city"), state: pick("billing_state", "signup_primary_state"), zip: pick("billing_zip", "signup_primary_zip"),
    occupation: "signup_occupation", employer: "signup_employer", method: "payment_type_name", check_number: "check_number", purpose: "note" } };
}
// Most treasurers' own sheets use plain words for their columns. Recognize those here, so the common case
// needs no AI at all; anything unusual still goes to the AI to sort out.
const HEADER_WORDS = {
  name: ["who", "name", "donor", "donor name", "contributor", "contributor name", "from", "given by", "full name", "person", "giver"],
  first_name: ["first", "first name", "firstname"], last_name: ["last", "last name", "lastname", "surname"],
  amount: ["amount", "amt", "how much", "$", "gift", "donation", "contribution", "sum", "dollars", "amount ($)", "amount $"],
  date: ["date", "when", "date received", "received", "day", "date rec'd", "date recd", "date given"],
  street: ["address", "street", "street address", "addr", "mailing address", "address 1", "address1"],
  city: ["city", "town"], state: ["state", "st"], zip: ["zip", "zip code", "zipcode", "postal code", "postal"],
  occupation: ["job", "occupation", "work", "profession", "employment", "occupation/employer", "job title"],
  employer: ["employer", "works for", "company"],
  purpose: ["notes", "note", "memo", "comment", "comments", "for", "purpose", "description", "what for", "details"],
  method: ["method", "how paid", "paid by", "payment", "payment type", "cash/check", "cash or check", "type of payment"],
  check_number: ["check #", "check number", "check no", "check no.", "ck #", "ck#", "check#", "chk #"],
};
const OUT_WORDS = ["payee", "vendor", "paid to", "spent", "expense", "expenses", "expenditure", "who we paid"];
function plainMap(headers) {
  const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9#$/ ]+/g, " ").replace(/\s+/g, " ").trim();
  const H = headers.map(norm), columns = {};
  for (const [k, words] of Object.entries(HEADER_WORDS)) { const i = H.findIndex((h, j) => words.includes(h) && !Object.values(columns).includes(headers[j])); if (i >= 0) columns[k] = headers[i]; }
  let direction = "in";
  const oi = H.findIndex((h) => OUT_WORDS.includes(h));
  if (oi >= 0) { if (columns.name) return null; columns.name = headers[oi]; direction = "out"; }   // a sheet with both is mixed: let the AI decide
  if (!columns.amount || !columns.date || !(columns.name || (columns.first_name && columns.last_name))) return null;
  return { plain: true, direction, columns };
}
function rowToEntry(row, map, file) {
  const c = map.columns, g = (k) => (c[k] ? row[c[k]] || "" : "");
  let amount = parseAmount(g("amount")); if (!amount) return null;
  let kind = "contribution";
  if (map.nb) {
    if (row.failed_at || row.canceled_at) return null;
    const t = (row.type || "").toLowerCase();
    if (/refund/.test(t)) kind = "refund"; else if (/expenditure|expense|disbursement/.test(t)) kind = "expense"; else if (amount < 0) kind = "refund";
  } else {
    if (map.direction === "out") kind = "expense";
    else if (map.direction === "mixed" && map.direction_column) {
      const v = (row[map.direction_column] || "").toLowerCase();
      kind = (map.direction_in_values || []).some((x) => v.includes(String(x).toLowerCase())) ? "contribution" : "expense";
    }
    if (amount < 0) kind = kind === "contribution" ? "refund" : "contribution";
    if (c.status && (map.skip_status_values || []).some((x) => (row[c.status] || "").toLowerCase().includes(String(x).toLowerCase()))) return null;
  }
  amount = Math.abs(amount);
  let name = g("name") || [g("first_name"), g("last_name")].filter(Boolean).join(" ");
  if (/^\s*(grand\s+)?(sub)?totals?\b|^\s*sum\b/i.test(name)) return null;     // a totals row at the bottom of the sheet
  if (!name && !g("date")) return null;
  const method = g("method"), isCorp = map.nb && /^(true|1|yes)$/i.test(row.is_corporate_contribution || "");
  if (map.ab && !name) return null;
  const notes = [g("purpose"), method].filter(Boolean).join(" ");
  let source = isCorp ? "corporation" : "individual";
  if (!map.ab && !map.nb) {
    // A candidate's own sheet: the notes column usually says what a row really is.
    if (kind === "refund" && !/refund|return/i.test(notes)) kind = "expense";           // a negative on a donations sheet is a payment
    if (kind === "contribution" && /\bloan/i.test(notes)) kind = "loan";
    if (kind === "contribution" && /in.?kind|donated|gave us|provided/i.test(notes)) kind = "inkind";
    if (/\(me\)|\bmyself\b|\bmy own\b|candidate/i.test(name + " " + notes) || (S.about.candidate && name.toLowerCase().includes(S.about.candidate.toLowerCase()))) { source = "candidate"; name = name.replace(/\s*\((me|myself|candidate)\)\s*/i, "").trim() || S.about.candidate; }
    if (/\bpac\b/i.test(notes)) source = "pac";
  }
  const out = KINDS[kind].group !== "in";
  const addr = splitAddress(g("street"), g("city"), g("state"), g("zip"));
  const e = {
    id: uid(), kind, source: out ? "" : source, name,
    street: addr.street, city: addr.city, state: addr.state || (addr.city ? "IN" : ""), zip: String(addr.zip || "").split("-")[0],
    occupation: g("occupation") || "", amount, date: parseDate(g("date")), method: method || (map.nb ? "online" : ""),
    check: (g("check_number") || (method.match(/check\s*#?\s*(\d+)/i) || [])[1] || ""), receivedBy: out ? "" : (S.about.treasurer || ""),
    desc: kind === "inkind" ? g("purpose").replace(/\(?in.?kind\)?/i, "").trim() : "", purpose: out ? g("purpose") : "",
    code: "", office: "", sourceFile: file, question: "", fromSheet: true,
  };
  if (source === "pac" || source === "candidate") return out ? e : (e.code = "", e);
  if (out) { e.code = CFA.guessCode(e.purpose); e.codeGuessed = codeIsWeak(e.purpose, e.code); }
  if (map.ab) return e;                       // ActBlue only takes money from individuals
  if (isCorp) return e;
  return applyDonorRules(e);
}
async function importSheet(f, rec) {
  const { headers, data } = await sheetRows(f);
  let map = abMap(headers) || nbMap(headers) || plainMap(headers);
  if (!map && isDemo()) throw new Error("The sample can read spreadsheets with plain column names like “Name”, “Amount” and “Date”. To import a sheet laid out differently, set up your own committee.");
  if (!map) {
    map = await ai("mapcolumns", { headers, rows: data.slice(0, 6) });
    if (!map.columns?.amount) throw new Error("Couldn't tell which column holds the amounts. Add a header row with “Name”, “Amount” and “Date”.");
  }
  const year = yearOf(curReport()?.end);
  const seen = new Set(S.entries.map((e) => [e.kind, (e.name || "").toLowerCase(), Number(e.amount), e.date].join("|")));
  let added = 0, otherYear = 0, dupes = 0, skipped = 0;
  const before = new Set(seen);
  const fresh = [], fees = {}; let refunds = 0, repeats = 0;
  for (const row of data) {
    const e = rowToEntry(row, map, f.name);
    if (!e) { skipped++; continue; }
    if (e.date && !e.date.startsWith(year)) { otherYear++; continue; }
    const k = [e.kind, e.name.toLowerCase(), e.amount, e.date].join("|");
    if (seen.has(k)) { if (before.has(k)) dupes++; else repeats++; continue; }
    seen.add(k); fresh.push(e); added++;
    if (map.ab) {
      e.method = "online (ActBlue)";
      const fee = parseAmount(row[map.columns.fee] || "");
      if (fee > 0) { const m = e.date.slice(0, 7); fees[m] = (fees[m] || 0) + fee; }
      const rd = parseDate(row[map.columns.refundDate] || "");
      if (rd) {
        const rk = ["refund", e.name.toLowerCase(), e.amount, rd].join("|");
        if (!seen.has(rk)) { seen.add(rk); refunds++; fresh.push({ ...e, id: uid(), kind: "refund", date: rd, receivedBy: "", purpose: "Refund of ActBlue contribution", code: "", method: "", question: "" }); }
      }
    }
  }
  // One fee expense per month, payable to ActBlue (code O), instead of hundreds of tiny lines.
  const feeMonths = Object.keys(fees).sort();
  for (const m of feeMonths) {
    const last = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
    const date = `${m}-${String(last).padStart(2, "0")}`, amt = Math.round(fees[m] * 100) / 100;
    const k = ["expense", ACTBLUE.name.toLowerCase(), amt, date].join("|");
    if (seen.has(k)) continue; seen.add(k);
    fresh.push({ id: uid(), kind: "expense", source: "", ...ACTBLUE, occupation: "", amount: amt, date, method: "withheld from deposits", check: "", receivedBy: "", desc: "", purpose: `ActBlue processing fees, ${new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleString("en-US", { month: "long" })}`, code: "O", office: "", sourceFile: f.name, question: "", fromSheet: true });
  }
  if (added > 3000) throw new Error(`That's ${added.toLocaleString()} rows for this year, more than one report can hold. Filter the export to this committee's ${year} transactions first.`);
  S.entries.push(...fresh); justAdded = fresh.map((e) => e.id);
  const pStart = curReport()?.start || "";
  const earlierN = fresh.filter((e) => pStart && e.date && e.date < pStart).length;
  rec.count = added - earlierN;
  const parts = [];
  if (earlierN) parts.push(`${earlierN} from earlier this year (kept for donor totals, not on this report)`);
  if (otherYear) parts.push(`${otherYear.toLocaleString()} from other years left out`);
  if (dupes) parts.push(`${dupes} already in your report`);
  if (repeats) parts.push(`${repeats} repeated row${repeats === 1 ? "" : "s"} skipped`);
  if (skipped) parts.push(`${skipped} blank, total or canceled row${skipped === 1 ? "" : "s"} skipped`);
  if (map.ab) { rec.ab = true; parts.unshift(`${refunds ? refunds + " refund" + (refunds > 1 ? "s" : "") + " · " : ""}fees added as ${feeMonths.length} monthly expense${feeMonths.length === 1 ? "" : "s"} to ActBlue`); }
  rec.detail = parts.join(" · ");
  if (!added && otherYear) rec.detail = `No ${year} transactions in this file. ${otherYear.toLocaleString()} rows are from other years, so they don't belong on this report.`;
  changed();
}
function b64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); }); }
async function shrink(f) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't open this photo. On iPhone, set Camera → Formats → Most Compatible, or take a screenshot of it.")); i.src = URL.createObjectURL(f); });
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.78).split(",")[1];
}
async function readFiles(files) {
  for (const f of files) {
    const rec = { name: f.name, status: "reading" }; S.files.push(rec); render();
    try {
      if (isSheet(f)) await importSheet(f, rec);
      else { const p = await fileToPayload(f); const j = await ai("extract", { ...p, context: context() }); rec.count = addItems(j.items, f.name); }
      rec.status = "done";
    } catch (e) { rec.status = "error"; rec.error = e.message; }
    changed(); render();
  }
}
async function readPrior(files) {
  startJob("prior");
  try {
    const all = [];
    for (const f of files) all.push(...((await fileToPayload(f)).files || []));
    const j = await ai("extract", { files: all, textLabel: "Previously filed CFA-4", text: "This is the candidate's previously filed CFA-4 report. Fill prior_report.", context: context() });
    const r = j.prior_report || {};
    const o = setOpening("upload");
    const set = (k, v) => { if (v != null && v !== "") o[k] = String(v); };
    set("cashBegin", r.line18_colA_ending_cash); set("cashJan1", r.line14_jan1_cash);
    set("rec15aB", r.line15a_colB); set("rec15bB", r.line15b_colB); set("exp17aB", r.line17a_colB); set("exp17bB", r.line17b_colB);
    o.readFrom = files[0]?.name || "your upload";
    if (r.file_number && !S.about.fileNumber) S.about.fileNumber = r.file_number;
    if (r.committee_name && !S.about.committee) S.about.committee = r.committee_name;
    S.priorDebts = (r.unpaid_debts || []).filter((d) => Number(d.balance ?? d.amount) > 0).map((d, i) => ({ id: "prior-debt-" + i, creditor: d.creditor, address: addr(d), amount: d.amount, nature: d.nature, date: d.date, paidBefore: Number(d.amount) - Number(d.balance ?? d.amount) }));
    const earlier = (j.items || []).filter((i) => KINDS[i.kind]?.group === "in" && i.date && i.date < (curReport()?.start || ""));
    addItems(earlier, files[0]?.name || "last report");
  } catch (e) { alert(e.message); }
  endJob("prior"); changed(); render();
}
async function runReview() {
  startJob("ai");
  try {
    const { C, flags } = results();
    const j = await ai("review", { report: { about: S.about, lines: C.lines, entries: S.entries, existing_flags: flags.filter((f) => !f.ai).map((f) => f.msg) } });
    S.aiFlags = (j.flags || []).map((f) => ({ ...f, reportId: curReport()?.id }));
  } catch (e) { S.aiFlags = [{ severity: "tip", message: "The second opinion couldn't run right now.", fix: e.message, reportId: curReport()?.id }]; }
  S.aiReviewedAt = Date.now();
  endJob("ai"); changed(); render();
}
async function buildPdf(mode) {
  busy.pdf = true; render();
  try {
    const rep = curReport();
    const tpl = await (await fetch("/forms/CFA-4.pdf")).arrayBuffer();
    let R, C;
    if (mode === "filed" && rep.snapshot?.R) { R = rep.snapshot.R; C = CFA.compute(R); }
    else { R = buildReport(rep); if (mode === "amend") R.amendment = true; C = CFA.compute(R); }
    const bytes = await CFAFill.build(PDFLib, tpl, R, C);
    saveFile(new Blob([bytes], { type: "application/pdf" }), `CFA-4 ${rep.type} ${yearOf(rep.end)}${mode === "amend" ? " amended" : ""} ${S.about.candidate || "report"}.pdf`);
  } catch (e) { alert("Couldn't build the PDF: " + e.message); }
  busy.pdf = false; render();
}
function buildStateFile() {
  busy.state = true; stateMsg = ""; render();
  try {
    const R = buildReport(); R.treasurer = S.about.treasurer;
    const C = CFA.compute(R);
    const { wb, counts } = StateExport.build(R, C, S.entries);
    const name = `IN-import ${curReport().type} ${yearOf(curReport().end)} ${(S.about.candidate || "report").replace(/[^\w ]+/g, "")}.xlsx`;
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveFile(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name);
    stateMsg = `Built ${name}: ${counts.contribution} contribution lines, ${counts.expenditure} expenditure lines, ${counts.debt} debt lines.`;
  } catch (e) { stateMsg = "Couldn't build the file: " + e.message; }
  busy.state = false; render();
}
function saveFile(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

// ---------- CFA-11: the 48-hour "large contribution" report ----------
// A candidate's committee that receives $1,000 or more from one source inside the supplemental window
// (25 days before an election through 48 hours before it) files a CFA-11 within 48 hours (IC 3-9-5-20.1).
const RECEIPT_KINDS = ["contribution", "inkind", "loan", "interest", "misc"];
const srcKeyOf = (e) => (e.personKey || nameKey(e.name)) + "|" + (CFA.SOURCE_SCHEDULE[e.source] || "A5");
function cfa11Items() {
  if (isParty()) return [];   // regular party committees don't file CFA-11 reports
  const out = [], t = today();
  for (const Y of committeeYears()) for (const w of CFA.suppWindows(+Y)) {
    const win = { ...w, id: `${w.report}-${Y}` };
    const inWin = S.entries.filter((e) => RECEIPT_KINDS.includes(e.kind) && e.date && e.date >= w.start && e.date <= w.end && e.name).sort((a, b) => a.date.localeCompare(b.date));
    const groups = new Map();
    for (const e of inWin) { const k = srcKeyOf(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    for (const [k, list] of groups) {
      const total = list.reduce((s, e) => s + num(e.amount), 0);
      if (total < CFA.LARGE_CONTRIB) continue;
      let run = 0, trigger = list[0];
      for (const e of list) { run += num(e.amount); if (run >= CFA.LARGE_CONTRIB) { trigger = e; break; } }
      const key = `${win.id}|${k}`;
      const filed = S.cfa11.filter((f) => f.key === key).sort((a, b) => (b.filedAt || "").localeCompare(a.filedAt || ""))[0] || null;
      const newSince = filed ? list.filter((e) => !filed.entryIds.includes(e.id)) : list;
      const due = new Date(`${trigger.date}T${trigger.time || "23:59"}:00`); due.setHours(due.getHours() + 48);
      const dueText = trigger.time ? `by ${due.toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
        : `within 48 hours of when you received it on ${fmtDate(trigger.date)} (add the time to that entry for the exact deadline)`;
      out.push({ key, window: win, name: list[0].name, entries: list, total, trigger, due, dueText, filed: filed && !newSince.length ? true : false, filedAt: filed?.filedAt, newSince });
    }
  }
  return out;
}
async function buildCfa11(key) {
  const it = cfa11Items().find((i) => i.key === key); if (!it) return;
  busy.pdf = true; render();
  try {
    const tpl = await (await fetch("/forms/CFA-11.pdf")).arrayBuffer();
    const a = S.about;
    const rows = it.entries.map((e) => ({
      classification: { individual: "IND", candidate: "IND", pac: "PAC", corporation: "CORP", labor: "LAB" }[e.source] || "OTHER",
      name: e.name, address: addr(e), occupation: e.occupation || "", type: e.kind === "contribution" ? "direct" : e.kind, desc: e.desc || "",
      amount: num(e.amount), date: e.date, receivedBy: e.receivedBy || "",
    }));
    const bytes = await CFAFill11.build(PDFLib, tpl, { fileNumber: a.fileNumber, candidate: a.candidate, phone: a.phone, street: a.street, city: a.city, state: a.state, zip: a.zip, party: a.party, office: a.office, county: a.county, treasurerTitle: a.treasurerTitle, start: it.window.start, end: it.window.end, rows });
    saveFile(new Blob([bytes], { type: "application/pdf" }), `CFA-11 ${it.name} ${a.candidate || ""}.pdf`);
    cfa11Prompt = key;
  } catch (e) { alert("Couldn't build the CFA-11: " + e.message); }
  busy.pdf = false; render();
}
let cfa11Prompt = null;

// Optional: corporations and unions that gave to more than one committee this year (names only; nothing else is shared).
const corpCache = {};
function corpWarnings() {
  const Y = yearOf(), out = [];
  for (const e of S.entries) {
    if (!(e.source === "corporation" || e.source === "labor") || !e.name || yearOf(e.date) !== Y) continue;
    const key = nameKey(e.name); if (S.dismissed["corp|" + key] || out.some((o) => o.key === key)) continue;
    if (corpCache[key] == null) { corpCache[key] = 0; lookupRaw("corp", { name: e.name, year: Y }).then((m) => { if (m && m.others) { corpCache[key] = m.others; render(); } }); continue; }
    if (corpCache[key] > 0) out.push({ key, name: e.name });
  }
  return out;
}
// Lookup responses for the corp check come back as { others }, not { match }.
async function lookupRaw(kind, q) { if (isDemo()) return null; try { const r = await fetch("/api/lookup?" + new URLSearchParams({ kind, ...q }), { headers: { "X-Draft-Code": CODE } }); return r.ok ? r.json() : null; } catch (e) { return null; } }

// ---------- Closing the committee ----------
function startFinal() {
  const last = S.reports.filter((r) => r.status === "filed").sort((a, b) => b.end.localeCompare(a.end))[0];
  const Y = yearOf(), o = openingFor(Y);
  const start = last ? nextDay(last.end) : (o ? o.ledgerFrom : `${Y}-01-01`);
  const end = today(); const due = new Date(end + "T12:00:00"); due.setDate(due.getDate() + 30);
  startReport("Final", start, end, due.toLocaleDateString("en-CA"), null);
}
const daysUntil = (d) => Math.ceil((new Date(d + "T12:00:00") - Date.now()) / 864e5);
const inSuppWindow = (d) => !isParty() && !!d && CFA.suppWindows(+yearOf(d)).some((w) => d >= w.start && d <= w.end);
const nextDay = (d) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + 1); return x.toLocaleDateString("en-CA"); };

// ---------- Donors and payees on file ----------
function peopleBook() {
  const Y = yearOf(), donors = new Map(), payees = new Map();
  for (const e of S.entries) {
    if (!e.name || yearOf(e.date) !== Y) continue;
    const g = KINDS[e.kind]?.group, k = (e.personKey || nameKey(e.name));
    const m = g === "in" ? donors : g === "out" ? payees : null; if (!m) continue;
    const cur = m.get(k) || { id: e.id, name: e.name, address: "", total: 0, n: 0, last: "" };
    cur.total = num(cur.total + num(e.amount)); cur.n++; if ((e.date || "") >= cur.last) { cur.last = e.date || ""; cur.id = e.id; if (e.street) cur.address = addr(e).join(", "); }
    m.set(k, cur);
  }
  const sort = (m) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { donors: sort(donors), payees: sort(payees) };
}
function addAgain(id) {
  const e = S.entries.find((x) => x.id === id); if (!e) return;
  const g = KINDS[e.kind]?.group;
  openEdit(null, g === "in" ? "contribution" : "expense", { name: e.name, source: e.source, street: e.street, city: e.city, state: e.state, zip: e.zip, occupation: e.occupation, personKey: e.personKey, code: g === "out" ? e.code : "" });
}

// ---------- Shared lookups (addresses from reports filed in this county) ----------
async function lookup(kind, q) {
  if (isDemo()) return null;
  try {
    const r = await fetch("/api/lookup?" + new URLSearchParams({ kind, ...q }), { headers: { "X-Draft-Code": CODE } });
    if (!r.ok) return null; const j = await r.json(); return j.match || null;
  } catch (e) { return null; }
}
// Once a report is filed its donors are public record, so their details can help other candidates in the county.
async function publishFiled(rep) {
  if (isDemo()) return;
  const county = S.about.county || "";
  const people = S.entries.filter((e) => inPeriod(e, rep) && KINDS[e.kind]?.group === "in" && e.name && e.street && (e.zip || e.city))
    .map((e) => ({ name: e.name, source: e.source || "", street: e.street, city: e.city, state: e.state, zip: e.zip, occupation: e.occupation || "" }));
  try { await fetch("/api/lookup", { method: "POST", headers: { "Content-Type": "application/json", "X-Draft-Code": CODE }, body: JSON.stringify({ county, people }) }); } catch (e) {}
}
// Entries read in from a report that was filed on paper before Tally are public too; share them once.
async function publishPriorOnce() {
  if (isDemo()) return;
  if (S.published.prior || !S.entries.some((e) => e.fromPrior)) return;
  const county = S.about.county || "";
  const people = S.entries.filter((e) => e.fromPrior && KINDS[e.kind]?.group === "in" && e.name && e.street && (e.zip || e.city))
    .map((e) => ({ name: e.name, source: e.source || "", street: e.street, city: e.city, state: e.state, zip: e.zip, occupation: e.occupation || "" }));
  try { const r = await fetch("/api/lookup", { method: "POST", headers: { "Content-Type": "application/json", "X-Draft-Code": CODE }, body: JSON.stringify({ county, people }) }); if (r.ok) { S.published.prior = Date.now(); changed(); } } catch (e) {}
}

// When someone adds a donor's job or address on one entry, fill the same blank on that donor's other entries,
// so fixing one flag doesn't leave the same flag on their second gift.
function fillSamePerson(e) {
  if (KINDS[e.kind]?.group !== "in" || !e.name) return;
  const k = e.personKey || personGroupKey(e.name), st = streetKey(e);
  for (const o of S.entries) {
    if (o === e || KINDS[o.kind]?.group !== "in" || (o.personKey || personGroupKey(o.name)) !== k) continue;
    if (st && streetKey(o) && streetKey(o) !== st) continue;            // same name, different address: someone else
    if (!o.occupation && e.occupation) o.occupation = e.occupation;
    if (!o.street && e.street) Object.assign(o, { street: e.street, city: e.city, state: e.state, zip: e.zip });
  }
}
// What still needs doing on one entry: the flags that point at it, and the fields they're about.
const FIELD_NAMES = { name: "name", amount: "amount", date: "date", street: "street address", city: "city", state: "state", zip: "ZIP", occupation: "job", receivedBy: "who received it", desc: "description", purpose: "what it was for", code: "expense code", source: "kind of donor" };
function entryNeeds(id) {
  const rep = curReport(); if (!rep) return { flags: [], fields: [] };
  const flags = results(rep).flags.filter((f) => (f.ids || []).includes(id) && f.sev !== "tip");
  const e = S.entries.find((x) => x.id === id) || {};
  // For an address, only point at the parts that are actually blank.
  const all = [...new Set(flags.flatMap((f) => f.fields || []))], isAddr = (k) => ["street", "city", "state", "zip"].includes(k);
  const blankAddr = all.filter((k) => isAddr(k) && !e[k]);
  const fields = all.filter((k) => !isAddr(k)).concat(blankAddr.length ? blankAddr : all.filter(isAddr).slice(0, 1));
  return { flags, fields };
}
const needsLine = (id) => { const n = entryNeeds(id); const bad = n.flags.some((f) => f.sev === "must_fix"); const list = n.fields.map((k) => FIELD_NAMES[k] || k); return list.length ? `<div class="needs ${bad ? "bad" : "warn"}">${bad ? "Needs" : "Check"}: ${esc(list.join(", "))}</div>` : ""; };

// ---------- Edit dialog ----------
function openEdit(id, presetKind, prefill) {
  const orig = id ? S.entries.find((e) => e.id === id) : null;
  const x = orig ? { ...orig } : { id: uid(), kind: presetKind || "contribution", source: presetKind === "expense" ? "" : "individual", state: "IN", receivedBy: S.about.treasurer || "", amount: "", date: "", ...(prefill || {}) };
  const dlg = $("#editDlg");
  const formData = () => { const o = {}; for (const [k, v] of new FormData($("#editForm"))) o[k] = k === "amount" ? (v === "" ? "" : Number(v)) : v; return o; };
  function draw() {
    const g = KINDS[x.kind]?.group;
    const f = (k, l, type = "text", hint = "") => `<label for="e_${k}">${l}${hint ? ` <small>${hint}</small>` : ""}<input id="e_${k}" name="${k}" type="${type}" ${type === "number" ? 'step="0.01" inputmode="decimal"' : ""} value="${esc(x[k])}"></label>`;
    const sel = (k, l, opts) => `<label for="e_${k}">${l}<select id="e_${k}" name="${k}"><option value=""></option>${Object.entries(opts).map(([v, t]) => `<option value="${v}" ${x[k] === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
    const debts = {};
    S.entries.filter((e) => e.kind === "loan" || e.kind === "unpaid_bill").forEach((e) => (debts[e.id.startsWith("prior") ? e.id : (e.kind === "loan" ? "loan-" + e.id : e.id)] = `${e.name} — ${money(e.amount)}`));
    S.priorDebts.forEach((d) => (debts[d.id] = `${d.creditor} — ${money(d.amount)}`));
    const need = orig ? entryNeeds(orig.id) : { flags: [], fields: [] };
    $("#editForm").innerHTML = `<h3>${orig ? "Edit this entry" : "Add an entry"}</h3>
    ${need.flags.length ? `<div class="fixlist">${need.flags.map((f) => `<p class="${f.sev === "must_fix" ? "bad" : "warn"}"><b>${esc(f.msg)}</b> ${esc(f.fix || "")}</p>`).join("")}</div>` : ""}
    ${x.question ? `<div class="q">${esc(x.question)}</div>` : ""}
    <div class="grid">${sel("kind", "What is it?", Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])))}${f("amount", "Amount ($)", "number")}${f("date", g === "in" ? "Date received" : g === "owed" ? "Date billed" : "Date paid", "date")}</div>
    <div class="grid">${f("name", g === "in" ? "Who gave it" : g === "owed" ? "Who you owe" : "Who was paid", "text", "full name or business name")}${g === "in" ? sel("source", "Who are they?", SOURCES) : ""}</div>
    <div class="grid">${f("street", "Street address")}${f("city", "City")}${f("state", "State")}${f("zip", "ZIP")}</div>
    ${g === "in" ? `<div class="grid">${f("occupation", "Occupation", "text", "required at $1,000+ a year")}${f("receivedBy", "Received by", "text", "who took it for the campaign")}${f("method", "Paid by", "text", "optional: check, cash, card, online")}${f("check", "Check #", "text", "optional, helps match your bank statement")}${inSuppWindow(x.date) ? f("time", "Time received", "time", "sets the 48-hour report deadline if this donor reaches $1,000") : ""}</div>
      ${x.kind === "inkind" || x.kind === "misc" ? `<div class="grid">${f("desc", x.kind === "inkind" ? "What was donated" : "What it was", "text", "like “yard signs”")}${x.kind === "inkind" ? sel("code", "Expense code for this gift", CODES) : ""}</div>` : ""}`
    : `<div class="grid">${f("purpose", "What it was for", "text", "be specific")}${g === "out" ? sel("code", "Expense code", CODES) : ""}${g === "out" ? f("method", "Paid by", "text", "optional: check, card, cash, online") : ""}${g === "out" ? f("check", "Check #", "text", "optional, helps match your bank statement") : ""}${g === "out" ? f("occupation", "Their occupation", "text", "optional, like “printer”") : ""}${x.kind === "transfer_out" ? f("office", "Office they're seeking", "text", "if it's a candidate") : ""}${x.kind === "debt_payment" ? sel("debtId", "Which debt is this paying?", debts) : ""}</div>`}
    <div id="lookupRow"></div>
    <p class="codehelp">${g === "out" ? "Not sure about the code? Signs, printing and ads are A. Event costs are F. Fees, postage and supplies are O." : ""}</p>
    <div class="nav">${orig ? `<button class="btn ghost" value="delete" type="submit">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" value="cancel" type="submit">Cancel</button><button class="btn" value="save" type="submit">Save</button></div></div>`;
    for (const k of need.fields) { const el = $("#e_" + k); if (el) { el.closest("label")?.classList.add("need"); el.addEventListener("input", () => el.closest("label")?.classList.remove("need"), { once: true }); } }
    const firstNeed = need.fields.map((k) => $("#e_" + k)).find(Boolean); if (firstNeed) setTimeout(() => firstNeed.focus(), 50);
    $("#e_kind").addEventListener("change", () => { Object.assign(x, formData()); draw(); });
    $("#e_date")?.addEventListener("change", () => { const was = !!$("#e_time"); Object.assign(x, formData()); if (was !== inSuppWindow(x.date)) draw(); });
    const pc = $("#e_purpose"), cd = $("#e_code");
    if (pc && cd) pc.addEventListener("change", () => { if (!cd.value) cd.value = CFA.guessCode(pc.value); });
    $("#e_name")?.addEventListener("change", () => suggest());
    if (x.name && !x.street) suggest();
  }
  // Offer an address from a report filed in this county when the one here is blank. Shown once per name; never filled in by itself.
  let lastLooked = "";
  async function suggest() {
    const g = KINDS[$("#e_kind")?.value]?.group, name = $("#e_name")?.value?.trim() || "";
    const row = $("#lookupRow"); if (!row) return;
    if (!name || $("#e_street")?.value || g === "owed") { row.innerHTML = ""; return; }
    const kind = g === "in" ? "person" : "payee", dk = `lk:${kind}:${nameKey(name)}`;
    if (S.dismissed[dk] || lastLooked === dk) return; lastLooked = dk;
    const m = await lookup(kind, { name, city: $("#e_city")?.value || "", occupation: $("#e_occupation")?.value || "", county: S.about.county || "" });
    if (!m || $("#e_name")?.value?.trim() !== name) return;
    const line = [m.street, [m.city, [m.state, m.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ");
    row.innerHTML = `<div class="q"><b>${kind === "person" ? `An address for ${esc(name)} appears on another report filed in ${esc(S.about.county || "this")} County` : `${esc(name)} appears on other reports`}:</b> ${esc(line)}${m.occupation && !$("#e_occupation")?.value ? `, ${esc(m.occupation)}` : ""}${m.code && kind === "payee" ? ` (usually coded ${esc(m.code)})` : ""}. Use it?
      <span class="row" style="margin-top:6px"><button class="btn small" type="button" id="lkYes">Yes, use it</button><button class="btn ghost small" type="button" id="lkNo">No</button></span></div>`;
    $("#lkYes").onclick = () => { for (const k of ["street", "city", "state", "zip"]) if ($("#e_" + k) && m[k]) $("#e_" + k).value = m[k]; if ($("#e_occupation") && !$("#e_occupation").value && m.occupation) $("#e_occupation").value = m.occupation; if ($("#e_code") && !$("#e_code").value && m.code) $("#e_code").value = m.code; if ($("#e_source") && !$("#e_source").value && m.source) $("#e_source").value = m.source; row.innerHTML = ""; };
    $("#lkNo").onclick = () => { S.dismissed[dk] = Date.now(); changed(); row.innerHTML = ""; };
  }
  draw();
  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v === "delete") S.entries = S.entries.filter((e) => e.id !== x.id);
    if (v === "save") { Object.assign(x, formData()); x.question = ""; delete x.sourceGuessed; delete x.codeGuessed; if (orig) { delete orig.sourceGuessed; delete orig.codeGuessed; Object.assign(orig, x); } else S.entries.push(x); fillSamePerson(orig || x); }
    if (v === "delete" || v === "save") { S.aiFlags = S.aiFlags && S.aiFlags.filter((a) => !(a.item_ids || []).includes(x.id)); changed(); }
    render();
  };
  dlg.returnValue = ""; dlg.showModal();
}

// ---------- Events ----------
document.addEventListener("click", (e) => {
  const b = e.target.closest("button, [data-copy]"); if (!b) return;
  if (b.dataset.go) { S.step = b.dataset.go; justAdded = S.step === "add" ? justAdded : []; changed(); render(); window.scrollTo({ top: 0 }); }
  else if (b.hasAttribute("data-dash")) goDash();
  else if (b.dataset.open) openReport(b.dataset.open, b.dataset.step);
  else if (b.dataset.startreport) { const [type, start, end, due, supp] = b.dataset.startreport.split("|"); startReport(type, start, end, due, supp ? supp.split(",") : null); }
  else if (b.dataset.plan != null) { const Y = yearOf(); S.year[Y] = { ...(S.year[Y] || {}), plan: b.dataset.plan ? { status: b.dataset.plan, office: S.about.office || "" } : null }; if (b.dataset.plan === "closing") startFinal(); else { changed(); render(); } }
  else if (b.dataset.again) addAgain(b.dataset.again);
  else if (b.dataset.cfa11) buildCfa11(b.dataset.cfa11);
  else if (b.dataset.cfa11filed) { const it = cfa11Items().find((i) => i.key === b.dataset.cfa11filed); if (it) { S.cfa11.push({ id: uid(), window: it.window.id, key: it.key, entryIds: it.entries.map((e) => e.id), filedAt: today() }); changed(); render(); } }
  else if (b.dataset.dismiss) { S.dismissed[b.dataset.dismiss] = Date.now(); changed(); render(); }
  else if (b.dataset.act === "samplesheet") importSampleSheet(false);
  else if (b.dataset.act === "allflags") { showAllFlags = true; render(); }
  else if (b.dataset.act === "undismiss") { for (const k of Object.keys(S.dismissed)) if (!k.startsWith("lk:") && !k.startsWith("corp|")) delete S.dismissed[k]; changed(); render(); }
  else if (b.dataset.act === "filed") markFiled(curReport(), $("#filedDate")?.value || today());
  else if (b.dataset.act === "filed-again") { const r = curReport(); r.amendment = true; markFiled(r, today()); }
  else if (b.dataset.act === "unfile") { const r = curReport(); r.status = "open"; r.snapshot = null; S.step = "print"; changed(); render(); }
  else if (b.dataset.act === "pdf-filed") buildPdf("filed");
  else if (b.dataset.act === "pdf-amend") buildPdf("amend");
  else if (b.dataset.tab) { S.tab = b.dataset.tab; render(); }
  else if (b.dataset.edit) openEdit(b.dataset.edit);
  else if (b.dataset.removefile != null) {
    const idx = +b.dataset.removefile;
    if (b.dataset.yes) { const f = S.files[idx]; if (f) { S.entries = S.entries.filter((e) => e.sourceFile !== f.name); S.files.splice(idx, 1); S.aiFlags = null; } confirmRemove = -1; changed(); }
    else if (b.dataset.no) confirmRemove = -1;
    else confirmRemove = idx;
    render();
  }
  else if (b.dataset.merge) applyMerge(b.dataset.merge);
  else if (b.dataset.splitdonor) splitDonor(b.dataset.splitdonor);
  else if (b.dataset.sort) { const key = b.dataset.sort.toLowerCase(); for (const e of S.entries) if ((e.name || "").trim().toLowerCase() === key && KINDS[e.kind]?.group === "in") { e.source = b.dataset.source; delete e.sourceGuessed; } changed(); render(); }
  else if (b.dataset.prior) { setOpening(b.dataset.prior); changed(); render(); }
  else if (b.dataset.start != null) {
    const ta = $("#notes"), t = STARTERS[+b.dataset.start].text, cur = ta.value.replace(/\s+$/, ""), pre = cur ? cur + "\n" : "";
    ta.value = pre + t; S.draft = ta.value; $("#coach").innerHTML = coach(ta.value); changed();
    ta.focus(); ta.setSelectionRange(pre.length + t.indexOf("["), pre.length + t.indexOf("]") + 1);
  }
  else if (b.dataset.copy) { navigator.clipboard?.writeText(b.dataset.copy).then(() => (b.textContent = "Copied"), () => {}); }
  else if (b.hasAttribute("data-closedlg")) b.closest("dialog").close();
  else if (b.dataset.act === "notes") readNotes();
  else if (b.dataset.act === "ask") askQuestion();
  else if (b.dataset.act === "askhistory") { showHistory = !showHistory; render(); }
  else if (b.dataset.act === "askclear") { S.ask = []; lastAskId = null; showHistory = false; changed(); render(); }
  else if (b.dataset.askadd) { const x = (S.ask || []).find((y) => y.id === b.dataset.askadd); if (x) { addItems(x.items, ""); x.items = []; changed(); render(); } }
  else if (b.dataset.newkind) openEdit(null, b.dataset.newkind);
  else if (b.dataset.bankadd) { const l = S.bank.lines.find((x) => x.id === b.dataset.bankadd); if (l) openEdit(null, l.dir === "in" ? "contribution" : "expense", { amount: l.amount, date: l.date, check: l.check, method: l.check ? "check" : "", bankLineId: l.id }); }
  else if (b.dataset.bankignore) { const l = S.bank.lines.find((x) => x.id === b.dataset.bankignore); if (l) l.ignored = true; changed(); render(); }
  else if (b.dataset.bankignoreall) { for (const l of bankCheck().lines) l.ignored = true; changed(); render(); }
  else if (b.dataset.removebank) { S.bank.lines = S.bank.lines.filter((l) => l.stId !== b.dataset.removebank); S.bank.statements = S.bank.statements.filter((st) => st.id !== b.dataset.removebank); changed(); render(); }
  else if (b.dataset.act === "new") openEdit(null);
  else if (b.dataset.act === "ai") runReview();
  else if (b.dataset.act === "pdf") buildPdf();
  else if (b.dataset.act === "state") buildStateFile();
  else if (b.dataset.act === "backup") saveFile(new Blob([JSON.stringify({ code: CODE, savedAt: new Date().toISOString(), data: S }, null, 1)], { type: "application/json" }), `finance-report-backup-${CODE}.json`);
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.bind) {
    const [o, k] = t.dataset.bind.split(".");
    if (o === "opening") { const Y = yearOf(curReport().end); if (S.year[Y]?.opening) S.year[Y].opening[k] = t.value; }
    else if (o === "report") { const r = curReport(); if (r) r[k] = t.value; }
    else if (k) S[o][k] = t.value; else S[o] = t.value;
    changed();
    if (t.tagName === "SELECT") render(); else $("#whoLine").textContent = S.about.committee || S.about.candidate || "New report";
  }
  if (t.id === "notes") { S.draft = t.value; const c = $("#coach"); if (c) c.innerHTML = coach(t.value); changed(); }
  if (t.id === "askBox") { S.askDraft = t.value; localSave(); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "amendBox") { const r = curReport(); if (r) { r.amendment = e.target.checked; changed(); } }
  if (e.target.id === "fileIn") readFiles([...e.target.files]);
  if (e.target.id === "priorIn") readPrior([...e.target.files]);
  if (e.target.id === "bankIn") readBank([...e.target.files]);
});
document.addEventListener("dragover", (e) => { const d = e.target.closest?.("#drop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
document.addEventListener("dragleave", (e) => { const d = e.target.closest?.("#drop"); if (d) d.classList.remove("over"); });
document.addEventListener("drop", (e) => { const d = e.target.closest?.("#drop"); if (d) { e.preventDefault(); d.classList.remove("over"); readFiles([...e.dataTransfer.files]); } });

// ---------- Boot ----------
(async function boot() {
  if (/^\/demo\/?$/.test(location.pathname) || /[?&]demo\b/.test(location.search)) { startDemo(); return; }
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9-]+)/) || location.search.match(/[?&]d=([A-Za-z0-9-]+)/);
  if (m) { try { await openCode(m[1]); return; } catch (e) { showStart(); $("#resumeCode").value = m[1]; $("#resumeErr").textContent = e.message; $("#resumeErr").hidden = false; return; } }
  showStart();
})();
