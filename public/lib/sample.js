// The sample campaign behind "Try it with a sample campaign". Every name, address and number here is made up.
// Each visitor gets a fresh copy in their browser; nothing is saved to the server.
(function (root) {
  const T = "Lee Ferris";
  let n = 0;
  const id = () => "s" + (++n);
  const give = (name, street, city, zip, occupation, amount, date, extra = {}) => ({
    id: id(), kind: "contribution", source: "individual", name, street, city, state: street ? "IN" : "", zip, occupation,
    amount, date, method: "check", check: "", receivedBy: T, desc: "", purpose: "", code: "", office: "", sourceFile: "", question: "", ...extra,
  });
  const online = (name, street, city, zip, occupation, amount, date) =>
    give(name, street, city, zip, occupation, amount, date, { method: "online (ActBlue)", sourceFile: "actblue-contributions.csv", fromSheet: true });
  const pay = (name, street, city, state, zip, amount, date, purpose, code, extra = {}) => ({
    id: id(), kind: "expense", source: "", name, street, city, state, zip, occupation: "", amount, date, method: "check", check: "",
    receivedBy: "", desc: "", purpose, code, office: "", sourceFile: "", question: "", ...extra,
  });
  const AB = ["ActBlue Technical Services", "PO Box 441146", "Somerville", "MA", "02144"];

  function build() {
    n = 0;
    return {
      v: 2, step: "dash", cur: null,
      about: {
        candidate: "Dana Whitcomb", committee: "Friends of Dana Whitcomb", acronym: "", office: "County Council, District 2",
        county: "Howard", party: "Democratic", treasurer: T, treasurerTitle: "Treasurer", phone: "765-555-0142",
        street: "412 W. Sycamore St", city: "Kokomo", state: "IN", zip: "46901", fileNumber: "2026-SAMPLE", report: "Pre-Election",
        amendment: false, filesWith: "county",
      },
      year: { 2026: {
        opening: { ledgerFrom: "2026-04-11", mode: "upload", readFrom: "April report", cashBegin: 1140, cashJan1: 0, rec15aB: 1400, rec15bB: 85, exp17aB: 345, exp17bB: 0 },
        plan: { status: "running", office: "County Council, District 2" },
      } },
      reports: [
        { id: "r-preprimary-2026", type: "Pre-Primary", start: "2026-01-01", end: "2026-04-10", due: "2026-04-17", status: "filed", external: true, filedAt: null,
          snapshot: { lines: { l18A: 1140, l18B: 1140, l14: 0, l15aB: 1400, l15bB: 85, l17aB: 345, l17bB: 0 } } },
        { id: "r-preelection-2026", type: "Pre-Election", start: "2026-04-11", end: "2026-10-09", due: "2026-10-16", supp: ["2026-10-10", "2026-11-01"], status: "open", bankBalance: "", amendment: false },
      ],
      cfa11: [],
      entries: [
        // From the April report, kept so each donor's total for the year is right.
        give("Carol Mendez", "1810 S. Webster St", "Kokomo", "46902", "Nurse", 100, "2026-02-10", { check: "1011", sourceFile: "April report", fromPrior: true }),
        give("Tom Reyes", "2400 S. Goyer Rd", "Kokomo", "46902", "Electrician", 500, "2026-03-05", { check: "772", sourceFile: "April report", fromPrior: true }),
        give("Dana Whitcomb", "412 W. Sycamore St", "Kokomo", "46901", "Teacher", 200, "2026-04-20", { source: "candidate", method: "personal check" }),
        give("Carol Mendez", "1810 S. Webster St", "Kokomo", "46902", "Nurse", 250, "2026-05-02", { check: "1043" }),
        give("Marcus Hale", "77 Park Ave", "Kokomo", "46901", "Consultant", 100, "2026-06-14", { check: "318" }),
        give("Riverside Builders LLC", "2200 E. Markland Ave", "Kokomo", "46901", "", 300, "2026-07-01", { source: "other", check: "5521" }),
        give("Gloria Banks", "", "", "", "", 150, "2026-07-18", { method: "cash" }),
        online("Ana Ruiz", "915 N. Washington St", "Kokomo", "46901", "Pharmacist", 25, "2026-08-03"),
        online("Ben Okafor", "1203 W. Jefferson St", "Kokomo", "46901", "Mechanic", 50, "2026-08-14"),
        online("Chris Dalton", "40 Wildcat Ct", "Kokomo", "46902", "Accountant", 35, "2026-08-22"),
        online("Dee Park", "3110 S. Dixon Rd", "Kokomo", "46902", "Retired", 25, "2026-09-02"),
        online("Eli Novak", "601 E. Sycamore St", "Kokomo", "46901", "Engineer", 100, "2026-09-11"),
        online("Faye Lin", "18 Oak Ridge Dr", "Greentown", "46936", "Librarian", 20, "2026-09-25"),
        pay(...AB, 4.33, "2026-08-31", "ActBlue processing fees, August", "O", { method: "withheld from deposits", sourceFile: "actblue-contributions.csv", fromSheet: true }),
        pay(...AB, 5.71, "2026-09-30", "ActBlue processing fees, September", "O", { method: "withheld from deposits", sourceFile: "actblue-contributions.csv", fromSheet: true }),
        pay("Main Street Printing", "210 N. Main St", "Kokomo", "IN", "46901", 412.5, "2026-08-20", "Yard signs and door hangers", "A", { check: "1003" }),
        pay("Kokomo Post Office", "201 N. Union St", "Kokomo", "IN", "46901", 58, "2026-09-10", "Stamps for mailer", "O", { check: "1004" }),
        pay("Meta Platforms Inc", "1 Hacker Way", "Menlo Park", "CA", "94025", 120, "2026-09-15", "Facebook ads", "A", { method: "card" }),
        pay("Hoosier Hardware", "1500 S. Reed Rd", "Kokomo", "IN", "46902", 64.2, "2026-09-19", "Stakes", "O", { method: "card", codeGuessed: true }),
      ],
      priorDebts: [], files: [{ name: "actblue-contributions.csv", status: "done", count: 6, ab: true, detail: "fees added as 2 monthly expenses to ActBlue" }],
      draft: "", aiFlags: null, mustFix: null, bank: { statements: [], lines: [] }, ask: [], dismissed: {}, published: { prior: 1 },
    };
  }
  root.TALLY_SAMPLE = build;
})(typeof window !== "undefined" ? window : globalThis);
