// Live end-to-end run of Lading on Bradbury, with separate client, provider and third-party wallets.
//   LADING=0x... node scripts/e2e.mjs            runs every scenario, writes scripts/e2e-log.json
//   ONLY=happy,cancel LADING=0x... node ...    runs just those
//
// Scenarios (each its own engagement, run concurrently, every write confirmed by reading state back):
//   happy    the real jq 1.7.1 release (source tarball -> binary), pinned to the jq release path, with an agreed digest:
//            verify, the watch window, release refused until every link is re-checked after it and that check is FINALIZED,
//            release, settle, the provider is paid exactly once
//   agreed   the verdict is fine but is not the digest the client agreed to: verify refuses, the client reclaims the stuck submission
//   drift    a verified file is quietly replaced: the re-check records drift, the escrow refunds the client
//   stale    verified but nobody confirms it again: after the stale point anyone can trigger the even split
//   cancel   an unaccepted proposal is cancelled; a refused payable call is made with 1 wei to measure where its value goes
// Release and stale paths wait out real windows (one hour minimum) and Bradbury finality (about 30 minutes).
// Signs with the dedicated testnet wallets in C:/Users/olumi/.genlayer-test-wallets (outside every repo).
import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const LADING = process.env.LADING || "";
if (!LADING) {
  console.error("set LADING=<escrow address>");
  process.exit(1);
}
const LINEAGE = process.env.LINEAGE || "0x6508856DE231e094BfD121Eb5A30D5C3c03972A9";
const LOGFILE = process.env.E2E_LOG || "scripts/e2e-log.json";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
let STRANDED = BigInt(process.env.KNOWN_STRANDED || 0);
const RUN = Date.now().toString(36);

const JQ = "https://github.com/jqlang/jq/releases/download/jq-1.7.1";
const JQ_PIN = "https://github.com/jqlang/jq/releases/";
const JQ_AMD64 = "5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5";
const JQ_ARM64 = "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5";
const DEMO = "https://raw.githubusercontent.com/2TheMoom/lading/main/demo/";
const AMOUNT = 2000000000000000n; // 0.002 GEN
const WINDOW = 3600;
const STALE = 7200;

const WALLETS = JSON.parse(readFileSync("C:/Users/olumi/.genlayer-test-wallets/wallets.json", "utf8"));
const names = ["gl-test-1", "gl-test-2", "gl-test-3"]; // client, provider, third party
const acct = Object.fromEntries(names.map((n) => [n, createAccount(WALLETS[n].privateKey)]));
const addr = Object.fromEntries(names.map((n) => [n, WALLETS[n].address]));
const clients = Object.fromEntries(names.map((n) => [n, createClient({ chain: testnetBradbury, account: acct[n] })]));
const reader = createClient({ chain: testnetBradbury });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const plain = (x) => (x instanceof Map ? Object.fromEntries([...x].map(([k, v]) => [k, plain(v)])) : Array.isArray(x) ? x.map(plain) : typeof x === "bigint" ? x.toString() : x);
const gen = (w) => (Number(w) / 1e18).toFixed(6);

