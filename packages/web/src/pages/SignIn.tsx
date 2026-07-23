/**
 * Signing in.
 *
 * Two steps: an address, then the six-digit code emailed to it. There is no
 * clickable link, on purpose. Mail clients open links in their own in-app
 * browser, which has no session, so the person lands on a signed-out page
 * wondering what went wrong. A code keeps them in the tab they started in.
 *
 * When somebody arrived by following an artifact link, this screen is drawn over
 * a blurred document shape so it is obvious there is something waiting. That
 * shape is fabricated in the browser and contains nothing real: see
 * DocumentSkeleton.
 *
 * One piece of wording is load-bearing. The server answers identically whether
 * or not an address has an account here, so that asking is never a way to find
 * out who uses this instance. This screen has to match that, or the interface
 * gives away what the server took care not to.
 */

import { useEffect, useRef, useState } from 'react';
import { endpoints, ApiError, type SignInMethods } from '../api.js';
import { Button, TextInput, ErrorNote, Field } from '../components/primitives.js';
import { DocumentSkeleton } from '../components/DocumentSkeleton.js';
import { CodeInput } from '../components/CodeInput.js';

type Step = 'email' | 'code';

export function SignIn({ redirectTo }: { redirectTo: string | null }) {
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const emailField = useRef<HTMLInputElement>(null);

  // Somebody who followed a link to an artifact gets the shape of a document
  // behind the card. Somebody who came to the front door does not.
  const arrivedAtAnArtifact = redirectTo?.startsWith('/a/') ?? false;

  useEffect(() => {
    endpoints.signInMethods().then(setMethods).catch(() => setMethods(null));
  }, []);

  useEffect(() => {
    // The cursor lands where they are going to type. Small, and it is the
    // difference between arriving and being greeted.
    if (step === 'email') emailField.current?.focus();
  }, [step]);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);

    try {
      await endpoints.requestCode(email.trim(), redirectTo);
      setStep('code');
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(code: string): Promise<void> {
    setProblem(null);
    setBusy(true);

    try {
      const result = await endpoints.verifyCode(email.trim(), code);
      // A full load rather than a client-side route change: the session cookie
      // is new, and the artifact page is served by the server.
      window.location.assign(result.redirectTo ?? redirectTo ?? '/');
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-dvh overflow-hidden">
      {arrivedAtAnArtifact && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <DocumentSkeleton />
          {/* A wash over the shape so the card never fights it for contrast. */}
          <div className="absolute inset-0 bg-canvas/45" />
        </div>
      )}

      <div className="relative grid min-h-dvh place-items-center px-5 py-10">
        <div className={`oa-rise w-full ${arrivedAtAnArtifact ? 'max-w-[340px]' : 'max-w-[420px]'}`}>
          <div className="rounded-[--radius-lg] border border-line bg-surface p-5 shadow-[--shadow-pop]">
            <header className="mb-4">
              <h1 className="text-[15px]">
                {arrivedAtAnArtifact ? 'Sign in to read this' : 'Open Artifact'}
              </h1>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                {arrivedAtAnArtifact
                  ? 'Somebody shared a document with you. Sign in with the address they used.'
                  : 'Publish and share HTML and Markdown from wherever you work.'}
              </p>
            </header>

            {step === 'email' ? (
              <form onSubmit={requestCode} className="flex flex-col gap-3">
                <Field label="Email address" htmlFor="email">
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
                </Field>
                <Button type="submit" tone="primary" busy={busy}>
                  {busy ? 'Sending' : 'Email me a code'}
                </Button>
              </form>
            ) : (
              <EnterCode
                email={email}
                busy={busy}
                onSubmit={submitCode}
                onStartOver={() => {
                  setStep('email');
                  setProblem(null);
                }}
                onResend={async () => {
                  setProblem(null);
                  await endpoints.requestCode(email.trim(), redirectTo).catch(() => undefined);
                }}
              />
            )}

            {problem && (
              <div className="mt-3">
                <ErrorNote>{problem}</ErrorNote>
              </div>
            )}

            {step === 'email' && methods?.google && (
              <>
                <Or />
                <a
                  href={`/auth/google/start${
                    redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ''
                  }`}
                  className="flex h-8 w-full items-center justify-center gap-2 rounded-[--radius] border border-line bg-surface text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-sunken"
                >
                  <GoogleMark />
                  Continue with Google
                </a>
              </>
            )}
          </div>

          {step === 'email' && methods?.signupMode === 'invite-only' && (
            <p className="mt-3 px-1 text-[11.5px] leading-relaxed text-ink-3">
              This instance is invite only. If nobody has shared anything with you yet, ask
              somebody here to.
            </p>
          )}

          {step === 'email' && !arrivedAtAnArtifact && (
            <SetupGuide instance={typeof window !== 'undefined' ? window.location.origin : ''} />
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * How to set up, for somebody who came to the front door.
 *
 * One thing to copy, and their own assistant does the rest. We do not walk the
 * person through terminal commands or tell them where a file goes for their
 * particular tool. We hand their assistant a plain-language instruction and let
 * it work that out, because it knows its own machine and we cannot keep nine
 * tools' file paths correct forever.
 *
 * Deliberately not shown to anybody who followed a link to a document. They came
 * to read something a colleague sent them, and the only thing in their way should
 * be the sign-in box. Setup on their way in taxes the person who shared it.
 *
 * The one step the assistant cannot do for them is approving the sign-in, which
 * happens in a browser and is a security boundary on purpose. The instruction
 * tells the assistant to surface that and wait.
 */

const SKILL_URL = 'https://raw.githubusercontent.com/iBala/open-artifact/main/skill/SKILL.md';

function setupPrompt(instance: string): string {
  return `Set up Open Artifact for me so you can publish documents as shareable links.

1. Install the tool from public npm (the --registry matters if my npm points at a private one):
   npm install -g open-artifact --registry https://registry.npmjs.org/

2. Sign me in. First ask me for my email address, then run:
   open-artifact login --instance ${instance} --email MY_EMAIL
   That emails me a six-digit code and returns straight away. Ask me for the code, then run:
   open-artifact login --instance ${instance} --email MY_EMAIL --code THE_CODE

3. Learn how to use it: read ${SKILL_URL} and save it where you read skills from, so you know when to publish. For example ~/.claude/skills/open-artifact/SKILL.md for Claude Code, ~/.codex/skills/open-artifact/SKILL.md for Codex, or .cursor/skills/open-artifact/SKILL.md for Cursor. If you have no skills folder, just follow that file directly.

4. Make it your default so I do not have to ask each time. Add this line to your standing instructions — the file you read every session (CLAUDE.md, AGENTS.md, .cursor/rules, GEMINI.md, or your tool's equivalent), creating it if there is none:
   "Publish documents, reports, dashboards and standalone HTML pages to Open Artifact by default (instance ${instance}) and give me the link, instead of a local file or the built-in artifacts panel. Not for code or config files."

5. Confirm it worked:
   open-artifact whoami --json
   You should see my email and this instance. Then tell me it is ready.

If you cannot run terminal commands, tell me — this setup needs an assistant that can.`;
}

function SetupGuide({ instance }: { instance: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = setupPrompt(instance);

  return (
    <section className="oa-fade mt-7" style={{ animationDelay: '90ms' }} aria-label="Set up your assistant">
      <h2 className="px-1 text-[11.5px] font-medium tracking-wide text-ink-3 uppercase">
        New here? Paste this into your assistant
      </h2>
      <p className="mt-1.5 px-1 text-[12px] leading-relaxed text-ink-3">
        Copy it into Claude, Cursor, Codex or whatever you use. It does the setup itself.
      </p>

      <div className="relative mt-3">
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(prompt).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              },
              () => undefined,
            );
          }}
          className="absolute right-2 top-2 z-10 rounded-[--radius] border border-line bg-surface px-2 py-1 text-[11px] text-ink-3 shadow-[--shadow-pop] transition-colors hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <pre className="oa-scroll max-h-72 overflow-auto rounded-[--radius-lg] border border-line bg-sunken p-3 pr-14 text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-ink-2">
          {prompt}
        </pre>
      </div>

      <p className="mt-3 px-1 text-[11px] leading-relaxed text-ink-3">
        Then just say <span className="text-ink-2">&ldquo;publish that as an artifact&rdquo;</span>.
        No terminal? Support for Claude on the web and ChatGPT is on the way.
      </p>
    </section>
  );
}

function EnterCode({
  email,
  busy,
  onSubmit,
  onStartOver,
  onResend,
}: {
  email: string;
  busy: boolean;
  onSubmit: (code: string) => Promise<void>;
  onStartOver: () => void;
  onResend: () => Promise<void>;
}) {
  const [resent, setResent] = useState(false);

  return (
    <div className="oa-fade flex flex-col gap-3">
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        {/* Matches what the server will and will not confirm. */}
        If <span className="font-medium text-ink">{email}</span> can sign in here, a six-digit
        code is on its way. It expires in 10 minutes.
      </p>

      <CodeInput onComplete={onSubmit} disabled={busy} />

      <div className="flex items-center justify-between text-[12px]">
        <button
          type="button"
          onClick={onStartOver}
          className="text-ink-3 transition-colors hover:text-ink"
        >
          Use a different address
        </button>
        <button
          type="button"
          onClick={() => {
            setResent(true);
            void onResend();
          }}
          disabled={resent}
          className="text-ink-3 transition-colors hover:text-ink disabled:opacity-50"
        >
          {resent ? 'Sent again' : 'Resend'}
        </button>
      </div>
    </div>
  );
}

function Or() {
  return (
    <div className="my-3.5 flex items-center gap-2.5" aria-hidden="true">
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11px] text-ink-3">or</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
