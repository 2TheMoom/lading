import { createClient } from "genlayer-js";
import { getGenLayerChain } from "../genlayer/chains";
import { getEthereumProvider, prepareWalletForWrites } from "../genlayer/client";
import type { Attestation, ChainLink, Engagement } from "./types";
import { decodeAttestation, decodeChain, decodeEngagement } from "./decode";
import { failedReceiptMessage, isContractRefusal } from "../receipt";
import { expectedStatus, finalStatus, movesFunds, type EngagementAction, type StaleKind } from "../engagement-actions";

/** Where a write is in its life. The UI shows these; only "finalized" means it is really done. */
export type WriteStage = "signing" | "submitted" | "accepted" | "confirmed" | "finalized" | "failed";

export interface WriteProgress {
  txHash?: string;
  stage: WriteStage;
  /** true when funds only move once the transaction finalizes */
  movesFunds: boolean;
  /** why a write failed, set with stage "failed" */
  message?: string;
  /** which contract this transaction went to: funding an escrow also registers the release with the verifier first */
  target?: "escrow" | "verifier";
}

export interface CreateArgs {
  id: string;
  provider: string;
  artifact: string;
  list: string;
  name: string;
  parent: string;
  pin: string;
  expected: string;
  deadline: number;
  window: number;
  stale: number;
  amountWei: bigint;
}

type Target = "escrow" | "verifier";

interface WriteSpec {
  target: Target;
  fn: string;
  args: unknown[];
  value?: bigint;
  /** the read-back that must hold once the transaction is ACCEPTED */
  confirm: () => Promise<boolean>;
  /** the read-back that must still hold once it is FINALIZED (at least as far along as `confirm`) */
  finalConfirm: () => Promise<boolean>;
  funds: boolean;
  onProgress?: (p: WriteProgress) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lading contract client.
 *
 * Reads use an account-free client. Writes use a second client that carries the injected wallet provider and is
 * connected to the chain before signing, as the GenLayerJS docs prescribe for browser wallets.
 *
 * A write is only reported as done after four checks: the transaction was accepted, its GenVM execution returned
 * (an ACCEPTED transaction can still have reverted), reading the state back shows the expected result, and then,
 * for EVERY write, the transaction reached FINALIZED with a successful GenVM result and the state still shows it.
 * Until then a write is only "recorded": it can still change, and the escrow itself only reads FINALIZED verdicts.
 */
class Lading {
  private escrow: `0x${string}`;
  private verifier: `0x${string}`;
  private readClient: any;
  private writeClient: any = null;
  private connectedFor: string | null = null;
  private address?: string | null;
  private rpcUrl?: string;

  constructor(escrow: string, verifier: string, address?: string | null, rpcUrl?: string) {
    this.escrow = escrow as `0x${string}`;
    this.verifier = verifier as `0x${string}`;
    this.rpcUrl = rpcUrl;
    this.address = address;
    const config: any = { chain: getGenLayerChain() };
    if (rpcUrl) config.endpoint = rpcUrl;
    this.readClient = createClient(config);
  }

  updateAccount(address: string): void {
    this.address = address;
    this.writeClient = null;
    this.connectedFor = null;
  }

  /** The provider-backed client, connected to the chain. Created lazily so reads never need a wallet. */
  private async writer(): Promise<any> {
    if (!this.address) throw new Error("Wallet not connected. Please connect your wallet first.");
    const provider = getEthereumProvider();
    if (!provider) throw new Error("No wallet found. Install MetaMask to sign transactions.");
    if (!this.writeClient || this.connectedFor !== this.address) {
      const config: any = { chain: getGenLayerChain(), account: this.address as `0x${string}`, provider };
      if (this.rpcUrl) config.endpoint = this.rpcUrl;
      const client = createClient(config);
      await prepareWalletForWrites(provider);
      this.writeClient = client;
      this.connectedFor = this.address;
    }
    return this.writeClient;
  }

  // ---- reads ---------------------------------------------------------------------------------

  async getEngagement(id: string): Promise<Engagement | null> {
    try {
      return decodeEngagement(await this.readClient.readContract({ address: this.escrow, functionName: "get_engagement", args: [id] }));
    } catch (error) {
      if (isContractRefusal(error)) return null;
      throw error;
    }
  }

