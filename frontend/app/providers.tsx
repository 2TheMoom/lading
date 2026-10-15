"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { WalletProvider } from "@/lib/genlayer/WalletProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  // useState so the QueryClient is created once per component lifecycle, not on every render
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 2000, refetchOnWindowFocus: false },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>{children}</WalletProvider>
      <Toaster
        position="top-right"
        theme="light"
        closeButton
        offset="80px"
        toastOptions={{
          style: {
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: "0",
            color: "var(--ink)",
            boxShadow: "6px 6px 0 var(--line)",
            fontFamily: "var(--font-body)",
          },
        }}
      />
    </QueryClientProvider>
  );
}
