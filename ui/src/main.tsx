import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/silkscreen/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/app.css";
import { App } from "./App";
import { VoxProvider } from "./state/store";
import type { ScreenKey } from "./components/Sidebar";

const screen = new URLSearchParams(window.location.search).get("screen") as ScreenKey | null;

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <VoxProvider>
      <App initialScreen={screen ?? "voices"} />
    </VoxProvider>
  </StrictMode>,
);