  async getEngagementCount(): Promise<number> {
    const n: any = await this.readClient.readContract({ address: this.escrow, functionName: "get_engagement_count", args: [] });
    return Number(n ?? 0);
  }

  /** One page (at most 50) of ids, oldest first. */
  async getEngagementIds(offset: number, limit: number): Promise<string[]> {
    const result: any = await this.readClient.readContract({ address: this.escrow, functionName: "get_engagement_ids", args: [offset, limit] });
    return Array.isArray(result) ? result.map(String) : [];
  }

  /** The newest `limit` ids, oldest first within that page, read from the end so a long history never has to be loaded. */
  async getRecentEngagementIds(limit = 20): Promise<string[]> {
    const count = await this.getEngagementCount();
    if (count === 0) return [];
    const start = Math.max(0, count - limit);
    return this.getEngagementIds(start, count - start);
  }

  /** The attestation id the escrow and the verifier both derive from the four inputs (the escrow checks them first). */
  async attestationId(artifact: string, list: string, name: string, parent: string): Promise<string> {
    return String(await this.readClient.readContract({ address: this.escrow, functionName: "attestation_id", args: [artifact, list, name, parent] }));
  }

  /** The verifier's record for one attestation, or null when it has none. */
  async getAttestation(id: string): Promise<Attestation | null> {
    try {
      return decodeAttestation(await this.readClient.readContract({ address: this.verifier, functionName: "get_attestation", args: [id] }));
    } catch (error) {
      if (isContractRefusal(error)) return null;
      throw error;
    }
  }

  /** The chain of custody from this attestation up to its root, nearest first ([] when unknown). */
  async getChain(id: string): Promise<ChainLink[]> {
    try {
      return decodeChain(await this.readClient.readContract({ address: this.verifier, functionName: "trace", args: [id] }));
    } catch (error) {
      if (isContractRefusal(error)) return [];
      throw error;
    }
  }

  // ---- the write path -------------------------------------------------------------------------

