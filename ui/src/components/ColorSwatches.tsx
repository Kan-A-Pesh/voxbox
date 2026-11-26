import { useRef, type KeyboardEvent } from "react";

/**
 * Color radio group (voices, sounds). One tab stop; arrows, Home and End move
 * and select, like native radios. `null` in `options` is "no color".
 */
export function ColorSwatches({ label, options, value, onChange }: {
  label: string;
  options: (string | null)[];
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const selected = Math.max(0, options.indexOf(value));

  function onKeyDown(e: KeyboardEvent) {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (selected === last ? 0 : selected + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (selected === 0 ? last : selected - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next] ?? null);
    group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }

  return (
    <div ref={group} className="picker__swatches" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((c, i) => (
        <button
          key={c ?? "none"}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={c ?? "Sans couleur"}
          tabIndex={i === selected ? 0 : -1}
          className={c ? "swatch" : "swatch swatch--none"}
          style={c ? { background: c } : undefined}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}
