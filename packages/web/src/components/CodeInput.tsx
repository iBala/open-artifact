/**
 * Six boxes for a six-digit code.
 *
 * Separate boxes read better than one field, but they are also where this kind
 * of control usually goes wrong. The behaviours that have to be right, because
 * people do all of them:
 *
 * - Pasting the whole code fills every box, whichever box was focused.
 * - Backspace on an empty box moves back and clears the one before, so holding
 *   it deletes the code rather than stopping at the first gap.
 * - The browser's own SMS or email autofill fills all six at once, which is why
 *   `autocomplete="one-time-code"` is on the first box and the whole thing
 *   tolerates a multi-character input event.
 * - Typing over a filled box replaces it instead of being ignored.
 * - Arrow keys move between boxes.
 * - It submits itself once the sixth digit lands. Nobody should have to reach
 *   for a button after typing the last digit.
 *
 * Non-digits are dropped rather than shown as an error, because the only way to
 * type one here is by accident.
 */

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';

const LENGTH = 6;

export function CodeInput({
  onComplete,
  disabled = false,
}: {
  onComplete: (code: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array<string>(LENGTH).fill(''));
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  function focusBox(index: number): void {
    const target = Math.max(0, Math.min(LENGTH - 1, index));
    boxes.current[target]?.focus();
    boxes.current[target]?.select();
  }

  /** Writes digits starting at an index, and submits if that completed the code. */
  function fill(from: number, incoming: string): void {
    const clean = incoming.replace(/\D/g, '');
    if (clean.length === 0) return;

    const next = [...digits];
    for (let offset = 0; offset < clean.length && from + offset < LENGTH; offset += 1) {
      next[from + offset] = clean[offset] ?? '';
    }
    setDigits(next);

    const landedAt = Math.min(from + clean.length, LENGTH - 1);
    focusBox(landedAt);

    const code = next.join('');
    if (code.length === LENGTH && !next.includes('')) {
      // Blur first, so the on-screen keyboard on a phone gets out of the way
      // before the screen changes underneath it.
      boxes.current[landedAt]?.blur();
      void onComplete(code);
    }
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next = [...digits];

      if (next[index]) {
        next[index] = '';
        setDigits(next);
        return;
      }

      // Empty box: step back and clear that one, so holding backspace works.
      if (index > 0) {
        next[index - 1] = '';
        setDigits(next);
        focusBox(index - 1);
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>): void {
    event.preventDefault();
    fill(0, event.clipboardData.getData('text'));
  }

  return (
    <div className="flex justify-between gap-1.5" role="group" aria-label="Six-digit code">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element;
          }}
          value={digit}
          disabled={disabled}
          onChange={(event) => fill(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={onPaste}
          onFocus={(event) => event.target.select()}
          // The browser fills the whole code into the first box; fill() spreads it.
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          inputMode="numeric"
          // Not maxLength=1: autofill and paste arrive as one long value, and
          // capping the field would throw away everything but the first digit.
          aria-label={`Digit ${index + 1}`}
          autoFocus={index === 0}
          className={[
            'h-11 w-full min-w-0 rounded-[--radius] border bg-surface text-center',
            'font-mono text-[17px] tabular-nums text-ink',
            'transition-colors duration-100',
            'disabled:opacity-50',
            digit ? 'border-ink-3' : 'border-line',
            'hover:border-ink-3 focus:border-accent',
          ].join(' ')}
        />
      ))}
    </div>
  );
}
