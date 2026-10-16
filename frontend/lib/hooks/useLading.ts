"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import Lading, { type CreateArgs, type WriteProgress } from "../contracts/Lading";
import { getContractAddress, getStudioUrl, getVerifierAddress } from "../genlayer/client";
import { useWallet } from "../genlayer/wallet";
import { success, error, info, configError } from "../utils/toast";
import { addPendingWrite, settlePendingWrite } from "../finality-store";
import type { Attestation, ChainLink, Engagement } from "../contracts/types";
import type { StaleKind } from "../engagement-actions";

export type { WriteProgress };

export function useLadingContract(): Lading | null {
  const { address } = useWallet();
  const escrow = getContractAddress();
  const verifier = getVerifierAddress();
  const rpcUrl = getStudioUrl();

  return useMemo(() => {
    if (!escrow || !verifier) {
      configError(
        "Setup Required",
        "Set NEXT_PUBLIC_CONTRACT_ADDRESS (the escrow) and NEXT_PUBLIC_VERIFIER_ADDRESS (the verifier it reads) in your .env file."
      );
      return null;
    }
    return new Lading(escrow, verifier, address, rpcUrl);
  }, [escrow, verifier, address, rpcUrl]);
}

export function useEngagement(id: string) {
  const contract = useLadingContract();
  return useQuery<Engagement | null, Error>({
    queryKey: ["engagement", id],
    queryFn: () => (contract ? contract.getEngagement(id) : Promise.resolve(null)),
    refetchOnWindowFocus: true,
    refetchInterval: 20000,
    staleTime: 2000,
    enabled: !!contract && !!id,
  });
}

/** The verifier's chain of custody for an attestation: what the escrow will read once it finalizes. */
export function useChain(attestationId: string | undefined) {
  const contract = useLadingContract();
  return useQuery<ChainLink[], Error>({
    queryKey: ["chain", attestationId],
    queryFn: () => (contract && attestationId ? contract.getChain(attestationId) : Promise.resolve([])),
    refetchInterval: 20000,
    staleTime: 2000,
    enabled: !!contract && !!attestationId,
  });
}

export function useAttestation(attestationId: string | undefined) {
  const contract = useLadingContract();
  return useQuery<Attestation | null, Error>({
    queryKey: ["attestation", attestationId],
    queryFn: () => (contract && attestationId ? contract.getAttestation(attestationId) : Promise.resolve(null)),
    refetchInterval: 20000,
    staleTime: 2000,
    enabled: !!contract && !!attestationId,
  });
}

/** The newest engagement ids (one page from the end of the list, never the whole history). */
export function useRecentEngagementIds(limit = 20) {
  const contract = useLadingContract();
  return useQuery<string[], Error>({
    queryKey: ["engagementIds", limit],
    queryFn: () => (contract ? contract.getRecentEngagementIds(limit) : Promise.resolve([])),
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
    staleTime: 2000,
    enabled: !!contract,
  });
}

export function useEngagementList() {
  const contract = useLadingContract();
  const idsQuery = useRecentEngagementIds();

  const listQuery = useQuery<Array<{ id: string; engagement: Engagement }>, Error>({
    queryKey: ["engagementList", idsQuery.data],
    queryFn: async () => {
      if (!contract || !idsQuery.data) return [];
      const results = await Promise.all(idsQuery.data.map(async (id) => ({ id, engagement: await contract.getEngagement(id) })));
      return results.filter((r): r is { id: string; engagement: Engagement } => r.engagement !== null);
    },
    enabled: !!contract && !!idsQuery.data,
    staleTime: 2000,
  });

  return { ...listQuery, isLoading: idsQuery.isLoading || listQuery.isLoading };
}

type Runner<TArgs> = (contract: Lading, args: TArgs, onProgress: (p: WriteProgress) => void) => Promise<string>;

interface Messages {
  recorded: { title: string; description: string };
  final?: { title: string; description: string };
  /** what to say about a transaction that went to the verifier, not the escrow (for example the release registration before funding) */
  verifier?: { title: string; description: string };
}