  /** Poll `pred` until it holds. Reads can lag a just-accepted write, so poll briefly. */
  private async until(pred: () => Promise<boolean>, tries: number, what: string): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (await pred().catch(() => false)) return;
      await sleep(5000);
    }
    throw new Error(what);
  }

  private async submitWrite(spec: WriteSpec): Promise<string> {
    const progress = (stage: WriteStage, txHash?: string, message?: string) => spec.onProgress?.({ stage, txHash, movesFunds: spec.funds, message, target: spec.target });
    const client = await this.writer();
    const address = spec.target === "escrow" ? this.escrow : this.verifier;

    progress("signing");
    let txHash: string;
    try {
      txHash = await client.writeContract({ address, functionName: spec.fn, args: spec.args, value: spec.value ?? BigInt(0) });
    } catch (error: any) {
      console.error(`Error calling ${spec.fn}:`, error);
      const rejected = error?.code === 4001 || /reject|denied/i.test(String(error?.message ?? ""));
      throw new Error(rejected ? "You rejected the transaction in your wallet." : `Failed to submit the ${spec.fn} transaction. Please try again.`);
    }
    progress("submitted", txHash);

    let receipt: any;
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash, status: "ACCEPTED" as any, retries: 60, interval: 5000 });
    } catch (error) {
      console.error(`Error confirming ${spec.fn} transaction:`, error);
      throw new Error(`Transaction ${txHash} was submitted but is not accepted yet. It may still complete: check the explorer.`);
    }
    // ACCEPTED only says validators agreed on a result, which can be a revert; a timeout records nothing at all.
    const failure = failedReceiptMessage(receipt, spec.fn, txHash);
    if (failure) throw new Error(failure);
    progress("accepted", txHash);

    await this.until(
      spec.confirm,
      24,
      "The transaction was accepted but the result is not showing yet. It may have been refused by the contract: check the explorer before retrying."
    );
    progress("confirmed", txHash);

    // Recorded is not done. Every write is watched until it is FINALIZED, then its GenVM result and the state are checked again.
    void this.awaitFinality(txHash, spec, progress);
    return txHash;
  }

  private async awaitFinality(txHash: string, spec: WriteSpec, progress: (stage: WriteStage, txHash?: string, message?: string) => void): Promise<void> {
    let receipt: any = null;
    for (let i = 0; i < 8 && !receipt; i++) {
      try {
        receipt = await this.readClient.waitForTransactionReceipt({ hash: txHash, status: "FINALIZED" as any, retries: 400, interval: 10000 });
      } catch {
        await sleep(15000);
      }
    }
    if (!receipt) {
      progress("failed", txHash, `Transaction ${txHash} has not finalized yet. It is recorded but not final: check the explorer before relying on it.`);
      return;
    }
    const failure = failedReceiptMessage(receipt, spec.fn, txHash);
    if (failure) {
      progress("failed", txHash, failure);
      return;
    }
    try {
      await this.until(spec.finalConfirm, 6, "x");
    } catch {
      progress("failed", txHash, `Transaction ${txHash} finalized but the state does not show its result. Check the explorer.`);
      return;
    }
    progress("finalized", txHash);
  }

  // ---- escrow writes --------------------------------------------------------------------------

  private escrowWrite(action: EngagementAction | "create", id: string, fn: string, args: unknown[], onProgress?: (p: WriteProgress) => void, value?: bigint, kind?: StaleKind) {
    const ok = expectedStatus(action, kind);
    const fin = finalStatus(action, kind);
    return this.submitWrite({
      target: "escrow", fn, args, value, funds: movesFunds(action, kind), onProgress,
      confirm: async () => { const e = await this.getEngagement(id); return !!e && ok(e); },
      finalConfirm: async () => { const e = await this.getEngagement(id); return !!e && fin(e); },
    });
  }

  createEngagement(a: CreateArgs, onProgress?: (p: WriteProgress) => void) {
    const args = [a.id, a.provider, a.artifact, a.list, a.name, a.parent, a.pin, a.expected, a.deadline, a.window, a.stale];
    return this.escrowWrite("create", a.id, "create_engagement", args, onProgress, a.amountWei);
  }

  /** The provider accepts an exact digest of the terms, read fresh from the contract. */
  async accept(id: string, onProgress?: (p: WriteProgress) => void) {
    const e = await this.getEngagement(id);
    if (!e || !e.terms_hash) throw new Error("Could not read the terms of this engagement. Try again.");
    return this.escrowWrite("accept", id, "accept", [id, e.terms_hash], onProgress);
  }

  submit(id: string, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("submit", id, "submit", [id], onProgress);
  }

  verify(id: string, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("verify", id, "verify", [id], onProgress);
  }

  /** Records that the release was confirmed after the window. Moves no money; settle pays it. */
  release(id: string, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("release", id, "release", [id], onProgress);
  }

  /** Records that the verifier no longer vouches for the release. Moves no money; settle refunds it. */
  refundDrift(id: string, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("refund_drift", id, "refund_drift", [id], onProgress);
  }

  /** Pays a recorded outcome, once. The transfer lands when this transaction finalizes. */
  settle(id: string, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("settle", id, "settle", [id], onProgress);
  }

  reclaimTimeout(id: string, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("reclaim_timeout", id, "reclaim_timeout", [id], onProgress);
  }

  /** A stuck submission refunds the client at once; a verified release nobody confirmed only records an even split (settle pays it). */
  reclaimStale(id: string, kind: StaleKind, onProgress?: (p: WriteProgress) => void) {
    return this.escrowWrite("reclaim_stale", id, "reclaim_stale", [id], onProgress, undefined, kind);
  }

  // ---- verifier writes ------------------------------------------------------------------------

  /** Registers a release with the verifier (no money). Anyone may; a release can be registered once. */
  attest(artifact: string, list: string, name: string, parent: string, attestationId: string, onProgress?: (p: WriteProgress) => void) {
    const known = async () => (await this.getAttestation(attestationId)) !== null;
    return this.submitWrite({ target: "verifier", fn: "attest", args: [artifact, list, name, parent], funds: false, onProgress, confirm: known, finalConfirm: known });
  }

  /** Asks the validators to hash the file again and agree on a verdict. Permissionless, one per five minutes per release. */
  async check(attestationId: string, onProgress?: (p: WriteProgress) => void) {
    const before = Number((await this.getAttestation(attestationId))?.checks ?? 0);
    const recorded = async () => Number((await this.getAttestation(attestationId))?.checks ?? 0) > before;
    return this.submitWrite({ target: "verifier", fn: "check", args: [attestationId], funds: false, onProgress, confirm: recorded, finalConfirm: recorded });
  }
}

export default Lading;
