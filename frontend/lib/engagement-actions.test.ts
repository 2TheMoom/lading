import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeAttestation, decodeChain, decodeEngagement } from "./contracts/decode.ts";
import type { ChainLink, Engagement } from "./contracts/types.ts";
import { availableActions, driftedLinks, expectedStatus, finalStatus, linksNeedingCheck, movesFunds, releaseBlocker, staleKind, staleSplitBlocker, windowOpen } from "./engagement-actions.ts";
import { failedReceiptMessage, isContractRefusal } from "./receipt.ts";
import { MAX_AHEAD, MAX_NAME, MAX_STALE, MAX_URL, MAX_WINDOW, MIN_STALE, MIN_WINDOW, NAME_CHARS, digestProblem, formatGen, nameProblem, normalizeUrl, parentProblem, pinProblem, short, timesProblem, urlProblem } from "./limits.ts";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const T = 1_800_000_000;
const HOUR = 3600;
const DIGEST = "ab".repeat(32);

function engagement(over: Partial<Engagement>): Engagement {
  return {
    client: CLIENT, provider: PROVIDER,
    artifact_url: "https://dl.example.com/releases/app", manifest_url: "https://dl.example.com/releases/SUMS", filename: "app",
    parent: "", pin: "https://dl.example.com/releases/", expected: "", attestation_id: "cd".repeat(32),
    amount: "1000", deadline: String(T + 86400), window: String(HOUR), stale_after: String(2 * HOUR),
    status: "funded", outcome: "", reason: "", submitted_at: "0", verified_at: "0", decided_at: "0",
    digest: "", links: "0", window_end: "0", stale_at: "0", terms_hash: "ef".repeat(32),
    ...over,
  };
}
const verified = (over: Partial<Engagement> = {}) => engagement({ status: "verified", verified_at: String(T), window_end: String(T + HOUR), stale_at: String(T + 3 * HOUR), digest: DIGEST, links: "1", ...over });
const link = (over: Partial<ChainLink> = {}): ChainLink => ({ id: "cd".repeat(32), filename: "app", status: "verified", digest: DIGEST, checked_at: String(T), artifact_url: "", manifest_url: "", ...over });

describe("limits and rules match the contract", () => {
  const source = readFileSync(new URL("../../contracts/lading.py", import.meta.url), "utf8");
  const constant = (name: string) => {
    const m = source.match(new RegExp(`^${name}\\s*=\\s*([0-9_ *]+)`, "m"));
    assert.ok(m, `${name} not found in the contract`);
    return m[1].replace(/_/g, "").split("*").reduce((a, b) => a * Number(b.trim()), 1);
  };
  it("every constant the form validates against is the contract's", () => {
    assert.equal(MIN_WINDOW, constant("MIN_WINDOW"));
    assert.equal(MAX_WINDOW, constant("MAX_WINDOW"));
    assert.equal(MIN_STALE, constant("MIN_STALE"));
    assert.equal(MAX_AHEAD, constant("MAX_AHEAD"));
    assert.equal(MAX_STALE, constant("MAX_STALE"));
    assert.equal(MAX_URL, constant("MAX_URL"));
    assert.equal(MAX_NAME, constant("MAX_NAME"));
  });
  it("the filename alphabet is the contract's", () => {
    const m = source.match(/^NAME_CHARS = "([^"]+)"/m);
    assert.ok(m);
    assert.equal(NAME_CHARS, m[1]);
  });
  it("the watch window is longer than the ~30 minute finality measured on Bradbury", () => {
    assert.ok(MIN_WINDOW >= 2 * 30 * 60);
  });
});

