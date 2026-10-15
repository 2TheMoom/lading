"use client";

import Link from "next/link";
import { useWallet } from "@/lib/genlayer/wallet";
import { short } from "@/lib/limits";
import { Brand } from "./Mark";

/** The header every app screen shares: brand, the two app destinations, the network and the wallet. */
export function AppBar({ active }: { active?: "deliveries" | "new" }) {
  const wallet = useWallet();
  return (
    <header className="l-nav">
      <Brand />
      <nav className="l-navlinks" aria-label="App">
        <Link href="/app" className={active === "deliveries" ? "on" : undefined}>Deliveries</Link>
        <Link href="/app/new" className={active === "new" ? "on" : undefined}>New escrow</Link>
        <span className="l-mono l-note">Bradbury 4221</span>
        {wallet.isConnected && wallet.address ? (
          <>
            <span className="l-chip" title={wallet.address}>{short(wallet.address, 6, 4)}</span>
            <button className="l-btn ghost small" type="button" onClick={() => wallet.switchWalletAccount().catch(() => undefined)}>Switch account</button>
            <button className="l-btn ghost small" type="button" onClick={wallet.disconnectWallet}>Disconnect</button>
          </>
        ) : (
          <button className="l-btn small" type="button" disabled={wallet.isLoading} onClick={() => wallet.connectWallet().catch(() => undefined)}>
            {wallet.isLoading ? "Connecting" : "Connect wallet"}
          </button>
        )}
      </nav>
    </header>
  );
}
