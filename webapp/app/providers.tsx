"use client";

import { useEffect } from "react";
import "reflect-metadata"; // must be in a client component, not a server component
import { SyncProvider } from "sync-engine/react";
import "@/sync/models"; // register models (side-effect import)
import { bootstrapFetcher, transactionSender } from "@/sync/fetchers";
import { WORKSPACE_ID, SSE_URL } from "@/sync/config";

export function Providers({ children }: { children: React.ReactNode }) {
  // Signal to the hydration-recovery script in layout.tsx that React mounted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEffect(() => { (window as any).__providersMounted = true; }, []);

  return (
    <SyncProvider
      config={{
        workspaceId: WORKSPACE_ID,
        transport: {
          bootstrapFetcher,
          transactionSender,
          syncUrl: `${SSE_URL}/api/events`,
        },
      }}
      fallback={
        <div style={{ padding: 40, textAlign: "center", color: "#888" }}>
          Loading sync engine...
        </div>
      }
    >
      {children}
    </SyncProvider>
  );
}
