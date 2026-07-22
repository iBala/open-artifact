/**
 * The home screen.
 *
 * Two sections: what you published, and what other people shared with you. The
 * second one arrives in Sprint 4 along with sharing itself; the shape is here now
 * so it is not bolted on later.
 */

import { useEffect, useState } from 'react';
import { endpoints, type ArtifactSummary } from '../api.js';
import { EmptyState, ErrorNote, RelativeTime } from '../components/primitives.js';

export function Home() {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () => {
    setFailed(false);
    endpoints
      .myArtifacts()
      .then((response) => setArtifacts(response.artifacts))
      .catch(() => setFailed(true));
  };

  useEffect(load, []);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <SectionHeading>What you published</SectionHeading>

        {failed && <ErrorNote onRetry={load}>Could not load your artifacts.</ErrorNote>}

        {!failed && artifacts === null && <LoadingRows />}

        {!failed && artifacts?.length === 0 && (
          <EmptyState title="Nothing published yet">
            Artifacts are published from wherever you work: an agent, a script, or the command
            line. Run <Code>open-artifact login</Code> to connect this account, then{' '}
            <Code>open-artifact publish report.md</Code>.
          </EmptyState>
        )}

        {artifacts && artifacts.length > 0 && (
          <ul className="flex flex-col">
            {artifacts.map((artifact, index) => (
              <ArtifactRow key={artifact.id} artifact={artifact} index={index} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading>Shared with you</SectionHeading>
        <EmptyState title="Nothing shared with you yet">
          When somebody shares an artifact with your email address, it appears here.
        </EmptyState>
      </section>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 border-b border-edge pb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
      {children}
    </h2>
  );
}

function ArtifactRow({ artifact, index }: { artifact: ArtifactSummary; index: number }) {
  return (
    <li
      className="oa-rise border-b border-edge-soft"
      // Rows arrive a beat apart, so a list reads as a list rather than
      // appearing all at once. Capped, or a long list would crawl in.
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <a
        href={`/a/${artifact.slug}`}
        className="group flex items-baseline justify-between gap-4 py-3.5 transition-colors hover:bg-edge-soft/60"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink group-hover:text-accent">
            {artifact.title}
          </span>
          <span className="mt-0.5 block text-[13px] text-ink-faint">
            {artifact.type === 'markdown' ? 'Markdown' : 'HTML'} ·{' '}
            <RelativeTime iso={artifact.updatedAt} prefix="updated" />
          </span>
        </span>
        <span className="shrink-0 text-[12px] text-ink-faint">Private</span>
      </a>
    </li>
  );
}

/**
 * Placeholder rows while the list loads, sized like the real thing.
 *
 * A spinner would say "wait"; these say "a list is coming, and roughly this
 * shape", and the page does not jump when the real rows replace them.
 */
function LoadingRows() {
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {[0, 1, 2].map((row) => (
        <li key={row} className="border-b border-edge-soft py-3.5">
          <span className="oa-breathe block h-[15px] w-52 rounded bg-edge" />
          <span className="oa-breathe mt-2 block h-[13px] w-32 rounded bg-edge-soft" />
        </li>
      ))}
    </ul>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-edge-soft px-1.5 py-0.5 font-mono text-[12.5px] text-ink">
      {children}
    </code>
  );
}
