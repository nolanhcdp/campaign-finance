// Save and load a candidate's report draft.
//   POST /api/draft            { accessCode }            → { code }            start a new draft
//   GET  /api/draft?code=XXX                              → { data, rev, updatedAt }
//   PUT  /api/draft            { code, rev, data }       → { rev, updatedAt }  (409 if another device saved first)
import { cleanCode, newCode, getDraft, saveDraft, draftExists, publishPayees, noteCorpGiver } from "../lib/store.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const MAX_BYTES = 2_500_000;

export async function POST(request) {
  try {
    const { accessCode } = await request.json().catch(() => ({}));
    if (!process.env.ACCESS_CODE || accessCode?.trim().toLowerCase() !== process.env.ACCESS_CODE.toLowerCase())
      return json({ error: "That sign-up code isn't right. Check with whoever sent you this link." }, 401);
    let code;
    for (let i = 0; i < 5; i++) { code = newCode(); if (!(await draftExists(code))) break; }
    const now = Date.now();
    await saveDraft(code, { data: null, rev: 0, createdAt: now, updatedAt: now }, { createdAt: now, updatedAt: now });
    return json({ code });
  } catch (e) { return json({ error: e.message }, 500); }
}

export async function GET(request) {
  try {
    const code = cleanCode(new URL(request.url).searchParams.get("code"));
    if (!code) return json({ error: "That code doesn't look right. It has 9 letters and numbers, like 7KQ-M2P-X9D." }, 400);
    const d = await getDraft(code);
    if (!d) return json({ error: "We couldn't find a report with that code." }, 404);
    return json({ code, data: d.data, rev: d.rev, updatedAt: d.updatedAt });
  } catch (e) { return json({ error: e.message }, 500); }
}

export async function PUT(request) {
  try {
    const body = await request.text();
    if (body.length > MAX_BYTES) return json({ error: "This report is too large to save. Contact your helper." }, 413);
    const { code: raw, rev, data } = JSON.parse(body);
    const code = cleanCode(raw);
    if (!code) return json({ error: "Bad code" }, 400);
    const cur = await getDraft(code);
    if (!cur) return json({ error: "We couldn't find a report with that code." }, 404);
    if (Number(rev) !== Number(cur.rev)) return json({ error: "conflict", rev: cur.rev, data: cur.data, updatedAt: cur.updatedAt }, 409);
    const now = Date.now();
    const next = { data, rev: cur.rev + 1, createdAt: cur.createdAt, updatedAt: now, signup: cur.signup };
    const a = data?.about || {};
    const open = (data?.reports || []).find((r) => r.id === data?.cur) || (data?.reports || []).filter((r) => r.status === "open").slice(-1)[0];
    const meta = {
      candidate: a.candidate || "", committee: a.committee || "", office: a.office || "", report: open ? `${open.type} ${String(open.end || "").slice(0, 4)}` : (a.report || ""),
      entries: (data?.entries || []).length, step: data?.step || "", mustFix: data?.mustFix ?? null,
      county: a.county || cur.signup?.county || "", email: cur.signup?.email || "", how: cur.signup?.how || "",
      createdAt: cur.createdAt, updatedAt: now,
    };
    await saveDraft(code, next, meta);
    sharePayees(code, data).catch(() => {});
    return json({ rev: next.rev, updatedAt: now });
  } catch (e) { return json({ error: e.message }, 500); }
}

// Payee addresses and codes aren't about people, so every save shares them with the county. Corporate and union
// donors are noted by name only (no amounts), so the optional over-the-limit check can count committees.
async function sharePayees(code, data) {
  const county = data?.about?.county || "", ents = data?.entries || [];
  const payees = ents.filter((e) => ["expense", "debt_payment", "transfer_out"].includes(e.kind) && e.name && e.street).map((e) => ({ name: e.name, street: e.street, city: e.city, state: e.state, zip: e.zip, code: e.code }));
  if (payees.length) await publishPayees(county, payees.slice(0, 500));
  for (const e of ents) if ((e.source === "corporation" || e.source === "labor") && e.name && e.date) await noteCorpGiver(String(e.date).slice(0, 4), e.name, code);
}
