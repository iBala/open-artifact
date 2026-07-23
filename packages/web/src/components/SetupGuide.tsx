/**
 * The one thing a person copies to set up their assistant.
 *
 * Shared by two screens: the logged-out front door, and the dashboard of
 * somebody who has an account but has not published yet — a person a document
 * was shared with, most often. Both hand the assistant the same plain-language
 * instruction and let it do the work, because it knows its own machine and we
 * cannot keep nine tools' file paths correct forever.
 *
 * The one step the assistant cannot do is approving the sign-in, which is a
 * security boundary on purpose. The instruction has it surface the code and wait.
 */

import { useState } from 'react';

const SKILL_URL = 'https://raw.githubusercontent.com/iBala/open-artifact/main/skill/SKILL.md';

export function setupPrompt(instance: string): string {
  return `Set up Open Artifact for me so you can publish documents as shareable links.

FIRST, decide which path applies to you:
- If you can run shell commands AND can reach ${instance} from where you run (curl its /healthz to check), follow the numbered steps below.
- Otherwise — you have no terminal (Claude on the web, ChatGPT), or your commands run in a sandbox whose network cannot reach that address (a 403 on every request before any code is entered is exactly this, not an account problem) — do not retry the steps and do not stop. Tell me to connect you as a custom connector instead, with this URL:
    ${instance}/mcp
  I add it in the app's settings — look under Settings for "Connectors" or "Apps"; if there is no option to add a custom connector, my workspace admin may need to enable it. Once connected you will have the publishing tools directly, and only step 4 below still applies: ask me the question, and if I say yes, give me the exact line to paste into your custom instructions — you cannot write them yourself.

1. Install the tool from public npm (the --registry matters if my npm points at a private one):
   npm install -g open-artifact --registry https://registry.npmjs.org/

2. Sign me in. First ask me for my email address, then run:
   open-artifact login --instance ${instance} --email MY_EMAIL
   That emails me a six-digit code and returns straight away. Ask me for the code, then run, putting your own name (Claude Code, Codex, Cursor, and so on) after --label so I can see which assistant is connected:
   open-artifact login --instance ${instance} --email MY_EMAIL --code THE_CODE --label "YOUR_NAME"

3. Learn how to use it: read ${SKILL_URL} and save it where you read skills from, so you know when to publish. For example ~/.claude/skills/open-artifact/SKILL.md for Claude Code, ~/.codex/skills/open-artifact/SKILL.md for Codex, or .cursor/skills/open-artifact/SKILL.md for Cursor. If you have no skills folder, just follow that file directly.

4. Ask me one yes/no question: do I want Open Artifact to be my default for Markdown and HTML — so that whenever you create or open one, you publish it here and give me the link, instead of a local file or the built-in artifacts panel?
   - If I say yes, add this to your standing instructions — the file you read every session (CLAUDE.md, AGENTS.md, .cursor/rules, GEMINI.md, or your tool's equivalent), creating it if there is none:
     "Open Artifact is my default for Markdown and HTML. When you create or open one — a report, doc, dashboard, write-up or page meant to be read — publish it to Open Artifact (instance ${instance}) and give me the link, instead of a local file or the built-in artifacts panel. Not for code or config files. If it is not installed or signed in, tell me and fall back to a file."
   - If I say no, add nothing. I will ask you to publish when I want to.

5. Confirm it worked:
   open-artifact whoami --json
   You should see my email and this instance. Then tell me it is ready.`;
}

export function SetupGuide({
  instance,
  heading = 'New here? Paste this into your assistant',
  intro = 'Copy it into Claude, Cursor, Codex or whatever you use. It does the setup itself.',
}: {
  instance: string;
  heading?: string;
  intro?: string;
}) {
  const [copied, setCopied] = useState(false);
  const prompt = setupPrompt(instance);

  return (
    <section className="oa-fade" style={{ animationDelay: '90ms' }} aria-label="Set up your assistant">
      <h2 className="px-1 text-[11.5px] font-medium tracking-wide text-ink-3 uppercase">{heading}</h2>
      <p className="mt-1.5 px-1 text-[12px] leading-relaxed text-ink-3">{intro}</p>

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
      </p>

      {/* The quieter second path. The paste block already routes no-terminal
          assistants here, but somebody skimming should not have to paste
          anything to learn the URL exists. */}
      <p className="mt-2 px-1 text-[11px] leading-relaxed text-ink-3">
        No terminal — Claude on the web, ChatGPT? Add{' '}
        <code className="rounded-[--radius-xs] border border-line-2 bg-sunken px-1 py-0.5 font-mono text-[10.5px] text-ink-2">
          {instance}/mcp
        </code>{' '}
        as a custom connector instead: look under Settings for Connectors or Apps. If the option
        is missing, a workspace admin may need to enable it.
      </p>
    </section>
  );
}
