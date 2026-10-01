// Campaign Finance Helper — AI reading and review, shared by /api/extract and /api/review.
// Environment: ANTHROPIC_API_KEY, ACCESS_CODE, MODEL (optional)
import { cleanCode, draftExists } from "./store.js";

const RULES = `
INDIANA CFA-4 RULES (State Form 4606 R18/6-25; 2026 Indiana Campaign Finance Manual R/7-26), for county/local candidate committees:
- Money in goes on Schedule A by SOURCE TYPE: A-1 individuals (including the candidate's own money), A-2 corporations (must have articles of incorporation; LLCs, LLPs, partnerships and sole proprietorships are NOT corporations), A-3 labor organizations, A-4 political action committees, A-5 everything else (LLCs, partnerships, party committees, other candidate committees, clubs). Set contributor_type to one of: individual, candidate, corporation, labor, pac, committee, other. If a business type is unclear, ask.
- Receipt type on Schedule A: Direct (money), In-Kind (goods/services; describe them), Interest, Loan, Miscellaneous (specify: refund, rebate, sale proceeds, etc.).
- Date received = the date the campaign received the contribution. If you only see a check date or a deposit date, use it and do not ask about it.
- Itemize a source once its calendar-year total exceeds $100. Itemized entries need full name, full mailing address and "received by" (the committee member who received it). Occupation is required for individuals giving $1,000+ in the year (a real job, not "consultant").
- Online/card donations: report the gross amount before platform fees; fees are a separate expenditure (code O). Whole-dollar online amounts are the gross amount; do not ask whether they are gross. Only an online amount with odd cents (like 24.11) suggests a net figure worth asking about.
- Candidate's own money: a contribution or a loan (loans also go on Schedule D). If the candidate paid a campaign bill personally, that is an in-kind contribution from the candidate.
- In-kind gifts are entered twice: Schedule A (in-kind) and Schedule B (in-kind expenditure).
- Money out goes on Schedule B with an expenditure CODE, required for every itemized expense:
  A = Advertising (signs, printing, literature, mailers, shirts, buttons, websites, radio/TV/newspaper/online ads, mailing lists, printed fundraising letters)
  F = Fundraising (event venue, food, catering, entertainment, speakers)
  O = Operations (filing fees, office rent, utilities, equipment, postage, travel, staff/consultants, polling, bank and payment-platform fees)
  C = Contributions to other campaigns, PACs, party committees, charities
  Expense types: Direct, In-Kind, Payment of Debt, Returned Contribution (refund), Other. Purpose must be specific.
- Credit card purchases: list the vendor, not the card company. Unpaid balances and unpaid bills go on Schedule D (debts owed by the committee).
- Corporations and unions may give at most $2,000 per calendar year across ALL county/local candidates combined. Foreign nationals may not give at all. Contributions in someone else's name are illegal.
- 2026 county report periods: Pre-Primary 1/1-4/10 (due 4/17 noon); Pre-Election 4/11-10/9 (due 10/16 noon); Annual 10/10-12/31 (due 1/20/2027 noon).
`;

