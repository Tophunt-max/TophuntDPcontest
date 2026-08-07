// FIX #9: Global Error Boundary for Admin Panel
// Catches render errors across the entire dashboard and shows a fallback UI
// instead of a blank/crashed page

import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error("[AdminPanel] Uncaught render error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#f8fafc",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div
            style={{
              background: "white",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: "40px 48px",
              maxWidth: 520,
              textAlign: "center",
              boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "#1e293b", marginBottom: 8 }}>
              Something went wrong
            </h2>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
              An unexpected error occurred in the admin panel. The error has been logged.
            </p>
            {this.state.error && (
              <pre
                style={{
                  background: "#f1f5f9",
                  borderRadius: 8,
                  padding: "12px 16px",
                  fontSize: 12,
                  color: "#dc2626",
                  textAlign: "left",
                  overflow: "auto",
                  maxHeight: 120,
                  marginBottom: 24,
                }}
              >
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReset}
              style={{
                background: "#6366f1",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "10px 24px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