describe("validation mirrors the contract", () => {
  it("refuses the urls the contract refuses", () => {
    const bad = ["http://a.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://a.com:8080/x", "https://u:p@a.com/x", "https://printer.local/x", "https://nodots/x",
      "https://a.com/a|b", "https://a.com/a b", "https://a.com/a\u001cb", "https://a.com/a\u0085b", "https://-bad.example.com/x", "https://exa_mple.com/x", "https://a.com/" + "a".repeat(300)];
    for (const u of bad) assert.ok(urlProblem(u), u);
    for (const u of ["https://raw.githubusercontent.com/o/r/main/SUMS", "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64", "https://DL.Example.COM/x#frag"]) {
      assert.equal(urlProblem(u), null, u);
    }
  });
  it("judges the whole pasted URL, fragment included, because the contract checks it before dropping the fragment", () => {
    for (const u of ["https://a.com/x#has space", "https://a.com/x#a|b", "https://a.com/x#" + "f".repeat(300)]) assert.ok(urlProblem(u), u);
    assert.equal(urlProblem("https://a.com/x#frag"), null);
  });
  it("drops the fragment like the contract does", () => {
    assert.equal(normalizeUrl("https://a.com/x#frag"), "https://a.com/x");
  });
  it("filenames", () => {
    for (const n of ["", ".hidden", "has space", "a/b", "x".repeat(201)]) assert.ok(nameProblem(n), n);
    for (const n of ["jq-linux-amd64", "app_1.0+build~2.tar.gz", "a@b=c,d"]) assert.equal(nameProblem(n), null, n);
  });
  it("source ids and agreed digests are 64 lowercase hex or empty", () => {
    for (const bad of ["ab".repeat(31), "AB".repeat(32), "zz".repeat(32), "0x" + "ab".repeat(31)]) {
      assert.ok(parentProblem(bad), bad);
      assert.ok(digestProblem(bad), bad);
    }
    assert.equal(parentProblem(""), null);
    assert.equal(digestProblem(""), null);
    assert.equal(parentProblem(DIGEST), null);
    assert.equal(digestProblem(DIGEST), null);
  });
  it("the pin ends in a slash and the list lives under it", () => {
    const list = "https://dl.example.com/releases/SUMS";
    assert.equal(pinProblem("https://dl.example.com/releases/", list), null);
    assert.equal(pinProblem("https://dl.example.com/", list), null);
    for (const bad of ["https://dl.example.com/releases", "https://other.example.org/releases/", "http://dl.example.com/releases/", "https://dl.example.com/releases/#x/", "https://dl.example.com.evil.net/"]) {
      assert.ok(pinProblem(bad, list), bad);
    }
  });
  it("times", () => {
    assert.equal(timesProblem(T + 10, MIN_WINDOW, MIN_STALE, T), null);
    assert.equal(timesProblem(T + MAX_AHEAD, MIN_WINDOW, MIN_STALE, T), null);
    for (const [d, w, s] of [[T, MIN_WINDOW, MIN_STALE], [T + 10, MIN_WINDOW - 1, MIN_STALE], [T + 10, MAX_WINDOW + 1, MIN_STALE], [T + 10, MIN_WINDOW, MIN_STALE - 1], [T + 10, MIN_WINDOW, MAX_STALE + 1], [T + 10, 3600.5, MIN_STALE], [T + MAX_AHEAD + 1, MIN_WINDOW, MIN_STALE]]) {
      assert.ok(timesProblem(d, w, s, T), `${d} ${w} ${s}`);
    }
  });
});

describe("decoding", () => {
  it("decodes an engagement from the Map genlayer-js returns", () => {
    const e = decodeEngagement(new Map<string, unknown>([["status", "decided"], ["outcome", "client"], ["amount", 1000n], ["window_end", 1_800_003_600n], ["expected", DIGEST], ["terms_hash", "cd".repeat(32)]]));
    assert.equal(e.status, "decided");
    assert.equal(e.outcome, "client");
    assert.equal(e.amount, "1000");
    assert.equal(e.window_end, "1800003600");
    assert.equal(e.expected, DIGEST);
    assert.equal(e.terms_hash, "cd".repeat(32));
  });
  it("falls back to safe defaults", () => {
    const e = decodeEngagement(new Map());
    assert.equal(e.status, "proposed");
    assert.equal(e.outcome, "");
    assert.equal(e.expected, "");
    assert.equal(e.terms_hash, "");
  });
  it("decodes the verifier's chain and attestation", () => {
    const chain = decodeChain([new Map<string, unknown>([["id", "x"], ["status", "drifted"], ["checked_at", 42n]]), { id: "y", status: "verified" }]);
    assert.deepEqual(chain.map((c) => [c.id, c.status, c.checked_at]), [["x", "drifted", "42"], ["y", "verified", "0"]]);
    assert.deepEqual(decodeChain(null), []);
    const a = decodeAttestation(new Map<string, unknown>([["status", "verified"], ["digest", DIGEST], ["checks", 2n], ["last_digest", ""]]));
    assert.equal(a.status, "verified");
    assert.equal(a.checks, "2");
    assert.equal(decodeAttestation(new Map()).status, "pending");
  });
});

