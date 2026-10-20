import Link from "next/link";
import { Brand } from "@/components/Mark";
import { NETWORK } from "@/lib/genlayer/network";

const REPO = "https://github.com/2TheMoom/lading";

function Digest({ children, tone }: { children: string; tone?: "good" | "bad" }) {
  return <div className={`l-digest${tone ? ` ${tone}` : ""}`}>{children}</div>;
}

export default function Landing() {
  return (
    <div>
      <header className="l-nav">
        <Brand />
        <nav className="l-navlinks" aria-label="Page">
          <a href="#how">How a delivery is paid</a>
          <a href="#custody">Chain of custody</a>
          <a href="#refuses">What it refuses</a>
          <a href="#limits">Limits</a>
          <Link href="/app" className="l-btn small">Open the app</Link>
        </nav>
      </header>

      {/* hero */}
      <section className="l-wrap" style={{ paddingBlock: "72px 64px", display: "flex", flexWrap: "wrap", gap: 56, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 440px", minWidth: 0 }}>
          <div className="l-eyebrow" style={{ marginBottom: 20 }}>Escrow for software delivery on GenLayer</div>
          <h1 className="l-display l-hero-title">Pay when the build matches.</h1>
          <p style={{ fontSize: 20, maxWidth: 540, margin: "0 0 20px" }}>
            Lading holds the money. Validators download the real release, hash it, and check it against the checksum list the publisher already ships. A match pays the developer. A mismatch sends the money back.
          </p>
          <p style={{ color: "var(--ink2)", maxWidth: 540, margin: "0 0 36px" }}>No marker line on a page that someone wrote for the occasion. The evidence is the file itself.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            <Link href="/app/new" className="l-btn">Fund an escrow</Link>
            <Link href="/app" className="l-btn ghost">See deliveries</Link>
          </div>
        </div>

        <div style={{ flex: "1 1 520px", minWidth: 0, maxWidth: 640 }}>
          <div className="l-panel" style={{ boxShadow: "10px 10px 0 var(--line)" }}>
            <div className="l-panel-head"><span>Bill of lading</span><span style={{ color: "var(--ink2)" }}>Real run, {NETWORK.short}</span></div>
            <div style={{ padding: 22 }}>
              <div className="l-kv" style={{ gridTemplateColumns: "100px minmax(0, 1fr)" }}>
                <div className="k">Artifact</div><div className="l-mono">jq-linux-amd64 <span style={{ color: "var(--ink2)" }}>2,319,424 bytes</span></div>
                <div className="k">Parent</div><div className="l-mono">jq-1.7.1.tar.gz <span className="l-ok">verified</span></div>
                <div className="k">List</div><div className="l-mono" style={{ fontSize: 12.5 }}>github.com/jqlang/jq/releases/download/jq-1.7.1/sha256sum.txt</div>
              </div>
              <div style={{ marginTop: 20, borderTop: "1px dashed var(--line)", paddingTop: 18 }}>
                <div className="l-label">Listed by the publisher</div>
                <Digest>5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5</Digest>
                <div className="l-label" style={{ marginTop: 12 }}>Computed by validators</div>
                <Digest tone="good">5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5</Digest>
              </div>
              <div style={{ marginTop: 22, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div className="l-note" style={{ maxWidth: 260 }}>Every validator downloaded the file and got the same digest.</div>
                <div className="l-stamp green">Verified</div>
              </div>
            </div>
            <div style={{ borderTop: "2px dashed var(--line)", padding: "18px 22px", background: "var(--panel2)" }}>
              <div className="l-label" style={{ marginBottom: 6 }}>Same name, wrong file</div>
              <div className="l-digest l-bad" style={{ fontSize: 12.5 }}>jq-linux-arm64 bytes served as jq-linux-amd64: computed 4dd2d8a0661df0b2…, listed 5942c9b0934e510e…</div>
              <div className="l-stamp red" style={{ marginTop: 10, fontSize: 20, padding: "2px 12px", borderWidth: 2 }}>Mismatch</div>
            </div>
          </div>
        </div>
      </section>

      {/* how */}
      <section id="how" className="l-wrap" style={{ paddingBlock: "56px" }}>
        <h2 className="l-display" style={{ fontSize: 48, margin: "0 0 8px" }}>How a delivery is paid</h2>
        <p style={{ color: "var(--ink2)", maxWidth: 640, margin: "0 0 36px" }}>Each step is a transaction you can read back from the contract.</p>
        <div className="l-steps">
          <div><div className="l-tag">Fund</div><p style={{ margin: 0 }}>The client escrows GEN against a release: the artifact URL, the publisher's checksum list, the filename the list should name, and optionally the exact digest they expect. The provider accepts by passing a digest of those exact terms.</p></div>
          <div><div className="l-tag">Ship</div><p style={{ margin: 0 }}>The provider publishes the release where the publisher publishes it and marks the work ready. Nothing is uploaded to Lading and nobody vouches by hand.</p></div>
          <div><div className="l-tag">Verify</div><p style={{ margin: 0 }}>Validators download the file and the list, hash the file, and agree on the verdict. Lading acts only on verdicts that have finalized, so nothing can be appealed away after the money moves.</p></div>
          <div><div className="l-tag">Settle</div><p style={{ margin: 0 }}>A watch window follows and anyone can re-check the files. If they changed, the client is refunded. If every link still matches after the window, the provider is paid. Settlement is its own transaction.</p></div>
        </div>
      </section>

      {/* custody */}
      <section id="custody" className="l-dark" style={{ padding: "64px 0" }}>
        <div className="l-wrap">
          <h2 className="l-display" style={{ fontSize: 48, margin: "0 0 8px", color: "#fff" }}>A build is only as good as its source</h2>
          <p style={{ color: "var(--dark-dim)", maxWidth: 680, fontSize: 17, margin: "0 0 40px" }}>A release is a chain: source, then a build, then a package. Lading can require every link. If the source later changes, everything built from it stops being trusted.</p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: 0 }}>
            {[
              { k: "Root", n: "jq-1.7.1.tar.gz", d: "1,950,645 bytes. Listed and computed digests agree.", s: "Verified", c: "var(--dark-green)", b: "solid" },
              { k: "Built from the root", n: "jq-linux-amd64", d: "2,319,424 bytes. The same list that names this file also names the root's digest.", s: "Verified, bound to its parent", c: "var(--dark-green)", b: "solid" },
              { k: "If the root is edited later", n: "Everything above it", d: "The root reads drifted. The build is untouched, but it is no longer trusted.", s: "Not trusted", c: "var(--dark-red)", b: "dashed" },
            ].flatMap((x, i, all) => [
              <div key={x.k} style={{ flex: "1 1 260px", minWidth: 0, border: `1px ${x.b} var(--dark-line)`, padding: 22 }}>
                <div className="l-mono" style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#a9a79d" }}>{x.k}</div>
                <div className="l-mono" style={{ fontSize: 16, margin: "6px 0 10px", color: "#fff" }}>{x.n}</div>
                <div style={{ fontSize: 14, color: "var(--dark-dim)" }}>{x.d}</div>
                <div className="l-display" style={{ marginTop: 14, letterSpacing: "0.14em", fontSize: 16, color: x.c }}>{x.s}</div>
              </div>,
              i < all.length - 1 ? (
                <div key={`a${i}`} aria-hidden="true" style={{ flex: "0 0 64px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="48" height="24" viewBox="0 0 48 24" fill="none"><path d="M0 12h44M36 4l8 8-8 8" stroke="#a9a79d" strokeWidth="2" /></svg>
                </div>
              ) : null,
            ])}
          </div>
          <p style={{ margin: "32px 0 0", color: "var(--dark-dim)", maxWidth: 760, fontSize: 15 }}>Trust can also be pinned to a publisher. A chain vouched for on someone else's site passes a plain check but fails one pinned to the real release path.</p>
        </div>
      </section>

      {/* refuses */}
      <section id="refuses" className="l-wrap" style={{ paddingBlock: "64px" }}>
        <h2 className="l-display" style={{ fontSize: 48, margin: "0 0 36px" }}>What it refuses to do</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0 56px" }}>
          {[
            [
              ["Treat an error as a verdict", "A timeout, a 404 or an empty page records nothing. Only a file that was read can be a mismatch."],
              ["Pay twice, or pay on a guess", "A decision only records an outcome. The payout is a separate transaction, recorded once, so a validator rotation cannot leave a stray transfer behind."],
              ["Read part of a file", "A file that cannot be read in full is refused, never cut short and hashed."],
            ],
            [
              ["Call a write done too early", `The app says "recorded, not final" until the transaction finalizes, ${NETWORK.finality} on ${NETWORK.short}, then confirms the result and the state.`],
              ["Take a bad request's money", `On ${NETWORK.short} a refused call keeps its value, so the form checks every rule before it asks your wallet to send anything.`],
              ["Hide who vouched", "Every link shows the list it was checked against, so a self-made chain cannot pass for the real one."],
            ],
          ].map((col, ci) => (
            <div key={ci} style={{ flex: "1 1 460px", minWidth: 0 }}>
              {col.map(([h, t], i) => (
                <div key={h} style={{ padding: "20px 0", borderTop: "1px solid var(--ink)", borderBottom: i === col.length - 1 ? "1px solid var(--ink)" : undefined }}>
                  <div className="l-display" style={{ fontSize: 22, letterSpacing: "0.06em" }}>{h}</div>
                  <p style={{ margin: "6px 0 0", fontSize: 15, color: "var(--ink2)" }}>{t}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* limits */}
      <section id="limits" style={{ background: "var(--panel2)", borderBlock: "1px solid var(--line)", padding: "56px 0" }}>
        <div className="l-wrap" style={{ display: "flex", flexWrap: "wrap", gap: 40 }}>
          <div style={{ flex: "0 1 300px" }}><h2 className="l-display" style={{ fontSize: 36, margin: 0 }}>Limits, stated plainly</h2></div>
          <div style={{ flex: "1 1 520px", minWidth: 0, fontSize: 15 }}>
            <p style={{ margin: "0 0 12px" }}>It trusts the publisher's list. If a publisher is compromised and replaces the file and the list together, the first reading is whatever was served. Lading makes later silent changes visible. It does not make the first publication honest.</p>
            <p style={{ margin: 0 }}>The parent link is vouched for by the publisher's list, not proven. Lading checks one list names both files. It cannot show the build was compiled from that source. The README lists every other limit.</p>
          </div>
        </div>
      </section>

      {/* cta */}
      <section className="l-wrap" style={{ paddingBlock: "72px", display: "flex", flexWrap: "wrap", gap: 32, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ flex: "1 1 480px", minWidth: 0 }}>
          <div className="l-display" style={{ fontSize: 56, lineHeight: 1, textWrap: "balance" }}>Put a real release behind the money.</div>
          <p style={{ margin: "14px 0 0", color: "var(--ink2)", maxWidth: 560 }}>Runs on GenLayer {NETWORK.short} with test GEN. Contracts, tests and a live run against the jq 1.7.1 release are public.</p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <Link href="/app/new" className="l-btn">Fund an escrow</Link>
          <a href={REPO} className="l-btn ghost">Read the contracts</a>
        </div>
      </section>

      <footer style={{ padding: "24px 48px", borderTop: "1px solid var(--line)", display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", fontSize: 13, color: "var(--ink2)" }} className="l-mono">
        <span>Lading, a bill of lading for software</span>
        <span>GenLayer {NETWORK.short}, chain {NETWORK.id}</span>
      </footer>
    </div>
  );
}
