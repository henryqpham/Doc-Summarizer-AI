// ─────────────────────────────────────────────────────────────────────────
//  Env loading with diagnostics that actually tell you what's wrong.
//
//  Config can come from a .env file OR from the real environment. The failure
//  modes are different and must not be collapsed into one vague message:
//    - .env doesn't exist
//    - .env exists but can't be parsed
//    - .env loaded fine but a value is empty
//    - .env has a UTF-8 BOM (a classic Windows gotcha that corrupts key #1)
// ─────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_PATH = join(process.cwd(), ".env");

/** Loads .env if present. Returns a short description of where config came from. */
export function loadEnv(required) {
  if (!existsSync(ENV_PATH)) {
    // No file — that's fine IF the values are already in the environment.
    const haveSome = required.some((n) => (process.env[n] || "").trim());
    if (haveSome) return "the environment";
    throw new Error(
      `No .env file found.\n\n` +
        `  Looked for:  ${ENV_PATH}\n\n` +
        `  Create it from the template:\n\n` +
        `      Copy-Item .env.example .env\n\n` +
        `  Then open .env and fill in your values.`
    );
  }

  // A UTF-8 BOM makes the FIRST key parse as "﻿ASKSAGE_EMAIL" — the value
  // silently never lands. PowerShell's Set-Content and Notepad both do this.
  const raw = readFileSync(ENV_PATH);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new Error(
      `Your .env starts with a UTF-8 BOM, which corrupts the first setting.\n\n` +
        `  Re-save it without a BOM. In PowerShell:\n\n` +
        `      $t = Get-Content .env -Raw\n` +
        `      [IO.File]::WriteAllText("$PWD\\.env", $t)\n`
    );
  }

  try {
    process.loadEnvFile(ENV_PATH);
  } catch (err) {
    throw new Error(`Found .env but could not read it:\n\n  ${err.message}`);
  }
  return ENV_PATH;
}

/**
 * Validates a URL setting and returns it normalised (no trailing slash).
 * Catches the two things that actually happen: an unreplaced <placeholder>,
 * and a value that isn't a URL at all. Either must fail here with a readable
 * message, not later inside fetch() as an ERR_INVALID_URL stack trace.
 */
export function requireUrl(name) {
  const raw = (process.env[name] || "").trim();

  if (/[<>]/.test(raw)) {
    throw new Error(
      `${name} still has a placeholder in it:\n\n` +
        `      ${raw}\n\n` +
        `  Replace the <...> part with your real Ask Sage host.\n` +
        `  It's the site you log into, with "chat." swapped for "api." —\n` +
        `  e.g. if you use https://chat.asksage.ai then:\n\n` +
        `      ${name}=https://api.asksage.ai`
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL:\n\n      ${raw}\n\n  Expected something like https://api.asksage.ai`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must start with https:// — got "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

/** Throws a per-variable checklist rather than a flat "you need X, Y, Z". */
export function requireVars(required, source) {
  const missing = required.filter((n) => !(process.env[n] || "").trim());
  if (!missing.length) return;

  const lines = required.map((n) => {
    const set = Boolean((process.env[n] || "").trim());
    return `      ${set ? "[ok]     " : "[MISSING]"} ${n}`;
  });

  throw new Error(
    `Some required settings are empty.\n\n` +
      `  Read from: ${source}\n\n` +
      lines.join("\n") +
      `\n\n  Open .env and fill in the ones marked MISSING.` +
      `\n  (No quotes around values, no trailing spaces.)`
  );
}
