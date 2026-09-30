// Campaign Finance Helper — candidate app
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
  { label: "Someone gave money", text: "[Name] of [street, city, ZIP], who works as [job], gave $[amount] by [check # / cash / card], deposited on [date]." },
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

function blank() {
  return {
    v: 1, step: "about",
    about: { candidate: "", committee: "", acronym: "", office: "", county: "Howard", party: "", treasurer: "", treasurerTitle: "Treasurer", phone: "", street: "", city: "", state: "IN", zip: "", fileNumber: "", report: "Pre-Election", amendment: false },
    prior: { mode: "", cashBegin: "", cashJan1: "", rec15aB: "", rec15bB: "", exp17aB: "", exp17bB: "" },
    bankBalance: "",
    entries: [], priorDebts: [], files: [], draft: "", aiFlags: null, mustFix: null,
  };
}

// ---------- Saving ----------
const LS = (code) => "cfh-draft-" + code;
function localSave() { try { localStorage.setItem(LS(CODE), JSON.stringify({ data: S, rev: REV, dirty, at: Date.now() })); localStorage.setItem("cfh-last-code", CODE); } catch (e) {} }
function changed() { dirty = true; localSave(); setSave(); clearTimeout(saveTimer); saveTimer = setTimeout(pushSave, 1200); }
async function pushSave() {
  if (!dirty || saving || !CODE) return;
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
  S = Object.assign(blank(), S);
  history.replaceState(null, "", "/r/" + CODE);
  showApp();
  if (dirty) pushSave();
}

// ---------- Start screen ----------
function showStart() {
  $("#startView").hidden = false; $("#appView").hidden = true;
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
    CODE = j.code; REV = 0; S = blank(); history.replaceState(null, "", "/r/" + CODE);
    showApp(); changed(); showCode(true);
  } catch (x) { err.textContent = x.message; err.hidden = false; }
});
$("#restoreBtn").addEventListener("click", () => $("#restoreIn").click());
$("#restoreIn").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j.code || !j.data) throw new Error();
    CODE = j.code; S = Object.assign(blank(), j.data);
    const r = await fetch("/api/draft?code=" + encodeURIComponent(CODE)); const k = await r.json();
    REV = r.ok ? k.rev : 0; showApp(); changed();
  } catch (x) { $("#resumeErr").textContent = "That file isn't a backup from this tool."; $("#resumeErr").hidden = false; }
});

