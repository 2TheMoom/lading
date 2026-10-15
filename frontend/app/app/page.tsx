"use client";

import Link from "next/link";
import { AppBar } from "@/components/AppBar";
import { useEngagementList } from "@/lib/hooks/useLading";
import { formatGen, short } from "@/lib/limits";
import { statusWords } from "@/lib/status";

export default function Deliveries() {
  const { data, isLoading, error } = useEngagementList();
  const rows = [...(data ?? [])].reverse();
  return (
    <div>
      <AppBar active="deliveries" />
      <main className="l-wrap" style={{ paddingBlock: "40px 64px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <div className="l-eyebrow" style={{ marginBottom: 8 }}>Newest first</div>
            <h1 className="l-display" style={{ fontSize: 56, lineHeight: 1, margin: 0 }}>Deliveries</h1>
          </div>
          <Link href="/app/new" className="l-btn">New escrow</Link>
        </div>

        {isLoading && <p className="l-note">Reading the contract…</p>}
        {error && <p className="l-bad">Could not read the contract: {error.message}</p>}
        {!isLoading && rows.length === 0 && (
          <div className="l-panel"><div className="l-panel-body"><p style={{ margin: 0 }}>No deliveries yet. Fund the first escrow against a real release.</p></div></div>
        )}

        <div style={{ display: "grid", gap: 16 }}>
          {rows.map(({ id, engagement: e }) => (
            <Link key={id} href={`/app/d/${encodeURIComponent(id)}`} className="l-panel" style={{ textDecoration: "none", color: "var(--ink)", display: "block" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between", padding: "18px 24px" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="l-display" style={{ fontSize: 26, textTransform: "none", wordBreak: "break-word" }}>{id} <span style={{ color: "var(--ink2)" }}>{e.filename}</span></div>
                  <div className="l-mono l-note" style={{ wordBreak: "break-all" }}>
                    client {short(e.client, 6, 4)} to provider {short(e.provider, 6, 4)} · {formatGen(e.amount)} GEN
                  </div>
                </div>
                <div className="l-stamp yellow" style={{ fontSize: 18, padding: "2px 12px", borderWidth: 2 }}>{statusWords(e)}</div>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
