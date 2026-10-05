// Open sign-up from the main page.
//   GET  /api/signup                                   → { turnstileSiteKey }   (empty when bot check isn't set up)
//   POST /api/signup { candidate, committee, office, county, email, phone, website, token } → { code }
// Guards: a hidden "website" field bots fill in, optional Cloudflare Turnstile, 3 sign-ups per hour per network,
// and a daily ceiling on new committees across the whole site. The email is stored for lost-code help only.
import { newCode, draftExists, saveDraft, bump } from "../lib/store.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const clean = (v, n = 120) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export async function GET() { return json({ turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "" }); }

export async function POST(request) {
  try {
    const b = await request.json().catch(() => ({}));
    if (b.website) return json({ error: "Something went wrong. Try again." }, 400);       // honeypot
    const f = { committeeType: b.committeeType === "party" ? "party" : "candidate", candidate: clean(b.candidate), committee: clean(b.committee), office: clean(b.office), county: clean(b.county, 40), email: clean(b.email, 160).toLowerCase(), phone: clean(b.phone, 30) };
    if (!f.candidate || !f.committee || !f.county) return json({ error: "Fill in your name, committee name and county." }, 400);   // for a party committee "candidate" carries the contact's name
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return json({ error: "That email address doesn't look right." }, 400);

    if (process.env.TURNSTILE_SECRET_KEY) {
      const form = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: String(b.token || "") });
      const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }).then((r) => r.json()).catch(() => ({}));
      if (!v.success) return json({ error: "Please finish the “I'm not a robot” check and try again." }, 400);
    }
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const day = new Date().toISOString().slice(0, 10);
    if ((await bump(`su:ip:${ip}`, 3600)) > 3) return json({ error: "Too many sign-ups from this network in the last hour. Try again later, or email for help." }, 429);
    if ((await bump(`su:day:${day}`, 172800)) > Number(process.env.SIGNUP_DAILY_LIMIT || 40)) return json({ error: "We've hit today's limit for new committees. Try again tomorrow, or email for help." }, 429);

    let code; for (let i = 0; i < 5; i++) { code = newCode(); if (!(await draftExists(code))) break; }
    const now = Date.now();
    const signup = { email: f.email, phone: f.phone, county: f.county, at: now, how: "self", committeeType: f.committeeType, contact: f.candidate };
    await saveDraft(code, { data: null, rev: 0, createdAt: now, updatedAt: now, signup },
      { candidate: f.candidate, committee: f.committee, office: f.office, county: f.county, email: f.email, how: "self", entries: 0, step: "", mustFix: null, createdAt: now, updatedAt: now });
    return json({ code });
  } catch (e) { return json({ error: e.message }, 500); }
}
