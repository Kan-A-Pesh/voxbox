import { render } from "@testing-library/react";
import { App } from "../App";
import { VoxProvider } from "../state/store";
import { createMockBackend, type MockOptions } from "../ipc/mock";
import type { ScreenKey } from "../components/Sidebar";

export function renderApp(screen: ScreenKey = "voices", options: MockOptions = {}) {
  const backend = createMockBackend({ meters: false, aiImportStepMs: 5, ...options });
  const utils = render(
    <VoxProvider backend={backend}>
      <App initialScreen={screen} />
    </VoxProvider>,
  );
  const callsOf = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);
  return { ...utils, backend, callsOf };
}