const LOG = { escrow: LADING, verifier: LINEAGE, run: RUN, started: new Date().toISOString(), events: [] };
function log(scn, msg, extra) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${scn.padEnd(8)} ${msg}`);
  LOG.events.push({ t: new Date().toISOString(), scenario: scn, msg, ...(extra || {}) });
  writeFileSync(LOGFILE, JSON.stringify(LOG, null, 1));
}

// One send at a time per wallet (a shared nonce is what made concurrent scripts clash before).
const queues = {};
function serial(who, fn) {
  const run = (queues[who] || Promise.resolve()).then(fn, fn);
  queues[who] = run.catch(() => {});
  return run;
}

async function read(address, fn, args = []) {
  for (let i = 0; ; i++) {
    try {
      return plain(await reader.readContract({ address, functionName: fn, args }));
    } catch (e) {
      if (i >= 8) throw e;
      await sleep(8000);
    }
  }
}
const eng = (id) => read(LADING, "get_engagement", [id]);

async function until(scn, what, id, pred, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const e = await eng(id);
    if (pred(e)) return e;
    await sleep(10000);
  }
  throw new Error(`${scn}: timed out waiting for ${what}`);
}

// Send, wait for ACCEPTED, return the receipt. Retries only send-time failures (nothing was submitted then).
async function send(scn, who, address, fn, args, value) {
  return serial(who, async () => {
    let hash;
    for (let a = 1; ; a++) {
      try {
        hash = await clients[who].writeContract({ address, functionName: fn, args, ...(value ? { value } : {}) });
        break;
      } catch (e) {
        if (a >= 4) throw e;
        log(scn, `${fn} send failed (${String(e.message || e).slice(0, 70)}), retry ${a}`);
        await sleep(15000);
      }
    }
    let r;
    for (let a = 1; ; a++) {
      try {
        r = await clients[who].waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 5000 });
        break;
      } catch (e) {
        if (a >= 8) throw e;
        await sleep(15000);
      }
    }
    const who2 = address === LADING ? "escrow" : "verifier";
    log(scn, `${who2}.${fn} ${hash.slice(0, 12)} exec=${r.txExecutionResultName}`, { fn, contract: who2, hash, exec: r.txExecutionResultName });
    return { hash, exec: r.txExecutionResultName, result: r.resultName };
  });
}
const esc = (scn, who, fn, args, value) => send(scn, who, LADING, fn, args, value);
const lin = (scn, who, fn, args) => send(scn, who, LINEAGE, fn, args);

// A write the contract must refuse. On Bradbury a refused PAYABLE call keeps its value, so it is counted in STRANDED.
async function expectRefused(scn, who, fn, args, value, address = LADING) {
  return serial(who, async () => {
    let hash;
    try {
      hash = await clients[who].writeContract({ address, functionName: fn, args, ...(value ? { value } : {}) });
    } catch (e) {
      log(scn, `${fn} refused before it was sent: ${String(e.message || e).slice(0, 120)}`, { fn, refused: "before send" });
      return { refused: true };
    }
    let r;
    for (let a = 1; ; a++) {
      try {
        r = await clients[who].waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 5000 });
        break;
      } catch (e) {
        if (a >= 8) throw e;
        await sleep(15000);
      }
    }
    const refused = r.txExecutionResultName !== "FINISHED_WITH_RETURN";
    if (refused && value) STRANDED += BigInt(value);
    log(scn, `${fn} ${hash.slice(0, 12)} exec=${r.txExecutionResultName}: ${refused ? "refused, as it must be" : "UNEXPECTEDLY ACCEPTED"}${refused && value ? ` (its ${value} wei stays in the contract)` : ""}`, { fn, hash, exec: r.txExecutionResultName, refused, strandedWei: refused && value ? String(value) : "0" });
    if (!refused) throw new Error(`${scn}: ${fn} should have been refused`);
    return { refused: true, hash };
  });
}

// Time from ACCEPTED to FINALIZED for one transaction.
async function finalized(scn, hash, label) {
  const t0 = Date.now();
  for (let a = 0; a < 20; a++) {
    try {
      await reader.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 400, interval: 10000 });
      const m = ((Date.now() - t0) / 60000).toFixed(1);
      log(scn, `${label} FINALIZED ${m} min after the wait began`, { label, finalizedAfterMinutes: Number(m) });
      return Number(m);
    } catch {
      await sleep(15000);
    }
  }
  throw new Error(`${scn}: ${label} did not finalize in time`);
}
const balance = async (who) => BigInt(await reader.getBalance({ address: addr[who] }));
const attId = (a, m, n, p) => read(LADING, "attestation_id", [a, m, n, p]);

// Make sure an attestation exists and is verified in the verifier's own state, and wait until that is FINAL.
async function verifiedAndFinal(scn, who, artifact, list, name, parent) {
  const id = await attId(artifact, list, name, parent);
  let a = null;
  try {
    a = await read(LINEAGE, "get_attestation", [id]);
  } catch {
    a = null;
  }
  if (!a) await lin(scn, who, "attest", [artifact, list, name, parent]);
  let hash = null;
  if (!a || a.status !== "verified") {
    const t = await lin(scn, who, "check", [id]);
    hash = t.hash;
  }
  const st = await until2(() => read(LINEAGE, "get_attestation", [id]), (x) => x.status === "verified", `${scn}: attestation ${name} verified`);
  log(scn, `verifier says ${name} is ${st.status}, digest ${st.digest.slice(0, 16)}...`, { attestation: id, digest: st.digest });
  if (hash) await finalized(scn, hash, `check of ${name}`);
  return id;
}
async function until2(getter, pred, what, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const x = await getter().catch(() => null);
    if (x && pred(x)) return x;
    await sleep(10000);
  }
  throw new Error(`timed out: ${what}`);
}

async function create(scn, id, o) {
  await esc(scn, "gl-test-1", "create_engagement", [id, addr["gl-test-2"], o.artifact, o.list, o.name, o.parent || "", o.pin, o.expected || "", o.deadline ?? now() + 4 * 3600, o.window ?? WINDOW, o.stale ?? STALE], o.amount ?? AMOUNT);
  const e0 = await until(scn, "proposed", id, (e) => e.status === "proposed");
  log(scn, `terms hash on chain ${e0.terms_hash.slice(0, 16)}..., attestation ${e0.attestation_id.slice(0, 16)}...`, { termsHash: e0.terms_hash });
  return e0;
}
async function toSubmitted(scn, id, o) {
  const e0 = await create(scn, id, o);
  await esc(scn, "gl-test-2", "accept", [id, e0.terms_hash]);
  await until(scn, "funded", id, (e) => e.status === "funded");
  await esc(scn, "gl-test-2", "submit", [id]);
  await until(scn, "submitted", id, (e) => e.status === "submitted");
}
// verify reads the verifier's FINALIZED state, so it can fail until the verdict finalizes: retry, recording every attempt
async function verifyWhenFinal(scn, id, who) {
  for (let a = 1; a <= 12; a++) {
    const t = await esc(scn, who, "verify", [id]);
    const e = await eng(id);
    if (e.status === "verified") {
      log(scn, `verified on attempt ${a}: digest ${e.digest.slice(0, 16)}..., links ${e.links}, window ends ${new Date(Number(e.window_end) * 1000).toISOString()}`, { attempt: a, digest: e.digest });
      return { t, e };
    }
    log(scn, `attempt ${a}: the verifier's finalized state does not vouch for it yet (exec ${t.exec}), waiting`);
    await sleep(300000);
  }
  throw new Error(`${scn}: never verified`);
}

