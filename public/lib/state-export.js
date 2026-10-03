// Builds the Excel import file for the Indiana Election Division's online campaign finance system
// (campaignfinance.in.gov), following the "Indiana Campaign Finance System Electronic Data Interchange"
// spreadsheet specification (2012 rev.). Six worksheets with fixed names and headers.
// Usage: const wb = StateExport.build(report, computed, entries); XLSX.writeFile(wb, name)
// Status: built to the published spec; UNTESTED against the live import until a filer tries it.

(function (root) {
  const H = {
    control: ["committeeId", "committeeName", "fileCreateDateTime", "description"],
    contribution: ["contributionId", "cbContributionType", "cbAmount", "cbCycleAmount", "cbDate", "cbContributorId", "cbContributorType", "cbOrgId", "cbOrgName", "cbFirstName", "cbMiddleName", "cbLastName", "cbNameSuffix", "cbAddress1", "cbAddress2", "cbCity", "cbState", "cbZip", "cbOccupation", "cbOccupationComments", "cbExplanation", "cbReceivedBy"],
    expenditure: ["expenditureId", "exDisbursementType", "exDisbursementDescOther", "exExpenditureType", "exAmount", "exCycleAmount", "exDate", "exPayeeId", "exOrgName", "exAddress1", "exAddress2", "exCity", "exState", "exZip", "exOccupation", "exOccupationComments", "exOfficeSought", "exPurpose", "exQuestionText", "exQuestionType", "exQuestionPosition"],
    debt: ["debtId", "debtType", "debtSourceReferenceId", "debtSourceName", "debtAddress1", "debtAddress2", "debtCity", "debtState", "debtZip", "debtOccupation", "debtAmount", "debtDate", "debtNature", "debtGrnName", "debtGrnAddress1", "debtGrnAddress2", "debtGrnCity", "debtGrnState", "debtGrnZip", "debtGrnAmount"],
    debtGuarantor: ["debtId", "debtGrnName", "debtGrnAddress1", "debtGrnAddress2", "debtGrnCity", "debtGrnState", "debtGrnZip", "debtGrnAmount"],
    debtPayment: ["debtPaymentId", "debtId", "debtPaymentDate", "debtPaymentAmountPrincipal", "debtFinalPayment"],
  };
  const CONTRIB_TYPE = { direct: "01", contribution: "01", inkind: "02", interest: "03", loan: "04", misc: "05" };
  const CONTRIBUTOR_TYPE = { individual: "01", candidate: "01", corporation: "02", labor: "03", pac: "04", committee: "05", other: "05" };
  const DISB_TYPE = { direct: "01", inkind: "02", debt: "03", refund: "04", other: "05" };
  const EXP_TYPE = { A: "01", O: "02", C: "03", F: "04" };
  const OCC = [
    [/farm|agricultur|rancher|grower/i, "01"], [/attorney|lawyer|paralegal|legal/i, "02"], [/auto|mechanic|car dealer|dealership/i, "03"],
    [/pastor|clergy|minister|priest|rabbi|church/i, "04"], [/construct|engineer|contractor|electrician|plumber|carpenter|builder|hvac/i, "05"],
    [/environment|waste|recycl/i, "06"], [/financ|bank|invest|account|cpa|bookkeep|advisor|broker/i, "07"], [/firefighter|paramedic|emt/i, "08"],
    [/food|restaurant|chef|cook|server|bartender|catering/i, "09"], [/casino|gaming/i, "10"], [/owner|business|entrepreneur|consultant|manager|executive|ceo|president|sales rep|marketing/i, "11"],
    [/government|civil|county|city|state employee|clerk|public|postal|usps/i, "12"], [/nurse|doctor|physician|dentist|medical|health|pharmac|therapist|hospital|caregiver|veterinar/i, "13"],
    [/homemaker|housewife|stay.at.home/i, "14"], [/insurance/i, "15"], [/police|sheriff|deputy|officer|law enforcement|corrections/i, "16"], [/lobby/i, "17"],
    [/manufactur|factory|assembl|machinist|welder|plant|uaw|production/i, "18"], [/media|journalist|reporter|entertain|musician|artist|photograph|writer/i, "19"], [/military|army|navy|air force|marine|veteran/i, "20"],
    [/mining|oil|gas/i, "21"], [/unemployed|not employed|between jobs/i, "22"], [/office|administrative|secretary|receptionist|assistant|clerical/i, "23"],
    [/real estate|realtor|property|landlord/i, "25"], [/retail|cashier|store|shop/i, "26"], [/retired/i, "27"], [/scien|tech|software|it\b|programmer|engineer|data|analyst/i, "28"],
    [/teacher|professor|educat|school|principal|instructor|librarian/i, "29"], [/student/i, "31"],
  ];
  function occCode(text) { const t = String(text || "").trim(); if (!t) return ""; for (const [re, c] of OCC) if (re.test(t)) return c; return "24"; }
  const d = (iso) => { if (!iso) return ""; const [y, m, dd] = iso.split("-"); return `${m}/${dd}/${y}`; };
  const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const cut = (s, n) => String(s ?? "").slice(0, n);
  function splitName(name) {
    const parts = String(name || "").trim().replace(/\s+/g, " ").split(" ");
    if (parts.length === 1) return { first: parts[0], middle: "", last: "", suffix: "" };
    let suffix = ""; if (/^(jr|sr|ii|iii|iv)\.?$/i.test(parts[parts.length - 1])) suffix = parts.pop();
    const first = parts.shift(), last = parts.pop() || "", middle = parts.join(" ");
    return { first, middle, last, suffix };
  }
  const addr = (lines) => { // ["street", "City, ST 12345"] → parts
    const [street = "", csz = ""] = lines || [];
    const m = csz.match(/^(.*?),?\s*([A-Z]{2})?\s*(\d{5})?(?:-\d{4})?\s*$/) || [];
    return { street, city: (m[1] || "").replace(/,$/, "").trim(), state: m[2] || "IN", zip: m[3] || "" };
  };

  function build(report, C, allEntries) {
    const S = C.schedules, start = C.start, end = C.end;
    const inPeriod = (e) => e.date && e.date >= start && e.date <= end;
    const contribution = [], expenditure = [], debt = [], debtGuarantor = [], debtPayment = [];
    const treasurer = cut(report.treasurer || "", 20);

    // Itemized contributions, from the five Schedule A pages
    const itemizedIds = new Set();
    for (const page of ["A1", "A2", "A3", "A4", "A5"]) for (const r of S[page] || []) {
      itemizedIds.add(r.id);
      const src = (allEntries.find((e) => e.id === r.id) || {});
      const ctype = CONTRIBUTOR_TYPE[src.source] || { A1: "01", A2: "02", A3: "03", A4: "04", A5: "05" }[page];
      const a = addr(r.address), nm = ctype === "01" ? splitName(r.name) : null;
      contribution.push({
        contributionId: r.id, cbContributionType: CONTRIB_TYPE[r.type] || "01", cbAmount: money(r.colA), cbCycleAmount: money(r.colB), cbDate: d(r.date),
        cbContributorId: "", cbContributorType: ctype, cbOrgId: "", cbOrgName: ctype === "01" ? "" : cut(r.name, 100),
        cbFirstName: nm ? cut(nm.first, 100) : "", cbMiddleName: nm ? cut(nm.middle, 100) : "", cbLastName: nm ? cut(nm.last, 100) : "", cbNameSuffix: nm ? cut(nm.suffix, 15) : "",
        cbAddress1: cut(a.street, 50), cbAddress2: "", cbCity: cut(a.city, 30), cbState: cut(a.state, 2), cbZip: cut(a.zip, 5),
        cbOccupation: occCode(r.occupation), cbOccupationComments: cut(r.occupation, 200), cbExplanation: cut(r.type === "inkind" || r.type === "misc" ? r.desc : "", 100),
        cbReceivedBy: cut(r.receivedBy || treasurer, 20) || treasurer,
      });
    }
    // Unitemized contributions: one line per month, no names
    const unit = {};
    for (const e of allEntries) if (inPeriod(e) && ["contribution", "inkind", "loan", "interest", "misc"].includes(e.kind) && !itemizedIds.has(e.id)) {
      const k = e.date.slice(0, 7); unit[k] = money((unit[k] || 0) + money(e.amount));
    }
    for (const [m, amt] of Object.entries(unit).sort()) if (amt > 0) {
      const last = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
      contribution.push({ contributionId: "UNIT-" + m, cbContributionType: "06", cbAmount: amt, cbCycleAmount: amt, cbDate: d(`${m}-${String(last).padStart(2, "0")}`), cbContributorType: "01", cbReceivedBy: treasurer, cbExplanation: "Unitemized contributions" });
    }

    // Itemized expenditures, from Schedule B
    const itemizedExp = new Set();
    for (const r of S.B || []) {
      itemizedExp.add(r.id);
      const a = addr(r.address);
      expenditure.push({
        expenditureId: r.id, exDisbursementType: DISB_TYPE[r.type] || "01", exDisbursementDescOther: r.type === "other" ? cut(r.otherDesc, 200) : "",
        exExpenditureType: EXP_TYPE[r.code] || "02", exAmount: money(r.colA), exCycleAmount: money(r.colB), exDate: d(r.date), exPayeeId: "",
        exOrgName: cut(r.recipient, 100), exAddress1: cut(a.street, 50), exAddress2: "", exCity: cut(a.city, 30), exState: cut(a.state, 2), exZip: cut(a.zip, 5),
        exOccupation: occCode(r.occupation), exOccupationComments: cut(r.occupation, 200), exOfficeSought: cut(r.office, 200), exPurpose: cut(r.purpose, 150),
        exQuestionText: "", exQuestionType: "", exQuestionPosition: "",
      });
    }
    const unitE = {};
    for (const e of allEntries) if (inPeriod(e) && ["expense", "debt_payment", "refund", "transfer_out", "inkind"].includes(e.kind) && !itemizedExp.has(e.id)) {
      const k = e.date.slice(0, 7); unitE[k] = money((unitE[k] || 0) + money(e.amount));
    }
    for (const [m, amt] of Object.entries(unitE).sort()) if (amt > 0) {
      const last = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
      expenditure.push({ expenditureId: "UNIT-" + m, exDisbursementType: "06", exExpenditureType: "02", exAmount: amt, exCycleAmount: amt, exDate: d(`${m}-${String(last).padStart(2, "0")}`), exPurpose: "Unitemized expenditures" });
    }

    // Debts owed by the committee (Schedule D). Endorser columns are left blank when there is no co-signer.
    for (const r of S.D || []) {
      const a = addr(r.address);
      debt.push({
        debtId: r.id, debtType: "01", debtSourceReferenceId: "", debtSourceName: cut(r.creditor, 100), debtAddress1: cut(a.street, 50), debtAddress2: "", debtCity: cut(a.city, 30), debtState: cut(a.state, 2), debtZip: cut(a.zip, 5),
        debtOccupation: cut(r.occupation, 100), debtAmount: money(r.amount), debtDate: d(r.date), debtNature: cut(r.nature, 45),
        debtGrnName: "", debtGrnAddress1: "", debtGrnAddress2: "", debtGrnCity: "", debtGrnState: "", debtGrnZip: "", debtGrnAmount: "",
      });
    }
    for (const r of S.E || []) {
      const a = addr(r.address);
      debt.push({ debtId: r.id, debtType: "02", debtSourceName: cut(r.borrower, 100), debtAddress1: cut(a.street, 50), debtCity: cut(a.city, 30), debtState: cut(a.state, 2), debtZip: cut(a.zip, 5), debtAmount: money(r.amount), debtDate: d(r.date), debtNature: cut(r.nature, 45), debtGrnName: cut(r.cosigner, 150) });
    }
    for (const e of allEntries) if (inPeriod(e) && e.kind === "debt_payment" && e.debtId) {
      debtPayment.push({ debtPaymentId: "PAY-" + e.id, debtId: e.debtId, debtPaymentDate: d(e.date), debtPaymentAmountPrincipal: money(e.amount), debtFinalPayment: e.finalPayment ? "Y" : "N" });
    }

    const now = new Date(), pad = (n) => String(n).padStart(2, "0");
    const control = [{ committeeId: cut(report.fileNumber || "", 11), committeeName: cut(report.committee?.name || "", 100),
      fileCreateDateTime: `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      description: cut(`${report.reportType || ""} report ${d(start)}-${d(end)} from Tally`, 100) }];

    const wb = XLSX.utils.book_new();
    const add = (name, rows) => { const data = [H[name], ...rows.map((r) => H[name].map((h) => (r[h] === undefined || r[h] === null) ? "" : r[h]))]; XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), name); };
    add("control", control); add("contribution", contribution); add("expenditure", expenditure); add("debt", debt); add("debtGuarantor", debtGuarantor); add("debtPayment", debtPayment);
    return { wb, counts: { contribution: contribution.length, expenditure: expenditure.length, debt: debt.length, debtPayment: debtPayment.length } };
  }

  const api = { build, occCode };
  if (typeof module !== "undefined") module.exports = api; else root.StateExport = api;
})(typeof window !== "undefined" ? window : globalThis);
