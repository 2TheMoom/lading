"use client";

import { getTxExplorerUrl } from "@/lib/genlayer/chains";
import type { WriteProgress } from "@/lib/contracts/Lading";

const STAGES: { key: WriteProgress["stage"]; label: string }[] = [
  { key: "signing", label: "Sign in wallet" },
  { key: "submitted", label: "Sent" },
  { key: "accepted", label: "Accepted by validators" },
  { key: "confirmed", label: "State read back (not final)" },
];
const ORDER = ["signing", "submitted", "accepted", "confirmed", "finalized"];

/** How far a write has got. Accepted is not done, and neither is "state read back": done is FINALIZED. */
export function TxProgress({ progress, pending }: { progress: (WriteProgress & { at: number }) | null; pending: boolean }) {
  if (!progress) return null;
  const at = progress.stage === "failed" ? ORDER.indexOf("confirmed") : ORDER.indexOf(progress.stage);
  return (
    <div className="l-mono" style={{ fontSize: 12, color: "var(--ink2)", marginTop: 14 }} aria-live="polite">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
        {STAGES.map((st) => {
          const i = ORDER.indexOf(st.key);
          const done = at > i || (at === i && st.key === "confirmed");
          const current = at === i && !done;
          return (
            <span key={st.key} style={{ color: done ? "var(--green)" : current && pending ? "var(--ink)" : "var(--ink2)" }}>
              {done ? "✓" : current && pending ? "…" : "·"} {st.label}
            </span>
          );
        })}
        {at >= ORDER.indexOf("confirmed") && (
          <span style={{ color: progress.stage === "finalized" ? "var(--green)" : progress.stage === "failed" ? "var(--red)" : "var(--ink)", fontWeight: 500 }}>
            {progress.stage === "finalized"
              ? progress.movesFunds ? "✓ Finalized, funds delivered" : "✓ Finalized, result confirmed"
              : progress.stage === "failed"
                ? `✗ ${progress.message ?? "Did not finalize as expected"}`
                : `… Recorded, not final: waiting for finality (about 30 min${progress.movesFunds ? ", funds move then" : ""})`}
          </span>
        )}
      </div>
      {progress.txHash && (
        <a className="break-all" style={{ textDecoration: "underline" }} href={getTxExplorerUrl(progress.txHash)} target="_blank" rel="noreferrer">
          {progress.txHash.slice(0, 14)}…
        </a>
      )}
    </div>
  );
}
