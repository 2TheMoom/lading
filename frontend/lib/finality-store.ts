import { useSyncExternalStore } from "react";

/**
 * Writes that are recorded but not final yet, per engagement. A write is only done once its transaction is
 * FINALIZED, so this keeps saying so (and keeps any failure visible) after a dialog closes or a toast fades.
 * It lives in memory for the session: after a reload the engagement itself is still read from the chain.
 */
export interface PendingWrite {
  label: string;
  txHash: string;
  since: number;
  /** set when the transaction did not finalize as expected */
  failed?: string;
}

let state: Record<string, PendingWrite[]> = {};
const listeners = new Set<() => void>();
const NONE: PendingWrite[] = [];

function emit(next: Record<string, PendingWrite[]>): void {
  state = next;
  listeners.forEach((l) => l());
}

/** A write was recorded and now waits for finality. */
export function addPendingWrite(id: string, w: PendingWrite): void {
  emit({ ...state, [id]: [...(state[id] ?? []).filter((x) => x.txHash !== w.txHash), w] });
}

/** The transaction finalized (drop it) or failed to (keep it, with the reason). */
export function settlePendingWrite(id: string, txHash: string, failed?: string): void {
  const list = (state[id] ?? []).flatMap((x) => (x.txHash !== txHash ? [x] : failed ? [{ ...x, failed }] : []));
  const next = { ...state };
  if (list.length) next[id] = list;
  else delete next[id];
  emit(next);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPendingWrites(id: string): PendingWrite[] {
  return state[id] ?? NONE;
}

export function usePendingWrites(id: string): PendingWrite[] {
  return useSyncExternalStore(subscribe, () => state[id] ?? NONE, () => NONE);
}
