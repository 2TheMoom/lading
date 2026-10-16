"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppBar } from "@/components/AppBar";
import { TxProgress } from "@/components/TxProgress";
import { useWallet } from "@/lib/genlayer/wallet";
import { useCreateEscrow, useLadingContract } from "@/lib/hooks/useLading";
import { digestProblem, formatGen, nameProblem, normalizeUrl, pinProblem, short, timesProblem, urlProblem, MIN_WINDOW, MIN_STALE } from "@/lib/limits";
import type { PreflightItem } from "@/app/api/preflight/route";

const WINDOWS = [
  { label: "1 hour", seconds: 3600 },
  { label: "6 hours", seconds: 6 * 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "3 days", seconds: 3 * 86400 },
  { label: "7 days", seconds: 7 * 86400 },
];
const STALES = [
  { label: "2 hours", seconds: 7200 },
  { label: "6 hours", seconds: 6 * 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
];

function genToWei(text: string): bigint {
  const t = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return BigInt(0);
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * BigInt("1000000000000000000") + BigInt(frac.padEnd(18, "0"));
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="l-field">
      <label htmlFor={id} className="l-label">{label}</label>
      {children}
      {hint && <div className="l-note" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

function Check({ ok, title, note }: { ok: boolean | null; title: string; note?: string }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px dashed var(--line)" }}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flex: "0 0 20px", marginTop: 2 }}>
        {ok === true && <path d="M4 10.5l4 4 8-9" stroke="var(--green)" strokeWidth="2.4" />}
        {ok === false && <path d="M5 5l10 10M15 5L5 15" stroke="var(--red)" strokeWidth="2.4" />}
        {ok === null && <circle cx="10" cy="10" r="6" stroke="var(--edge)" strokeWidth="2" strokeDasharray="3 3" />}
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {note && <div className="l-note" style={{ wordBreak: "break-word" }}>{note}</div>}
      </div>
    </div>
  );
}

export default function NewEscrow() {
  const router = useRouter();
  const { address } = useWallet();
  const contract = useLadingContract();
  const create = useCreateEscrow();

  const [f, setF] = useState({
    id: "", provider: "", artifact: "", list: "", name: "", srcArtifact: "", srcName: "", pin: "", expected: "", amount: "", deadline: "",
  });
  const [windowSeconds, setWindowSeconds] = useState(WINDOWS[0].seconds);
  const [staleSeconds, setStaleSeconds] = useState(STALES[0].seconds);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value.trim() }));

  const artifact = normalizeUrl(f.artifact);
  const list = normalizeUrl(f.list);
  const srcArtifact = normalizeUrl(f.srcArtifact);
  const hasSource = f.srcArtifact !== "" || f.srcName !== "";
  const amountWei = genToWei(f.amount);
  const deadlineTs = f.deadline ? Math.floor(new Date(f.deadline).getTime() / 1000) : 0;

  const problems = useMemo(() => {
    const p: string[] = [];
    if (f.id && (f.id.length < 1 || f.id.length > 64)) p.push("The escrow ID must be 1 to 64 characters.");
    if (f.provider && !/^0x[0-9a-fA-F]{40}$/.test(f.provider)) p.push("The provider must be a 0x wallet address.");
    if (f.provider && address && f.provider.toLowerCase() === address.toLowerCase()) p.push("The provider cannot be your own wallet.");
    if (f.artifact) { const x = urlProblem(f.artifact); if (x) p.push(`Artifact: ${x}`); }
    if (f.list) { const x = urlProblem(f.list); if (x) p.push(`Checksum list: ${x}`); }
    if (f.name) { const x = nameProblem(f.name); if (x) p.push(x); }
    if (f.pin && f.list) { const x = pinProblem(f.pin, f.list); if (x) p.push(x); }
    if (f.expected) { const x = digestProblem(f.expected); if (x) p.push(x); }
    if (hasSource) {
      if (!f.srcArtifact || !f.srcName) p.push("Give both the source URL and its filename in the list, or neither.");
      else {
        const x = urlProblem(f.srcArtifact) || nameProblem(f.srcName);
        if (x) p.push(`Source: ${x}`);
      }
    }
    if (f.deadline) { const x = timesProblem(deadlineTs, windowSeconds, staleSeconds, Math.floor(Date.now() / 1000)); if (x) p.push(x); }
    if (f.amount && amountWei <= BigInt(0)) p.push("The amount must be a positive number of GEN.");
    return p;
  }, [f, artifact, list, srcArtifact, hasSource, amountWei, deadlineTs, windowSeconds, staleSeconds, address]);

  const filled = !!(f.id && f.provider && f.artifact && f.list && f.name && f.pin && f.deadline && amountWei > BigInt(0));
  const inputsOk = filled && problems.length === 0;

  // preflight: really download and hash the file(s) before any money is sent
  const [pre, setPre] = useState<{ state: "idle" | "loading" | "done" | "error"; list?: { readable: boolean; note: string }; items?: PreflightItem[]; error?: string }>({ state: "idle" });
  useEffect(() => {
    const urlsOk = f.artifact && f.list && f.name && !urlProblem(f.artifact) && !urlProblem(f.list) && !nameProblem(f.name) && (!hasSource || (srcArtifact && f.srcName && !urlProblem(f.srcArtifact) && !nameProblem(f.srcName)));
    if (!urlsOk) { setPre({ state: "idle" }); return; }
    setPre({ state: "loading" });
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const items = [{ artifact, name: f.name }, ...(hasSource ? [{ artifact: srcArtifact, name: f.srcName }] : [])];
        const res = await fetch("/api/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ list, items }), signal: ctl.signal });
        const json = await res.json();
        if (!res.ok) setPre({ state: "error", error: json.error ?? "The check failed." });
        else setPre({ state: "done", list: json.list, items: json.items });
      } catch (e: any) {
        if (e?.name !== "AbortError") setPre({ state: "error", error: "The check could not run." });
      }
    }, 700);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [f.artifact, f.list, f.name, f.srcArtifact, f.srcName, artifact, list, srcArtifact, hasSource]);

  const main = pre.items?.[0];
  const src = hasSource ? pre.items?.[1] : undefined;
  const preOk = pre.state === "done" && pre.list?.readable === true && main?.verdict === "match" && (!hasSource || src?.verdict === "match");
  const agreedOk = f.expected === "" || (main?.computed ? main.computed === f.expected : null);

  // what the verifier already knows about this release
  const [reg, setReg] = useState<{ id: string; status: string | null } | null>(null);
  useEffect(() => {
    if (!contract || !inputsOk) { setReg(null); return; }
    let live = true;
    (async () => {
      try {
        let parent = "";
        if (hasSource) parent = await contract.attestationId(srcArtifact, list, f.srcName, "");
        const id = await contract.attestationId(artifact, list, f.name, parent);
        const a = await contract.getAttestation(id);
        if (live) setReg({ id, status: a ? a.status : null });
      } catch {
        if (live) setReg(null);
      }
    })();
    return () => { live = false; };
  }, [contract, inputsOk, artifact, list, f.name, srcArtifact, f.srcName, hasSource]);

  const canFund = !!address && inputsOk && preOk && agreedOk !== false && !create.isPending;

  const fund = async () => {
    if (!contract || !canFund) return;
    let parent = "";
    if (hasSource) parent = await contract.attestationId(srcArtifact, list, f.srcName, "");
    create.run(
      { id: f.id, provider: f.provider, artifact, list, name: f.name, parent, pin: f.pin, expected: f.expected, deadline: deadlineTs, window: windowSeconds, stale: staleSeconds, amountWei, source: hasSource ? { artifact: srcArtifact, name: f.srcName } : undefined },
      { onSuccess: () => router.push(`/app/d/${encodeURIComponent(f.id)}`) } as any
    );
  };

  const inputCls = (bad: boolean) => `l-input${bad ? " bad" : ""}`;

  return (
    <div>
      <AppBar active="new" />
      <main className="l-wrap" style={{ paddingBlock: "40px 64px" }}>
        <div className="l-eyebrow" style={{ marginBottom: 8 }}>Nothing is sent until you press Fund</div>
        <h1 className="l-display" style={{ fontSize: 56, lineHeight: 1, margin: "0 0 32px" }}>New escrow</h1>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 40, alignItems: "flex-start" }}>
          <div className="l-panel" style={{ flex: "1 1 560px", minWidth: 0 }}>
            <div className="l-panel-head"><span>Shipment</span></div>
            <div className="l-panel-body" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
                <div style={{ flex: "1 1 200px", minWidth: 0 }}><Field id="f-id" label="Escrow ID"><input id="f-id" className="l-input" value={f.id} onChange={set("id")} placeholder="lad-0001" /></Field></div>
                <div style={{ flex: "2 1 300px", minWidth: 0 }}><Field id="f-prov" label="Provider address"><input id="f-prov" className="l-input" value={f.provider} onChange={set("provider")} placeholder="0x…" /></Field></div>
              </div>
              <Field id="f-art" label="Artifact URL" hint="The file validators download and hash. Use a URL that never changes, such as a release asset.">
                <input id="f-art" className={inputCls(!!f.artifact && !!urlProblem(f.artifact))} value={f.artifact} onChange={set("artifact")} placeholder="https://github.com/…/releases/download/…/app-linux-amd64" />
              </Field>
              <Field id="f-list" label="Publisher's checksum list" hint="Plain sha256sum format: a 64 character digest, then the filename.">
                <input id="f-list" className={inputCls(!!f.list && !!urlProblem(f.list))} value={f.list} onChange={set("list")} placeholder="https://github.com/…/releases/download/…/sha256sum.txt" />
              </Field>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}><Field id="f-name" label="Filename in the list"><input id="f-name" className={inputCls(!!f.name && !!nameProblem(f.name))} value={f.name} onChange={set("name")} placeholder="app-linux-amd64" /></Field></div>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}><Field id="f-pin" label="Pin the publisher" hint="Every link's list must live under this address."><input id="f-pin" className={inputCls(!!f.pin && !!f.list && !!pinProblem(f.pin, f.list))} value={f.pin} onChange={set("pin")} placeholder="https://github.com/…/releases/" /></Field></div>
              </div>
              <Field id="f-exp" label="Agreed digest (optional)" hint="If you already know the exact sha256 you expect, enter it: only that file can ever be paid for.">
                <input id="f-exp" className={inputCls(!!f.expected && !!digestProblem(f.expected))} value={f.expected} onChange={set("expected")} placeholder="64 lowercase hex digits" />
              </Field>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
                <div style={{ flex: "2 1 300px", minWidth: 0 }}><Field id="f-src" label="Built from, URL (optional)" hint="The source the build comes from, listed in the same checksum list."><input id="f-src" className="l-input" value={f.srcArtifact} onChange={set("srcArtifact")} placeholder="https://…/app-1.0.tar.gz" /></Field></div>
                <div style={{ flex: "1 1 200px", minWidth: 0 }}><Field id="f-srcn" label="Source filename"><input id="f-srcn" className="l-input" value={f.srcName} onChange={set("srcName")} placeholder="app-1.0.tar.gz" /></Field></div>
              </div>
            </div>

            <div className="l-panel-head" style={{ borderTop: "2px solid var(--ink)" }}><span>Money and time</span></div>
            <div className="l-panel-body" style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
              <div style={{ flex: "1 1 150px", minWidth: 0 }}><Field id="f-amt" label="Amount (GEN)" hint="Held until the release is confirmed."><input id="f-amt" className="l-input" value={f.amount} onChange={set("amount")} placeholder="0.002" /></Field></div>
              <div style={{ flex: "1 1 190px", minWidth: 0 }}><Field id="f-dl" label="Ship by"><input id="f-dl" type="datetime-local" className="l-input" value={f.deadline} onChange={(e) => setF((s) => ({ ...s, deadline: e.target.value }))} /></Field></div>
              <div style={{ flex: "1 1 170px", minWidth: 0 }}>
                <Field id="f-win" label="Watch window" hint="At least an hour, so finality fits inside.">
                  <select id="f-win" className="l-input" value={windowSeconds} onChange={(e) => setWindowSeconds(Number(e.target.value))}>
                    {WINDOWS.filter((w) => w.seconds >= MIN_WINDOW).map((w) => <option key={w.seconds} value={w.seconds}>{w.label}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ flex: "1 1 170px", minWidth: 0 }}>
                <Field id="f-stale" label="Recover a stuck case after">
                  <select id="f-stale" className="l-input" value={staleSeconds} onChange={(e) => setStaleSeconds(Number(e.target.value))}>
                    {STALES.filter((w) => w.seconds >= MIN_STALE).map((w) => <option key={w.seconds} value={w.seconds}>{w.label}</option>)}
                  </select>
                </Field>
              </div>
            </div>
          </div>

          <div style={{ flex: "1 1 360px", minWidth: 0, maxWidth: 480, display: "flex", flexDirection: "column", gap: 24 }}>
            <div className="l-panel">
              <div className="l-panel-head"><span>Checked before your wallet opens</span></div>
              <div style={{ padding: "8px 24px 18px" }}>
                <Check ok={problems.length === 0 && filled ? true : problems.length > 0 ? false : null} title="Every field passes the contract's rules" note={problems.length ? problems[0] : filled ? undefined : "Fill in the form to run the checks."} />
                <Check ok={pre.state === "idle" ? null : pre.state === "loading" ? null : pre.state === "error" ? false : pre.list?.readable ? true : false}
                  title="The checksum list can be read" note={pre.state === "loading" ? "Downloading it now…" : pre.state === "error" ? pre.error : pre.state === "done" && !pre.list?.readable ? pre.list?.note : undefined} />
                {main && (
                  <Check ok={main.verdict === "match"} title={main.verdict === "match" ? `The file matches the list: ${main.size.toLocaleString("en-US")} bytes` : "The file does not check out"}
                    note={main.verdict === "match" ? `Computed ${short(main.computed, 12, 8)}, listed ${short(main.listed[0] ?? "", 12, 8)}.` : main.note} />
                )}
                {hasSource && src && <Check ok={src.verdict === "match"} title={src.verdict === "match" ? "The source matches the same list" : "The source does not check out"} note={src.verdict === "match" ? `Computed ${short(src.computed, 12, 8)}.` : src.note} />}
                {f.expected && <Check ok={agreedOk} title="The file is the one you agreed to" note={agreedOk === false ? `It hashes to ${short(main?.computed ?? "", 12, 8)}, so verify would refuse it.` : undefined} />}
                {reg && <Check ok={true} title={reg.status ? `The verifier already knows this release: ${reg.status}` : "The verifier will register this release first"} note={reg.status ? undefined : "That is one extra transaction before the escrow is funded."} />}
              </div>
            </div>

            <div className="l-warn"><b>Read before sending</b>Your wallet will send {amountWei > BigInt(0) ? formatGen(amountWei.toString()) : "the amount"} GEN. On Bradbury a request the contract refuses keeps its money, which is why every rule is checked first and the file is downloaded and hashed here before you can fund.</div>

            {problems.length > 1 && <div className="l-bad l-note">{problems.slice(1).map((p) => <div key={p}>{p}</div>)}</div>}

            <div>
              <button className="l-btn" type="button" disabled={!canFund} onClick={fund}>
                {create.isPending ? "Working…" : `Fund ${amountWei > BigInt(0) ? formatGen(amountWei.toString()) : ""} GEN`}
              </button>
              {!address && <div className="l-note" style={{ marginTop: 8 }}>Connect a wallet to fund an escrow.</div>}
              <div className="l-note" style={{ marginTop: 8 }}>It counts as funded once it finalizes, about 30 minutes.</div>
              <TxProgress progress={create.progress} pending={create.isPending} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
