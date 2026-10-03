// Helper view: list every draft so Nolan can open one and help.
//   GET /api/admin   header X-Admin-Code: <ADMIN_CODE>   → { drafts: [...] }
import { listDrafts, newCode, draftExists, saveDraft, listQuestions } from "../lib/store.js";

export async function GET(request) {
  const code = request.headers.get("X-Admin-Code") || "";
  if (!process.env.ADMIN_CODE || code !== process.env.ADMIN_CODE)
    return new Response(JSON.stringify({ error: "Wrong helper code" }), { status: 401, headers: { "Content-Type": "application/json" } });
  try {
    if (new URL(request.url).searchParams.get("view") === "questions")
      return new Response(JSON.stringify({ questions: await listQuestions() }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    const drafts = await listDrafts();
    return new Response(JSON.stringify({ drafts }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// POST /api/admin  header X-Admin-Code  body { drafts: [{ label, data }] }  → { created: [{ code, label }] }
export async function POST(request) {
  const code = request.headers.get("X-Admin-Code") || "";
  if (!process.env.ADMIN_CODE || code !== process.env.ADMIN_CODE)
    return new Response(JSON.stringify({ error: "Wrong helper code" }), { status: 401, headers: { "Content-Type": "application/json" } });
  try {
    const { drafts } = await request.json();
    const created = [];
    for (const d of (drafts || []).slice(0, 50)) {
      let c; for (let i = 0; i < 5; i++) { c = newCode(); if (!(await draftExists(c))) break; }
      const now = Date.now(), data = d.data || null, a = data?.about || {};
      await saveDraft(c, { data, rev: 1, createdAt: now, updatedAt: now }, { candidate: a.candidate || d.label || "", committee: a.committee || "", office: a.office || "", report: a.report || "", entries: (data?.entries || []).length, step: data?.step || "", mustFix: null, createdAt: now, updatedAt: now });
      created.push({ code: c, label: d.label || a.candidate || "" });
    }
    return new Response(JSON.stringify({ created }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
