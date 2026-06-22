"use client";
import dynamic from "next/dynamic";
import { PublicLandingCta } from "./PublicLandingCta";

const App = dynamic(() => import("./App").then(m => ({ default: m.App })), {
  ssr: false,
  loading: () => null,
});

interface AppShellProps {
  namespace: string;
  showCta?: boolean;
}

export function AppShell({ namespace, showCta = false }: AppShellProps) {
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      {showCta && <PublicLandingCta />}
      <div style={{ flex: 1, minHeight: 0 }}>
        <App namespace={namespace} />
      </div>
    </div>
  );
}
