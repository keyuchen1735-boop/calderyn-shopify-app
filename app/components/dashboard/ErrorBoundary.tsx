// A React error boundary for the dashboard subtree.
//
// The dashboard SPA renders entirely client-side off polled API data; before
// this, a single render throw (e.g. a partial row reaching `.toFixed`) had no
// boundary to catch it and fell through to Remix's bare "Application error".
// This catches such errors and shows a recoverable fallback instead. The
// fallback is self-contained (inline styles, no `cd-*` dependency) so it also
// works as the root-level backstop, before the dashboard stylesheet loads.

import { Component, type ErrorInfo, type ReactNode } from "react";

export function DashboardErrorFallback({ error }: { error?: unknown }) {
  const detail =
    error instanceof Error && error.message ? error.message : undefined;
  return (
    <div
      role="alert"
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        textAlign: "center",
        fontFamily:
          "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        color: "#1a1a1a",
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
        Something went wrong
      </h1>
      <p style={{ margin: 0, maxWidth: 420, color: "#5c5f62", fontSize: 14 }}>
        This view hit a snag. Reload to try again — your data is safe.
      </p>
      {detail ? (
        <code
          style={{
            fontSize: 12,
            color: "#8c9196",
            maxWidth: 420,
            wordBreak: "break-word",
          }}
        >
          {detail}
        </code>
      ) : null}
      <button
        type="button"
        onClick={() => {
          if (typeof location !== "undefined") location.reload();
        }}
        style={{
          marginTop: 8,
          padding: "8px 16px",
          borderRadius: 8,
          border: "1px solid #babfc3",
          background: "#fff",
          fontSize: 14,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}

interface Props {
  children?: ReactNode;
}
interface State {
  error: Error | null;
}

export class DashboardErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The SPA otherwise swallows render errors; surface them for prod debugging.
    console.error("Dashboard render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <DashboardErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
