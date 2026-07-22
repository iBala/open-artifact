/**
 * The small set of things every screen is built from.
 *
 * Kept deliberately few. A product with four button variants ends up with four
 * different answers to "which one is the important one", and the answer stops
 * meaning anything.
 */

import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type Tone = 'primary' | 'default' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  size?: Size;
  /** Shows it is working, and stops it being pressed twice. */
  busy?: boolean;
}

const TONES: Record<Tone, string> = {
  primary: 'bg-accent text-white border-transparent hover:bg-accent-2',
  default: 'bg-surface text-ink border-line hover:bg-sunken',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-sunken hover:text-ink',
  danger: 'bg-transparent text-danger border-line hover:bg-danger-wash hover:border-danger',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 gap-1.5 rounded-[--radius-sm] text-[12.5px]',
  md: 'h-8 px-3 gap-2 rounded-[--radius] text-[13px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'default', size = 'md', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={[
        'inline-flex shrink-0 items-center justify-center border font-medium',
        // Only colour and transform move. Animating layout is what makes an
        // interface feel loose.
        'transition-[background-color,border-color,color,opacity] duration-100',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        SIZES[size],
        TONES[tone],
        className,
      ].join(' ')}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
});

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent ${className}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={[
          'h-9 w-full rounded-[--radius] border border-line bg-surface px-2.5',
          'text-[13px] text-ink placeholder:text-ink-3',
          'transition-colors duration-100 hover:border-ink-3 focus:border-accent',
          className,
        ].join(' ')}
        {...rest}
      />
    );
  },
);

/** A label that sits above a field. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-ink-2">
        {label}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty and error states
// ---------------------------------------------------------------------------

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
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="oa-fade flex flex-col items-start px-1 py-10">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {children && (
        <div className="mt-1.5 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-3">
          {children}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="oa-rise flex items-start gap-2 rounded-[--radius] border border-line bg-danger-wash px-3 py-2.5 text-[12.5px] text-ink"
    >
      <span className="flex-1">{children}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 font-medium text-accent hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces of chrome
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn';
}) {
  const tones = {
    neutral: 'bg-sunken text-ink-2 border-line',
    accent: 'bg-accent-wash text-accent border-transparent',
    warn: 'bg-danger-wash text-danger border-transparent',
  };
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-[--radius-xs] border px-1.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Divider({ className = '' }: { className?: string }) {
  return <hr className={`m-0 border-0 border-t border-line ${className}`} />;
}

/**
 * A timestamp, in the reader's own timezone.
 *
 * Everything the server stores and sends is UTC. Converting happens here, at the
 * moment of rendering, and nowhere else in the product.
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
  if (seconds < 90) return '1m ago';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  // Past a week an actual date is more use than "five weeks ago".
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

/**
 * A modal panel.
 *
 * Built on the browser's own <dialog>, which brings focus trapping, Escape, and
 * inertness of the page behind it for free. Reimplementing those by hand is how
 * dialogs end up unusable by keyboard.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const element = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;

    // Escape fires the dialog's own cancel event; keep our state in step.
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={element}
      aria-labelledby="oa-dialog-title"
      onClick={(event) => {
        // Clicking the backdrop closes. The backdrop is the dialog element
        // itself; anything inside is a descendant, so this only fires outside.
        if (event.target === element.current) onClose();
      }}
      className={[
        'oa-pop m-auto w-[calc(100vw-32px)] rounded-[--radius-lg] border border-line',
        'bg-surface p-0 text-ink shadow-[--shadow-dialog]',
        'backdrop:bg-black/25 backdrop:backdrop-blur-[2px]',
      ].join(' ')}
      style={{ maxWidth: width }}
    >
      <div className="px-4 pb-3 pt-4">
        <h2 id="oa-dialog-title" className="text-[14px]">
          {title}
        </h2>
        {description && <p className="mt-1 text-[12.5px] text-ink-3">{description}</p>}
      </div>

      {children && <div className="px-4 pb-4">{children}</div>}

      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-sunken px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
