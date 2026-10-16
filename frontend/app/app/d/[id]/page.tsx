"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppBar } from "@/components/AppBar";
import { TxProgress } from "@/components/TxProgress";
import { getAddressExplorerUrl, getTxExplorerUrl } from "@/lib/genlayer/chains";
import { useWallet } from "@/lib/genlayer/wallet";
import { usePendingWrites } from "@/lib/finality-store";
import {
  useAccept, useAttestation, useChain, useEngagement, useReclaimStale, useReclaimTimeout, useRecheck, useRefundDrift,
  useRelease, useSettle, useSubmit, useVerify,
} from "@/lib/hooks/useLading";
import { availableActions, driftedLinks, linksNeedingCheck, releaseBlocker, staleKind, windowOpen, type EngagementAction } from "@/lib/engagement-actions";
import { formatGen, short } from "@/lib/limits";
import { statusWords } from "@/lib/status";
import type { ChainLink, Engagement } from "@/lib/contracts/types";

function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const when = (ts: string | number) => (Number(ts) > 0 ? new Date(Number(ts) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
function span(sec: number): string {
  if (sec <= 0) return "now";
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ${Math.ceil((sec % 3600) / 60)} min`;
  return `${Math.floor(sec / 86400)} d ${Math.floor((sec % 86400) / 3600)} h`;
}

type Mark = "done" | "now" | "wait";
function Step({ mark, title, note, right, sub, shaded }: { mark: Mark; title: string; note?: string; right?: string; sub?: string; shaded?: boolean }) {
  const stroke = mark === "done" ? "var(--green)" : mark === "now" ? "var(--ink)" : "var(--line)";
  return (
    <div className={`l-row${shaded ? " l-pending" : ""}`} style={shaded ? { margin: "0 -24px", paddingInline: 24 } : undefined}>
      <div style={{ display: "flex", gap: 14, minWidth: 0 }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" style={{ flex: "0 0 22px", marginTop: 2 }}>
          <circle cx="11" cy="11" r="9" stroke={stroke} strokeWidth="2" strokeDasharray={mark === "now" ? "4 3" : undefined} />
          {mark === "done" && <path d="M6.5 11.5l3 3 6-7" stroke="var(--green)" strokeWidth="2.2" />}
          {mark === "now" && <circle cx="11" cy="11" r="3.5" fill="var(--ink)" />}
        </svg>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: mark === "wait" ? "var(--ink2)" : undefined }}>{title}</div>
          {note && <div className="l-note" style={{ wordBreak: "break-word" }}>{note}</div>}
        </div>
      </div>
      {(right || sub) && (
        <div style={{ textAlign: "right" }}>
          {right && <div className="l-display" style={{ letterSpacing: "0.1em", fontSize: 15, color: mark === "done" ? "var(--green)" : "var(--ink2)", fontWeight: 700 }}>{right}</div>}
          {sub && <div className="l-mono l-note" style={{ fontSize: 12 }}>{sub}</div>}
        </div>
      )}
    </div>
  );
}

function role(e: Engagement, address: string | null | undefined): string {
  if (!address) return "Connect a wallet to act on this delivery.";
  if (address.toLowerCase() === e.client.toLowerCase()) return "You are the client.";
  if (address.toLowerCase() === e.provider.toLowerCase()) return "You are the provider.";
  return "You are neither party. Anyone can still verify, check, release and settle.";
}

export default function Delivery() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params?.id ?? ""));
  const { address } = useWallet();
  const now = useNow();
  const { data: e, isLoading } = useEngagement(id);
  const { data: chain = [] } = useChain(e?.attestation_id);
  const { data: att } = useAttestation(e?.attestation_id);
  const pending = usePendingWrites(id);

  const accept = useAccept();
  const submit = useSubmit();
  const verify = useVerify();
  const release = useRelease();
  const refund = useRefundDrift();
  const settle = useSettle();
  const reclaimT = useReclaimTimeout();
  const reclaimS = useReclaimStale();
  const recheck = useRecheck();

  if (isLoading) return <div><AppBar active="deliveries" /><main className="l-wrap" style={{ paddingBlock: 48 }}><p className="l-note">Reading the contract…</p></main></div>;
  if (!e) return <div><AppBar active="deliveries" /><main className="l-wrap" style={{ paddingBlock: 48 }}><p>No delivery called <span className="l-mono">{id}</span>. <Link href="/app" style={{ textDecoration: "underline" }}>Back to deliveries</Link></p></main></div>;

  const actions = availableActions(e, { address, now });
  const end = Number(e.window_end);
  const blocker = releaseBlocker(e, chain, now);
  const drift = driftedLinks(chain);
  const verifierSays = att?.status ?? "pending";
  const unlinked = chain.length === 0;
  // root first: a build can only be checked once its source is verified
  const rootFirst = [...chain].reverse();
  const needAfterWindow = e.status === "verified" && now >= end ? linksNeedingCheck(chain, end) : [];
  const toCheck: ChainLink[] = e.status === "submitted" || e.status === "funded" || e.status === "proposed" ? rootFirst.filter((l) => l.status !== "verified") : [...needAfterWindow].reverse();
  const connected = !!address;
  const computed = att ? (att.status === "drifted" ? att.last_digest : att.digest) : "";
  const listed = att?.listed ?? "";
  const matches = att?.status === "verified" && computed !== "" && computed === listed;
  const stamp = verifierSays === "verified" ? { text: "Match", cls: "green" } : verifierSays === "pending" ? { text: "Not checked yet", cls: "yellow" } : { text: verifierSays, cls: "red" };

  const row = (action: EngagementAction, label: string, run: () => void, busy: boolean, opts?: { danger?: boolean; note?: string; blocked?: boolean }) =>
    actions.includes(action) && (
      <div key={action} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button className={`l-btn small${opts?.danger ? " danger" : ""}`} type="button" disabled={busy || !!opts?.blocked} onClick={run}>{busy ? "Working…" : label}</button>
        {opts?.note && <span className="l-note">{opts.note}</span>}
      </div>
    );

  return (
    <div>
      <AppBar active="deliveries" />
      <main className="l-wrap" style={{ paddingBlock: "40px 64px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32 }}>
          <div style={{ minWidth: 0 }}>
            <div className="l-eyebrow" style={{ marginBottom: 8 }}><Link href="/app" style={{ textDecoration: "none" }}>Deliveries</Link> / Delivery</div>
            <h1 className="l-display" style={{ fontSize: "clamp(34px, 5vw, 52px)", lineHeight: 1, margin: 0, wordBreak: "break-word", textTransform: "none" }}>{id} <span style={{ color: "var(--ink2)" }}>{e.filename}</span></h1>
          </div>
          <div className="l-stamp yellow">{statusWords(e)}</div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 40, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 620px", minWidth: 0, display: "flex", flexDirection: "column", gap: 32 }}>

            <section className="l-panel" aria-label="What the validators checked">
              <div className="l-panel-head"><span>What the validators checked</span><span style={{ color: "var(--ink2)" }}>The verifier's latest recorded state</span></div>
              <div className="l-panel-body">
                <div className="l-kv">
                  <div className="k">Artifact</div><div className="l-mono" style={{ fontSize: 13 }}>{e.artifact_url}{att && Number(att.size) > 0 ? <span style={{ color: "var(--ink2)" }}> · {Number(att.size).toLocaleString("en-US")} bytes</span> : null}</div>
                  <div className="k">List</div><div className="l-mono" style={{ fontSize: 13 }}>{e.manifest_url}</div>
                  <div className="k">Pinned to</div><div className="l-mono" style={{ fontSize: 13 }}>{e.pin}</div>
                  {e.expected && (<><div className="k">Agreed digest</div><div className="l-mono" style={{ fontSize: 13 }}>{short(e.expected, 16, 10)} {att && computed && <span className={computed === e.expected ? "l-ok" : "l-bad"}>{computed === e.expected ? "matches" : "does not match"}</span>}</div></>)}
                </div>
                <div style={{ marginTop: 22, borderTop: "1px dashed var(--line)", paddingTop: 20, display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ flex: "1 1 440px", minWidth: 0 }}>
                    <div className="l-label">Listed by the publisher</div>
                    <div className="l-digest" style={{ margin: "2px 0 14px" }}>{listed || "not read yet"}</div>
                    <div className="l-label">Computed from the bytes{att?.status === "drifted" ? " (now different)" : ""}</div>
                    <div className={`l-digest ${matches ? "good" : computed ? "bad" : ""}`} style={{ margin: "2px 0 0" }}>{computed || "not checked yet"}</div>
                  </div>
                  <div className={`l-stamp ${stamp.cls}`}>{stamp.text}</div>
                </div>
                {e.digest && <p className="l-note" style={{ margin: "16px 0 0" }}>Committed at verification: <span className="l-mono">{short(e.digest, 16, 10)}</span></p>}
              </div>
            </section>

            <section className="l-panel" aria-label="Chain of custody">
              <div className="l-panel-head"><span>Chain of custody</span></div>
              <div style={{ padding: "8px 24px 20px" }}>
                {unlinked && <p className="l-note">The verifier has no record of this release yet.</p>}
                {chain.map((l, i) => (
                  <div key={l.id} className="l-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="l-mono">{l.filename}</div>
                      <div className="l-note">{i === 0 ? "This build." : "Its source."} {Number(l.checked_at) > 0 ? `Last checked ${when(l.checked_at)}.` : "Never checked."} List: <span className="l-mono">{short(l.manifest_url.replace("https://", ""), 28, 18)}</span></div>
                    </div>
                    <div className="l-display" style={{ letterSpacing: "0.12em", fontWeight: 700, color: l.status === "verified" ? "var(--green)" : l.status === "pending" ? "var(--ink2)" : "var(--red)" }}>{l.status}</div>
                  </div>
                ))}
                {chain.length > 0 && <p className="l-note" style={{ margin: "12px 0 0" }}>This is the verifier's latest state. The escrow reads only what has finalized.</p>}
              </div>
            </section>

            <section className="l-panel" aria-label="Progress">
              <div className="l-panel-head"><span>Progress, and how final each step is</span></div>
              <div style={{ padding: "8px 24px 20px" }}>
                <Step mark="done" title={`Funded, ${formatGen(e.amount)} GEN`} note="Escrow held by the contract" />
                <Step mark={e.status === "proposed" ? "now" : "done"} title={e.status === "proposed" ? "Waiting for the provider to accept the exact terms" : "Provider accepted the exact terms"} note={`Terms digest ${short(e.terms_hash, 12, 8)}`} />
                <Step mark={e.status === "funded" ? "now" : e.status === "proposed" ? "wait" : "done"} title={e.status === "submitted" || ["verified", "decided", "settled"].includes(e.status) ? "Provider marked it shipped" : "Waiting for the provider to ship"} note={`Ship by ${when(e.deadline)}`} />
                <Step mark={e.status === "submitted" ? "now" : ["verified", "decided", "settled"].includes(e.status) ? "done" : "wait"} title={["verified", "decided", "settled"].includes(e.status) ? "Verified: the digest matches" : "Verification"} note={["verified", "decided", "settled"].includes(e.status) ? `${e.links} link${e.links === "1" ? "" : "s"} vouched for in finalized state` : "Needs a verdict that has finalized, about 30 minutes after the check."} right={["verified", "decided", "settled"].includes(e.status) ? when(e.verified_at) : undefined} />
                <Step mark={e.status === "verified" ? (windowOpen(e, now) ? "now" : "done") : ["decided", "settled"].includes(e.status) ? "done" : "wait"} title="Watch window" note={e.status === "verified" ? (windowOpen(e, now) ? `Closes in ${span(end - now)}. Anyone can re-check the files while it runs.` : "Closed.") : "Starts when the release is verified."} />
                <Step mark={e.status === "verified" && now >= end ? (needAfterWindow.length === 0 && drift.length === 0 ? "done" : "now") : ["decided", "settled"].includes(e.status) ? "done" : "wait"} title="Every link checked again after the window" note={blocker ?? (e.status === "verified" ? "All checked. Release can record the outcome." : "A check made after the window closes, and finalized, is what lets the provider be paid.")} />
                <Step mark={e.status === "decided" ? "now" : e.status === "settled" ? "done" : "wait"} title={e.status === "decided" || e.status === "settled" ? `Outcome recorded: ${e.outcome === "provider" ? "pay the provider" : e.outcome === "split" ? "split evenly" : "refund the client"}` : "Outcome"} note={e.reason ? `Reason: ${e.reason}` : "Release or refund records it. Moves no money."} />
                <Step mark={e.status === "settled" ? "done" : "wait"} title="Settled" note="Settle pays the recorded outcome, once, in its own transaction." />
              </div>
              {pending.length > 0 && (
                <div style={{ padding: "0 24px 20px" }}>
                  {pending.map((w) => (
                    <div key={w.txHash} className="l-note l-pending" style={{ padding: "8px 12px", marginTop: 8, wordBreak: "break-word", color: w.failed ? "var(--red)" : "var(--ink)" }}>
                      {w.failed ? `✗ ${w.label}: ${w.failed}` : `… ${w.label}: recorded, not final yet. It counts as done once its transaction finalizes (about 30 minutes on Bradbury).`}{" "}
                      <a href={getTxExplorerUrl(w.txHash)} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{w.txHash.slice(0, 14)}…</a>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside style={{ flex: "1 1 360px", minWidth: 0, maxWidth: 460, display: "flex", flexDirection: "column", gap: 24 }}>
            <section className="l-panel" aria-label="Parties and money">
              <div className="l-panel-head"><span>Parties and money</span></div>
              <div className="l-panel-body">
                <div className="l-kv" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
                  <div className="k">Client</div><div className="l-mono" style={{ fontSize: 13 }}><a href={getAddressExplorerUrl(e.client)} target="_blank" rel="noreferrer">{short(e.client, 6, 4)}</a>{address && address.toLowerCase() === e.client.toLowerCase() ? ", you" : ""}</div>
                  <div className="k">Provider</div><div className="l-mono" style={{ fontSize: 13 }}><a href={getAddressExplorerUrl(e.provider)} target="_blank" rel="noreferrer">{short(e.provider, 6, 4)}</a>{address && address.toLowerCase() === e.provider.toLowerCase() ? ", you" : ""}</div>
                  <div className="k">Escrowed</div><div style={{ fontWeight: 600 }}>{formatGen(e.amount)} GEN</div>
                  <div className="k">Watch window</div><div>{span(Number(e.window))}</div>
                  <div className="k">Stuck case</div><div>Recoverable {span(Number(e.stale_after))} after it stalls{Number(e.stale_at) > 0 ? ` (from ${when(e.stale_at)})` : ""}</div>
                  <div className="k">Attestation</div><div className="l-mono" style={{ fontSize: 12 }}>{short(e.attestation_id, 10, 6)}</div>
                </div>
              </div>
            </section>

            <section className="l-panel" aria-label="Your move">
              <div className="l-panel-head"><span>Your move</span></div>
              <div className="l-panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p className="l-note" style={{ margin: 0 }}>{role(e, address)}</p>
                {e.status === "verified" && drift.length === 0 && <p className="l-note" style={{ margin: 0 }}>The file matches the publisher's list. During the window anyone can re-check it. If a file changed, the refund unlocks once that change is on record and has finalized.</p>}
                {drift.length > 0 && e.status === "verified" && <p className="l-bad" style={{ margin: 0 }}>The verifier no longer vouches for {drift.length === 1 ? "a link" : `${drift.length} links`}. The refund can be recorded once that has finalized.</p>}

                {row("accept", "Accept these terms", () => accept.run({ id }), accept.isPending, { note: `Records this digest of the exact terms: ${short(e.terms_hash, 12, 8)}.` })}
                {row("submit", "Mark as shipped", () => submit.run({ id }), submit.isPending)}
                {connected && toCheck.length > 0 && ["proposed", "funded", "submitted", "verified"].includes(e.status) && (e.status !== "verified" || now >= end) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button className="l-btn small ghost" type="button" disabled={recheck.isPending} onClick={() => recheck.run({ subject: id, attestationIds: toCheck.map((l) => l.id) })}>
                      {recheck.isPending ? "Working…" : `Ask validators to check ${toCheck.length === 1 ? "the file" : `${toCheck.length} files`}`}
                    </button>
                    <span className="l-note">One check per file every five minutes. The verdict counts once it finalizes.</span>
                  </div>
                )}
                {row("verify", "Verify now", () => verify.run({ id }), verify.isPending, { note: "Needs the verifier's verdict to have finalized." })}
                {row("release", "Record the release", () => release.run({ id }), release.isPending, { blocked: !!blocker, note: blocker ?? "Records the outcome. Settle pays it." })}
                {row("refund_drift", "Record a refund, a file changed", () => refund.run({ id }), refund.isPending, { danger: true, blocked: drift.length === 0, note: drift.length === 0 ? "Unlocks when a link no longer checks out." : undefined })}
                {row("settle", e.outcome === "provider" ? "Settle: pay the provider" : "Settle: refund the client", () => settle.run({ id }), settle.isPending, { note: "Pays once. The money moves when this finalizes." })}
                {row("reclaim_timeout", e.status === "proposed" ? "Cancel and reclaim" : "Reclaim the escrow", () => reclaimT.run({ id }), reclaimT.isPending, { danger: true })}
                {row("reclaim_stale", staleKind(e, now) === "verified" ? "Recover: split evenly" : "Recover the stuck submission", () => reclaimS.run({ id }), reclaimS.isPending, { danger: true, note: staleKind(e, now) === "verified" ? "Nobody could confirm it after the window. It splits evenly." : "The release was never verified. This refunds the client." })}
                {actions.length === 0 && toCheck.length === 0 && connected && <p className="l-note" style={{ margin: 0 }}>Nothing for you to do right now.</p>}

                {[accept, submit, recheck, verify, release, refund, settle, reclaimT, reclaimS].map((h, i) => (h.progress ? <TxProgress key={i} progress={h.progress} pending={h.isPending} /> : null))}
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
