import type { Engagement } from "./contracts/types.ts";

/** One short phrase for where a delivery stands, used on the list and the stamp of the detail screen. */
export function statusWords(e: Engagement): string {
  if (e.status === "settled") return e.outcome === "provider" ? "Paid" : e.outcome === "split" ? "Split" : "Refunded";
  if (e.status === "decided") return e.outcome === "provider" ? "Release recorded" : "Refund recorded";
  if (e.status === "verified") return "Verified, watching";
  if (e.status === "submitted") return "Shipped";
  if (e.status === "funded") return "Accepted";
  return "Proposed";
}