describe("availableActions follows the contract's access rules", () => {
  const ctx = (address: string | null, now: number) => ({ address, now });
  it("proposed: the provider accepts before the deadline, the client may cancel, a stranger can do nothing", () => {
    const e = engagement({ status: "proposed" });
    assert.deepEqual(availableActions(e, ctx(PROVIDER, T)), ["accept"]);
    assert.deepEqual(availableActions(e, ctx(CLIENT, T)), ["reclaim_timeout"]);
    assert.deepEqual(availableActions(e, ctx(STRANGER, T)), []);
    assert.deepEqual(availableActions(e, ctx(PROVIDER, T + 86400)), []);
    assert.deepEqual(availableActions(e, ctx(null, T)), []);
  });
  it("funded: only the provider submits, before the deadline; the client reclaims strictly after it", () => {
    const e = engagement({ status: "funded" });
    assert.deepEqual(availableActions(e, ctx(PROVIDER, T)), ["submit"]);
    assert.deepEqual(availableActions(e, ctx(CLIENT, T)), []);
    assert.deepEqual(availableActions(e, ctx(CLIENT, T + 86400)), []);
    assert.deepEqual(availableActions(e, ctx(CLIENT, T + 86401)), ["reclaim_timeout"]);
    assert.deepEqual(availableActions(e, ctx(PROVIDER, T + 86400)), []);
  });
  it("submitted: anyone connected can verify, nobody when disconnected; only the client recovers a stuck submission", () => {
    const e = engagement({ status: "submitted", stale_at: String(T + 86400 + 2 * HOUR) });
    assert.deepEqual(availableActions(e, ctx(STRANGER, T)), ["verify"]);
    assert.deepEqual(availableActions(e, ctx(null, T)), []);
    assert.deepEqual(availableActions(e, ctx(CLIENT, T + 86400 + 2 * HOUR - 1)), ["verify"]);
    assert.deepEqual(availableActions(e, ctx(CLIENT, T + 86400 + 2 * HOUR)), ["verify", "reclaim_stale"]);
    assert.deepEqual(availableActions(e, ctx(STRANGER, T + 86400 + 2 * HOUR)), ["verify"]);
  });
  it("verified: refund is always offered to anyone connected; release only once the window has closed (boundary inclusive)", () => {
    const e = verified();
    assert.deepEqual(availableActions(e, ctx(STRANGER, T + HOUR - 1)), ["refund_drift"]);
    assert.deepEqual(availableActions(e, ctx(STRANGER, T + HOUR)), ["release", "refund_drift"]);
    assert.deepEqual(availableActions(e, ctx(null, T + HOUR)), []);
  });
  it("verified: after the stale point anyone can trigger the even split", () => {
    const e = verified();
    assert.ok(!availableActions(e, ctx(STRANGER, T + 3 * HOUR - 1)).includes("reclaim_stale"));
    assert.ok(availableActions(e, ctx(STRANGER, T + 3 * HOUR)).includes("reclaim_stale"));
  });
  it("decided: anyone connected can settle; settled engagements offer nothing", () => {
    assert.deepEqual(availableActions(engagement({ status: "decided", outcome: "provider" }), ctx(STRANGER, T)), ["settle"]);
    assert.deepEqual(availableActions(engagement({ status: "decided", outcome: "provider" }), ctx(null, T)), []);
    assert.deepEqual(availableActions(engagement({ status: "settled", outcome: "provider" }), ctx(CLIENT, T)), []);
  });
});

describe("stale and window helpers", () => {
  it("staleKind is null without a stale_at, before it, and in other states", () => {
    assert.equal(staleKind(engagement({ status: "submitted" }), T + 10 * 86400), null);
    assert.equal(staleKind(verified(), T + 3 * HOUR - 1), null);
    assert.equal(staleKind(verified(), T + 3 * HOUR), "verified");
    assert.equal(staleKind(engagement({ status: "submitted", stale_at: String(T) }), T), "submitted");
    assert.equal(staleKind(engagement({ status: "decided", stale_at: String(T) }), T + 1), null);
  });
  it("windowOpen is true only while verified and before the window ends", () => {
    assert.equal(windowOpen(verified(), T + HOUR - 1), true);
    assert.equal(windowOpen(verified(), T + HOUR), false);
    assert.equal(windowOpen(engagement({ status: "submitted" }), T), false);
  });
});

