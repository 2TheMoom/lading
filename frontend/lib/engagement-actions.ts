import type { ChainLink, Engagement } from "./contracts/types.ts";

export type StaleKind = "submitted" | "verified";

export type EngagementAction =
  | "accept"
  | "submit"
  | "verify"
  | "release"
  | "refund_drift"
  | "settle"
  | "reclaim_timeout"
  | "reclaim_stale";

export interface ActionContext {
  /** The connected wallet, or null when nobody is connected. */
  address: string | null | undefined;
  /** Current unix time in seconds. */
  now: number;
}

function sameAddr(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Which kind of stale recovery the contract would accept right now, if any. Mirrors reclaim_stale():
 * a stuck submission once stale_after seconds have passed since the deadline, a verified release nobody
 * could confirm once stale_after seconds have passed since the watch window closed.
 */
export function staleKind(e: Engagement, now: number): StaleKind | null {
  const stale = Number(e.stale_at);
  if (!(stale > 0) || now < stale) return null;
  if (e.status === "submitted") return "submitted";
  if (e.status === "verified") return "verified";
  return null;
}

/** True while the watch window of a verified release is still running. */
export function windowOpen(e: Engagement, now: number): boolean {
  return e.status === "verified" && now < Number(e.window_end);
}

/**
 * What the connected account may do right now, exactly as the contract's access rules allow it:
 *  - accept: provider only, while the proposal is open and before the deadline
 *  - submit: provider only, after accepting and before the deadline
 *  - verify: anyone, once submitted
 *  - release: anyone, after the watch window (the contract also needs a fresh finalized check of every link)
 *  - refund_drift: anyone, while verified (the contract refuses unless the verifier no longer vouches)
 *  - settle: anyone, once an outcome is recorded
 *  - reclaim_timeout: client only; an unaccepted proposal any time, an accepted one after the deadline
 *  - reclaim_stale: client for a stuck submission, anyone for a verified release that was never confirmed
 */
export function availableActions(e: Engagement, ctx: ActionContext): EngagementAction[] {
  const actions: EngagementAction[] = [];
  const connected = !!ctx.address;
  const isClient = sameAddr(ctx.address, e.client);
  const isProvider = sameAddr(ctx.address, e.provider);
  const deadline = Number(e.deadline);
  const pastDeadline = ctx.now >= deadline;

  if (e.status === "proposed") {
    if (isProvider && !pastDeadline) actions.push("accept");
    if (isClient) actions.push("reclaim_timeout");
  }
  if (e.status === "funded") {
    if (isProvider && !pastDeadline) actions.push("submit");
    if (isClient && ctx.now > deadline) actions.push("reclaim_timeout");
  }
  if (e.status === "submitted") {
    if (connected) actions.push("verify");
    if (isClient && staleKind(e, ctx.now) === "submitted") actions.push("reclaim_stale");
  }
  if (e.status === "verified") {
    if (connected && ctx.now >= Number(e.window_end)) actions.push("release");
    if (connected) actions.push("refund_drift");
    if (connected && staleKind(e, ctx.now) === "verified") actions.push("reclaim_stale");
  }
  if (e.status === "decided" && connected) actions.push("settle");
  return actions;
}

const RANK: Record<string, number> = { proposed: 0, funded: 1, submitted: 2, verified: 3, decided: 4, settled: 5 };
const MIN_RANK: Record<string, number> = {
  create: 0, accept: 1, submit: 2, verify: 3, release: 4, refund_drift: 4, settle: 5, reclaim_timeout: 5, reclaim_stale: 5,
};
const NEEDS_OUTCOME: Record<string, string[]> = { release: ["provider"], refund_drift: ["client"], reclaim_timeout: ["client"], reclaim_stale: ["client", "split"] };

/** Status (and outcome) the engagement must reach for a write to count as recorded: read back after every transaction. */
export function expectedStatus(action: EngagementAction | "create"): (e: Engagement) => boolean {
  switch (action) {
    case "create": return (e) => e.status === "proposed";
    case "accept": return (e) => e.status === "funded";
    case "submit": return (e) => e.status === "submitted";
    case "verify": return (e) => e.status === "verified";
    case "release": return (e) => e.status === "decided" && e.outcome === "provider";
    case "refund_drift": return (e) => e.status === "decided" && e.outcome === "client";
    case "settle": return (e) => e.status === "settled";
    case "reclaim_timeout": return (e) => e.status === "settled" && e.outcome === "client";
    case "reclaim_stale": return (e) => e.status === "settled" && (e.outcome === "client" || e.outcome === "split");
    default: return () => true;
  }
}

/**
 * What a FINALIZED write must still show when the engagement is read again: at least as far along as the write made it
 * (someone else's later step is fine), and the outcome it recorded where it recorded one.
 */
export function finalStatus(action: EngagementAction | "create"): (e: Engagement) => boolean {
  return (e) => {
    if ((RANK[e.status] ?? -1) < (MIN_RANK[action] ?? 99)) return false;
    const need = NEEDS_OUTCOME[action];
    return !need || need.includes(e.outcome);
  };
}

/** True for actions that move funds: the transfer only lands when the transaction finalizes. */
export function movesFunds(action: EngagementAction | "create"): boolean {
  return action === "settle" || action === "reclaim_timeout" || action === "reclaim_stale";
}

/** Links of the chain that still need a check recorded after the window closed (release refuses until every link has one). */
export function linksNeedingCheck(chain: ChainLink[], windowEnd: number): ChainLink[] {
  return chain.filter((l) => !(Number(l.checked_at) >= windowEnd));
}

/** Links the verifier no longer calls verified. */
export function driftedLinks(chain: ChainLink[]): ChainLink[] {
  return chain.filter((l) => l.status !== "verified");
}

/** In plain words, what stands between a verified release and its release right now, or null when nothing does. */
export function releaseBlocker(e: Engagement, chain: ChainLink[], now: number): string | null {
  if (e.status !== "verified") return null;
  const end = Number(e.window_end);
  if (now < end) return "The watch window is still open.";
  if (chain.length === 0) return "The verifier's record could not be read.";
  const drift = driftedLinks(chain);
  if (drift.length > 0) return `${drift.length === 1 ? "A link is" : `${drift.length} links are`} no longer verified: the client can ask for the refund.`;
  const need = linksNeedingCheck(chain, end);
  if (need.length > 0) return `${need.length === 1 ? "One link needs" : `${need.length} links need`} a new check after the window closed, and that check must finalize (about 30 minutes).`;
  return null;
}
