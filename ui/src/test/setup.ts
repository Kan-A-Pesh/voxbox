import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy*/waitFor give up after 1 s by default: too short for the app flows when the test
// files share a busy CI runner. Only the deadline grows; an assertion that never holds still fails.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());
