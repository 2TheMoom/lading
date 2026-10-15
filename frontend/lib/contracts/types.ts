/**
 * TypeScript types for the Lading escrow contract and the verifier it reads.
 */

export type EngagementStatus = "proposed" | "funded" | "submitted" | "verified" | "decided" | "settled";
export type Outcome = "" | "provider" | "client" | "split";

export interface Engagement {
  client: string;
  provider: string;
  artifact_url: string;
  manifest_url: string; // the publisher's checksum list
  filename: string; // the name the list must give this artifact
  parent: string; // attestation id of the source this was built from, "" for none
  pin: string; // every link's list must live under this https prefix
  expected: string; // sha256 the client agreed to receive, "" if the publisher's list decides
  attestation_id: string; // the verifier's id for this release
  amount: string; // wei, as decimal string
  deadline: string; // unix seconds: ship before this
  window: string; // watch window in seconds after verification
  stale_after: string; // seconds before a stuck case can be recovered
  status: EngagementStatus;
  outcome: Outcome;
  reason: string;
  submitted_at: string;
  verified_at: string;
  decided_at: string;
  digest: string; // the sha256 the verifier vouched for at verification, "" before
  links: string; // how many links were in the chain at verification
  window_end: string; // unix seconds, "0" until verified
  stale_at: string; // unix seconds a stuck case becomes recoverable, "0" otherwise
  terms_hash: string; // what the provider's accept() must pass
}

/** One link of the verifier's chain of custody, nearest first. */
export interface ChainLink {
  id: string;
  filename: string;
  status: string; // pending, verified, mismatch, unlisted, unbound, drifted
  digest: string;
  checked_at: string; // unix seconds, "0" if never recorded
  artifact_url: string;
  manifest_url: string;
}

/** The verifier's record for one attestation. */
export interface Attestation {
  attester: string;
  artifact_url: string;
  manifest_url: string;
  filename: string;
  parent: string;
  depth: string;
  status: string;
  digest: string; // committed at the first verification
  listed: string; // what the publisher's list says now
  last_digest: string; // what the bytes hashed to when the status last said drifted
  size: string;
  created_at: string;
  first_verified_at: string;
  checked_at: string;
  checks: string;
}

export interface TransactionReceipt {
  status: string;
  hash: string;
  blockNumber?: number;
  [key: string]: any;
}