function showCode(first) {
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
function buildReport() {
  const a = S.about, p = S.prior;
  const typed = p.mode === "typed" || p.mode === "upload";
  const n = (v) => (v === "" || v == null ? 0 : Number(v));
  return {
    reportType: a.report, fileNumber: a.fileNumber, amendment: a.amendment, treasurerTitle: a.treasurerTitle, today: today(),
    committee: { name: a.committee, acronym: a.acronym, phone: a.phone, street: a.street, city: a.city, state: a.state, zip: a.zip, party: a.party },
    candidate: { name: a.candidate, party: a.party, office: a.office, county: a.county },
    cashBegin: n(p.cashBegin), cashJan1: n(p.cashJan1),
    prior: typed ? { rec15aB: n(p.rec15aB), rec15bB: n(p.rec15bB), exp17aB: n(p.exp17aB), exp17bB: n(p.exp17bB) } : (p.mode === "first" ? { rec15aB: 0, rec15bB: 0, exp17aB: 0, exp17bB: 0 } : undefined),
    bankBalance: S.bankBalance,
    entries: S.entries.filter((e) => e.kind !== "unpaid_bill"),
    debts: S.priorDebts.concat(S.entries.filter((e) => e.kind === "unpaid_bill").map((e) => ({ id: e.id, creditor: e.name, address: addr(e), amount: e.amount, nature: e.purpose ? "Unpaid bill: " + e.purpose : "Unpaid bill", date: e.date }))),
  };
}
const addr = (e) => [e.street, [e.city, [e.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean);
function results() {
  const C = CFA.compute(buildReport());
  const extra = [];
  for (const e of S.entries) {
    if (e.question) extra.push({ sev: "check", ids: [e.id], msg: e.question, fix: "Open the entry, fix anything needed, and save it to clear this." });
    if (!(Number(e.amount) > 0)) extra.push({ sev: "must_fix", ids: [e.id], msg: `${e.name || "An entry"} has no amount.`, fix: "Enter the dollar amount." });
    if (KINDS[e.kind]?.group === "in" && !e.source) extra.push({ sev: "must_fix", ids: [e.id], msg: `What kind of donor is ${e.name || "this"}: a person, a corporation, an LLC, a union, a PAC?`, fix: "The form has a separate page for each kind. Use the “Sort your donors” buttons on the Check Each Entry step.", step: "list" });
    if (e.sourceGuessed && e.source) extra.push({ sev: "check", ids: [e.id], msg: `We filed ${e.name} as ${({ corporation: "a corporation", other: "an LLC or other business", labor: "a union", pac: "a PAC", committee: "a party or candidate committee" })[e.source] || e.source} because ${e.sourceGuessed}.`, fix: "If that's right, nothing to do. If not, open the entry and change “Who are they?”" });
    if (e.codeGuessed && e.code && KINDS[e.kind]?.group === "out") extra.push({ sev: "check", ids: [e.id], msg: `We coded the ${money(e.amount)} payment to ${e.name || "this vendor"} as O (operations) because “${e.purpose || "no purpose given"}” didn't tell us more.`, fix: "Change the code if it was advertising (A), a fundraiser cost (F) or a gift to another campaign (C)." });
  }
  const a = S.about;
  for (const [k, l] of [["committee", "committee name"], ["candidate", "candidate name"], ["office", "office sought"], ["treasurer", "treasurer's name"], ["street", "mailing address"], ["city", "city"], ["zip", "ZIP code"]])
    if (!a[k]) extra.push({ sev: "must_fix", ids: [], msg: `The cover page is missing the ${l}.`, fix: "Fill it in on the first step.", step: "about" });
  if (!S.prior.mode) extra.push({ sev: "must_fix", ids: [], msg: "We need the numbers from your last report.", fix: "Go to “Your last report” and fill it in, or say this is your first report.", step: "prior" });
  const ai = (S.aiFlags || []).map((f) => ({ sev: f.severity, ids: f.item_ids || [], msg: f.message, fix: f.fix, ai: true }));
  const order = { must_fix: 0, check: 1, tip: 2 };
  const seenMsg = new Set();
  const flags = [...C.flags, ...extra, ...ai].filter((f) => { const k = f.sev + "|" + f.msg; if (seenMsg.has(k)) return false; seenMsg.add(k); return true; }).sort((x, y) => order[x.sev] - order[y.sev]);
  return { C, flags };
}

// ---------- Render ----------
function showApp() { $("#startView").hidden = true; $("#appView").hidden = false; $("#codeLabel").textContent = CODE; render(); setSave(); }
function render() {
  const { flags } = results();
  S.mustFix = flags.filter((f) => f.sev === "must_fix").length;
  $("#whoLine").textContent = S.about.committee || S.about.candidate || "New report";
  const idx = STEPS.findIndex((s) => s.id === S.step);
  $("#steps").innerHTML = STEPS.map((s, i) => `<li class="${i < idx ? "done" : ""}"><button type="button" data-go="${s.id}" ${s.id === S.step ? 'aria-current="step"' : ""}><span class="n">${i < idx ? "✓" : i + 1}</span>${s.t}</button></li>`).join("");
  $("#progressBox").textContent = `${S.entries.length} entr${S.entries.length === 1 ? "y" : "ies"} · ${S.mustFix} to fix`;
  $("#main").innerHTML = VIEWS[S.step]();
  if (S.step === "add") { const ta = $("#notes"); if (ta) $("#coach").innerHTML = coach(ta.value); }
}
const navRow = (back, next, nextLabel = "Continue") => `<div class="nav">${back ? `<button class="btn ghost" data-go="${back}" type="button">Back</button>` : "<span></span>"}${next ? `<button class="btn" data-go="${next}" type="button">${nextLabel}</button>` : ""}</div>`;
const field = (obj, k, label, hint = "", attrs = "") => `<label for="f-${obj}-${k}">${label}${hint ? ` <small>${hint}</small>` : ""}<input id="f-${obj}-${k}" data-bind="${obj}.${k}" value="${esc(S[obj][k])}" ${attrs}></label>`;

const VIEWS = {
about() {
  const P = CFA.PERIODS_2026;
  return `<div><h2>About your campaign</h2><p class="lead">This goes on the cover page. Use the committee name and file number from your CFA-1 statement of organization.</p></div>
  <div class="panel grid">
    ${field("about", "committee", "Committee name", "exactly as on your CFA-1")}
    ${field("about", "fileNumber", "File number", "from the county election board")}
    ${field("about", "candidate", "Candidate's full name", "include any nickname on the ballot")}
    ${field("about", "office", "Office sought", "include district, like “County Council, District 2”")}
    ${field("about", "party", "Party", "or “Independent candidate”")}
    ${field("about", "county", "County of residence")}
    ${field("about", "treasurer", "Treasurer's name")}
    ${field("about", "phone", "Committee phone")}
    ${field("about", "street", "Committee mailing address")}
    ${field("about", "city", "City")}
    ${field("about", "state", "State")}
    ${field("about", "zip", "ZIP code", "", 'inputmode="numeric"')}
    <label for="f-report">Which report is this?<select id="f-report" data-bind="about.report">${Object.entries(P).map(([k, p]) => `<option value="${k}" ${S.about.report === k ? "selected" : ""}>${k} (${fmtDate(p.start)} – ${fmtDate(p.end)})</option>`).join("")}</select></label>
  </div>
  <p class="muted">Due to the county election board by <b>noon on ${fmtDate(P[S.about.report]?.due)}</b>. Late reports are fined $50 a day.</p>
  ${navRow(null, "prior")}`;
},
prior() {
  const p = S.prior, m = p.mode;
  const opt = (k, t, d) => `<button type="button" data-prior="${k}" aria-pressed="${m === k}"><b>${t}</b><small>${d}</small></button>`;
  const hint = (n, t) => `<span class="numchip">${n}</span> ${t}`;
  const numField = (n, k, label) => `<label for="f-prior-${k}"><span>${hint(n, label)}</span><input id="f-prior-${k}" data-bind="prior.${k}" inputmode="decimal" value="${esc(p[k])}" placeholder="0.00"></label>`;
  let body = "";
  if (m === "first") body = `<div class="panel"><p style="margin:0"><b>Good, that's the easy case.</b> Everything starts at zero, plus whatever you add in the next step.</p></div>`;
  if (m === "upload" || m === "typed") body = `
    <div class="panel type">
      <h3>Take a photo of page 1 of your April report</h3>
      <p class="muted" style="margin:0">The first page is all we need. We'll read the six numbers off it and fill them in below for you to check.</p>
      <label class="drop" for="priorIn" style="padding:16px"><strong>Choose a photo or PDF</strong><p>The page with the boxes labeled 13 through 20.</p><input id="priorIn" type="file" multiple hidden accept="image/*,.pdf"></label>
      ${busy.prior ? '<p style="margin:0"><span class="spinner"></span> Reading your report…</p>' : ""}
      ${p.readFrom ? `<p class="hint" style="margin:0">Filled in from ${esc(p.readFrom)}. Check the numbers against the page.</p>` : ""}
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
  return `<div><h2>Your last report</h2><p class="lead">This report picks up where your April one left off, so a few numbers carry over.</p></div>
  <h3>Did you file a campaign finance report (CFA-4) this April?</h3>
  <div class="choice">${opt("upload", "Yes, I filed a report in April", "We'll get six numbers from it")}${opt("first", "No, I haven't filed a CFA-4 yet", "This will be my first one")}</div>
  ${body}
  ${navRow("about", "add")}`;
},
add() {
  const recent = justAdded.length ? `<div class="added"><b>Added ${justAdded.length} entr${justAdded.length === 1 ? "y" : "ies"}.</b> <button class="linkbtn" type="button" data-go="list">Check them</button></div>` : "";
  const files = S.files.length ? `<ul class="files">${S.files.slice(-12).reverse().map((f, i) => { const idx = S.files.length - 1 - i; const n = S.entries.filter((e) => e.sourceFile === f.name).length;
    return `<li><span>${esc(f.name)}</span><span class="row" style="justify-content:flex-end">${f.status === "reading" ? '<span class="spinner"></span> Reading' : f.status === "done" ? `<span><span class="pill ok">${f.count} added</span>${f.detail ? `<div class="src">${esc(f.detail)}</div>` : ""}</span>` : f.status === "error" ? `<span class="err">${esc(f.error || "Couldn't read")}</span>` : ""}
    ${f.status !== "reading" ? (confirmRemove === idx ? `<span class="row"><span class="hint">Remove this file and its ${n} entr${n === 1 ? "y" : "ies"}?</span><button class="btn small" type="button" data-removefile="${idx}" data-yes="1">Yes, remove</button><button class="btn ghost small" type="button" data-removefile="${idx}" data-no="1">Keep</button></span>` : `<button class="btn ghost small" type="button" data-removefile="${idx}">Remove</button>`) : ""}</span></li>`; }).join("")}</ul>` : "";
  const year = (CFA.PERIODS_2026[S.about.report]?.end || today()).slice(0, 4);
  const log = (S.ask || []).slice(-3);
  return `<div><h2>Add your records</h2><p class="lead">Enter each donation and payment, or upload what you have. Not sure about something? Ask at the bottom of the page.</p></div>
  ${recent}
  <div class="panel type">
    <h3>Add an entry</h3>
    <div class="choice">
      <button type="button" data-newkind="contribution"><b>Money came in</b><small>A donation, a loan, your own money, or donated goods</small></button>
      <button type="button" data-newkind="expense"><b>Money went out</b><small>Something the campaign paid for, or a bill you owe</small></button>
    </div>
    <details class="tipsbox"><summary>What you'll need for each entry</summary>
      <div class="tipsgrid">
        <div><b>Money in</b><ul><li>Who gave it (full name, or the business or group)</li><li>Street address, city and ZIP</li><li>Their job, once they've given $1,000 this year</li><li>How much, and the date you <b>deposited</b> it</li><li>Whether a business is an Inc./Corp. or an LLC</li></ul></div>
        <div><b>Money out</b><ul><li>Who you paid, and their address</li><li>What it was for (“yard signs”, “filing fee”)</li><li>How much, and the date you paid</li></ul></div>
        <div><b>Easy to forget</b><ul><li>Your own money put into the campaign</li><li>Campaign bills you paid personally</li><li>Donated food, printing or services</li><li>Bank and online-donation fees</li><li>Bills you owe but haven't paid</li></ul></div>
      </div></details>
  </div>
  <div class="or"><span>Have an ActBlue export, a spreadsheet, or a stack of paper?</span></div>
  <label class="drop" id="drop" for="fileIn"><strong>Upload photos or files</strong><p>Take a picture of each check, receipt or deposit slip, or upload a bank statement or spreadsheet. We'll pull out every entry for you to check.</p>
    <div class="chips"><span class="chip">ActBlue export</span><span class="chip">Phone photos</span><span class="chip">PDF</span><span class="chip">Excel / CSV</span><span class="chip">Screenshots</span></div>
    <input id="fileIn" type="file" multiple hidden accept="image/*,.pdf,.csv,.tsv,.txt,.xlsx,.xls"></label>
  ${files}
  <details class="tipsbox panel" ${S.files.some((f) => f.ab) ? "" : "open"}>
    <summary>Raise money on ActBlue? Get all of it in three steps.</summary>
    <ol class="abguide">
      <li>Sign in at <b>secure.actblue.com</b>. In the left menu, under <b>Tools</b>, click <b>Downloads</b>.</li>
      <li>Choose the <b>Contributions</b> report, set the dates to <b>January 1 to today</b>, and click <b>Export</b>. Pick <b>CSV</b>. ActBlue emails you the file or shows a download link.</li>
      <li>Drop that file in the box above. We add every ${year} donation with the donor's address and job, list ActBlue's fees as an expense the way the state wants, and record any refunds. Do this again right before you file to catch new donations.</li>
    </ol>
    <p class="hint" style="margin:0">Checks and cash still get entered above. Uploading the same export twice is safe; we skip what's already here.</p>
  </details>
  <div class="summary">${statTiles()}</div>
  <div class="panel ask">
    <h3>Have a question?</h3>
    <p class="muted" style="margin:4px 0 10px">Ask anything about what counts, what to enter, or how something should be reported. Answers use Indiana's rules and your report so far.</p>
    ${log.map((x) => `<div class="qa"><div class="q">${esc(x.q)}</div><div class="a">${esc(x.a)}${x.items?.length ? `<div class="row" style="margin-top:8px"><button class="btn small" type="button" data-askadd="${esc(x.id)}">Add ${x.items.length === 1 ? "this entry" : x.items.length + " entries"}</button></div>` : ""}</div></div>`).join("")}
    <textarea id="askBox" rows="2" placeholder="Example: My cousin bought $200 of yard signs for me. How do I report that?">${esc(S.askDraft || "")}</textarea>
    ${noteErr ? `<p class="err" style="margin:6px 0 0">${esc(noteErr)}</p>` : ""}
    <div class="row" style="margin-top:8px"><button class="btn ghost" type="button" data-act="ask" ${busy.ask ? "disabled" : ""}>${busy.ask ? '<span class="spinner"></span> Thinking…' : "Ask"}</button></div>
  </div>
  ${navRow("prior", "list", "Check my entries")}`;
},
list() {
  const tab = S.tab || "all";
  const flagged = new Set(results().flags.filter((f) => f.sev === "must_fix").flatMap((f) => f.ids));
  const rows = S.entries.filter((e) => tab === "all" || KINDS[e.kind]?.group === tab).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const unsorted = [...new Map(S.entries.filter((e) => KINDS[e.kind]?.group === "in" && !e.source && e.name).map((e) => [e.name.trim().toLowerCase(), e.name.trim()])).values()];
  const sortStrip = unsorted.length ? `<div class="panel sortstrip"><h3>Sort your donors</h3>
    <p class="muted" style="margin:4px 0 10px">The form has a separate page for each kind of donor, and corporations and unions have a $2,000 yearly limit. Tap the right kind for each one. <a href="https://inbiz.in.gov/BOS/PublicSearch/Search" target="_blank" rel="noopener">Not sure if a business is a corporation? Look it up</a>.</p>
    ${unsorted.map((n) => `<div class="sortrow"><b>${esc(n)}</b><div class="row">${Object.entries(SOURCES).filter(([k]) => k !== "candidate").map(([k, l]) => `<button type="button" class="starter" data-sort="${esc(n)}" data-source="${k}">${l}</button>`).join("")}</div></div>`).join("")}
  </div>` : "";
  return `<div><h2>Check each entry</h2><p class="lead">Everything so far, in date order. Tap Edit to fix anything.</p></div>${sortStrip}
  <div class="row" style="justify-content:space-between"><div class="tabs">${[["all", "All"], ["in", "Money in"], ["out", "Money out"], ["owed", "Unpaid bills"]].map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div><button class="btn ghost small" type="button" data-act="new">Add an entry</button></div>
  <div class="tablewrap"><table><thead><tr><th>Date</th><th>What</th><th>Name</th><th>Details</th><th class="amt">Amount</th><th></th></tr></thead><tbody>
  ${rows.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${KINDS[e.kind]?.label || e.kind}</td>
    <td>${esc(e.name) || "<span class='pill bad'>missing</span>"}<div class="src">${esc(e.sourceFile ? "from " + e.sourceFile : "typed in")}</div></td>
    <td>${esc([SOURCES[e.source] && KINDS[e.kind]?.group === "in" ? SOURCES[e.source] : "", e.code ? "Code " + e.code : "", e.purpose || e.desc, e.occupation].filter(Boolean).join(" · "))}${e.question ? `<div class="q">${esc(e.question)}</div>` : ""}</td>
    <td class="amt">${money(e.amount)}</td>
    <td>${flagged.has(e.id) ? '<span class="pill bad">fix</span>' : e.question ? '<span class="pill warn">check</span>' : '<span class="pill ok">ok</span>'} <button class="btn ghost small" type="button" data-edit="${e.id}">Edit</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">Nothing here yet.</td></tr>`}
  </tbody></table></div>
  <div class="panel grid"><label for="f-bank">Bank balance on ${fmtDate(CFA.PERIODS_2026[S.about.report]?.end)}<small>Optional. From your bank statement. We use it to catch anything missing.</small><input id="f-bank" data-bind="bankBalance" inputmode="decimal" value="${esc(S.bankBalance)}"></label></div>
  ${navRow("add", "review", "Look for problems")}`;
},
review() {
  const { flags } = results();
  const bad = flags.filter((f) => f.sev === "must_fix").length, warn = flags.filter((f) => f.sev === "check").length;
  const head = bad ? `${bad} thing${bad > 1 ? "s" : ""} to fix before you file` : warn ? "No blockers. A few things to double-check." : "Everything checks out.";
  const cls = { must_fix: "bad", check: "warn", tip: "tip" };
  return `<div><h2>${head}</h2><p class="lead">Red items would make the report wrong or incomplete. Yellow items are worth a second look.</p></div>
  <div class="flags">${flags.map((f) => `<div class="flag ${cls[f.sev]}"><div class="bar"></div><div><b>${esc(f.msg)}</b><p>${esc(f.fix)}</p></div><div class="row">${f.ids[0] && S.entries.some((e) => e.id === f.ids[0]) ? `<button class="btn ghost small" type="button" data-edit="${f.ids[0]}">Fix</button>` : f.step ? `<button class="btn ghost small" type="button" data-go="${f.step}">Fix</button>` : ""}</div></div>`).join("") || '<div class="panel empty">No problems found.</div>'}</div>
  <div class="panel"><h3>Second opinion</h3><p class="muted" style="margin:4px 0 10px">Have the AI look over the whole report for things rules can't catch, like the same donor under two spellings or an expense that looks personal.</p>
  <button class="btn ghost" type="button" data-act="ai" ${busy.ai ? "disabled" : ""}>${busy.ai ? '<span class="spinner"></span> Reviewing…' : S.aiFlags ? "Run the review again" : "Run the review"}</button></div>
  ${navRow("list", "print", "Build my report")}`;
},
print() {
  const { C, flags } = results(); const L = C.lines;
  const bad = flags.filter((f) => f.sev === "must_fix").length;
  const ln = (n, t, a, b) => `<div class="ln"><span>${n}</span><span>${t}</span><b>${a == null ? "" : money(a)}</b><b>${b == null ? "" : money(b)}</b></div>`;
  return `<div><h2>${bad ? "Almost there" : "Your report is ready"}</h2><p class="lead">${bad ? `There ${bad === 1 ? "is 1 item" : `are ${bad} items`} still marked red. You can print a draft now, but fix those before you file.` : "Download it, print it, sign it, and turn it in."}</p></div>
  <div class="panel"><div class="lines">
    <div class="ln hd"><span></span><span></span><span style="text-align:right">This period</span><span style="text-align:right">Year to date</span></div>
    ${ln(13, "Cash at start of this period", L.l13)}${ln(14, "Cash on January 1", null, L.l14)}
    ${ln("15a", "Itemized contributions", L.l15aA, L.l15aB)}${ln("15b", "Unitemized contributions", L.l15bA, L.l15bB)}
    ${ln(16, "Total", L.l16A, L.l16B)}
    ${ln("17a", "Itemized expenditures", L.l17aA, L.l17aB)}${ln("17b", "Unitemized expenditures", L.l17bA, L.l17bB)}
    ${ln(18, "Cash at end of this period", L.l18A, L.l18B)}${ln(19, "Debts you owe", L.l19)}${ln(20, "Debts owed to you", L.l20)}
  </div></div>
  <div class="row"><button class="btn" type="button" data-act="pdf" ${busy.pdf ? "disabled" : ""}>${busy.pdf ? '<span class="spinner"></span> Building…' : bad ? "Download a draft CFA-4" : "Download my CFA-4 (PDF)"}</button>
    <button class="btn ghost" type="button" data-act="backup">Download a backup file</button></div>
  <div class="panel"><h3>How to file</h3><ol>
    <li>Print every page.</li>
    <li>The treasurer signs and dates the summary page. If the candidate isn't the treasurer, the candidate signs too.</li>
    <li>Turn it in to the county election board (the Clerk's office) by <b>noon on ${fmtDate(C.due)}</b>. Ask the Clerk whether they take email or fax. A mailed report counts only when it arrives, not by postmark.</li>
    <li>Keep receipts for every expense over $25 for three years.</li>
  </ol></div>
  ${navRow("review", null)}`;
},
};
function statTiles() { const { C } = results(); const L = C.lines; return [["Entries", S.entries.length], ["Money in", money(L.l15cA)], ["Money out", money(L.l17cA)], ["Ending cash", money(L.l18A)]].map(([l, v]) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`).join(""); }

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
    in: [["amount", "amount"], ["date", "deposit date"], ["address", "full address + ZIP"], ["how", "check, cash or card"]],
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
  const r = await fetch("/api/" + endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Draft-Code": CODE }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
  return j;
}
function context() {
  const a = S.about, P = CFA.PERIODS_2026[a.report] || {};
  return { candidate_name: a.candidate, treasurer: a.treasurer, committee: a.committee, report: a.report, period_start: P.start, period_end: P.end, today: today() };
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

async function askQuestion() {
  const q = ($("#askBox")?.value || "").trim(); if (!q) return;
  busy.ask = true; noteErr = ""; render();
  try {
    const { C, flags } = results();
    const ctx = { ...context(), lines: C.lines, entry_count: S.entries.length, entries: S.entries.slice(-60).map((e) => ({ kind: e.kind, source: e.source, name: e.name, amount: e.amount, date: e.date, purpose: e.purpose || e.desc, code: e.code })), open_problems: flags.filter((f) => f.sev !== "tip").slice(0, 20).map((f) => f.msg) };
    const j = await ai("ask", { question: q, context: ctx, history: (S.ask || []).slice(-3).map((x) => ({ q: x.q, a: x.a })) });
    S.ask = (S.ask || []).concat([{ id: uid(), q, a: j.answer || "", items: j.items || [] }]).slice(-10);
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
    occupation: col("Donor Occupation"), employer: col("Donor Employer"), check_number: col("Check Number"),
    fee: col("Fee"), refundDate: col("Refund Date"), recipient: col("Recipient"), comments: col("Comments") } };
}
// Sorts a donor into the right Schedule A page from the name alone when the name makes it obvious.
// Returns { source, why } for sure things, { source: "" } when a person must decide.
function classifyDonor(name) {
  const n = " " + String(name || "").trim() + " ";
  const t = (re, source, why) => (re.test(n) ? { source, why } : null);
  return (
    t(/\b(inc|corp|corporation|incorporated|co\.|company|ltd)\b\.?/i, "corporation", "the name includes “Inc.” or “Corp.”") ||
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
  let map = abMap(headers) || nbMap(headers);
  if (!map) {
    map = await ai("mapcolumns", { headers, rows: data.slice(0, 6) });
    if (!map.columns?.amount) throw new Error("Couldn't tell which column holds the amounts. Add a header row with “Name”, “Amount” and “Date”.");
  }
  const year = (CFA.PERIODS_2026[S.about.report]?.end || today()).slice(0, 4);
  const seen = new Set(S.entries.map((e) => [e.kind, (e.name || "").toLowerCase(), Number(e.amount), e.date].join("|")));
  let added = 0, otherYear = 0, dupes = 0, skipped = 0;
  const fresh = [], fees = {}; let refunds = 0;
  for (const row of data) {
    const e = rowToEntry(row, map, f.name);
    if (!e) { skipped++; continue; }
    if (e.date && !e.date.startsWith(year)) { otherYear++; continue; }
    const k = [e.kind, e.name.toLowerCase(), e.amount, e.date].join("|");
    if (seen.has(k)) { dupes++; continue; }
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
  rec.count = added;
  const parts = [];
  if (otherYear) parts.push(`${otherYear.toLocaleString()} from other years left out`);
  if (dupes) parts.push(`${dupes} already in your report`);
  if (skipped) parts.push(`${skipped} failed, canceled or empty`);
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
  busy.prior = true; render();
  try {
    const all = [];
    for (const f of files) all.push(...((await fileToPayload(f)).files || []));
    const j = await ai("extract", { files: all, textLabel: "Previously filed CFA-4", text: "This is the candidate's previously filed CFA-4 report. Fill prior_report.", context: context() });
    const r = j.prior_report || {};
    const set = (k, v) => { if (v != null && v !== "") S.prior[k] = String(v); };
    set("cashBegin", r.line18_colA_ending_cash); set("cashJan1", r.line14_jan1_cash);
    set("rec15aB", r.line15a_colB); set("rec15bB", r.line15b_colB); set("exp17aB", r.line17a_colB); set("exp17bB", r.line17b_colB);
    S.prior.readFrom = files[0]?.name || "your upload"; S.prior.mode = "upload";
    if (r.file_number && !S.about.fileNumber) S.about.fileNumber = r.file_number;
    if (r.committee_name && !S.about.committee) S.about.committee = r.committee_name;
    S.priorDebts = (r.unpaid_debts || []).filter((d) => Number(d.balance ?? d.amount) > 0).map((d, i) => ({ id: "prior-debt-" + i, creditor: d.creditor, address: addr(d), amount: d.amount, nature: d.nature, date: d.date, paidBefore: Number(d.amount) - Number(d.balance ?? d.amount) }));
    const earlier = (j.items || []).filter((i) => KINDS[i.kind]?.group === "in" && i.date && i.date < (CFA.PERIODS_2026[S.about.report]?.start || ""));
    addItems(earlier, files[0]?.name || "last report");
  } catch (e) { alert(e.message); }
  busy.prior = false; changed(); render();
}
async function runReview() {
  busy.ai = true; render();
  try {
    const { C, flags } = results();
    const j = await ai("review", { report: { about: S.about, lines: C.lines, entries: S.entries, existing_flags: flags.filter((f) => !f.ai).map((f) => f.msg) } });
    S.aiFlags = j.flags || [];
  } catch (e) { S.aiFlags = [{ severity: "tip", message: "The second opinion couldn't run right now.", fix: e.message }]; }
  busy.ai = false; changed(); render();
}
async function buildPdf() {
  busy.pdf = true; render();
  try {
    const tpl = await (await fetch("/forms/CFA-4.pdf")).arrayBuffer();
    const R = buildReport(), C = CFA.compute(R);
    const bytes = await CFAFill.build(PDFLib, tpl, R, C);
    saveFile(new Blob([bytes], { type: "application/pdf" }), `CFA-4 ${S.about.report} ${S.about.candidate || "report"}.pdf`);
  } catch (e) { alert("Couldn't build the PDF: " + e.message); }
  busy.pdf = false; render();
}
function saveFile(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

// ---------- Edit dialog ----------
function openEdit(id, presetKind) {
  const orig = id ? S.entries.find((e) => e.id === id) : null;
  const x = orig ? { ...orig } : { id: uid(), kind: presetKind || "contribution", source: presetKind === "expense" ? "" : "individual", state: "IN", receivedBy: S.about.treasurer || "", amount: "", date: "" };
  const dlg = $("#editDlg");
  const formData = () => { const o = {}; for (const [k, v] of new FormData($("#editForm"))) o[k] = k === "amount" ? (v === "" ? "" : Number(v)) : v; return o; };
  function draw() {
    const g = KINDS[x.kind]?.group;
    const f = (k, l, type = "text", hint = "") => `<label for="e_${k}">${l}${hint ? ` <small>${hint}</small>` : ""}<input id="e_${k}" name="${k}" type="${type}" ${type === "number" ? 'step="0.01" inputmode="decimal"' : ""} value="${esc(x[k])}"></label>`;
    const sel = (k, l, opts) => `<label for="e_${k}">${l}<select id="e_${k}" name="${k}"><option value=""></option>${Object.entries(opts).map(([v, t]) => `<option value="${v}" ${x[k] === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
    const debts = {};
    S.entries.filter((e) => e.kind === "loan" || e.kind === "unpaid_bill").forEach((e) => (debts[e.id.startsWith("prior") ? e.id : (e.kind === "loan" ? "loan-" + e.id : e.id)] = `${e.name} — ${money(e.amount)}`));
    S.priorDebts.forEach((d) => (debts[d.id] = `${d.creditor} — ${money(d.amount)}`));
    $("#editForm").innerHTML = `<h3>${orig ? "Edit this entry" : "Add an entry"}</h3>
    ${x.question ? `<div class="q">${esc(x.question)}</div>` : ""}
    <div class="grid">${sel("kind", "What is it?", Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])))}${f("amount", "Amount ($)", "number")}${f("date", g === "in" ? "Date deposited" : g === "owed" ? "Date billed" : "Date paid", "date")}</div>
    <div class="grid">${f("name", g === "in" ? "Who gave it" : g === "owed" ? "Who you owe" : "Who was paid", "text", "full name or business name")}${g === "in" ? sel("source", "Who are they?", SOURCES) : ""}</div>
    <div class="grid">${f("street", "Street address")}${f("city", "City")}${f("state", "State")}${f("zip", "ZIP")}</div>
    ${g === "in" ? `<div class="grid">${f("occupation", "Occupation", "text", "required at $1,000+ a year")}${f("receivedBy", "Received by", "text", "who took it for the campaign")}${f("method", "Paid by", "text", "check, cash, card, online")}${f("check", "Check #")}</div>
      ${x.kind === "inkind" || x.kind === "misc" ? `<div class="grid">${f("desc", x.kind === "inkind" ? "What was donated" : "What it was", "text", "like “yard signs”")}${x.kind === "inkind" ? sel("code", "Expense code for this gift", CODES) : ""}</div>` : ""}`
    : `<div class="grid">${f("purpose", "What it was for", "text", "be specific")}${g === "out" ? sel("code", "Expense code", CODES) : ""}${g === "out" ? f("occupation", "Their occupation", "text", "optional, like “printer”") : ""}${x.kind === "transfer_out" ? f("office", "Office they're seeking", "text", "if it's a candidate") : ""}${x.kind === "debt_payment" ? sel("debtId", "Which debt is this paying?", debts) : ""}</div>`}
    <p class="codehelp">${g === "out" ? "Not sure about the code? Signs, printing and ads are A. Event costs are F. Fees, postage and supplies are O." : ""}</p>
    <div class="nav">${orig ? `<button class="btn ghost" value="delete" type="submit">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" value="cancel" type="submit">Cancel</button><button class="btn" value="save" type="submit">Save</button></div></div>`;
    $("#e_kind").addEventListener("change", () => { Object.assign(x, formData()); draw(); });
    const pc = $("#e_purpose"), cd = $("#e_code");
    if (pc && cd) pc.addEventListener("change", () => { if (!cd.value) cd.value = CFA.guessCode(pc.value); });
  }
  draw();
  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v === "delete") S.entries = S.entries.filter((e) => e.id !== x.id);
    if (v === "save") { Object.assign(x, formData()); x.question = ""; delete x.sourceGuessed; delete x.codeGuessed; if (orig) { delete orig.sourceGuessed; delete orig.codeGuessed; Object.assign(orig, x); } else S.entries.push(x); }
    if (v === "delete" || v === "save") { S.aiFlags = S.aiFlags && S.aiFlags.filter((a) => !(a.item_ids || []).includes(x.id)); changed(); }
    render();
  };
  dlg.returnValue = ""; dlg.showModal();
}

// ---------- Events ----------
document.addEventListener("click", (e) => {
  const b = e.target.closest("button, [data-copy]"); if (!b) return;
  if (b.dataset.go) { S.step = b.dataset.go; justAdded = S.step === "add" ? justAdded : []; changed(); render(); window.scrollTo({ top: 0 }); }
  else if (b.dataset.tab) { S.tab = b.dataset.tab; render(); }
  else if (b.dataset.edit) openEdit(b.dataset.edit);
  else if (b.dataset.removefile != null) {
    const idx = +b.dataset.removefile;
    if (b.dataset.yes) { const f = S.files[idx]; if (f) { S.entries = S.entries.filter((e) => e.sourceFile !== f.name); S.files.splice(idx, 1); S.aiFlags = null; } confirmRemove = -1; changed(); }
    else if (b.dataset.no) confirmRemove = -1;
    else confirmRemove = idx;
    render();
  }
  else if (b.dataset.sort) { const key = b.dataset.sort.toLowerCase(); for (const e of S.entries) if ((e.name || "").trim().toLowerCase() === key && KINDS[e.kind]?.group === "in") { e.source = b.dataset.source; delete e.sourceGuessed; } changed(); render(); }
  else if (b.dataset.prior) { S.prior.mode = b.dataset.prior; changed(); render(); }
  else if (b.dataset.start != null) {
    const ta = $("#notes"), t = STARTERS[+b.dataset.start].text, cur = ta.value.replace(/\s+$/, ""), pre = cur ? cur + "\n" : "";
    ta.value = pre + t; S.draft = ta.value; $("#coach").innerHTML = coach(ta.value); changed();
    ta.focus(); ta.setSelectionRange(pre.length + t.indexOf("["), pre.length + t.indexOf("]") + 1);
  }
  else if (b.dataset.copy) { navigator.clipboard?.writeText(b.dataset.copy).then(() => (b.textContent = "Copied"), () => {}); }
  else if (b.hasAttribute("data-closedlg")) b.closest("dialog").close();
  else if (b.dataset.act === "notes") readNotes();
  else if (b.dataset.act === "ask") askQuestion();
  else if (b.dataset.askadd) { const x = (S.ask || []).find((y) => y.id === b.dataset.askadd); if (x) { addItems(x.items, ""); x.items = []; changed(); render(); } }
  else if (b.dataset.newkind) openEdit(null, b.dataset.newkind);
  else if (b.dataset.act === "new") openEdit(null);
  else if (b.dataset.act === "ai") runReview();
  else if (b.dataset.act === "pdf") buildPdf();
  else if (b.dataset.act === "backup") saveFile(new Blob([JSON.stringify({ code: CODE, savedAt: new Date().toISOString(), data: S }, null, 1)], { type: "application/json" }), `finance-report-backup-${CODE}.json`);
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.bind) {
    const [o, k] = t.dataset.bind.split(".");
    if (k) S[o][k] = t.value; else S[o] = t.value;
    changed();
    if (t.tagName === "SELECT") render(); else $("#whoLine").textContent = S.about.committee || S.about.candidate || "New report";
  }
  if (t.id === "notes") { S.draft = t.value; const c = $("#coach"); if (c) c.innerHTML = coach(t.value); changed(); }
  if (t.id === "askBox") { S.askDraft = t.value; localSave(); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "fileIn") readFiles([...e.target.files]);
  if (e.target.id === "priorIn") readPrior([...e.target.files]);
});
document.addEventListener("dragover", (e) => { const d = e.target.closest?.("#drop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
document.addEventListener("dragleave", (e) => { const d = e.target.closest?.("#drop"); if (d) d.classList.remove("over"); });
document.addEventListener("drop", (e) => { const d = e.target.closest?.("#drop"); if (d) { e.preventDefault(); d.classList.remove("over"); readFiles([...e.dataTransfer.files]); } });

// ---------- Boot ----------
(async function boot() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9-]+)/) || location.search.match(/[?&]d=([A-Za-z0-9-]+)/);
  if (m) { try { await openCode(m[1]); return; } catch (e) { showStart(); $("#resumeCode").value = m[1]; $("#resumeErr").textContent = e.message; $("#resumeErr").hidden = false; return; } }
  showStart();
})();
