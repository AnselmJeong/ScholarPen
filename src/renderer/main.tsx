import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { App } from "./App";
import { rpc } from "./rpc";

// Apply theme before first render to avoid flash
async function applyInitialTheme() {
  try {
    const settings = await rpc.getSettings();
    applyTheme(settings.theme ?? "system");
  } catch {
    applyTheme("system");
  }
}

export function applyTheme(theme: "light" | "dark" | "system") {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const useDark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", useDark);
  // Radix UI portals render into document.body — needs dark class too
  document.body.classList.toggle("dark", useDark);
  // Notify React components that need to react to theme changes
  window.dispatchEvent(new CustomEvent("themechange", { detail: { dark: useDark } }));
}

export function useIsDark(): boolean {
  const [isDark, setIsDark] = React.useState(
    () => document.documentElement.classList.contains("dark")
  );
  React.useEffect(() => {
    const handler = (e: Event) => setIsDark((e as CustomEvent<{ dark: boolean }>).detail.dark);
    window.addEventListener("themechange", handler);
    return () => window.removeEventListener("themechange", handler);
  }, []);
  return isDark;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ScholarPen] React error:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "#c00" }}>
          <h2>ScholarPen crashed</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

async function bootstrap() {
  await applyInitialTheme();
  createRoot(root!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

bootstrap();
