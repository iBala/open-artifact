/**
 * Signing in.
 *
 * The first screen anybody sees, and the one that has to work when everything
 * else is unfamiliar. It asks for one thing at a time and tells the truth about
 * what happens next.
 *
 * "We have sent a link if that address can sign in here" is worded carefully. The
 * server deliberately answers the same way for an address it knows and one it
 * does not, so that asking is never a way to find out who uses this instance.
 * The wording has to match that, or the interface quietly leaks what the server
 * took care not to.
 */

import { useEffect, useRef, useState } from 'react';
import { endpoints, ApiError, type SignInMethods } from '../api.js';
import { Button, TextInput, ErrorNote } from '../components/primitives.js';

export function SignIn({ redirectTo }: { redirectTo: string | null }) {
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const emailField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endpoints.signInMethods().then(setMethods).catch(() => setMethods(null));
  }, []);

  useEffect(() => {
    // The cursor lands where the person is going to type. Small, and it is the
    // difference between arriving and being greeted.
    emailField.current?.focus();
  }, []);

  async function requestLink(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setState('sending');

    try {
      await endpoints.requestMagicLink(email.trim(), redirectTo);
      setState('sent');
    } catch (error) {
      setState('idle');
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="oa-rise w-full max-w-[380px]">
        <header className="mb-8">
          <h1 className="text-[26px] tracking-[-0.03em]">Open Artifact</h1>
          <p className="mt-1.5 text-[14px] text-ink-soft">
            Publish and share HTML and Markdown from wherever you work.
          </p>
        </header>

        {state === 'sent' ? (
          <CheckYourEmail email={email} onStartOver={() => setState('idle')} />
        ) : (
          <>
            <form onSubmit={requestLink} className="flex flex-col gap-3">
              <label htmlFor="email" className="text-[13px] font-medium text-ink-soft">
                Email address
              </label>
              <TextInput
                id="email"
                ref={emailField}
                type="email"
                name="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button type="submit" tone="primary" busy={state === 'sending'}>
                {state === 'sending' ? 'Sending' : 'Email me a sign-in link'}
              </Button>
            </form>

            {problem && (
              <div className="mt-4">
                <ErrorNote>{problem}</ErrorNote>
              </div>
            )}

            {methods?.google && (
              <>
                <Divider />
                <a
                  href={`/auth/google/start${
                    redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ''
                  }`}
                  className="flex w-full items-center justify-center gap-2 rounded-[--radius] border border-edge px-3.5 py-2 text-[14px] font-medium text-ink transition-colors duration-150 hover:bg-edge-soft"
                >
                  <GoogleMark />
                  Continue with Google
                </a>
              </>
            )}

            {methods?.signupMode === 'invite-only' && (
              <p className="mt-6 text-[13px] leading-relaxed text-ink-faint">
                This instance is invite only. If nobody has shared anything with you yet, ask
                someone here to.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function CheckYourEmail({ email, onStartOver }: { email: string; onStartOver: () => void }) {
  return (
    <div className="oa-rise rounded-[--radius-lg] border border-edge bg-paper-raised p-6 shadow-[--shadow-low]">
      <h2 className="text-[16px]">Check your email</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
        If <span className="font-medium text-ink">{email}</span> can sign in here, a link is on
        its way. It works once and expires in 15 minutes.
      </p>
      <button
        type="button"
        onClick={onStartOver}
        className="mt-4 text-[13px] font-medium text-accent underline underline-offset-2"
      >
        Use a different address
      </button>
    </div>
  );
}

function Divider() {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-edge" />
      <span className="text-[12px] text-ink-faint">or</span>
      <span className="h-px flex-1 bg-edge" />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
