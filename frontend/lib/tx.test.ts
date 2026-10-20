import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { txExecName, txStatusName } from "./tx.ts";
import { failedReceiptMessage } from "./receipt.ts";
import { BRADBURY, STUDIONET, networkFor } from "./genlayer/network.ts";

describe("reading a transaction on either network", () => {
  it("Bradbury records keep their own names", () => {
    const r = { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN" };
    assert.equal(txStatusName(r), "ACCEPTED");
    assert.equal(txExecName(r), "FINISHED_WITH_RETURN");
    assert.equal(txExecName({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR" }), "FINISHED_WITH_ERROR");
  });

  it("a Studionet receipt has only a number: every number maps to its name", () => {
    const names = ["UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "UNDETERMINED", "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING", "READY_TO_FINALIZE", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"];
    names.forEach((n, i) => {
      assert.equal(txStatusName({ status: i }), n);
      assert.equal(txStatusName({ status: String(i) }), n);
    });
    assert.equal(txStatusName({ status: 99 }), "");
    assert.equal(txStatusName({}), "");
    assert.equal(txStatusName(null), "");
    assert.equal(txStatusName(undefined), "");
  });

  it("a Studionet getTransaction carries statusName, which wins", () => {
    assert.equal(txStatusName({ statusName: "FINALIZED", status: 7 }), "FINALIZED");
  });

  it("the leader's execution result decides whether the contract ran on Studionet", () => {
    assert.equal(txExecName({ consensus_data: { leader_receipt: [{ execution_result: "SUCCESS" }] } }), "FINISHED_WITH_RETURN");
    assert.equal(txExecName({ consensus_data: { leader_receipt: [{ execution_result: "ERROR" }] } }), "FINISHED_WITH_ERROR");
    assert.equal(txExecName({ consensus_data: { leader_receipt: { execution_result: "SUCCESS" } } }), "FINISHED_WITH_RETURN");
    assert.equal(txExecName({ consensus_data: { leader_receipt: [] } }), "");
    assert.equal(txExecName({}), "");
    assert.equal(txExecName(null), "");
  });

  it("validators that never voted read as not voted", () => {
    assert.equal(txExecName({ result_name: "IDLE" }), "NOT_VOTED");
  });
});

describe("a failed write is recognised from a Studionet receipt too", () => {
  const studio = (status: number, run: string) => ({ status, result_name: "MAJORITY_AGREE", consensus_data: { leader_receipt: [{ execution_result: run }] } });

  it("a returned call is not a failure", () => {
    assert.equal(failedReceiptMessage(studio(5, "SUCCESS"), "accept", "0xaa"), null);
    assert.equal(failedReceiptMessage(studio(7, "SUCCESS"), "accept", "0xaa"), null);
  });

  it("a refused call says it was refused", () => {
    const m = failedReceiptMessage(studio(5, "ERROR"), "accept", "0xaa");
    assert.match(String(m), /The contract refused accept/);
  });

  it("validators that timed out say nothing was recorded", () => {
    for (const status of [6, 8, 12, 13]) assert.match(String(failedReceiptMessage({ status }, "verify", "0xbb")), /Validators did not complete verify/);
  });

  it("a Bradbury receipt still behaves as before", () => {
    assert.equal(failedReceiptMessage({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN" }, "x", "0x1"), null);
    assert.match(String(failedReceiptMessage({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR" }, "x", "0x1")), /refused/);
    assert.match(String(failedReceiptMessage({ statusName: "LEADER_TIMEOUT" }, "x", "0x1")), /did not complete/);
  });
});

describe("the network the app is built for", () => {
  it("knows both networks and falls back to Bradbury", () => {
    assert.equal(networkFor(4221), BRADBURY);
    assert.equal(networkFor(61999), STUDIONET);
    assert.equal(networkFor(1), BRADBURY);
    assert.equal(networkFor(Number.NaN), BRADBURY);
  });

  it("says how long finality takes on each", () => {
    assert.equal(BRADBURY.finality, "about 30 minutes");
    assert.equal(STUDIONET.finality, "about a minute");
    assert.equal(STUDIONET.isStudio, true);
    assert.equal(BRADBURY.isStudio, false);
  });

  it("uses the Studio explorer and rpc for Studionet", () => {
    assert.equal(STUDIONET.explorer, "https://explorer-studio.genlayer.com");
    assert.equal(STUDIONET.rpc, "https://studio.genlayer.com/api");
    assert.equal(STUDIONET.id, 61999);
  });
});
