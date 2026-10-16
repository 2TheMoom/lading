/** Mirrors the constants and input rules in contracts/lading.py; a test fails if they drift apart. */
export const MIN_WINDOW = 3600;
export const MAX_WINDOW = 7 * 86400;
export const MAX_AHEAD = 730 * 86400;
export const MIN_STALE = 7200;
export const MAX_STALE = 30 * 86400;
export const MAX_URL = 300;
export const MAX_NAME = 200;
export const NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+@=,-~";
const LABEL = "abcdefghijklmnopqrstuvwxyz0123456789-";
const INTERNAL = ["local", "internal", "lan", "localhost", "home", "corp", "intranet", "localdomain", "arpa"];

/** What the contract stores for a URL: the fragment is dropped. */
export function normalizeUrl(u: string): string {
  return u.split("#", 1)[0];
}

/**
 * Why a URL would be refused by create_engagement (and by the verifier), or null when it is fine.
 * A refused payable call keeps its value on Bradbury, so everything the contract checks is checked here first.
 */
export function urlProblem(u: string): string | null {
  if (!u.startsWith("https://") || u.length > MAX_URL) return `The URL must start with https:// and be at most ${MAX_URL} characters.`;
  // \s plus the separators Python's str.isspace() adds (U+001C to U+001F, U+0085): stricter is safe, looser would strand funds.
  if (/[\s\u001c-\u001f\u0085"'<>\\`|]/.test(u)) return "The URL has a character the contract refuses.";
  const host = u.slice(8).split("/")[0].split("?")[0].split("#")[0].toLowerCase();
  if (host.includes("@") || host.includes(":")) return "The URL may not contain credentials or a port.";
  const parts = host.split(".");
  const last = parts[parts.length - 1];
  if (parts.length < 2 || INTERNAL.includes(last) || !/[a-z]/.test(last)) return "The URL host must be a public domain name.";
  for (const p of parts) {
    if (p.length < 1 || p.length > 63 || p.startsWith("-") || p.endsWith("-") || [...p].some((c) => !LABEL.includes(c))) {
      return "The URL host is not a valid domain name.";
    }
  }
  return null;
}

export function nameProblem(n: string): string | null {
  if (n.length < 1 || n.length > MAX_NAME) return `The filename must be 1 to ${MAX_NAME} characters.`;
  if ([...n].some((c) => !NAME_CHARS.includes(c)) || n.startsWith(".")) return "The filename may use letters, digits and . _ + @ = , - ~ only.";
  return null;
}

/** "" for none, else the verifier's 64 lowercase hex id. */
export function parentProblem(p: string): string | null {
  if (p === "") return null;
  return /^[0-9a-f]{64}$/.test(p) ? null : "The source must be empty or a 64 digit lowercase hex attestation id.";
}

/** "" to let the publisher's list decide, else a 64 digit lowercase sha256. */
export function digestProblem(d: string): string | null {
  if (d === "") return null;
  return /^[0-9a-f]{64}$/.test(d) ? null : "An agreed digest must be empty or 64 lowercase hex digits.";
}

/** The pin is an https prefix ending in a slash, and the checksum list must live under it. */
export function pinProblem(pin: string, list: string): string | null {
  const bad = urlProblem(pin);
  if (bad) return bad;
  if (normalizeUrl(pin) !== pin || !pin.endsWith("/")) return "The publisher pin must be an https address ending in /.";
  if (!normalizeUrl(list).startsWith(pin)) return "The checksum list must live under the publisher pin.";
  return null;
}

export function timesProblem(deadline: number, window: number, stale: number, now: number): string | null {
  if (!Number.isInteger(deadline) || !Number.isInteger(window) || !Number.isInteger(stale)) return "Times must be whole numbers.";
  if (deadline <= now) return "The ship-by time must be in the future.";
  if (deadline > now + MAX_AHEAD) return "The ship-by time must be within two years.";
  if (window < MIN_WINDOW || window > MAX_WINDOW) return `The watch window must be ${MIN_WINDOW / 3600} hour to ${MAX_WINDOW / 86400} days.`;
  if (stale < MIN_STALE || stale > MAX_STALE) return `Stuck-case recovery must be ${MIN_STALE / 3600} hours to ${MAX_STALE / 86400} days.`;
  return null;
}

/** GEN amount for display. Small amounts keep their precision. */
export function formatGen(wei: string): string {
  const n = Number(wei) / 1e18;
  if (!Number.isFinite(n) || n === 0) return "0.000";
  const text = n >= 1 ? n.toFixed(3) : n.toFixed(9).replace(/0+$/, "");
  const [whole, frac = ""] = text.split(".");
  return `${whole}.${frac.padEnd(3, "0")}`;
}

/** 0xab12…cd34 style shortening for ids and hashes. */
export function short(s: string, head = 8, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