const results = {};

async function happy() {
  const scn = "happy";
  const id = `lad-${RUN}-happy`;
  const art = `${JQ}/jq-linux-amd64`;
  const list = `${JQ}/sha256sum.txt`;
  const root = await verifiedAndFinal(scn, "gl-test-3", `${JQ}/jq-1.7.1.tar.gz`, list, "jq-1.7.1.tar.gz", "");
  await verifiedAndFinal(scn, "gl-test-3", art, list, "jq-linux-amd64", root);
  await toSubmitted(scn, id, { artifact: art, list, name: "jq-linux-amd64", parent: root, pin: JQ_PIN, expected: JQ_AMD64 });
  const { e } = await verifyWhenFinal(scn, id, "gl-test-3");
  const end = Number(e.window_end);
  await expectRefused(scn, "gl-test-3", "release", [id]);
  await expectRefused(scn, "gl-test-3", "refund_drift", [id]);
  const wait = end + 30 - now();
  log(scn, `watch window open until ${new Date(end * 1000).toISOString()}, waiting ${Math.ceil(wait / 60)} min`);
  if (wait > 0) await sleep(wait * 1000);
  // the check on record is from before the window closed: release must still be refused
  await expectRefused(scn, "gl-test-3", "release", [id]);
  const c1 = await lin(scn, "gl-test-3", "check", [await attId(`${JQ}/jq-1.7.1.tar.gz`, list, "jq-1.7.1.tar.gz", "")]);
  const c2 = await lin(scn, "gl-test-3", "check", [await attId(art, list, "jq-linux-amd64", root)]);
  if (c1.exec !== "FINISHED_WITH_RETURN" || c2.exec !== "FINISHED_WITH_RETURN") throw new Error(`${scn}: the post-window checks did not record`);
  await expectRefused(scn, "gl-test-3", "release", [id]); // recorded but not final yet: still refused
  await finalized(scn, c1.hash, "post-window check of the source");
  await finalized(scn, c2.hash, "post-window check of the build");
  const before = await balance("gl-test-2");
  let released = false;
  for (let a = 1; a <= 6 && !released; a++) {
    const t = await esc(scn, "gl-test-3", "release", [id]);
    released = (await eng(id)).status === "decided";
    if (!released) {
      log(scn, `release attempt ${a} not accepted (exec ${t.exec}), waiting`);
      await sleep(120000);
    }
  }
  if (!released) throw new Error(`${scn}: release never recorded`);
  const acc0 = await read(LADING, "get_accounting");
  const st = await esc(scn, "gl-test-3", "settle", [id]);
  const done = await until(scn, "settled", id, (x) => x.status === "settled");
  await finalized(scn, st.hash, "settle");
  await expectRefused(scn, "gl-test-3", "settle", [id]);
  const after = await balance("gl-test-2");
  log(scn, `provider balance ${gen(before)} -> ${gen(after)} (escrow = ${gen(AMOUNT)}); outcome ${done.outcome}/${done.reason}; scheduled before settle ${acc0.total_scheduled}`, { before: before.toString(), after: after.toString() });
  results.happy = { status: done.status, outcome: done.outcome, providerDelta: (after - before).toString() };
}

