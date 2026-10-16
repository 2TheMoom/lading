import { useSyncExternalStore } from "react";

/**
 * Writes that are recorded but not final yet, per engagement. A write is only done once its transaction is
 * FINALIZED, so this keeps saying so (and keeps any failure visible) after a dialog closes or a toast fades.
 * It is kept in this browser's storage, so a reload does not turn "recorded, not final" into a plain "Paid" or "Refunded":
 * the entries that come back are watched again until their transactions finalize (see useResumeFinality).
 */
export interface PendingWrite {
  label: string;
  txHash: string;
  since: number;
  /** set when the transaction did not finalize as expected */
  failed?: string;
}

const STORAGE_KEY = "lading_pending_writes_v1";
const NONE: PendingWrite[] = [];
const listeners = new Set<() => void>();

function load(): Record<string, PendingWrite[]> {
  try {
    if (typeof window === "undefined") return {};
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    const out: Record<string, PendingWrite[]> = {};
    for (const [id, list] of Object.entries(raw)) {
      const ok = (Array.isArray(list) ? list : []).filter((w: any) => w && typeof w.txHash === "string" && typeof w.label === "string");
      if (ok.length) out[id] = ok as PendingWrite[];
    }
    return out;
  } catch {
    return {};
  }
}

let state: Record<string, PendingWrite[]> = load();
/** Hashes that came back from storage and have not been watched yet in this page. */
const restored = new Set<string>(Object.values(state).flat().filter((w) => !w.failed).map((w) => w.txHash));

function emit(next: Record<string, PendingWrite[]>): void {
  state = next;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage can be blocked; the in-memory list still works for this session
  }
  listeners.forEach((l) => l());
}

/** Pending writes of this engagement that were restored after a reload and are not being watched yet. Taking them marks them watched. */
export function takeRestoredWrites(id: string): PendingWrite[] {
  const mine = (state[id] ?? []).filter((w) => restored.has(w.txHash) && !w.failed);
  mine.forEach((w) => restored.delete(w.txHash));
  return mine;
}

/** Put writes back to be taken again (a watcher that was stopped before it saw them finalize). */
export function releaseRestoredWrites(writes: PendingWrite[]): void {
  writes.forEach((w) => restored.add(w.txHash));
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