function useWriteAction<TArgs>(action: Runner<TArgs>, messages: Messages, errorTitle: string, getSubject: (args: TArgs) => string) {
  const contract = useLadingContract();
  const { address } = useWallet();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<(WriteProgress & { at: number }) | null>(null);

  const refresh = (subject: string) => {
    queryClient.invalidateQueries({ queryKey: ["engagement", subject] });
    queryClient.invalidateQueries({ queryKey: ["chain"] });
    queryClient.invalidateQueries({ queryKey: ["attestation"] });
    queryClient.invalidateQueries({ queryKey: ["engagementIds"] });
    queryClient.invalidateQueries({ queryKey: ["engagementList"] });
  };

  const mutation = useMutation({
    mutationFn: async (args: TArgs) => {
      if (!contract) throw new Error("Contract not configured. Please set the contract addresses in your .env file.");
      if (!address) throw new Error("Wallet not connected. Please connect your wallet first.");
      setIsPending(true);
      setProgress(null);
      const subject = getSubject(args);
      return action(contract, args, (p) => {
        setProgress({ ...p, at: Date.now() });
        // a transaction to the verifier must never be reported in the escrow's words ("Escrow funded" before any money moved)
        const say = p.target === "verifier" && messages.verifier ? messages.verifier : messages.recorded;
        const isVerifierStep = say !== messages.recorded;
        if (p.stage === "confirmed" && p.txHash) addPendingWrite(subject, { label: say.title, txHash: p.txHash, since: Date.now() });
        if (p.stage === "finalized" && p.txHash) {
          settlePendingWrite(subject, p.txHash);
          refresh(subject);
          const done = isVerifierStep
            ? { title: `${say.title}, final`, description: "The transaction finalized with a successful result and the state shows it." }
            : messages.final ?? { title: `${messages.recorded.title}, final`, description: "The transaction finalized with a successful result and the state shows it." };
          success(done.title, { description: done.description });
        } else if (p.stage === "failed" && p.txHash) {
          settlePendingWrite(subject, p.txHash, p.message || "Did not finalize as expected.");
          refresh(subject);
          error(`${say.title}: not final`, { description: p.message || "The transaction did not finalize as expected." });
        }
      });
    },
    onSuccess: (_data, args) => {
      refresh(getSubject(args));
      setIsPending(false);
      // Recorded, not done: the success message comes when the transaction finalizes.
      info(`${messages.recorded.title}: recorded, waiting for finality`, {
        description: `${messages.recorded.description} It counts as done once it finalizes (about 30 minutes on Bradbury).`,
        duration: 8000,
      });
    },
    onError: (err: any) => {
      console.error(errorTitle, err);
      setIsPending(false);
      setProgress(null);
      error(errorTitle, { description: err?.message || "Please try again." });
    },
  });

  return { ...mutation, isPending, progress, clearProgress: () => setProgress(null), run: mutation.mutate };
}

const PAYS = "The money moves when this transaction finalizes.";

export type CreateRequest = CreateArgs & { source?: { artifact: string; name: string } };

export function useCreateEscrow() {
  return useWriteAction<CreateRequest>(
    async (c, a, onProgress) => {
      // register the release (and its source) with the verifier first when nobody has; the escrow only reads finalized verdicts about it
      if (a.source) {
        const srcId = await c.attestationId(a.source.artifact, a.list, a.source.name, "");
        if (!(await c.getAttestation(srcId))) await c.attest(a.source.artifact, a.list, a.source.name, "", srcId, onProgress);
      }
      const attId = await c.attestationId(a.artifact, a.list, a.name, a.parent);
      if (!(await c.getAttestation(attId))) await c.attest(a.artifact, a.list, a.name, a.parent, attId, onProgress);
      return c.createEngagement(a, onProgress);
    },
    {
      recorded: { title: "Escrow funded", description: "The money is held. The provider must accept the exact terms before work starts." },
      verifier: { title: "Release registered with the verifier", description: "No money has moved yet. The escrow is funded in the next transaction." },
    },
    "Failed to create the escrow",
    (a) => a.id
  );
}

export function useAccept() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.accept(a.id, onProgress),
    { recorded: { title: "Terms accepted", description: "The provider agreed to the exact source, list, filename, amount and times." } },
    "Failed to accept",
    (a) => a.id
  );
}

export function useSubmit() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.submit(a.id, onProgress),
    { recorded: { title: "Marked shipped", description: "The release is ready to be verified." } },
    "Failed to mark as shipped",
    (a) => a.id
  );
}

export function useVerify() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.verify(a.id, onProgress),
    { recorded: { title: "Verified", description: "The verifier's finalized state vouches for the release. The watch window has started." } },
    "Verification did not go through",
    (a) => a.id
  );
}

export function useRelease() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.release(a.id, onProgress),
    { recorded: { title: "Release recorded", description: "Every link was checked again after the window. Nothing is paid until you settle it." } },
    "Release did not go through",
    (a) => a.id
  );
}

export function useRefundDrift() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.refundDrift(a.id, onProgress),
    { recorded: { title: "Refund recorded", description: "The verifier no longer vouches for the release. Nothing is paid until you settle it." } },
    "Refund did not go through",
    (a) => a.id
  );
}

export function useSettle() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.settle(a.id, onProgress),
    {
      recorded: { title: "Settlement recorded", description: PAYS },
      final: { title: "Settled", description: "The transaction finalized and the money was delivered, once." },
    },
    "Failed to settle",
    (a) => a.id
  );
}

export function useReclaimTimeout() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.reclaimTimeout(a.id, onProgress),
    {
      recorded: { title: "Refund recorded", description: PAYS },
      final: { title: "Refunded", description: "The transaction finalized and the escrow was returned." },
    },
    "Failed to reclaim",
    (a) => a.id
  );
}

export function useReclaimStale() {
  return useWriteAction<{ id: string; kind: StaleKind }>(
    (c, a, onProgress) => c.reclaimStale(a.id, a.kind, onProgress),
    {
      recorded: { title: "Recovery recorded", description: "Recorded. A stuck submission refunds the client once this finalizes; a split is paid by Settle." },
      final: { title: "Recovered", description: "The transaction finalized. If it recorded a split, Settle now pays it." },
    },
    "Failed to recover the engagement",
    (a) => a.id
  );
}

/** Asks the validators to hash each given link again, one after the other (the verifier allows one check per release per five minutes). */
export function useRecheck() {
  return useWriteAction<{ subject: string; attestationIds: string[] }>(
    async (c, a, onProgress) => {
      let last = "";
      for (const id of a.attestationIds) last = await c.check(id, onProgress);
      return last;
    },
    { recorded: { title: "Re-check recorded", description: "The validators hashed the file again and agreed on a verdict." } },
    "The re-check did not go through",
    (a) => a.subject
  );
}
