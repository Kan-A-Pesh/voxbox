import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/silkscreen/400.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/app.css";
import { App } from "./App";
import { VoxProvider } from "./state/store";
import { isScreenKey } from "./components/Sidebar";
import { captureGlobalErrors } from "./lib/clientLog";

captureGlobalErrors();

const screen = new URLSearchParams(window.location.search).get("screen");

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <VoxProvider>
      <App initialScreen={isScreenKey(screen) ? screen : "voices"} />
    </VoxProvider>
  </StrictMode>,
);
