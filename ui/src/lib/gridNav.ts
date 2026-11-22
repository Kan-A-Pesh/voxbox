import type { KeyboardEvent } from "react";

/**
 * Arrow-key navigation between `[data-grid-item]` descendants of a grid container.
 * Columns are inferred from layout, so it follows the responsive column count.
 */
export function onGridKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-grid-item]")];
  const current = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
  if (current < 0) return;
  const top = items[0]?.offsetTop ?? 0;
  const cols = Math.max(1, items.filter((el) => el.offsetTop === top).length);
  const delta: Record<string, number> = {
    ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -current, End: items.length - 1 - current,
  };
  const next = items[current + (delta[e.key] ?? 0)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}