const ENTRY = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["contribution", "inkind", "loan", "interest", "misc", "expense", "debt_payment", "refund", "transfer_out", "unpaid_bill"],
      description: "contribution=money given to the campaign; inkind=donated goods/services; loan=loan TO the campaign; interest/misc=other money in; expense=campaign paid someone; debt_payment=paying back a loan or old bill; refund=campaign returned a contribution; transfer_out=campaign gave to another campaign/PAC/party/charity; unpaid_bill=bill owed but not yet paid" },
    source: { type: "string", enum: ["individual", "candidate", "corporation", "labor", "pac", "committee", "other", ""], description: "who the money came FROM (money-in kinds only)" },
    name: { type: "string", description: "full name of the person or organization (the donor for money in, the payee for money out)" },
    street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" },
    occupation: { type: "string" },
    amount: { type: "number" },
    date: { type: "string", description: "YYYY-MM-DD, the date on the document" },
    method: { type: "string", description: "check, cash, card, online, in-kind, other" },
    check_number: { type: "string" },
    received_by: { type: "string" },
    desc: { type: "string", description: "what was donated (in-kind) or what the other receipt was (misc)" },
    purpose: { type: "string", description: "what a payment was for, specific" },
    code: { type: "string", enum: ["A", "F", "O", "C", ""], description: "expenditure code for money out" },
    office: { type: "string", description: "office sought, if the payee is a candidate" },
    source_file: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    missing: { type: "array", items: { type: "string" } },
    question: { type: "string", description: "one plain, friendly question for the candidate if anything is unclear" },
  },
  required: ["kind", "amount", "confidence", "missing"],
};
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: ENTRY },
    prior_report: {
      type: "object", description: "ONLY when the upload is a previously filed CFA-4: its summary numbers",
      properties: {
        report_type: { type: "string" }, period_start: { type: "string" }, period_end: { type: "string" },
        line14_jan1_cash: { type: "number" }, line15a_colB: { type: "number" }, line15b_colB: { type: "number" },
        line17a_colB: { type: "number" }, line17b_colB: { type: "number" }, line18_colA_ending_cash: { type: "number" },
        file_number: { type: "string" }, committee_name: { type: "string" },
        unpaid_debts: { type: "array", items: { type: "object", properties: { creditor: { type: "string" }, street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, amount: { type: "number" }, nature: { type: "string" }, date: { type: "string" }, balance: { type: "number" } } } },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["items"],
};
const MAP_SCHEMA = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["in", "out", "mixed", "unknown"], description: "are the rows money coming in, going out, or both" },
    direction_column: { type: "string", description: "column that says whether a row is money in or out, if mixed" },
    direction_in_values: { type: "array", items: { type: "string" }, description: "values in that column meaning money in" },
    columns: { type: "object", properties: {
      name: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
      amount: { type: "string" }, date: { type: "string" }, street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" },
      occupation: { type: "string" }, employer: { type: "string" }, purpose: { type: "string" }, method: { type: "string" }, check_number: { type: "string" },
      status: { type: "string", description: "column indicating failed/canceled/refunded, if any" } } },
    skip_status_values: { type: "array", items: { type: "string" }, description: "values in the status column meaning the row should be skipped" },
    notes: { type: "string" },
  },
  required: ["direction", "columns"],
};
const MAP_PROMPT = `You are given the header row and a few sample rows of a spreadsheet a local candidate kept for their campaign finances.
Return which column holds each piece of information (exact header text). Leave a field out if there is no such column. Decide whether rows are money in (donations), money out (expenses), or mixed.`;
const ASK_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "plain-language answer, 1-4 short sentences, for a first-time local candidate" },
    items: { type: "array", items: ENTRY, description: "ONLY if the candidate described a specific transaction with enough detail to record it; otherwise empty" },
  },
  required: ["answer", "items"],
};
const ASK_PROMPT = `You are a friendly helper inside a tool that builds Indiana CFA-4 campaign finance reports for first-time county and local candidates.
Answer the candidate's question in plain language, briefly, using the rules below and the summary of their report. Say what to do, not the statute.
If you're unsure, say what the county election board would need to confirm. Never invent facts about their report.
If the candidate describes a specific donation or payment with enough detail to record it, return it in "items" as well, so the tool can offer to add it. Otherwise leave items empty.
${RULES}`;
const BANK_SCHEMA = {
  type: "object",
  properties: {
    account_last4: { type: "string" },
    period_start: { type: "string", description: "YYYY-MM-DD" },
    period_end: { type: "string", description: "YYYY-MM-DD" },
    opening_balance: { type: "number" },
    closing_balance: { type: "number" },
    lines: { type: "array", items: { type: "object", properties: {
      date: { type: "string", description: "YYYY-MM-DD" },
      amount: { type: "number", description: "always positive" },
      direction: { type: "string", enum: ["in", "out"] },
      description: { type: "string", description: "the bank's description, verbatim" },
      check_number: { type: "string" },
      balance_after: { type: "number" },
    }, required: ["date", "amount", "direction"] } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["lines"],
};
const BANK_PROMPT = `You read bank statements for a small political campaign's checking account. Return every transaction line: date, positive amount, whether money came in or went out, the bank's description verbatim, the check number if shown, and the running balance if shown.
Also return the statement period and the opening and closing balances. Skip summary rows and running totals; do not skip fees. Never invent lines. If a page is cut off, say so in notes.`;
const FLAG_SCHEMA = {
  type: "object",
  properties: { flags: { type: "array", items: { type: "object", properties: {
    severity: { type: "string", enum: ["must_fix", "check", "tip"] },
    item_ids: { type: "array", items: { type: "string" } },
    message: { type: "string" }, fix: { type: "string" } }, required: ["severity", "message", "fix"] } } },
  required: ["flags"],
};

const EXTRACT_PROMPT = `You help first-time local candidates in Indiana prepare their CFA-4 campaign finance report.
You receive whatever they have: photos of checks, deposit slips, receipts, invoices, bank statements, screenshots, spreadsheets in any layout, or typed notes.
Turn every financial transaction you find into an item. Rules:
- Never invent data. Leave unknown fields empty and list them in "missing".
- A check made out TO the campaign is money in; a check or receipt paid BY the campaign is money out.
- "I" or "me" in typed notes means the candidate; use source "candidate" and the candidate's name from the context.
- One photo can hold several items (a deposit slip); the same item can appear in several files. Mention likely duplicates in notes.
- Bank statements: deposits are money in (often without donor names; ask), debits are money out.
- If the upload is a previously filed CFA-4 report, fill "prior_report" with its summary numbers and unpaid debts, and return its itemized entries as items with their original dates.
- Write "question" in plain, friendly language when something must be confirmed.
${RULES}`;

const REVIEW_PROMPT = `You review a draft Indiana CFA-4 report before a nervous first-time local candidate prints and files it.
Rule-based checks have already run (listed as existing_flags); do not repeat them. Look for what rules can't catch:
- Likely duplicates under different spellings, or the same money entered from two sources.
- Expenses that look personal (not allowed), or purposes too vague to pass.
- Businesses that may be corporations filed as individuals/other, or vice versa.
- Things commonly forgotten: bank fees, filing fees, candidate's own spending (in-kind), donated food or printing, unpaid bills.
- Anything a county clerk would question.
Be specific, kind, and short. Use "must_fix" only for things that make the report wrong.
${RULES}`;

async function authorized(request) {
  const access = request.headers.get("X-Access-Code");
  if (access && process.env.ACCESS_CODE && access.trim().toLowerCase() === process.env.ACCESS_CODE.toLowerCase()) return true;
  const code = cleanCode(request.headers.get("X-Draft-Code"));
  return !!code && (await draftExists(code));
}

export async function handle(request, endpoint) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  if (!(await authorized(request))) return json({ error: "Not signed in" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  try {
    if (endpoint === "extract") {
      const content = [];
      for (const f of (body.files || []).slice(0, 8)) {
        if (f.mediaType === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: f.mediaType, data: f.data } });
        else if (/^image\/(jpeg|png|gif|webp)$/.test(f.mediaType)) content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
        else continue;
        content.push({ type: "text", text: `(file above: ${f.name})` });
      }
      if (body.text) content.push({ type: "text", text: `${body.textLabel || "Typed notes"}:\n${String(body.text).slice(0, 150000)}` });
      if (body.context) content.push({ type: "text", text: `Report context: ${JSON.stringify(body.context)}` });
      if (!content.length) return json({ error: "Nothing to read" }, 400);
      content.push({ type: "text", text: "Record every transaction with the record_items tool." });
      return json(await callClaude(EXTRACT_PROMPT, content, "record_items", ITEM_SCHEMA));
    }
    if (endpoint === "bank") {
      const content = [];
      for (const f of (body.files || []).slice(0, 12)) {
        if (f.mediaType === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: f.mediaType, data: f.data } });
        else if (/^image\/(jpeg|png|gif|webp)$/.test(f.mediaType)) content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
        else continue;
        content.push({ type: "text", text: `(file above: ${f.name})` });
      }
      if (body.text) content.push({ type: "text", text: `Bank download:\n${String(body.text).slice(0, 150000)}` });
      if (!content.length) return json({ error: "Nothing to read" }, 400);
      content.push({ type: "text", text: "Record the statement with the record_statement tool." });
      return json(await callClaude(BANK_PROMPT, content, "record_statement", BANK_SCHEMA));
    }
    if (endpoint === "ask") {
      const content = [{ type: "text", text: `Report summary:\n${JSON.stringify(body.context).slice(0, 60000)}\n\nRecent questions:\n${JSON.stringify(body.history || []).slice(0, 6000)}\n\nQuestion: ${String(body.question || "").slice(0, 4000)}\n\nAnswer with the answer_question tool.` }];
      return json(await callClaude(ASK_PROMPT, content, "answer_question", ASK_SCHEMA));
    }
    if (endpoint === "mapcolumns") {
      const content = [{ type: "text", text: `Headers:\n${JSON.stringify(body.headers)}\n\nSample rows:\n${JSON.stringify((body.rows || []).slice(0, 8))}\n\nUse the map_columns tool.` }];
      return json(await callClaude(MAP_PROMPT, content, "map_columns", MAP_SCHEMA));
    }
    if (endpoint === "review") {
      const content = [{ type: "text", text: `Draft report:\n${JSON.stringify(body.report).slice(0, 250000)}\n\nReport problems with the record_flags tool.` }];
      return json(await callClaude(REVIEW_PROMPT, content, "record_flags", FLAG_SCHEMA));
    }
    return json({ error: "Unknown endpoint" }, 404);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

async function callClaude(system, content, toolName, schema) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.MODEL || "claude-sonnet-5-5",
      max_tokens: 12000,
      system,
      tools: [{ name: toolName, description: "Return the structured result. Always call this tool exactly once with the complete result; do not answer in plain text.", input_schema: schema }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {}
    if (res.status === 401) throw new Error("The AI key isn't being accepted. Check ANTHROPIC_API_KEY in Vercel and redeploy.");
    if (res.status === 429 || res.status === 529) throw new Error("The reader is busy right now. Try again in a minute.");
    throw new Error(`The reader couldn't run (${res.status}${detail ? ": " + detail.slice(0, 200) : ""}).`);
  }
  const data = await res.json();
  const tool = (data.content || []).find((b) => b.type === "tool_use");
  if (tool) return tool.input;
  // Fallback: the model answered in text; look for a JSON object in it.
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  throw new Error("The reader didn't return a result. Try again.");
}
