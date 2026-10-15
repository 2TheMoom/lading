import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addPendingWrite, getPendingWrites, settlePendingWrite } from "./finality-store.ts";

describe("writes waiting for finality", () => {
  it("a recorded write stays pending until its own transaction finalizes", () => {
    addPendingWrite("e1", { label: "Accepted", txHash: "0xaa", since: 1 });
    addPendingWrite("e1", { label: "Submitted", txHash: "0xbb", since: 2 });
    assert.deepEqual(getPendingWrites("e1").map((w) => w.txHash), ["0xaa", "0xbb"]);
    settlePendingWrite("e1", "0xaa"); // finalized: gone, the other one still waits
    assert.deepEqual(getPendingWrites("e1").map((w) => w.txHash), ["0xbb"]);
    settlePendingWrite("e1", "0xbb");
    assert.deepEqual(getPendingWrites("e1"), []);
  });
  it("a write that fails to finalize stays visible with the reason", () => {
    addPendingWrite("e2", { label: "Verified", txHash: "0xcc", since: 1 });
    settlePendingWrite("e2", "0xcc", "finalized but the engagement does not show its result");
    const [w] = getPendingWrites("e2");
    assert.equal(w.failed, "finalized but the engagement does not show its result");
    assert.equal(w.txHash, "0xcc");
  });
  it("recording the same transaction twice does not duplicate it, and engagements are separate", () => {
    addPendingWrite("e3", { label: "Verified", txHash: "0xdd", since: 1 });
    addPendingWrite("e3", { label: "Verified", txHash: "0xdd", since: 2 });
    assert.equal(getPendingWrites("e3").length, 1);
    assert.deepEqual(getPendingWrites("other"), []);
    settlePendingWrite("e3", "0xnot-there"); // an unknown transaction changes nothing
    assert.equal(getPendingWrites("e3").length, 1);
  });
});
