import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickMetaMask, withTimeout } from "./genlayer/provider.ts";

const rabby = { isMetaMask: true, isRabby: true, name: "rabby-proxy" };
const mm = { isMetaMask: true, name: "metamask" };
const phantom = { isMetaMask: true, isPhantom: true, name: "phantom" };

describe("choosing the MetaMask provider", () => {
  it("prefers MetaMask's own announcement over whatever owns window.ethereum (Rabby claims isMetaMask and can hang)", () => {
    const announced = [
      { info: { rdns: "io.rabby", name: "Rabby Wallet" }, provider: rabby },
      { info: { rdns: "app.phantom", name: "Phantom" }, provider: phantom },
      { info: { rdns: "io.metamask", name: "MetaMask" }, provider: mm },
    ];
    assert.equal(pickMetaMask(announced, undefined, rabby), mm);
  });
  it("accepts MetaMask Flask", () => {
    const flask = { name: "flask" };
    assert.equal(pickMetaMask([{ info: { rdns: "io.metamask.flask" }, provider: flask }], undefined, rabby), flask);
  });
  it("without announcements, takes a real MetaMask from the legacy providers list, skipping look-alikes", () => {
    assert.equal(pickMetaMask([], [rabby, phantom, mm], rabby), mm);
  });
  it("without either, falls back to window.ethereum, and to null when there is no wallet at all", () => {
    assert.equal(pickMetaMask([], undefined, mm), mm);
    assert.equal(pickMetaMask([], undefined, undefined), null);
  });
  it("never picks a look-alike just because it says isMetaMask", () => {
    assert.equal(pickMetaMask([], [rabby, phantom], undefined), null);
  });
});

describe("a wallet that never answers", () => {
  it("gives the fallback after the timeout instead of waiting forever", async () => {
    const never = new Promise<string>(() => {});
    assert.equal(await withTimeout(never, 30, "gave up"), "gave up");
  });
  it("returns the real answer when it comes in time, and the fallback when the wallet errors", async () => {
    assert.equal(await withTimeout(Promise.resolve("answer"), 200, "gave up"), "answer");
    assert.equal(await withTimeout(Promise.reject(new Error("locked")), 200, "gave up"), "gave up");
  });
});
