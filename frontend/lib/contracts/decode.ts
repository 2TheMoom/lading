import type { Attestation, ChainLink, Engagement } from "./types.ts";

/**
 * genlayer-js decodes Python dicts (and dataclasses) as JS Map instances,
 * keyed by field name. This flattens one level of the Map into a plain
 * object.
 */
function toPlainObject(raw: any): Record<string, any> {
  const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw ?? {});
  const obj: Record<string, any> = {};
  for (const [key, value] of entries) {
    obj[key] = value;
  }
  return obj;
}

const s = (v: unknown, fallback = "0") => String(v ?? fallback);

export function decodeEngagement(raw: any): Engagement {
  const o = toPlainObject(raw);
  return {
    client: s(o.client, ""),
    provider: s(o.provider, ""),
    artifact_url: s(o.artifact_url, ""),
    manifest_url: s(o.manifest_url, ""),
    filename: s(o.filename, ""),
    parent: s(o.parent, ""),
    pin: s(o.pin, ""),
    expected: s(o.expected, ""),
    attestation_id: s(o.attestation_id, ""),
    amount: s(o.amount),
    deadline: s(o.deadline),
    window: s(o.window),
    stale_after: s(o.stale_after),
    status: s(o.status, "proposed") as Engagement["status"],
    outcome: s(o.outcome, "") as Engagement["outcome"],
    reason: s(o.reason, ""),
    submitted_at: s(o.submitted_at),
    verified_at: s(o.verified_at),
    decided_at: s(o.decided_at),
    digest: s(o.digest, ""),
    links: s(o.links),
    window_end: s(o.window_end),
    stale_at: s(o.stale_at),
    terms_hash: s(o.terms_hash, ""),
  };
}

export function decodeChain(raw: any): ChainLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = toPlainObject(item);
    return {
      id: s(o.id, ""),
      filename: s(o.filename, ""),
      status: s(o.status, "pending"),
      digest: s(o.digest, ""),
      checked_at: s(o.checked_at),
      artifact_url: s(o.artifact_url, ""),
      manifest_url: s(o.manifest_url, ""),
    };
  });
}

export function decodeAttestation(raw: any): Attestation {
  const o = toPlainObject(raw);
  return {
    attester: s(o.attester, ""),
    artifact_url: s(o.artifact_url, ""),
    manifest_url: s(o.manifest_url, ""),
    filename: s(o.filename, ""),
    parent: s(o.parent, ""),
    depth: s(o.depth),
    status: s(o.status, "pending"),
    digest: s(o.digest, ""),
    listed: s(o.listed, ""),
    last_digest: s(o.last_digest, ""),
    size: s(o.size),
    created_at: s(o.created_at),
    first_verified_at: s(o.first_verified_at),
    checked_at: s(o.checked_at),
    checks: s(o.checks),
  };
}
