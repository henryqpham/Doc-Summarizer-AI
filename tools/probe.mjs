// ─────────────────────────────────────────────────────────────────────────
//  PROBE — discovers what we can't look up.
//
//  Ask Sage's response schemas aren't publicly documented (docs site is an SPA,
//  SwaggerHub 404s). Rather than guess field names, this asks the live API and
//  prints the RAW JSON. It answers:
//    0. Is ASKSAGE_EMAIL actually required, or does the key alone work?
//    1. Does auth work, and what field holds the token?
//    2. What models can this account use?   -> ASKSAGE_MODEL
//    3. What does /server/query return?     -> pins down the parser
//    4. Does /server/file extract text?
//
//  Run:  npm run probe
//  Needs only ASKSAGE_BASE_URL + ASKSAGE_API_KEY. Email is optional on purpose:
//  step 0 exists to find out whether it's needed at all.
// ─────────────────────────────────────────────────────────────────────────
import { loadEnv, requireVars, requireUrl } from "../lib/env.mjs";

let BASE;
try {
  const source = loadEnv(["ASKSAGE_BASE_URL", "ASKSAGE_API_KEY"]);
  requireVars(["ASKSAGE_BASE_URL", "ASKSAGE_API_KEY"], source);
  BASE = requireUrl("ASKSAGE_BASE_URL");
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

const EMAIL = (process.env.ASKSAGE_EMAIL || "").trim();
const KEY = (process.env.ASKSAGE_API_KEY || "").trim();
const MODEL = (process.env.ASKSAGE_MODEL || "").trim();

let TOKEN = null;

/** Never print the live token or the API key, even in a debug dump. */
function redact(value) {
  let out = JSON.stringify(value, null, 2) ?? "undefined";
  if (TOKEN) out = out.split(TOKEN).join("<REDACTED-TOKEN>");
  if (KEY) out = out.split(KEY).join("<REDACTED-KEY>");
  return out;
}

function head(title) {
  console.log(`\n${"─".repeat(72)}\n  ${title}\n${"─".repeat(72)}`);
}

async function call(path, { form, body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers["x-access-tokens"] = token;
  if (!form) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: form ?? JSON.stringify(body ?? {}),
    });
  } catch (err) {
    // A network/DNS failure is a config problem, not a crash. Say so plainly.
    const why = err?.cause?.code === "ENOTFOUND" ? `Host not found — is ASKSAGE_BASE_URL right?` : err?.cause?.message || err.message;
    console.error(`\n  Could not reach ${BASE}${path}\n\n      ${why}\n`);
    process.exit(1);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { __nonJsonBody: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, data };
}

console.log(`\n  Instance: ${BASE}`);
console.log(`  Email:    ${EMAIL || "(not set — testing key-only auth)"}`);

// ── 0. Is the email actually required? ────────────────────────────────────
head("0. Is ASKSAGE_EMAIL required?   (trying the API key directly as a token)");
const keyOnly = await call("/server/get-models", { token: KEY });
console.log(`  status: ${keyOnly.status}`);

if (keyOnly.ok) {
  TOKEN = KEY;
  console.log(`
  ✔ KEY-ONLY AUTH WORKS. The API key is accepted directly as a token.
    ASKSAGE_EMAIL is not needed — you were right.`);
} else {
  console.log(`
  ✘ Rejected (${keyOnly.status}). The key alone is not accepted as a token.
    Ask Sage requires the documented email + api_key -> token exchange.`);
  console.log(redact(keyOnly.data));
}

// ── 1. Token exchange ─────────────────────────────────────────────────────
if (!TOKEN) {
  if (!EMAIL) {
    head("1. POST /user/get-token-with-api-key — CANNOT RUN");
    console.log(`  Key-only auth failed above, and ASKSAGE_EMAIL isn't set, so there's
  no way to authenticate. Add your Ask Sage account email to .env:

      ASKSAGE_EMAIL=you@youragency.gov

  then re-run "npm run probe".`);
    process.exit(1);
  }

  head("1. POST /user/get-token-with-api-key");
  const auth = await call("/user/get-token-with-api-key", { body: { email: EMAIL, api_key: KEY }, token: null });
  console.log(`  status: ${auth.status}`);
  console.log(`  top-level keys: [${Object.keys(auth.data ?? {}).join(", ")}]`);
  console.log(redact(auth.data));

  if (!auth.ok) {
    console.error(`\n  Auth failed. Check the email/key. Note a .env saved as CRLF or with a
  UTF-8 BOM can corrupt the key and produce a 401 that looks like a wrong key.\n`);
    process.exit(1);
  }

  const flat = { ...(auth.data ?? {}), ...(auth.data?.response ?? {}) };
  TOKEN = [flat.access_token, flat.token, flat.accessToken, auth.data?.response].find(
    (v) => typeof v === "string" && v.length > 20
  );

  if (!TOKEN) {
    console.error("\n  200 OK but no token field spotted above. Paste this output and it'll be pinned down.\n");
    process.exit(1);
  }
  console.log(`\n  ✔ Token acquired (${TOKEN.length} chars).`);
} else {
  head("1. Token exchange — SKIPPED (not needed, key-only auth works)");
}

// ── 2. Models ─────────────────────────────────────────────────────────────
head("2. POST /server/get-models   ← your ASKSAGE_MODEL comes from here");
const models = keyOnly.ok ? keyOnly : await call("/server/get-models");
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
  console.log("  Pick a model from step 2, set ASKSAGE_MODEL in .env, and re-run to see the response shape.");
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
console.log(`  Next: set ASKSAGE_MODEL in .env from step 2, then run "npm start".
  Paste this output if any field name differs from what lib/asksage.mjs guesses.\n`);