describe("write confirmation", () => {
  it("each write has the status (and outcome) it must read back", () => {
    assert.ok(expectedStatus("create")(engagement({ status: "proposed" })));
    assert.ok(expectedStatus("accept")(engagement({ status: "funded" })));
    assert.ok(!expectedStatus("accept")(engagement({ status: "proposed" })));
    assert.ok(expectedStatus("verify")(engagement({ status: "verified" })));
    assert.ok(expectedStatus("release")(engagement({ status: "decided", outcome: "provider" })));
    assert.ok(!expectedStatus("release")(engagement({ status: "decided", outcome: "client" })));
    assert.ok(expectedStatus("refund_drift")(engagement({ status: "decided", outcome: "client" })));
    assert.ok(!expectedStatus("refund_drift")(engagement({ status: "verified" })));
    assert.ok(expectedStatus("settle")(engagement({ status: "settled", outcome: "provider" })));
    assert.ok(!expectedStatus("settle")(engagement({ status: "decided", outcome: "provider" })));
    assert.ok(expectedStatus("reclaim_timeout")(engagement({ status: "settled", outcome: "client" })));
    // a stuck submission refunds at once; a verified release only records the split (settle pays it)
    assert.ok(expectedStatus("reclaim_stale", "submitted")(engagement({ status: "settled", outcome: "client" })));
    assert.ok(!expectedStatus("reclaim_stale", "submitted")(engagement({ status: "decided", outcome: "split" })));
    assert.ok(expectedStatus("reclaim_stale", "verified")(engagement({ status: "decided", outcome: "split" })));
    assert.ok(expectedStatus("reclaim_stale", "verified")(engagement({ status: "settled", outcome: "split" })));
    assert.ok(!expectedStatus("reclaim_stale", "verified")(engagement({ status: "verified" })));
    assert.ok(!expectedStatus("reclaim_stale", "verified")(engagement({ status: "decided", outcome: "client" })));
    assert.ok(!expectedStatus("reclaim_stale")(engagement({ status: "settled", outcome: "provider" })));
  });
  it("after finality the engagement must be at least as far along as the write made it, with the outcome it recorded", () => {
    assert.ok(finalStatus("verify")(engagement({ status: "settled", outcome: "provider" })));
    assert.ok(!finalStatus("verify")(engagement({ status: "submitted" })));
    assert.ok(!finalStatus("accept")(engagement({ status: "proposed" })));
    assert.ok(finalStatus("release")(engagement({ status: "settled", outcome: "provider" })));
    assert.ok(!finalStatus("release")(engagement({ status: "settled", outcome: "client" })));
    assert.ok(!finalStatus("release")(engagement({ status: "verified" })));
    assert.ok(finalStatus("refund_drift")(engagement({ status: "decided", outcome: "client" })));
    assert.ok(!finalStatus("refund_drift")(engagement({ status: "decided", outcome: "provider" })));
    assert.ok(!finalStatus("settle")(engagement({ status: "decided", outcome: "provider" })));
    assert.ok(finalStatus("reclaim_stale", "verified")(engagement({ status: "decided", outcome: "split" })));
    assert.ok(!finalStatus("reclaim_stale", "verified")(engagement({ status: "verified" })));
    assert.ok(!finalStatus("reclaim_stale", "verified")(engagement({ status: "decided", outcome: "provider" })));
    assert.ok(finalStatus("reclaim_stale", "submitted")(engagement({ status: "settled", outcome: "client" })));
    assert.ok(!finalStatus("reclaim_stale", "submitted")(engagement({ status: "decided", outcome: "client" })));
  });
  it("only actions that pay say funds move on finalization", () => {
    for (const a of ["settle", "reclaim_timeout"] as const) assert.ok(movesFunds(a), a);
    assert.ok(movesFunds("reclaim_stale", "submitted"));
    assert.ok(!movesFunds("reclaim_stale", "verified"), "a stale split only records; settle pays it");
    // release and refund_drift only record an outcome: no transfer may share their transaction
    for (const a of ["release", "refund_drift", "verify", "accept", "submit", "create"] as const) assert.ok(!movesFunds(a), a);
  });
});