async function agreed() {
  const scn = "agreed";
  const id = `lad-${RUN}-agreed`;
  const art = `${JQ}/jq-linux-amd64`;
  const list = `${JQ}/sha256sum.txt`;
  const root = await attId(`${JQ}/jq-1.7.1.tar.gz`, list, "jq-1.7.1.tar.gz", "");
  // the client agreed to the ARM digest; the publisher's list, the bytes and the verifier all agree on the AMD64 build
  const deadline = now() + 900;
  await toSubmitted(scn, id, { artifact: art, list, name: "jq-linux-amd64", parent: root, pin: JQ_PIN, expected: JQ_ARM64, deadline });
  await expectRefused(scn, "gl-test-3", "verify", [id]);
  if ((await eng(id)).status !== "submitted") throw new Error(`${scn}: a different digest than the agreed one verified`);
  const stale = deadline + STALE + 30;
  await expectRefused(scn, "gl-test-1", "reclaim_stale", [id]);
  log(scn, `stuck submission, recoverable at ${new Date(stale * 1000).toISOString()}, waiting ${Math.ceil((stale - now()) / 60)} min`);
  await sleep(Math.max(0, stale - now()) * 1000);
  await expectRefused(scn, "gl-test-3", "reclaim_stale", [id]); // only the client may reclaim a stuck submission
  const before = await balance("gl-test-1");
  const t = await esc(scn, "gl-test-1", "reclaim_stale", [id]);
  const done = await until(scn, "settled", id, (x) => x.status === "settled");
  await finalized(scn, t.hash, "reclaim_stale");
  log(scn, `refunded: outcome ${done.outcome}/${done.reason}; client balance ${gen(before)} -> ${gen(await balance("gl-test-1"))} (before its own gas)`);
  results.agreed = { status: done.status, outcome: done.outcome, reason: done.reason };
}

async function drift() {
  const scn = "drift";
  const id = `lad-${RUN}-drift`;
  const name = "pack-drift.txt";
  const art = DEMO + name;
  const list = DEMO + "SHA256SUMS";
  await verifiedAndFinal(scn, "gl-test-3", art, list, name, "");
  await toSubmitted(scn, id, { artifact: art, list, name, parent: "", pin: DEMO });
  await verifyWhenFinal(scn, id, "gl-test-3");
  await expectRefused(scn, "gl-test-3", "refund_drift", [id]); // still checks out
  // the provider quietly replaces the file after it was verified
  writeFileSync("demo/pack-drift.txt", "Lading demo artifact for the drift scenario, REPLACED after verification\nThis is not what was verified.\n");
  const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
  git("add", "demo/pack-drift.txt");
  git("commit", "-m", `E2E ${RUN}: the verified file is replaced`);
  const push = git("push", "origin", "main");
  log(scn, `file replaced and pushed (exit ${push.status}); waiting for the raw cache to expire`);
  await sleep(330000);
  const c = await lin(scn, "gl-test-3", "check", [await attId(art, list, name, "")]);
  const a = await read(LINEAGE, "get_attestation", [await attId(art, list, name, "")]);
  log(scn, `the verifier now says ${a.status}; committed ${a.digest.slice(0, 16)}..., now ${String(a.last_digest).slice(0, 16)}...`, { status: a.status });
  if (a.status !== "drifted") throw new Error(`${scn}: the re-check did not record drift`);
  await expectRefused(scn, "gl-test-3", "refund_drift", [id]); // the drift is recorded but not final yet: refuse
  await finalized(scn, c.hash, "re-check that recorded the drift");
  let decided = false;
  for (let k = 1; k <= 6 && !decided; k++) {
    const t = await esc(scn, "gl-test-3", "refund_drift", [id]);
    decided = (await eng(id)).status === "decided";
    if (!decided) {
      log(scn, `refund_drift attempt ${k} not accepted (exec ${t.exec}), waiting`);
      await sleep(120000);
    }
  }
  if (!decided) throw new Error(`${scn}: refund_drift never recorded`);
  const before = await balance("gl-test-1");
  const st = await esc(scn, "gl-test-3", "settle", [id]);
  const done = await until(scn, "settled", id, (x) => x.status === "settled");
  await finalized(scn, st.hash, "settle");
  log(scn, `refunded after drift: outcome ${done.outcome}/${done.reason}; client balance ${gen(before)} -> ${gen(await balance("gl-test-1"))}`);
  results.drift = { status: done.status, outcome: done.outcome, reason: done.reason };
}

