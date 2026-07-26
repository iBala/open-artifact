/**
 * The theme control: system, light, dark.
 *
 * Three states shown at once rather than one button that cycles. A cycling
 * button asks you to press it and find out, and it can never show that "system"
 * is a state at all — which is the one most people are actually in.
 *
 * It is a radio group, not a row of buttons, because that is what it is: one
 * choice out of three. Arrow keys move between them for free, and a screen
 * reader announces which is set.
 *
 * The indicator slides between positions rather than appearing. That movement is
 * the only thing telling you the three sit on one track and you moved along it.
 * It is 140ms, and it is gone entirely for anybody who asked for reduced motion.
 */

import { useTheme, type ThemePreference } from '../theme.jsx';

const OPTIONS: { value: ThemePreference; label: string; icon: () => React.ReactNode }[] = [
  { value: 'system', label: 'Match system', icon: SystemIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
];

export function ThemeControl({ className = '' }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  // Never -1 in practice, but the indicator's position is computed from it and
  // a negative would slide it off the left edge.
  const index = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === preference),
  );

  return (
    // 28px tall on purpose: the same as a small Button, so wherever it stands
    // next to one they share a baseline instead of nearly sharing one.
    <div
      role="radiogroup"
      aria-label="Theme"
      className={`relative inline-flex h-7 shrink-0 rounded-[--radius-sm] border border-line bg-sunken p-[2px] ${className}`}
    >
      {/* One indicator that moves, rather than a background on each option that
          switches on and off. Sits behind the icons and is never a hit target.
          It is a raised surface against a sunken track — the same two tones the
          rest of the product uses for "this one", so it reads in both themes. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[2px] top-[2px] size-[22px] rounded-[3px] bg-surface shadow-[0_1px_2px_oklch(0%_0_0_/_0.08)] transition-transform duration-[140ms] ease-[--ease-out-soft]"
        style={{ transform: `translateX(${index * 22}px)` }}
      />

      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = value === preference;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            // Only the set option is a tab stop; arrow keys reach the others,
            // which is how a radio group is meant to behave.
            tabIndex={selected ? 0 : -1}
            onClick={() => setPreference(value)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
              if (next) setPreference(next.value);
            }}
            className={[
              'relative grid size-[22px] place-items-center rounded-[3px] transition-colors duration-100',
              selected ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            ].join(' ')}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

/* The icons are 12px and single-weight, to sit at the same volume as the
   interface text beside them rather than above it. */

function SystemIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 13.75h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.4v1.3M8 13.3v1.3M14.6 8h-1.3M2.7 8H1.4M12.7 3.3l-.9.9M4.2 11.8l-.9.9M12.7 12.7l-.9-.9M4.2 4.2l-.9-.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.4 9.6A5.7 5.7 0 0 1 6.4 2.6a5.7 5.7 0 1 0 7 7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
