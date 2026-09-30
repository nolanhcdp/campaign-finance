// Draft storage on Upstash Redis (added from the Vercel Marketplace; free tier is plenty).
// Uses the REST API directly, so no packages are needed.

// Finds the Upstash REST settings whatever prefix Vercel gave them (KV_, kv_KV_, STORAGE_, UPSTASH_REDIS_, ...).
const findEnv = (suffix) => {
  for (const k of ["KV_" + suffix, "UPSTASH_REDIS_" + suffix]) if (process.env[k]) return process.env[k];
  const wantUrl = suffix.endsWith("URL");
  const k = Object.keys(process.env).find((n) => n.endsWith("_" + suffix) && /^https?:\/\//.test(process.env[n] || "") === wantUrl);
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