describe("reads", () => {
  it("a contract refusal means nothing is there; a network failure is not that", () => {
    assert.ok(isContractRefusal(new Error("Missing or invalid parameters.\n\nDetails: execution failed: &genvm.VMResult{Kind:0x1, ...}: genvm execution error")));
    assert.ok(!isContractRefusal(new Error("An unknown RPC error occurred.\n\nDetails: fetch failed")));
    assert.ok(!isContractRefusal(new Error("The request timed out.")));
    assert.ok(!isContractRefusal(undefined));
  });
});

describe("stale split blocker", () => {
  const stale = T + 3 * HOUR;
  it("is silent before the stale point and for other states", () => {
    assert.equal(staleSplitBlocker(verified(), [link({ status: "drifted" })], stale - 1), null);
    assert.equal(staleSplitBlocker(engagement({ status: "submitted", stale_at: String(T) }), [link()], T + 1), null);
  });
  it("points at the refund when a link drifted and at the release when every link is fresh", () => {
    assert.match(staleSplitBlocker(verified(), [link({ status: "drifted", checked_at: String(T + HOUR + 10) })], stale)!, /refund applies/);
    assert.match(staleSplitBlocker(verified(), [link({ checked_at: String(T + HOUR) })], stale)!, /release applies/);
  });
  it("allows the split when a link was not re-checked after the window, or the verifier cannot be read", () => {
    assert.equal(staleSplitBlocker(verified(), [link({ checked_at: String(T + HOUR - 1) })], stale), null);
    assert.equal(staleSplitBlocker(verified(), [], stale), null);
  });
});

describe("chain helpers", () => {
  const end = T + HOUR;
  it("links needing a new check are exactly those not checked at or after the window end", () => {
    const chain = [link({ checked_at: String(end - 1) }), link({ id: "b", checked_at: String(end) }), link({ id: "c", checked_at: String(end + 5) }), link({ id: "d", checked_at: "0" })];
    assert.deepEqual(linksNeedingCheck(chain, end).map((l) => l.id), [chain[0].id, "d"]);
  });
  it("drifted links are the ones the verifier no longer calls verified", () => {
    const chain = [link(), link({ id: "b", status: "drifted" }), link({ id: "c", status: "mismatch" }), link({ id: "d", status: "pending" })];
    assert.deepEqual(driftedLinks(chain).map((l) => l.id), ["b", "c", "d"]);
  });
  it("says in plain words what blocks a release", () => {
    const e = verified();
    assert.equal(releaseBlocker(engagement({ status: "submitted" }), [], T), null);
    assert.match(releaseBlocker(e, [link()], end - 1) ?? "", /watch window is still open/);
    assert.match(releaseBlocker(e, [], end) ?? "", /could not be read/);
    assert.match(releaseBlocker(e, [link({ status: "drifted" })], end) ?? "", /no longer verified/);
    assert.match(releaseBlocker(e, [link(), link({ id: "b" })], end) ?? "", /2 links need a new check/);
    assert.match(releaseBlocker(e, [link({ checked_at: String(end - 1) })], end) ?? "", /One link needs a new check/);
    assert.equal(releaseBlocker(e, [link({ checked_at: String(end) })], end), null);
  });
});

describe("formatting", () => {
  it("keeps precision for small amounts instead of rounding to zero", () => {
    assert.equal(formatGen("2000000000000000"), "0.002");
    assert.equal(formatGen("200000000000000"), "0.0002");
    assert.equal(formatGen("0"), "0.000");
    assert.equal(formatGen("2500000000000000000"), "2.500");
  });
  it("shortens long ids", () => {
    assert.equal(short("abcdef"), "abcdef");
    assert.equal(short(DIGEST), `${DIGEST.slice(0, 8)}…${DIGEST.slice(-6)}`);
  });
});

describe("failedReceiptMessage", () => {
  it("explains a validator timeout as nothing recorded, even if the wallet shows confirmed", () => {
    for (const statusName of ["LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "UNDETERMINED", "CANCELED"]) {
      const m = failedReceiptMessage({ statusName }, "verify", "0xabc");
      assert.match(m ?? "", /Nothing was recorded/);
      assert.match(m ?? "", new RegExp(statusName));
    }
  });
  it("reports a contract refusal separately, and says nothing when the contract ran", () => {
    assert.match(failedReceiptMessage({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR" }, "release", "0x2") ?? "", /The contract refused release/);
    assert.equal(failedReceiptMessage({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN" }, "settle", "0x3"), null);
    assert.equal(failedReceiptMessage(undefined, "settle", "0x3"), null);
  });
});
