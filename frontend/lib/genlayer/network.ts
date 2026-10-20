/**
 * The GenLayer network the app talks to, chosen at build time by NEXT_PUBLIC_GENLAYER_CHAIN_ID.
 * Everything that differs between networks lives here: the wallet's network parameters, the explorer, and how long finality takes,
 * so the copy the app shows never claims "about 30 minutes" on a network that finalizes in under a minute.
 */
export interface Network {
  id: number;
  key: "bradbury" | "studionet";
  /** The name the wallet shows. */
  chainName: string;
  /** The name used in running text. */
  short: string;
  rpc: string;
  explorer: string;
  /** How long a write takes to FINALIZE, in words. Writes are always watched until then. */
  finality: string;
  isStudio: boolean;
}

export const BRADBURY: Network = {
  id: 4221,
  key: "bradbury",
  chainName: "GenLayer Bradbury Testnet",
  short: "Bradbury testnet",
  rpc: "https://rpc-bradbury.genlayer.com",
  explorer: "https://explorer-bradbury.genlayer.com",
  finality: "about 30 minutes",
  isStudio: false,
};

export const STUDIONET: Network = {
  id: 61999,
  key: "studionet",
  chainName: "GenLayer Studionet",
  short: "Studionet",
  rpc: "https://studio.genlayer.com/api",
  explorer: "https://explorer-studio.genlayer.com",
  finality: "about a minute",
  isStudio: true,
};

const NETWORKS: Record<number, Network> = { [BRADBURY.id]: BRADBURY, [STUDIONET.id]: STUDIONET };

/** An unknown chain id falls back to Bradbury, in the same place and the same way the chain object does (see chains.ts). */
export function networkFor(chainId: number): Network {
  return NETWORKS[chainId] ?? BRADBURY;
}

export const NETWORK: Network = networkFor(parseInt(process.env.NEXT_PUBLIC_GENLAYER_CHAIN_ID || String(BRADBURY.id), 10));
