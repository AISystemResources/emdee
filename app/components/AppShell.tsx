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
  /**
   * SPRINT-188: hard-disable all edit UI. Set true by the admin
   * viewer so writes can't even be attempted (API-layer refusal is
   * belt-and-braces; this is the belt).
   */
  readOnly?: boolean;
}

export function AppShell({ namespace, showCta = false, readOnly = false }: AppShellProps) {
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      {showCta && <PublicLandingCta />}
      <div style={{ flex: 1, minHeight: 0 }}>
        <App namespace={namespace} readOnly={readOnly} />
      </div>
    </div>
  );
}
