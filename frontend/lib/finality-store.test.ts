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

describe("surviving a reload", () => {
  const fakeWindow = (initial?: string) => {
    const data: Record<string, string> = initial === undefined ? {} : { lading_pending_writes_v1: initial };
    (globalThis as any).window = { localStorage: { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } } };
    return data;
  };
  const fresh = (tag: string) => import(`./finality-store.ts?${tag}`);

  it("brings back what was waiting for finality and hands each restored write out once", async () => {
    fakeWindow(JSON.stringify({ e9: [{ label: "Refund recorded", txHash: "0xaa", since: 1 }, { label: "Verified", txHash: "0xbb", since: 2, failed: "x" }] }));
    const s = await fresh("restore");
    assert.deepEqual(s.getPendingWrites("e9").map((w: any) => w.txHash), ["0xaa", "0xbb"]);
    assert.deepEqual(s.takeRestoredWrites("e9").map((w: any) => w.txHash), ["0xaa"]); // the failed one is not watched again
    assert.deepEqual(s.takeRestoredWrites("e9"), []);
    s.releaseRestoredWrites([{ label: "Refund recorded", txHash: "0xaa", since: 1 }]); // a watcher stopped early
    assert.deepEqual(s.takeRestoredWrites("e9").map((w: any) => w.txHash), ["0xaa"]);
    delete (globalThis as any).window;
  });
  it("writes what it holds to storage as writes come and go", async () => {
    const data = fakeWindow();
    const s = await fresh("persist");
    s.addPendingWrite("e1", { label: "Funded", txHash: "0x11", since: 1 });
    assert.equal(JSON.parse(data.lading_pending_writes_v1).e1[0].txHash, "0x11");
    s.settlePendingWrite("e1", "0x11");
    assert.deepEqual(JSON.parse(data.lading_pending_writes_v1), {});
    delete (globalThis as any).window;
  });
  it("ignores corrupt storage instead of breaking the page", async () => {
    fakeWindow("{not json");
    const s = await fresh("corrupt");
    assert.deepEqual(s.getPendingWrites("anything"), []);
    delete (globalThis as any).window;
  });
});
