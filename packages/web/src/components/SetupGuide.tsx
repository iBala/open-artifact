/**
 * The one thing a person copies to set up their assistant.
 *
 * Shared by two screens: the logged-out front door, and the dashboard of
 * somebody who has an account but has not published yet — a person a document
 * was shared with, most often.
 *
 * It used to paste a forty-line block. Now it hands the assistant a single
 * sentence: install the CLI, then read this instance's /setup.md and follow it.
 * The long instructions live at that URL (served per-instance), so the thing a
 * human copies stays short and the steps can change without changing this.
 */

import { useState } from 'react';

export function setupPrompt(instance: string): string {
  return `Set up Open Artifact for me. Install the CLI — npm install -g open-artifact --registry https://registry.npmjs.org/ — then read ${instance}/setup.md and follow it to sign me in and set yourself up.`;
}

export function SetupGuide({
  instance,
  heading = 'New here? Paste this into your assistant',
  intro = 'Copy it into Claude, Cursor, Codex or whatever you use. It reads the setup guide and does the rest.',
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
        <pre className="oa-scroll overflow-auto rounded-[--radius-lg] border border-line bg-sunken p-3 pr-14 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-2">
          {prompt}
        </pre>
      </div>

      <p className="mt-3 px-1 text-[11px] leading-relaxed text-ink-3">
        Then just say <span className="text-ink-2">&ldquo;publish that as an artifact&rdquo;</span>.
      </p>

      {/* The quieter second path. The setup guide covers it too, but somebody
          skimming should not have to read it to learn the URL exists. */}
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
