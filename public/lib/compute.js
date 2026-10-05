// CFA-4 rules engine: turns a list of entries into the numbers, schedule rows and flags for one report.
// Based on State Form 4606 (R18 / 6-25) and the 2026 Indiana Campaign Finance Manual (R/7-26).
// Works in the browser (window.CFA) and in Node (module.exports).

(function (root) {
  const ITEMIZE_OVER_CANDIDATE = 100; // IC 3-9-5-14: itemize when a source's calendar-year total exceeds $100 ($200 for party committees)
  const OCCUPATION_AT = 1000;        // occupation required when an individual gives $1,000+ in the calendar year
  const CORP_LABOR_LIMIT = 2000;     // IC 3-9-2-4: $2,000/yr from a corporation or union, shared across ALL county/local candidates
  const LARGE_CONTRIB = 1000;        // CFA-11 "48-hour" report threshold

  const PERIODS_2026 = {
    "Pre-Primary":  { start: "2026-01-01", end: "2026-04-10", due: "2026-04-17", supp: ["2026-04-11", "2026-05-03"], election: "2026-05-05" },
    "Pre-Election": { start: "2026-04-11", end: "2026-10-09", due: "2026-10-16", supp: ["2026-10-10", "2026-11-01"], election: "2026-11-03" },
    "Annual":       { start: "2026-10-10", end: "2026-12-31", due: "2027-01-20" },
  };
  // Reporting calendars by election year. Add a year here when the Election Division publishes it.
  // "local" covers county, city, town, township, school board and state legislative candidates on that year's ballot.
  const CALENDARS = { 2026: { local: PERIODS_2026 } };
  // Third Wednesday in January of the following year, noon: the annual report deadline (IC 3-9-5-10).
  function annualDue(year) { const d = new Date(Date.UTC(year + 1, 0, 1)); const dow = d.getUTCDay(); const first = 1 + ((3 - dow + 7) % 7); return `${year + 1}-01-${String(first + 14).padStart(2, "0")}`; }
  // The reports a committee owes in a year. Running for office in a year with a published calendar → that calendar;
  // otherwise just the annual report, which every open committee files whether or not it was on the ballot.
  // Regular party committees file their annual report by noon on March 1 (moved to the next weekday when it falls on a weekend).
  function partyAnnualDue(year) { const d = new Date(Date.UTC(year + 1, 2, 1)); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  function periodsFor(year, running, kind) {
    const cal = CALENDARS[year];
    if (kind === "party") {
      // Party committees file pre-primary, pre-election and annual reports; no 48-hour reports.
      if (cal) { const out = {}; for (const [k, p] of Object.entries(cal.local)) { out[k] = { ...p, supp: null }; if (k === "Annual") out[k].due = partyAnnualDue(year); } return out; }
      return { "Annual": { start: `${year}-01-01`, end: `${year}-12-31`, due: partyAnnualDue(year) } };
    }
    if (running && cal) return cal.local;
    return { "Annual": { start: `${year}-01-01`, end: `${year}-12-31`, due: annualDue(year) } };
  }
  // Supplemental ("48-hour") windows in a year: 25 days before an election through 48 hours before it.
  function suppWindows(year) {
    const cal = CALENDARS[year]; if (!cal) return [];
    return Object.entries(cal.local).filter(([, p]) => p.supp).map(([k, p]) => ({ report: k, start: p.supp[0], end: p.supp[1], election: p.election }));
  }
  // Cash movement between two dates (from inclusive, to exclusive). In-kind gifts don't touch cash.
  function netCash(entries, from, to) {
    let n = 0;
    for (const e of entries || []) {
      if (!e.date || e.date < from || e.date >= to) continue;
      if (["contribution", "loan", "interest", "misc"].includes(e.kind)) n += num(e.amount);
      else if (["expense", "debt_payment", "refund", "transfer_out"].includes(e.kind)) n -= num(e.amount);
    }
    return num(n);
  }

  // Where each kind of money-in lands on Schedule A
  const SOURCE_SCHEDULE = { individual: "A1", candidate: "A1", corporation: "A2", labor: "A3", pac: "A4", committee: "A5", other: "A5" };
  const RECEIPT_KINDS = ["contribution", "inkind", "loan", "interest", "misc"];
  const EXPENSE_KINDS = ["expense", "debt_payment", "refund", "transfer_out"];

  const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const inRange = (d, a, b) => d && d >= a && d <= b;
  const yearOf = (d) => (d || "").slice(0, 4);

  function addressLines(e) {
    const street = e.street || e.address || "";
    const csz = [e.city, [e.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return [street, csz].filter(Boolean);
  }

  function compute(report) {
    const P = report.period || PERIODS_2026[report.reportType] || {};
    const start = report.start || P.start, end = report.end || P.end, year = yearOf(end);
    const ledgerFrom = report.ledgerFrom || `${year}-01-01`;
    const isParty = report.committeeType === "party";
    const ITEMIZE_OVER = isParty ? 200 : ITEMIZE_OVER_CANDIDATE;   // regular party committees itemize over $200   // entries before this were already counted in report.prior
    const all = (report.entries || []).filter((e) => yearOf(e.date) === year || !e.date);
    const flags = [];
    const flag = (sev, ids, msg, fix, fields) => flags.push({ sev, ids: [].concat(ids || []), msg, fix, fields: fields || [] });

    const receipts = all.filter((e) => RECEIPT_KINDS.includes(e.kind));
    const expenses = all.filter((e) => EXPENSE_KINDS.includes(e.kind) || e.kind === "inkind");
    const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");

    // ---------- Receipts (Schedule A) ----------
    const srcKey = (e) => (e.personKey || norm(e.name)) + "|" + (SOURCE_SCHEDULE[e.source] || "A5");
    const ytd = {};
    receipts.filter((e) => e.date && e.date <= end).forEach((e) => { ytd[srcKey(e)] = num((ytd[srcKey(e)] || 0) + num(e.amount)); });
    const alwaysItemize = (e) => e.source === "committee" || (e.source === "pac" && (e.kind === "inkind" || e.transfer));
    // Itemize everything we can identify. The $100 rule is the floor the law sets, not a ceiling:
    // a gift goes to the unitemized line only when we don't have who it came from and where they live.
    const itemizeAll = report.itemizeAll !== false;
    const hasInfo = (e) => !!(e.name && (e.street || e.address) && (e.zip || e.city));

    const sched = { A1: [], A2: [], A3: [], A4: [], A5: [], B: [], D: [], E: [] };
    let rec = { itA: 0, unA: 0, itPrior: 0, unPrior: 0 };
    const running = {};
    const priorYtd = {};
    receipts.filter((e) => e.date && e.date < start).forEach((e) => { priorYtd[srcKey(e)] = num((priorYtd[srcKey(e)] || 0) + num(e.amount)); });

    for (const e of receipts.slice().sort(byDate)) {
      const k = srcKey(e), amt = num(e.amount);
      if (!e.date) { flag("must_fix", e.id, `${e.name || "An entry"} (${money(amt)}) has no date.`, "Add the date you received it.", ["date"]); continue; }
      running[k] = num((running[k] || 0) + amt);
      if (e.date < start) { // earlier this year: only needed for year-to-date columns
        if (e.date < ledgerFrom) continue;  // already inside the typed numbers from the last report
        if (priorYtd[k] > ITEMIZE_OVER || alwaysItemize(e) || (itemizeAll && hasInfo(e))) rec.itPrior += amt; else rec.unPrior += amt;
        continue;
      }
      if (e.date > end) continue; // belongs on the next report
      const itemized = ytd[k] > ITEMIZE_OVER || alwaysItemize(e) || (itemizeAll && hasInfo(e));
      if (!itemized) { rec.unA += amt; continue; }
      rec.itA += amt;
      const s = SOURCE_SCHEDULE[e.source] || "A5";
      sched[s].push({
        id: e.id, name: e.name, address: addressLines(e), occupation: e.occupation || "",
        type: e.kind === "contribution" ? "direct" : e.kind, desc: e.desc || "",
        colA: amt, colB: running[k], date: e.date, receivedBy: e.receivedBy || "",
      });
      // Itemized-entry requirements
      if (!e.name) flag("must_fix", e.id, `A ${money(amt)} ${label(e)} has no name.`, "Enter the contributor's full name.", ["name"]);
      if ((addressLines(e).length < 2 || !e.zip) && (ytd[k] > ITEMIZE_OVER || alwaysItemize(e))) flag("must_fix", e.id, `${e.name} gave ${money(ytd[k])} this year, so their full mailing address is required.`, "Add street, city, state and ZIP.", ["street", "city", "state", "zip"]);
      else if (addressLines(e).length < 2 || !e.zip) flag("check", e.id, `${e.name}'s address is incomplete.`, "Add the ZIP or city so the entry is complete, or leave it and it still prints as itemized.", ["street", "city", "zip"]);
      if (!e.receivedBy) flag("must_fix", e.id, `Who received ${e.name}'s ${money(amt)} ${label(e)}?`, "Enter the committee member who received it (usually the treasurer or candidate).", ["receivedBy"]);
      if ((e.source === "individual" || e.source === "candidate") && ytd[k] >= OCCUPATION_AT && !e.occupation)
        flag("must_fix", e.id, `${e.name} gave ${money(ytd[k])} this year. Donors who give $1,000 or more must list an occupation.`, "Add a real job title, like “attorney” or “retired” (not “consultant”).", ["occupation"]);
      if (/^\s*consultant\s*$/i.test(e.occupation || "")) flag("check", e.id, `${e.name}'s occupation is listed as “consultant,” which the form instructions say isn't specific enough.`, "Use what they actually do, like “marketing consultant” or “IT consultant.”", ["occupation"]);
      if (e.kind === "inkind" && !e.desc) flag("must_fix", e.id, `The in-kind gift from ${e.name} doesn't say what was given.`, "Describe it, like “yard signs” or “food for fundraiser.”", ["desc"]);
      if (e.kind === "misc" && !e.desc) flag("must_fix", e.id, `The ${money(amt)} from ${e.name} is marked “other” without saying what it was.`, "Describe it, like “refund from printer” or “sale of shirts.”", ["desc"]);
    }

    // Corporation and union limits (shared by all county, local and school board candidates)
    for (const [k, total] of Object.entries(ytd)) {
      const [nm, s] = k.split("|");
      if ((s === "A2" || s === "A3") && total > CORP_LABOR_LIMIT) {
        const ids = receipts.filter((e) => srcKey(e) === k).map((e) => e.id);
        const shown = (receipts.find((e) => srcKey(e) === k) || {}).name || nm;
        flag("must_fix", ids, `${s === "A2" ? "Corporation" : "Union"} “${shown}” gave you ${money(total)} this year. The legal limit is ${money(CORP_LABOR_LIMIT)} a year, and that limit is shared across every ${isParty ? "county and local party committee" : "county and local candidate"} they give to.`, `Refund at least ${money(total - CORP_LABOR_LIMIT)} and report the refund as a returned contribution.`);
      }
    }

    // CFA-11 48-hour report for large contributions in the supplemental window
    if (report.checkLargeContributions && P.supp) {
      const win = {};
      receipts.filter((e) => inRange(e.date, P.supp[0], P.supp[1])).forEach((e) => { win[srcKey(e)] = num((win[srcKey(e)] || 0) + num(e.amount)); });
      for (const [k, t] of Object.entries(win)) if (t >= LARGE_CONTRIB) {
        const ids = receipts.filter((e) => srcKey(e) === k && inRange(e.date, P.supp[0], P.supp[1])).map((e) => e.id);
        const who = receipts.find((e) => e.id === ids[0]).name;
        flag("must_fix", ids, `${who} gave ${money(t)} between ${fmt(P.supp[0])} and ${fmt(P.supp[1])}. That requires a CFA-11 “large contribution” report within 48 hours of receiving it.`, "File a CFA-11 with the county election board now (email, fax or in person). It will also go on your next CFA-4.");
      }
    }

    // ---------- Expenditures (Schedule B) ----------
    // In-kind contributions are entered twice: once as money in (Schedule A) and once as money out (Schedule B).
    const outRows = expenses.map((e) => e.kind === "inkind"
      ? { ...e, kind: "inkind_out", code: e.code || guessCode(e.desc), purpose: e.desc || "", recipient: e.name }
      : { ...e, recipient: e.name });
    const payKey = (e) => norm(e.recipient);
    const expYtd = {};
    outRows.filter((e) => e.date && e.date <= end).forEach((e) => { expYtd[payKey(e)] = num((expYtd[payKey(e)] || 0) + num(e.amount)); });
    const expPriorYtd = {};
    outRows.filter((e) => e.date && e.date < start).forEach((e) => { expPriorYtd[payKey(e)] = num((expPriorYtd[payKey(e)] || 0) + num(e.amount)); });
    let exp = { itA: 0, unA: 0, itPrior: 0, unPrior: 0 };
    const runOut = {};
    for (const e of outRows.slice().sort(byDate)) {
      const k = payKey(e), amt = num(e.amount);
      if (!e.date) { if (e.kind !== "inkind_out") flag("must_fix", e.id, `The ${money(amt)} payment to ${e.recipient || "someone"} has no date.`, "Add the date the check was mailed or the payment was made.", ["date"]); continue; }
      runOut[k] = num((runOut[k] || 0) + amt);
      const always = e.kind === "transfer_out" || e.code === "C";
      const payeeInfo = !!(e.recipient && (e.street || e.address) && (e.zip || e.city));
      if (e.date < start) { if (e.date >= ledgerFrom) { if (expPriorYtd[k] > ITEMIZE_OVER || always || (itemizeAll && payeeInfo)) exp.itPrior += amt; else exp.unPrior += amt; } continue; }
      if (e.date > end) continue;
      if (!(expYtd[k] > ITEMIZE_OVER || always || (itemizeAll && payeeInfo))) { exp.unA += amt; continue; }
      exp.itA += amt;
      const type = { expense: "direct", transfer_out: "direct", inkind_out: "inkind", debt_payment: "debt", refund: "refund" }[e.kind] || "other";
      sched.B.push({
        id: e.id, code: e.code || "", recipient: e.recipient, address: addressLines(e),
        occupation: e.occupation || "", office: e.office || "", type, otherDesc: e.otherDesc || "",
        purpose: e.purpose || e.desc || "", colA: amt, colB: runOut[k], date: e.date,
      });
      if (!e.code) flag("must_fix", e.id, `The ${money(amt)} payment to ${e.recipient} needs an expenditure code.`, "Pick A (advertising), F (fundraising), O (operations) or C (contribution to another campaign or group). A missing code makes the report defective.", ["code"]);
      if (!(e.purpose || e.desc)) flag("must_fix", e.id, `The ${money(amt)} payment to ${e.recipient} doesn't say what it was for.`, "Be specific, like “yard signs” or “filing fee.”", ["purpose"]);
      if (addressLines(e).length < 2 && e.kind !== "inkind_out" && (expYtd[k] > ITEMIZE_OVER || always)) flag("must_fix", e.id, `${e.recipient} was paid ${money(expYtd[k])} this year, so their mailing address is required.`, "Add street, city, state and ZIP.", ["street", "city", "state", "zip"]);
      if (/visa|mastercard|american express|amex|discover|capital one|chase card|credit card/i.test(e.recipient || ""))
        flag("check", e.id, `“${e.recipient}” looks like a credit card company.`, "List the business you actually bought from, not the card company.", ["name"]);
    }

    // ---------- Debts (Schedules D and E) ----------
    const debts = (report.debts || []).concat(receipts.filter((e) => e.kind === "loan").map((e) => ({
      id: "loan-" + e.id, fromEntry: e.id, creditor: e.name, address: addressLines(e), occupation: e.occupation,
      amount: e.amount, nature: "Loan", date: e.date,
    })));
    for (const d of debts) {
      if (d.date && d.date > end) continue;
      const paid = num(d.paidYtd != null ? d.paidYtd : all.filter((x) => x.kind === "debt_payment" && x.debtId === d.id && x.date && x.date <= end).reduce((s, x) => s + num(x.amount), 0));
      const bal = num(num(d.amount) - num(d.paidBefore) - paid);
      if (bal <= 0 && !(d.date && d.date >= start)) continue; // paid off before this period
      sched.D.push({ id: d.id, creditor: d.creditor, address: d.address || addressLines(d), occupation: d.occupation || "", vendor: d.vendor || "", amount: num(d.amount), nature: d.nature || "", date: d.date, paidYtd: paid, balance: Math.max(bal, 0) });
      if (!d.nature) flag("must_fix", d.id, `The debt to ${d.creditor} needs a description.`, "Say what kind of debt it is, like “loan,” “unpaid invoice” or “committee credit card.”");
    }
    for (const d of report.owedTo || []) {
      const bal = num(num(d.amount) - num(d.paidYtd));
      sched.E.push({ id: d.id, borrower: d.borrower, address: d.address || [], cosigner: d.cosigner || "", amount: num(d.amount), nature: d.nature || "Loan", date: d.date, paidYtd: num(d.paidYtd), balance: bal });
    }

    // ---------- Summary sheet ----------
    // Column B (year to date) = the typed numbers from the last report filed before the ledger starts (if any)
    // + entries dated from the ledger start up to this period + this period.
    const prior = report.prior || {};
    const recB = { it: num(prior.rec15aB) + num(rec.itPrior) + num(rec.itA), un: num(prior.rec15bB) + num(rec.unPrior) + num(rec.unA) };
    const expB = { it: num(prior.exp17aB) + num(exp.itPrior) + num(exp.itA), un: num(prior.exp17bB) + num(exp.unPrior) + num(exp.unA) };
    const L = {};
    L.l13 = num(report.cashBegin); L.l14 = num(report.cashJan1);
    L.l15aA = num(rec.itA); L.l15bA = num(rec.unA); L.l15cA = num(L.l15aA + L.l15bA);
    L.l15aB = num(recB.it); L.l15bB = num(recB.un); L.l15cB = num(L.l15aB + L.l15bB);
    L.l16A = num(L.l13 + L.l15cA); L.l16B = num(L.l14 + L.l15cB);
    L.l17aA = num(exp.itA); L.l17bA = num(exp.unA); L.l17cA = num(L.l17aA + L.l17bA);
    L.l17aB = num(expB.it); L.l17bB = num(expB.un); L.l17cB = num(L.l17aB + L.l17bB);
    L.l18A = num(L.l16A - L.l17cA); L.l18B = num(L.l16B - L.l17cB);
    L.l19 = num(sched.D.reduce((s, d) => s + d.balance, 0));
    L.l20 = num(sched.E.reduce((s, d) => s + d.balance, 0));

    if (L.l18A < 0) flag("must_fix", [], `Ending cash comes out to ${money(L.l18A)}.`, "You can't spend more than you had. Look for a missing deposit, or an expense entered twice.");
    if (Math.abs(L.l18A - L.l18B) > 0.009) flag("must_fix", [], `Line 18 doesn't match in both columns (${money(L.l18A)} vs ${money(L.l18B)}).`, "Your starting cash, January 1 cash, or earlier-report totals don't line up. Check them against your last report.");
    if (report.bankBalance != null && report.bankBalance !== "" && Math.abs(num(report.bankBalance) - L.l18A) > 0.009)
      flag("check", [], `Your bank balance on ${fmt(end)} was ${money(report.bankBalance)}, but the report ends at ${money(L.l18A)}.`, `The ${money(num(report.bankBalance) - L.l18A)} difference usually means a missing deposit, fee or check.`);
    // Online donations with odd cents (like $24.11) usually mean the amount after fees was entered. Whole-dollar amounts are almost always the full gift.
    const hasFees = outRows.some((e) => /fee/i.test((e.purpose || "") + (e.desc || "") + (e.recipient || "")));
    const centsOnline = receipts.filter((e) => e.date >= start && e.date <= end && /online|actblue|paypal|venmo|stripe|square|anedot|winred|card/i.test(e.method || "") && Math.abs(num(e.amount) * 100 - Math.round(num(e.amount))) > 0.5 && Math.round(num(e.amount) * 100) % 100 !== 0 && Math.round(num(e.amount) * 100) % 50 !== 0);
    if (!hasFees && centsOnline.length)
      flag("check", centsOnline.map((e) => e.id), `${centsOnline.length === 1 ? `The ${money(centsOnline[0].amount)} online gift from ${centsOnline[0].name}` : `${centsOnline.length} online gifts`} ha${centsOnline.length === 1 ? "s" : "ve"} odd cents, which usually means the amount after fees.`, "Report the amount the donor actually gave, and list the processing fees as an expense (code O). Uploading your ActBlue export does both for you.");
    for (const e of all) if (e.date && e.date > end && e.date <= (report.today || "9999"))
      flag("tip", e.id, `${e.name || "An entry"} on ${fmt(e.date)} is after this report ends (${fmt(end)}).`, "It's saved and will go on your next report.");

    return { start, end, due: P.due, lines: L, schedules: sched, flags };
  }

  function guessCode(text) {
    const t = String(text || "").toLowerCase();
    if (/sign|shirt|button|sticker|ad\b|ads|advert|print|flyer|literature|mailer|postcard|website|web|radio|tv|newspaper|billboard|door hanger|palm card|boost|facebook|meta|instagram|google|digital|banner|video|photo|design|logo|domain|hosting|robocall|text message|sms/.test(t)) return "A";
    if (/fundrais|catering|caterer|food|pizza|restaurant|venue|hall rental|drinks|refreshment|speaker|band|entertain/.test(t)) return "F";
    if (/donation to|contribution to|sponsorship|transfer to|party dues/.test(t)) return "C";
    return "O";
  }
  const label = (e) => ({ contribution: "contribution", inkind: "in-kind gift", loan: "loan", interest: "interest payment", misc: "receipt" }[e.kind] || "entry");
  function money(n) { return (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" }); }
  function fmt(d) { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${m}/${dd}/${y.slice(2)}`; }

  const api = { compute, guessCode, money, fmt, netCash, periodsFor, suppWindows, annualDue, partyAnnualDue, PERIODS_2026, CALENDARS, SOURCE_SCHEDULE, ITEMIZE_OVER: ITEMIZE_OVER_CANDIDATE, OCCUPATION_AT, CORP_LABOR_LIMIT, LARGE_CONTRIB };
  if (typeof module !== "undefined") module.exports = api; else root.CFA = api;
})(typeof window !== "undefined" ? window : globalThis);
