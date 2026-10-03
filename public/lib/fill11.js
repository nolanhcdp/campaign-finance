// Fills the official CFA-11 "Supplemental Large Contribution Report" (State Form 48492, R8 / 6-25).
// Three contributors per page; extra pages repeat the form. Usage: CFAFill11.build(PDFLib, templateBytes, data)
(function (root) {
  const amt = (v) => (v === "" || v == null) ? "" : (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dt = (d) => { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${m}/${dd}/${y.slice(2)}`; };
  const chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

  async function build(PDFLib, templateBytes, D) {
    const { PDFDocument, StandardFonts } = PDFLib;
    const out = await PDFDocument.create();
    const pages = chunk(D.rows || [], 3); if (!pages.length) pages.push([]);
    for (const rows of pages) {
      const doc = await PDFDocument.load(templateBytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const form = doc.getForm();
      const get = (name) => { try { return form.getTextField(name); } catch (e) { return null; } };
      const setText = (name, text, size = 9, multiline = false) => {
        const tf = get(name); if (!tf || text == null || text === "") return;
        const s = String(text); const w = tf.acroField.getWidgets()[0].getRectangle();
        if (multiline) { try { tf.enableMultiline(); } catch (e) {} } else { while (size > 5 && font.widthOfTextAtSize(s, size) > w.width - 4) size -= 0.5; }
        try { tf.setFontSize(size); } catch (e) { tf.acroField.setDefaultAppearance(`/Helv ${size} Tf 0 g`); }
        tf.setText(s);
      };
      const check = (name, on) => { if (!on) return; try { form.getCheckBox(name).check(); } catch (e) {} };
      setText("File Number", D.fileNumber);
      setText("Number of Pages", String(pages.length));
      try { form.getRadioGroup("IS THIS AN AMENDMENT").select(D.amendment ? "Yes" : "No"); } catch (e) {}
      setText("Candidate Name", D.candidate);
      const ph = String(D.phone || "").replace(/\D/g, "");
      if (ph.length >= 10) { setText("Area Code", ph.slice(0, 3)); setText("2 Committee Telephone Number", `${ph.slice(3, 6)}-${ph.slice(6, 10)}`); } else setText("2 Committee Telephone Number", D.phone);
      setText("Address", D.street); setText("City", D.city); setText("State", D.state); setText("ZIP Code", D.zip);
      setText("Party", D.party); setText("Office Sought", D.office); setText("County of Residence", D.county);
      setText("Begining Date", dt(D.start)); setText("Ending Date", dt(D.end));
      rows.forEach((r, i) => {
        const n = i + 1, sfx = n === 1 ? "" : `_${n}`;
        setText(`Classification${sfx}`, r.classification, 8);
        setText(`Donor ${n}`, [r.name, ...(r.address || [])].join("\n"), 8, true);
        setText(n === 1 ? "Contributors Occupation if applicable" : `Contributors Occupation if applicable_${n}`, r.occupation, 8);
        check(`Direct${sfx}`, r.type === "direct"); check(`InKind describe${sfx}`, r.type === "inkind"); check(`Loan${sfx}`, r.type === "loan");
        check(`Interest${sfx}`, r.type === "interest"); check(`Miscellaneous specify${sfx}`, r.type === "misc");
        if (r.type === "inkind") setText(`Describe ${n}`, r.desc, 7);
        if (r.type === "misc") setText(n === 1 ? " 1" : " 2", r.desc, 7);
        setText(`Amount of Contribution ${n}`, amt(r.amount), 9, true);
        setText(n === 1 ? "Date and Received By 1" : `Date and Recevied by ${n}`, [dt(r.date), r.receivedBy].filter(Boolean).join("\n"), 7, true);
      });
      setText("Title", D.treasurerTitle || "Treasurer");
      form.updateFieldAppearances(font);
      form.flatten();
      doc.getPage(0).node.delete(PDFLib.PDFName.of("Annots"));
      const [copied] = await out.copyPages(doc, [0]);
      out.addPage(copied);
    }
    out.setTitle(`CFA-11 Large Contribution Report - ${D.candidate || ""}`.trim());
    return await out.save();
  }
  const api = { build };
  if (typeof module !== "undefined") module.exports = api; else root.CFAFill11 = api;
})(typeof window !== "undefined" ? window : globalThis);
