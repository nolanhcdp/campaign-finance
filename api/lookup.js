// Shared lookups across committees in a county.
//   GET  /api/lookup?kind=person|payee&name=&city=&occupation=&county=   → { match } or { match: null }
//   GET  /api/lookup?kind=corp&name=&year=                               → { others: n }
//   POST /api/lookup { county, people: [...] }                            publish donors from a report marked filed
// Both need a valid report code in X-Draft-Code.
import { cleanCode, draftExists, findPerson, findPayee, publishPeople, corpOthers } from "../lib/store.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
async function auth(request) { const c = cleanCode(request.headers.get("X-Draft-Code")); return c && (await draftExists(c)) ? c : null; }

export async function GET(request) {
  const code = await auth(request); if (!code) return json({ error: "Not signed in" }, 401);
  try {
    const q = new URL(request.url).searchParams;
    const kind = q.get("kind"), name = (q.get("name") || "").trim(), county = q.get("county") || "";
    if (!name) return json({ match: null });
    if (kind === "person") return json({ match: await findPerson(county, name, { city: q.get("city") || "", occupation: q.get("occupation") || "" }) });
    if (kind === "payee") return json({ match: await findPayee(county, name, { city: q.get("city") || "" }) });
    if (kind === "corp") return json({ others: await corpOthers(q.get("year") || new Date().getFullYear(), name, code) });
    return json({ error: "Unknown lookup" }, 400);
  } catch (e) { return json({ error: e.message }, 500); }
}
export async function POST(request) {
  const code = await auth(request); if (!code) return json({ error: "Not signed in" }, 401);
  try {
    const { county, people } = await request.json();
    const n = await publishPeople(county, people);
    return json({ ok: true, published: n });
  } catch (e) { return json({ error: e.message }, 500); }
}
