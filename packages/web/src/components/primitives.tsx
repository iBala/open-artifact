/**
 * The small set of things every screen is built from.
 *
 * Kept few on purpose. A product with four button variants ends up with four
 * different answers to "which one is the important one", and the answer stops
 * meaning anything.
 */

import { type ButtonHTMLAttributes, type InputHTMLAttributes, forwardRef } from 'react';

type ButtonTone = 'primary' | 'quiet' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  /** Shows the button is working and stops it being pressed twice. */
  busy?: boolean;
}

const TONE_CLASSES: Record<ButtonTone, string> = {
  primary:
    'bg-accent text-white border-transparent hover:bg-accent-hover active:translate-y-px',
  quiet:
    'bg-transparent text-ink border-edge hover:bg-edge-soft active:translate-y-px',
  danger:
    'bg-transparent text-danger border-edge hover:bg-danger-wash hover:border-danger active:translate-y-px',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'quiet', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      // The transition is on colour and transform only. Animating layout
      // properties is what makes an interface feel loose.
      className={[
        'inline-flex items-center justify-center gap-2 rounded-[--radius]',
        'border px-3.5 py-2 text-[14px] font-medium',
        'transition-[background-color,border-color,color,transform] duration-150',
        'disabled:opacity-50 disabled:pointer-events-none',
        TONE_CLASSES[tone],
        className,
      ].join(' ')}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
});

/** A quiet mark that something is happening. Never a full-screen block. */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin"
    />
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={[
          'w-full rounded-[--radius] border border-edge bg-paper-raised',
          'px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-faint',
          'transition-colors duration-150',
          'hover:border-ink-faint focus:border-accent',
          className,
        ].join(' ')}
        {...rest}
      />
    );
  },
);

/**
 * What a screen says when it has nothing to show.
 *
 * Given real attention because an empty dashboard is the first thing a new
 * person sees, and "no artifacts" tells them nothing about what to do next.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="oa-rise flex flex-col items-center px-6 py-16 text-center">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {children && (
        <div className="mt-2 max-w-sm text-[14px] leading-relaxed text-ink-soft">{children}</div>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/** Something went wrong, said plainly, with a way out where there is one. */
export function ErrorNote({
  children,
  onRetry,
}: {
  children: React.ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="oa-rise rounded-[--radius] border border-edge bg-danger-wash px-4 py-3 text-[14px] text-ink"
    >
      <p className="m-0">{children}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-[13px] font-medium text-accent underline underline-offset-2"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * A timestamp, in the reader's own timezone.
 *
 * Everything the server stores and sends is UTC. Converting happens here, at the
 * moment of rendering, and nowhere else.
 */
export function RelativeTime({ iso, prefix }: { iso: string; prefix?: string }) {
  const label = describeWhen(iso);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {prefix ? `${prefix} ${label}` : label}
    </time>
  );
}

function describeWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'at an unknown time';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;

  // Past a week, an actual date is more use than "five weeks ago".
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(new Date(iso).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}
