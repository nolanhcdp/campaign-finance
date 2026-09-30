// Helper view: list every draft so Nolan can open one and help.
//   GET /api/admin   header X-Admin-Code: <ADMIN_CODE>   → { drafts: [...] }
import { listDrafts } from "../lib/store.js";

export async function GET(request) {
  const code = request.headers.get("X-Admin-Code") || "";
  if (!process.env.ADMIN_CODE || code !== process.env.ADMIN_CODE)
    return new Response(JSON.stringify({ error: "Wrong helper code" }), { status: 401, headers: { "Content-Type": "application/json" } });
  try {
    const drafts = await listDrafts();
    return new Response(JSON.stringify({ drafts }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
