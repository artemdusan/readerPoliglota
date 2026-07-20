import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100dvh",
          padding: "2rem",
          textAlign: "center",
          color: "var(--txt-1)",
          background: "var(--bg)",
        }}>
          <h2 style={{ marginBottom: "1rem" }}>Coś poszło nie tak</h2>
          <p style={{ color: "var(--txt-3)", marginBottom: "1.5rem" }}>
            Wystąpił nieoczekiwany błąd. Spróbuj odświeżyć stronę.
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            style={{
              padding: "0.6rem 1.5rem",
              border: "none",
              borderRadius: "8px",
              background: "var(--gold)",
              color: "#fff",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            Odśwież
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
