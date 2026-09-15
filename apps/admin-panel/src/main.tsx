import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
// Self-hosted Inter (the four weights the UI uses). Bundled by Vite and served
// same-origin, so it loads under the strict CSP — `font-src 'self'` — that
// deliberately does NOT allow Google Fonts on this money-moving panel. The old
// <link> to fonts.googleapis.com was blocked in production, which is why the app
// silently fell back to the system font.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./index.css";

// FIX #9: Wrap entire app in ErrorBoundary to prevent blank screen on render errors
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
