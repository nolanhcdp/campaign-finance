// Save and load a candidate's report draft.
//   POST /api/draft            { accessCode }            → { code }            start a new draft
//   GET  /api/draft?code=XXX                              → { data, rev, updatedAt }
//   PUT  /api/draft            { code, rev, data }       → { rev, updatedAt }  (409 if another device saved first)
import { cleanCode, newCode, getDraft, saveDraft, draftExists } from "../lib/store.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const MAX_BYTES = 900_000;

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
    const next = { data, rev: cur.rev + 1, createdAt: cur.createdAt, updatedAt: now };
    const a = data?.about || {};
    const meta = {
      candidate: a.candidate || "", committee: a.committee || "", office: a.office || "", report: a.report || "",
      entries: (data?.entries || []).length, step: data?.step || "", mustFix: data?.mustFix ?? null,
      createdAt: cur.createdAt, updatedAt: now,
    };
    await saveDraft(code, next, meta);
    return json({ rev: next.rev, updatedAt: now });
  } catch (e) { return json({ error: e.message }, 500); }
}
