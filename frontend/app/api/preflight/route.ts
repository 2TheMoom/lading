import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { nameProblem, normalizeUrl, urlProblem } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Preflight: download the artifact and the publisher's list the way the validators will, so a bad request is
 * caught BEFORE money is sent (on Bradbury a refused payable call keeps its value). It answers one question:
 * would the verifier call this file verified, mismatch, unlisted, or could it not be read?
 *
 * Safety: only https URLs that pass the contract's own URL rules; every redirect hop is re-checked; the host must
 * resolve to public addresses only; hard caps on bytes and time; a small per-client rate limit. The answer is advisory:
 * the contract and the validators decide.
 */

const MAX_ARTIFACT = 4_000_000; // the verifier's limit
const MAX_LIST = 500_000;
const MAX_HOPS = 5;
const TIMEOUT_MS = 12_000;
const HEADERS = { Accept: "application/octet-stream,text/plain,*/*", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const ENTRY = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/;

const hits = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 12;
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("::ffff:");
}

/**
 * The URLs the contract stores follow the contract's rules (checked on entry). A redirect target is not stored, so it
 * only has to be a plain https address on a public host: release downloads redirect to long signed URLs.
 */
async function assertPublic(url: string, entry: boolean): Promise<void> {
  if (entry) {
    const bad = urlProblem(url);
    if (bad) throw new Error(bad);
  }
  const u = new URL(url);
  if (u.protocol !== "https:" || u.port || u.username || u.password) throw new Error("Only plain https addresses are followed.");
  if (isIP(u.hostname.replace(/^\[|\]$/g, "")) !== 0) throw new Error("An address, not a domain name, was given.");
  const addrs = await lookup(u.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => privateAddress(a.address))) throw new Error("The host does not resolve to a public address.");
}

interface Fetched {
  ok: boolean;
  status: number;
  size: number;
  tooLarge: boolean;
  digest: string;
  text: string;
}

/** Download up to maxBytes, following redirects by hand so every hop is validated. */
async function fetchLimited(start: string, maxBytes: number, wantText: boolean): Promise<Fetched> {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublic(url, hop === 0);
    const res = await fetch(url, { method: "GET", headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("A redirect had no destination.");
      url = new URL(loc, url).toString();
      continue;
    }
    if (res.status !== 200 || !res.body) return { ok: false, status: res.status, size: 0, tooLarge: false, digest: "", text: "" };
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: true, status: 200, size, tooLarge: true, digest: "", text: "" };
      }
      hash.update(value);
      if (wantText) chunks.push(value);
    }
    const text = wantText ? Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") : "";
    return { ok: size > 0, status: 200, size, tooLarge: false, digest: size > 0 ? hash.digest("hex") : "", text };
  }
  throw new Error("Too many redirects.");
}

function listedDigests(text: string, name: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    if (raw.length > 1000) continue;
    const m = ENTRY.exec(raw.replace(/\s+$/, ""));
    if (!m) continue;
    const n = m[2].startsWith("./") ? m[2].slice(2) : m[2];
    if (n === name) out.add(m[1].toLowerCase());
  }
  return [...out].sort();
}

export type PreflightVerdict = "match" | "mismatch" | "unlisted" | "unreadable" | "too_large";

export interface PreflightItem {
  name: string;
  verdict: PreflightVerdict;
  size: number;
  computed: string;
  listed: string[];
  note: string;
}

async function one(artifact: string, list: Fetched, name: string): Promise<PreflightItem> {
  const listed = listedDigests(list.text, name);
  let art: Fetched;
  try {
    art = await fetchLimited(artifact, MAX_ARTIFACT, false);
  } catch (e: any) {
    return { name, verdict: "unreadable", size: 0, computed: "", listed, note: String(e?.message || e).slice(0, 160) };
  }
  if (!art.ok) return { name, verdict: "unreadable", size: 0, computed: "", listed, note: `The artifact returned HTTP ${art.status}, or was empty.` };
  if (art.tooLarge) return { name, verdict: "too_large", size: art.size, computed: "", listed, note: "The file is too large to be read in full, so the verifier would refuse it." };
  if (listed.length === 0) return { name, verdict: "unlisted", size: art.size, computed: art.digest, listed, note: "The publisher's list does not name this filename." };
  if (listed.length > 1) return { name, verdict: "mismatch", size: art.size, computed: art.digest, listed, note: "The list names this file with different digests." };
  if (listed[0] !== art.digest) return { name, verdict: "mismatch", size: art.size, computed: art.digest, listed, note: "The file's digest is not the one the publisher lists." };
  return { name, verdict: "match", size: art.size, computed: art.digest, listed, note: "The file matches the publisher's list." };
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return NextResponse.json({ error: "Too many checks, wait a minute." }, { status: 429 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }
  const list = typeof body?.list === "string" ? normalizeUrl(body.list) : "";
  const items: { artifact: string; name: string }[] = Array.isArray(body?.items) ? body.items.slice(0, 3) : [];
  if (!list || items.length === 0) return NextResponse.json({ error: "Give a list and at least one item." }, { status: 400 });
  for (const it of items) {
    const bad = urlProblem(normalizeUrl(String(it?.artifact ?? ""))) || nameProblem(String(it?.name ?? ""));
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  }
  const listBad = urlProblem(list);
  if (listBad) return NextResponse.json({ error: listBad }, { status: 400 });

  let listed: Fetched;
  try {
    listed = await fetchLimited(list, MAX_LIST, true);
  } catch (e: any) {
    return NextResponse.json({ list: { readable: false, note: String(e?.message || e).slice(0, 160) }, items: [] });
  }
  if (!listed.ok || listed.tooLarge) {
    return NextResponse.json({ list: { readable: false, note: listed.tooLarge ? "The checksum list is too large to be read in full." : `The list returned HTTP ${listed.status}, or was empty.` }, items: [] });
  }
  const results: PreflightItem[] = [];
  for (const it of items) results.push(await one(normalizeUrl(it.artifact), listed, it.name));
  return NextResponse.json({ list: { readable: true, note: "" }, items: results });
}
