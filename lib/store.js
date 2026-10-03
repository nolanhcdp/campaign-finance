// Draft storage on Upstash Redis (added from the Vercel Marketplace; free tier is plenty).
// Uses the REST API directly, so no packages are needed.

// Finds the Upstash REST settings whatever prefix Vercel gave them (KV_, STORAGE_, UPSTASH_REDIS_, ...).
const findEnv = (suffix) => {
  for (const k of ["KV_" + suffix, "UPSTASH_REDIS_" + suffix]) if (process.env[k]) return process.env[k];
  const k = Object.keys(process.env).find((n) => n.endsWith("_" + suffix) && /^https?:\/\//.test(process.env[n]) === (suffix === "REST_API_URL" || suffix === "REST_URL"));
  return k ? process.env[k] : undefined;
};
const URL_ = () => findEnv("REST_API_URL") || findEnv("REST_URL");
const TOKEN = () => findEnv("REST_API_TOKEN") || findEnv("REST_TOKEN");

export async function redis(...cmds) {
  if (!URL_() || !TOKEN()) throw new Error("Storage isn't connected. Add Upstash Redis to the Vercel project.");
  const res = await fetch(`${URL_()}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error(`Storage error ${res.status}`);
  const out = await res.json();
  for (const r of out) if (r.error) throw new Error(`Storage error: ${r.error}`);
  return out.map((r) => r.result);
}

// Resume codes: 9 characters from an alphabet with no look-alikes (no 0/O, 1/I/L), shown as XXX-XXX-XXX.
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = "";
  for (const b of bytes) s += ALPHA[b % ALPHA.length];
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
}
export function cleanCode(c) {
  const s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 9 || [...s].some((ch) => !ALPHA.includes(ch))) return null;
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
}

export async function getDraft(code) {
  const [raw] = await redis(["GET", `draft:${code}`]);
  return raw ? JSON.parse(raw) : null;
}
export async function draftExists(code) {
  const [n] = await redis(["EXISTS", `draft:${code}`]);
  return n === 1;
}
export async function saveDraft(code, draft, meta) {
  await redis(
    ["SET", `draft:${code}`, JSON.stringify(draft)],
    ["SET", `meta:${code}`, JSON.stringify(meta)],
    ["ZADD", "drafts", String(draft.updatedAt), code],
  );
}
export async function listDrafts(limit = 300) {
  const [codes] = await redis(["ZREVRANGE", "drafts", "0", String(limit - 1)]);
  if (!codes || !codes.length) return [];
  const [metas] = await redis(["MGET", ...codes.map((c) => `meta:${c}`)]);
  return codes.map((c, i) => ({ code: c, ...(metas[i] ? JSON.parse(metas[i]) : {}) }));
}

// ---------- Shared lookups ----------
// Donor details come only from reports a candidate has marked as filed (public record); payees from any report.
// Keys are per county. Nothing here is browsable: the API answers one name at a time.
export const nameKey = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(mr|mrs|ms|dr|jr|sr|ii|iii|llc|inc|corp|co|the)\b/g, "").replace(/\s+/g, " ").trim();
const ck = (county) => String(county || "").toLowerCase().replace(/[^a-z]/g, "") || "x";
export async function publishPeople(county, people) {
  const cmds = [];
  for (const p of (people || []).slice(0, 2000)) {
    const k = nameKey(p.name); if (!k || !p.street) continue;
    const rec = { street: p.street || "", city: p.city || "", state: p.state || "IN", zip: p.zip || "", occupation: p.occupation || "", source: p.source || "" };
    cmds.push(["HSET", `person:${ck(county)}:${k}`, `${rec.street}|${rec.zip}`.toLowerCase(), JSON.stringify(rec)]);
  }
  if (cmds.length) await redis(...cmds);
  return cmds.length;
}
export async function publishPayees(county, payees) {
  const cmds = [];
  for (const p of (payees || []).slice(0, 2000)) {
    const k = nameKey(p.name); if (!k) continue;
    const rec = { street: p.street || "", city: p.city || "", state: p.state || "IN", zip: p.zip || "", code: p.code || "" };
    cmds.push(["HSET", `payee:${ck(county)}:${k}`, `${rec.street}|${rec.zip}|${rec.code}`.toLowerCase(), JSON.stringify(rec)]);
  }
  if (cmds.length) await redis(...cmds);
  return cmds.length;
}
export async function findPerson(county, name, hints = {}) {
  const [h] = await redis(["HGETALL", `person:${ck(county)}:${nameKey(name)}`]);
  return pick(h, hints);
}
export async function findPayee(county, name, hints = {}) {
  const [h] = await redis(["HGETALL", `payee:${ck(county)}:${nameKey(name)}`]);
  return pick(h, hints);
}
// One suggestion or none: a single address on file for that name in the county, or several narrowed to one by city/occupation.
function pick(h, hints) {
  if (!h || !h.length) return null;
  let recs = []; for (let i = 1; i < h.length; i += 2) { try { recs.push(JSON.parse(h[i])); } catch (e) {} }
  const distinct = (rs) => [...new Map(rs.map((r) => [`${r.street}|${r.zip}`.toLowerCase(), r])).values()];
  let d = distinct(recs);
  if (d.length > 1 && hints.city) d = d.filter((r) => r.city.toLowerCase() === String(hints.city).toLowerCase()) || d;
  if (d.length > 1 && hints.occupation) { const f = d.filter((r) => r.occupation && r.occupation.toLowerCase() === String(hints.occupation).toLowerCase()); if (f.length) d = f; }
  if (d.length !== 1) return null;
  const r = d[0];
  if (!r.code) { const codes = recs.filter((x) => x.code).map((x) => x.code); if (codes.length) r.code = codes.sort((a, b) => codes.filter((c) => c === b).length - codes.filter((c) => c === a).length)[0]; }
  return r;
}
// Corporations and unions that gave to more than one committee this year (names only, no amounts).
export async function noteCorpGiver(year, name, code) { const k = nameKey(name); if (k) await redis(["SADD", `corp:${year}:${k}`, code]); }
export async function corpOthers(year, name, code) { const [m] = await redis(["SMEMBERS", `corp:${year}:${nameKey(name)}`]); return (m || []).filter((c) => c !== code).length; }
// Questions candidates asked, with dollar amounts stripped, so the helper can see what people get stuck on.
export async function logQuestion(q, county) {
  const text = String(q).replace(/\$?\d[\d,]*(\.\d+)?/g, "[amount]").slice(0, 500);
  if (!text.trim()) return;
  await redis(["LPUSH", "questions", JSON.stringify({ q: text, county: county || "", at: Date.now() })], ["LTRIM", "questions", "0", "499"]);
}
export async function listQuestions(limit = 200) { const [l] = await redis(["LRANGE", "questions", "0", String(limit - 1)]); return (l || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean); }

// ---------- Limits ----------
// Counts something in a time window; returns the new count. Used for sign-ups per IP and AI calls per committee.
export async function bump(key, ttlSeconds) {
  const [n] = await redis(["INCR", key], ["EXPIRE", key, String(ttlSeconds)]);
  return n;
}
