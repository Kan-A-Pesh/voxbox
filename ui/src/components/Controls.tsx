import { useId, type ReactNode } from "react";
import { PixelIcon } from "./PixelIcon";
import type { IconName } from "./icons";

/** Square pixel switch. The whole row (label included) is the hit target. */
export function Toggle({ label, checked, onChange, hint, compact }: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
  compact?: boolean;
}) {
  const id = useId();
  return (
    <label className={`toggle${compact ? " toggle--compact" : ""}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="toggle__input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <span className="toggle__track" aria-hidden="true"><span className="toggle__knob" /></span>
      <span className="toggle__text">
        <span className="toggle__label">{label}</span>
        {hint ? <span id={`${id}-hint`} className="toggle__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Slider({ label, value, min, max, step, onChange, format, hint, id: idProp }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
  id?: string;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <div className="slider__head">
        <label className="label" htmlFor={id}>{label}</label>
        <output className="slider__value" htmlFor={id}>{format ? format(value) : value}</output>
      </div>
      <input
        id={id}
        type="range"
        className="slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? <p id={`${id}-hint`} className="hint">{hint}</p> : null}
    </div>
  );
}

export function IconButton({ icon, label, onClick, pressed, tone, disabled, size = 2 }: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone?: "danger" | "accent";
  disabled?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${tone ? ` icon-btn--${tone}` : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <PixelIcon name={icon} scale={size} />
    </button>
  );
}

export function Chips<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="chip"
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="chip__count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Terminal-style search: "> rechercher une voix_". */
export function SearchField({ label, placeholder, value, onChange }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="search">
      <span className="search__prompt" aria-hidden="true">&gt;</span>
      <input
        type="search"
        className="search__input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <PixelIcon name={icon} scale={4} className="empty__icon" />
      <p className="empty__title">{title}</p>
      {children ? <p className="empty__text">{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorPanel({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div className="error-panel" role="alert">
      <PixelIcon name="warning" scale={3} />
      <div className="error-panel__body">
        <p className="error-panel__title">{title}</p>
        <p className="error-panel__text">{message}</p>
        {action}
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const steps = 20;
  const filled = Math.round(Math.min(1, Math.max(0, value)) * steps);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      {Array.from({ length: steps }, (_, i) => (
        <span key={i} className={`progress__cell${i < filled ? " is-on" : ""}`} />
      ))}
    </div>
  );
}

export function Field({ label, htmlFor, hint, error, children }: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? " field--error" : ""}`}>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className="field__error" id={`${htmlFor}-error`}>
          <PixelIcon name="warning" scale={1} /> {error}
        </p>
      ) : hint ? (
        <p className="hint" id={`${htmlFor}-hint`}>{hint}</p>
      ) : null}
    </div>
  );
}
