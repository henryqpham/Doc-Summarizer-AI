// ─────────────────────────────────────────────────────────────────────────
//  PROBE — discovers what we can't look up.
//
//  Ask Sage's response schemas aren't publicly documented (docs site is an SPA,
//  SwaggerHub 404s). Rather than guess field names, this asks the live API and
//  prints the RAW JSON. It answers:
//    1. Does auth work?             (token exchange)
//    2. What's the token field?     (raw shape)
//    3. What models can you use?    -> ASKSAGE_MODEL
//    4. What's the query response?  -> pins down the parser
//
//  Run:  npm run probe
//  Needs only ASKSAGE_EMAIL / ASKSAGE_API_KEY / ASKSAGE_BASE_URL.
// ─────────────────────────────────────────────────────────────────────────
// Load .env if present; otherwise fall through to the real environment.
try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on process.env */
}

const BASE = (process.env.ASKSAGE_BASE_URL || "").replace(/\/+$/, "");
const EMAIL = (process.env.ASKSAGE_EMAIL || "").trim();
const KEY = (process.env.ASKSAGE_API_KEY || "").trim();
const MODEL = (process.env.ASKSAGE_MODEL || "").trim();

if (!BASE || !EMAIL || !KEY) {
  console.error("\n  Need ASKSAGE_BASE_URL, ASKSAGE_EMAIL and ASKSAGE_API_KEY in .env.\n");
  process.exit(1);
}

let TOKEN = null;

/** Never print the live token or the API key, even in a debug dump. */
function redact(value) {
  const json = JSON.stringify(value, null, 2) ?? "undefined";
  let out = json;
  if (TOKEN) out = out.split(TOKEN).join("<REDACTED-TOKEN>");
  if (KEY) out = out.split(KEY).join("<REDACTED-KEY>");
  return out;
}

function head(title) {
  console.log(`\n${"─".repeat(72)}\n  ${title}\n${"─".repeat(72)}`);
}

async function call(path, { body, form } = {}) {
  const headers = {};
  if (TOKEN) headers["x-access-tokens"] = TOKEN;
  if (!form) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: form ?? JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { __nonJsonBody: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, data: parsed };
}

// ── 0. Can we skip the email? ─────────────────────────────────────────────
// Ask Sage's documented flow is email + api_key -> token. But it costs nothing
// to check whether the raw API key is accepted directly as x-access-tokens; if
// it is, ASKSAGE_EMAIL can be dropped from .env entirely.
head("0. Is the email actually required?  (trying the API key as a token)");
{
  const res = await fetch(`${BASE}/server/get-models`, {
    method: "POST",
    headers: { "x-access-tokens": KEY, "content-type": "application/json" },
    body: "{}",
  });
  console.log(`  status: ${res.status}`);
  if (res.ok) {
    console.log(`  ✔ The API key works directly as a token — the email is NOT needed.
    Tell Claude, and ASKSAGE_EMAIL can be removed from .env.`);
  } else {
    console.log(`  ✘ Rejected (${res.status}). The email + token exchange IS required,
    as their docs say. Keep ASKSAGE_EMAIL in .env.`);
  }
}

// ── 1. Auth ───────────────────────────────────────────────────────────────
head("1. POST /user/get-token-with-api-key");
const auth = await call("/user/get-token-with-api-key", { body: { email: EMAIL, api_key: KEY } });
console.log(`  status: ${auth.status}`);
console.log(`  top-level keys: [${Object.keys(auth.data ?? {}).join(", ")}]`);
console.log(redact(auth.data));

if (!auth.ok) {
  console.error("\n  Auth failed. Check email/key, and that .env saved as LF (a trailing \\r 401s).\n");
  process.exit(1);
}

// Find the token wherever it lives.
const flat = { ...(auth.data ?? {}), ...(auth.data?.response ?? {}) };
TOKEN =
  [flat.access_token, flat.token, flat.accessToken, auth.data?.response].find(
    (v) => typeof v === "string" && v.length > 20
  ) ?? null;

if (!TOKEN) {
  console.error("\n  Got a 200 but couldn't spot the token above. Paste this output and it'll be pinned down.\n");
  process.exit(1);
}
console.log(`\n  ✔ Token acquired (${TOKEN.length} chars). Field located.`);

// ── 2. Models ─────────────────────────────────────────────────────────────
head("2. POST /server/get-models   ← your ASKSAGE_MODEL comes from here");
const models = await call("/server/get-models");
console.log(`  status: ${models.status}`);
console.log(redact(models.data));

// ── 3. Query ──────────────────────────────────────────────────────────────
if (MODEL) {
  head(`3. POST /server/query   (model: ${MODEL})`);
  const q = await call("/server/query", {
    body: {
      message: "Reply with exactly the word: OK",
      model: MODEL,
      temperature: 0.0,
      dataset: "none",
      live: 0,
      limit_references: 0,
    },
  });
  console.log(`  status: ${q.status}`);
  console.log(`  top-level keys: [${Object.keys(q.data ?? {}).join(", ")}]`);
  console.log(redact(q.data));
  console.log("\n  ^ Whichever field holds the answer text is what lib/asksage.mjs must read.");
} else {
  head("3. POST /server/query — SKIPPED");
  console.log("  Set ASKSAGE_MODEL in .env (pick one from step 2) and re-run to see the response shape.");
}

// ── 4. File extraction ────────────────────────────────────────────────────
head("4. POST /server/file   (server-side text extraction)");
const form = new FormData();
form.append("file", new Blob([Buffer.from("Hello from the probe. This is a test document.")]), "probe.txt");
const f = await call("/server/file", { form });
console.log(`  status: ${f.status}`);
console.log(`  top-level keys: [${Object.keys(f.data ?? {}).join(", ")}]`);
console.log(redact(f.data));

head("Done");
console.log(`  Next: put the right model name in .env as ASKSAGE_MODEL, then run "npm start".
  If any field name above differs from what lib/asksage.mjs guesses, paste this output.\n`);
