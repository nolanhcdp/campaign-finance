// Fills the official CFA-4 (State Form 4606, R18 / 6-25) from the output of CFA.compute().
// Each page is filled on a fresh copy of the form, flattened, then copied into the final PDF,
// so schedules can run to as many continuation pages as needed.
// Usage: const bytes = await CFAFill.build(PDFLib, templateBytes, report, computed)

(function (root) {
  const TPL = { summary: 0, A1: 2, A2: 4, A3: 6, A4: 8, A5: 10, B: 12, C: 14, D: 16, E: 18 };
  const ROWS = { A1: 5, A2: 5, A3: 5, A4: 5, A5: 5, B: 7, D: 7, E: 7 };
  const PREFIX = { A1: "a-1", A2: "a-2", A3: "a-3", A4: "a-4", A5: "a-5", B: "b", D: "d", E: "e" };

  const n = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
  const amt = (v) => (v === "" || v == null) ? "" : (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dt = (d) => { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${m}/${dd}/${y.slice(2)}`; };
  const chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

  async function build(PDFLib, templateBytes, report, C) {
    const { PDFDocument, StandardFonts } = PDFLib;
    const out = await PDFDocument.create();
    const plan = [{ kind: "summary" }];
    for (const s of ["A1", "A2", "A3", "A4", "A5", "B", "D", "E"]) {
      const rows = C.schedules[s] || [];
      if (!rows.length) continue;
      const pages = chunk(rows, ROWS[s]);
      pages.forEach((r, i) => plan.push({ kind: s, rows: r, page: i + 1, of: pages.length, total: rows }));
    }
    const totalPages = plan.length;

    for (const step of plan) {
      const doc = await PDFDocument.load(templateBytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const form = doc.getForm();
      const tIdx = TPL[step.kind];
      const pageRef = doc.getPage(tIdx).ref;
      const fields = form.getFields().filter((f) => f.acroField.getWidgets().some((w) => w.P() && w.P() === pageRef) || f.acroField.getWidgets().some((w) => (doc.getPage(tIdx).node.Annots()?.asArray() || []).some((a) => doc.context.lookup(a) === w.dict)));
      const byName = new Map(fields.map((f) => [n(f.getName()), f]));
      const find = (...patterns) => {
        for (const p of patterns) {
          if (typeof p === "string") { const f = byName.get(n(p)); if (f) return f; }
          else for (const [k, f] of byName) if (p.test(k)) return f;
        }
        return null;
      };
      const setText = (f, text, opts = {}) => {
        if (!f || text === "" || text == null) return;
        const tf = form.getTextField(f.getName());
        const w = tf.acroField.getWidgets()[0].getRectangle();
        const s = String(text);
        let size = opts.size || 9;
        if (opts.multiline) { try { tf.enableMultiline(); } catch (e) {} }
        else { while (size > 5 && font.widthOfTextAtSize(s, size) > w.width - 4) size -= 0.5; }
        try { tf.setFontSize(size); } catch (e) { tf.acroField.setDefaultAppearance(`/Helv ${size} Tf 0 g`); }
        tf.setText(s);
      };
      const check = (f, on) => { if (f && on) form.getCheckBox(f.getName()).check(); };

      setText(find("File Number"), report.fileNumber);

      if (step.kind === "summary") fillSummary(find, setText, check, report, C, totalPages);
      else {
        const p = PREFIX[step.kind];
        setText(find(`${p} page`), String(step.page));
        setText(find(`${p} page of`), String(step.of));
        step.rows.forEach((r, i) => fillRow(step.kind, p, i + 1, r, find, setText, check));
        const sub = step.rows.reduce((s, r) => s + ((step.kind === "D" || step.kind === "E") ? r.balance : r.colA), 0);
        const all = step.total.reduce((s, r) => s + ((step.kind === "D" || step.kind === "E") ? r.balance : r.colA), 0);
        setText(find(new RegExp(`^${esc(p)} subtotal`)), amt(sub));
        if (step.page === step.of) setText(find(new RegExp(`^${esc(p)} total`)), amt(all));
      }

      form.updateFieldAppearances(font);
      form.flatten();
      doc.getPage(tIdx).node.delete(PDFLib.PDFName.of("Annots")); // drop leftover widget references
      const [copied] = await out.copyPages(doc, [tIdx]);
      out.addPage(copied);
    }
    out.setTitle(`CFA-4 ${report.reportType || ""} Report - ${report.committee?.name || ""}`.trim());
    return await out.save();
  }

  function fillSummary(find, setText, check, R, C, totalPages) {
    const L = C.lines, c = R.committee || {}, cand = R.candidate || {};
    setText(find("Total Pages in Report"), String(totalPages));
    check(find(/^is this an amendment/), false);
    try { const g = find(/^is this an amendment/); if (g) g.select(R.amendment ? "Yes" : "No"); } catch (e) {}
    check(find("Check if New Name"), c.newName);
    check(find("Check if New Address"), c.newAddress);
    setText(find("Full Name of Committee"), c.name);
    setText(find("Acronym or Abbreviated Name"), c.acronym);
    setText(find("Telephone Number"), c.phone);
    setText(find("Mailing Address"), c.street);
    setText(find("City State ZIP Code"), [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "));
    setText(find("Party Affiliation"), c.party);
    setText(find("Full Name of Candidate"), cand.name);
    setText(find("Party Affiliation or If Independent"), cand.party);
    setText(find("Office Sought Include district number if any"), cand.office);
    setText(find("County of Residence"), cand.county);
    const type = { "Pre-Primary": "PrePrimary", "Pre-Election": "PreElection", "Annual": "Annual", "Nomination": "Nomination", "Pre-Convention": "PreConvention", "Post-Convention": "PostConvention", "Final": "Final /Disbands", "Outgoing Treasurer": "Outgoing Treasurer" }[R.reportType];
    if (type) check(find(type), true); else if (R.reportType) { check(find("Other"), true); setText(find("Other Type"), R.reportType); }
    setText(find("Start Date"), dt(C.start));
    setText(find("End Date"), dt(C.end));
    setText(find("Cash On Hand - Reporting Period"), amt(L.l13));
    setText(find(/^cash on hand - jan/), amt(L.l14));
    setText(find("Itemized - Column A"), amt(L.l15aA)); setText(find("Itemized - Column B"), amt(L.l15aB));
    setText(find("Unitemized - Column A"), amt(L.l15bA)); setText(find("Unitemized - Column B"), amt(L.l15bB));
    setText(find("Subtotal - Column A"), amt(L.l15cA)); setText(find("Subtotal - Column B"), amt(L.l15cB));
    setText(find("Total - Column A"), amt(L.l16A)); setText(find("Total - Column B"), amt(L.l16B));
    setText(find("Exp. Itemized - Column A"), amt(L.l17aA)); setText(find("Exp. Itemized - Column B"), amt(L.l17aB));
    setText(find("Exp. Unitemized - Column A"), amt(L.l17bA)); setText(find("Exp. Unitemized - Column B"), amt(L.l17bB));
    setText(find("Exp. Subtotal - Column A"), amt(L.l17cA)); setText(find("Exp. Subtotal - Column B"), amt(L.l17cB));
    setText(find("Exp. Total - Column A"), amt(L.l18A)); setText(find("Exp. Total - Column B"), amt(L.l18B));
    setText(find("Debts OWED BY Comm"), amt(L.l19));
    setText(find("Debts OWED TO Comm"), amt(L.l20));
    setText(find("Title"), R.treasurerTitle || "Treasurer");
  }

  function fillRow(kind, p, i, r, find, setText, check) {
    const P = esc(p);
    const rx = (s) => new RegExp(`^${P} ${s}$`);
    if (kind.startsWith("A")) {
      setText(find(rx(`contributor ${i}`)), [r.name, ...r.address].join("\n"), { multiline: true, size: 8 });
      setText(find(rx(`contributor ${i} occupation`)), r.occupation);
      check(find(rx(`direct ${i}`)), r.type === "direct");
      check(find(rx(`inkind ${i}`)), r.type === "inkind");
      if (r.type === "inkind") setText(find(rx(`inkind description ${i}`)), r.desc);
      check(find(rx(`interest ${i}`)), r.type === "interest");
      check(find(rx(`loan ${i}`)), r.type === "loan");
      check(find(rx(`misc\\. ${i}`)), r.type === "misc");
      if (r.type === "misc") setText(find(rx(`specify misc\\. ${i}`), rx(`misc\\. description ${i}`)), r.desc);
      setText(find(rx(`value ${i} - column a`)), amt(r.colA));
      setText(find(rx(`value ${i} - column b`)), amt(r.colB));
      setText(find(rx(`date received ${i}`)), dt(r.date));
      setText(find(rx(`rece\\w*d by ${i}`)), r.receivedBy, { multiline: true, size: 7 });   // the state's form spells two of these "Recevied"
    } else if (kind === "B") {
      setText(find(rx(`code ${i}`)), r.code);
      setText(find(rx(`recipient ${i}`)), [r.recipient, ...r.address].join("\n"), { multiline: true, size: 8 });
      setText(find(rx(`occupation ${i}`)), r.occupation, { multiline: true, size: 7 });
      setText(find(rx(`office sought ${i}`)), r.office, { multiline: true, size: 7 });
      check(find(rx(`direct ${i}`)), r.type === "direct");
      check(find(rx(`inkind ${i}`)), r.type === "inkind");
      check(find(rx(`payment of debt ${i}`)), r.type === "debt");
      check(find(rx(`returned contribution ${i}`)), r.type === "refund");
      check(find(rx(`other ${i}`)), r.type === "other");
      if (r.type === "other") setText(find(rx(`specify other ${i}`)), r.otherDesc);
      setText(find(rx(`purpose ${i}`)), r.purpose);
      setText(find(rx(`amount ${i} - column a`)), amt(r.colA));
      setText(find(rx(`amount ${i} - column b`)), amt(r.colB));
      setText(find(rx(`date ${i}`)), dt(r.date));
    } else if (kind === "D") {
      setText(find(rx(`lender ${i}`)), [r.creditor, ...(r.address || [])].join("\n"), { multiline: true, size: 8 });
      setText(find(rx(`occupation ${i}`)), r.occupation, { multiline: true, size: 7 });
      setText(find(rx(`vendor ${i}`)), r.vendor, { size: 7 });
      setText(find(rx(`amount ${i}`)), amt(r.amount));
      setText(find(rx(`nature of debt ${i}`)), r.nature, { size: 8 });
      setText(find(rx(`date ${i}`)), dt(r.date));
      setText(find(rx(`paid ytd ${i}`)), amt(r.paidYtd));
      setText(find(rx(`balance ${i}`)), amt(r.balance));
    } else if (kind === "E") {
      setText(find(rx(`borrower ${i}`)), [r.borrower, ...(r.address || [])].join("\n"), { multiline: true, size: 8 });
      setText(find(rx(`co-signer ${i}`)), r.cosigner, { multiline: true, size: 8 });
      setText(find(rx(`original amount ${i}`)), amt(r.amount));
      setText(find(rx(`nature of debt ${i}`)), r.nature, { size: 8 });
      setText(find(rx(`date ${i}`)), dt(r.date));
      setText(find(rx(`paid ytd ${i}`)), amt(r.paidYtd));
      setText(find(rx(`balance ${i}`)), amt(r.balance));
    }
  }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"); }

  const api = { build };
  if (typeof module !== "undefined") module.exports = api; else root.CFAFill = api;
})(typeof window !== "undefined" ? window : globalThis);
