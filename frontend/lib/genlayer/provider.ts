/**
 * Finding the MetaMask provider when several wallets are installed.
 *
 * `window.ethereum` is one shared slot, and every wallet extension fights over it. Rabby, for one, puts a proxy there, and a wallet that
 * is locked, asleep or set up differently can leave every request to that slot hanging forever, which froze this app on "Connecting".
 * The standard answer is EIP-6963: each wallet announces itself, and the app picks the one it means. This file holds the choosing
 * (pure, tested) and the discovery (the only part that touches the page).
 */

export interface Announced {
  info?: { rdns?: string; name?: string };
  provider: any;
}

const METAMASK_RDNS = ["io.metamask", "io.metamask.flask"];
const IMPOSTER_FLAGS = ["isRabby", "isPhantom", "isBraveWallet", "isCoinbaseWallet", "isTrust", "isOkxWallet", "isKeplr"];

/** The MetaMask provider among what the page can see, or whatever owns window.ethereum when no wallet announced itself. */
export function pickMetaMask(announced: Announced[], legacy: any[] | undefined, current: any): any | null {
  const viaAnnouncement = announced.find((a) => METAMASK_RDNS.includes(a.info?.rdns ?? ""));
  if (viaAnnouncement) return viaAnnouncement.provider;
  const viaLegacyList = (legacy ?? []).find((p) => p?.isMetaMask && !IMPOSTER_FLAGS.some((f) => p[f]));
  if (viaLegacyList) return viaLegacyList;
  return current ?? null;
}

/** Collect what the installed wallets announce right now. Wallets answer the request event synchronously. */
export function announcedProviders(): Announced[] {
  if (typeof window === "undefined") return [];
  const found: Announced[] = [];
  const on = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d?.provider) found.push(d);
  };
  window.addEventListener("eip6963:announceProvider", on);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.removeEventListener("eip6963:announceProvider", on);
  return found;
}

/** The provider to talk to: MetaMask's own, not whichever wallet currently owns window.ethereum. */
export function findMetaMask(): any | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return pickMetaMask(announcedProviders(), w.ethereum?.providers, w.ethereum);
}

/** A promise that gives up: a wallet that never answers must not leave the page waiting forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}