async function stale() {
  const scn = "stale";
  const id = `lad-${RUN}-stale`;
  const name = "pack-stale.txt";
  const art = DEMO + name;
  const list = DEMO + "SHA256SUMS";
  await verifiedAndFinal(scn, "gl-test-3", art, list, name, "");
  await toSubmitted(scn, id, { artifact: art, list, name, parent: "", pin: DEMO });
  const { e } = await verifyWhenFinal(scn, id, "gl-test-3");
  const end = Number(e.window_end);
  const staleAt = Number(e.stale_at);
  await expectRefused(scn, "gl-test-3", "reclaim_stale", [id]);
  await sleep(Math.max(0, end + 30 - now()) * 1000);
  await expectRefused(scn, "gl-test-3", "release", [id]); // nobody re-checked after the window
  log(scn, `nobody confirms it again; stale point ${new Date(staleAt * 1000).toISOString()}, waiting ${Math.ceil((staleAt + 30 - now()) / 60)} min`);
  await sleep(Math.max(0, staleAt + 30 - now()) * 1000);
  const p0 = await balance("gl-test-2");
  const c0 = await balance("gl-test-1");
  const t = await esc(scn, "gl-test-3", "reclaim_stale", [id]);
  const done = await until(scn, "settled", id, (x) => x.status === "settled");
  await finalized(scn, t.hash, "reclaim_stale (even split)");
  const p1 = await balance("gl-test-2");
  const c1 = await balance("gl-test-1");
  log(scn, `split: outcome ${done.outcome}/${done.reason}; provider +${gen(p1 - p0)} (half = ${gen(AMOUNT / 2n)}), client +${gen(c1 - c0)} (half, before its own gas)`, { providerDelta: (p1 - p0).toString(), clientDelta: (c1 - c0).toString() });
  results.stale = { status: done.status, outcome: done.outcome, reason: done.reason, providerDelta: (p1 - p0).toString() };
}

async function cancel() {
  const scn = "cancel";
  const art = `${JQ}/jq-linux-amd64`;
  const list = `${JQ}/sha256sum.txt`;
  // 1. a refused payable call: the pin is not a prefix of the list. Measure where its 1 wei goes.
  const bad = [`lad-${RUN}-bad`, addr["gl-test-2"], art, list, "jq-linux-amd64", "", "https://example.org/other/", "", now() + 4 * 3600, WINDOW, STALE];
  const before = await read(LADING, "get_engagement_count");
  await expectRefused(scn, "gl-test-1", "create_engagement", bad, 1n);
  if ((await read(LADING, "get_engagement_count")) !== before) throw new Error(`${scn}: a refused creation was stored`);
  // 2. an unaccepted proposal is cancelled by its client, and only by its client
  const id = `lad-${RUN}-cancel`;
  await create(scn, id, { artifact: art, list, name: "jq-linux-amd64", parent: "", pin: JQ_PIN });
  await expectRefused(scn, "gl-test-2", "reclaim_timeout", [id]);
  await expectRefused(scn, "gl-test-3", "reclaim_timeout", [id]);
  const t = await esc(scn, "gl-test-1", "reclaim_timeout", [id]);
  const done = await until(scn, "settled", id, (x) => x.status === "settled");
  await expectRefused(scn, "gl-test-1", "reclaim_timeout", [id]);
  await finalized(scn, t.hash, "reclaim_timeout");
  results.cancel = { status: done.status, outcome: done.outcome, reason: done.reason };
}

const all = { happy, agreed, drift, stale, cancel };
const order = Object.keys(all).filter((k) => !ONLY || ONLY.includes(k));
const settled = await Promise.allSettled(order.map((k) => all[k]()));
settled.forEach((s, i) => {
  if (s.status === "rejected") log(order[i], `FAILED: ${String(s.reason?.message || s.reason).slice(0, 900)}`);
});
LOG.results = results;
LOG.accounting = await read(LADING, "get_accounting");
{
  const a = LOG.accounting;
  // value a refused payable call left behind is in neither total; it is the only surplus allowed
  const ok = Number(a.shortfall) === 0 && BigInt(a.in_flight) === STRANDED && BigInt(a.balance) === BigInt(a.unscheduled) + STRANDED;
  LOG.strandedWei = STRANDED.toString();
  LOG.accountingOk = ok;
  log("account", ok ? `OK: nothing short, nothing in flight; the only surplus is ${STRANDED} wei kept from refused payable calls` : `MISMATCH (stranded ${STRANDED}): ${JSON.stringify(a)}`);
}
LOG.finished = new Date().toISOString();
writeFileSync(LOGFILE, JSON.stringify(LOG, null, 1));
console.log("\nRESULTS", JSON.stringify(results, null, 1), "\nACCOUNTING", JSON.stringify(LOG.accounting));
