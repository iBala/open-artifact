/**
 * The dashboard.
 *
 * The same two groups the sidebar holds, given room: what you published, and
 * what other people shared with you. A list rather than cards, because these are
 * documents and a list is how you scan documents.
 */

import { type ArtifactSummary, type SharedArtifact } from '../api.js';
import { Link } from '../router.jsx';
import { Badge, EmptyState, RelativeTime } from '../components/primitives.js';

export function Home({
  mine,
  shared,
  loading,
  failed,
  onRetry,
}: {
  mine: ArtifactSummary[];
  shared: SharedArtifact[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-9">
      <h1 className="text-[17px]">Artifacts</h1>

      {failed && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onRetry}
            className="text-[12.5px] text-accent hover:underline"
          >
            Could not load your artifacts. Try again.
          </button>
        </div>
      )}

      <Group title="Yours">
        {loading && mine.length === 0 && <LoadingRows />}
        {!loading && mine.length === 0 && (
          <EmptyState title="Nothing published yet">
            Artifacts are published from wherever you work: an agent, a script, or a terminal.
            Run <Code>open-artifact login</Code>, then{' '}
            <Code>open-artifact publish report.md</Code>.
          </EmptyState>
        )}
        {mine.map((artifact, index) => (
          <Row
            key={artifact.id}
            slug={artifact.slug}
            title={artifact.title}
            type={artifact.type}
            updatedAt={artifact.updatedAt}
            trailing={artifact.isPublic === 1 ? <Badge tone="accent">Public</Badge> : null}
            index={index}
          />
        ))}
      </Group>

      <Group title="Shared with you">
        {!loading && shared.length === 0 && (
          <EmptyState title="Nothing shared with you yet">
            When somebody shares an artifact with your email address, or with everybody at your
            domain, it appears here.
          </EmptyState>
        )}
        {shared.map((artifact, index) => (
          <Row
            key={artifact.id}
            slug={artifact.slug}
            title={artifact.title}
            type={artifact.type}
            updatedAt={artifact.updatedAt}
            byline={artifact.ownerName ?? artifact.ownerEmail ?? undefined}
            index={index}
          />
        ))}
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
        {title}
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function Row({
  slug,
  title,
  type,
  updatedAt,
  byline,
  trailing,
  index,
}: {
  slug: string;
  title: string;
  type: 'markdown' | 'html';
  updatedAt: string;
  byline?: string;
  trailing?: React.ReactNode;
  index: number;
}) {
  return (
    <li
      className="oa-rise border-b border-line-2 last:border-0"
      // Rows land a beat apart, so a list reads as a list rather than appearing
      // all at once. Capped, or a long list would crawl in.
      style={{ animationDelay: `${Math.min(index, 6) * 25}ms` }}
    >
      <Link
        to={`/a/${slug}`}
        className="group flex items-center gap-3 rounded-[--radius-sm] px-1.5 py-2.5 transition-colors hover:bg-sunken"
      >
        <span
          aria-hidden="true"
          className="grid size-[18px] shrink-0 place-items-center rounded-[4px] border border-line text-[8px] font-bold uppercase text-ink-3"
        >
          {type === 'markdown' ? 'M' : 'H'}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink group-hover:text-accent">
            {title}
          </span>
          {byline && <span className="block truncate text-[11.5px] text-ink-3">{byline}</span>}
        </span>

        {trailing}

        <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">
          <RelativeTime iso={updatedAt} />
        </span>
      </Link>
    </li>
  );
}

/**
 * Placeholder rows, sized like the real thing.
 *
 * A spinner would say "wait". These say "a list is coming, roughly this shape",
 * and the page does not jump when the real rows replace them.
 */
function LoadingRows() {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <li key={row} aria-hidden="true" className="border-b border-line-2 px-1.5 py-2.5">
          <span className="oa-breathe block h-[13px] w-48 rounded bg-line" />
        </li>
      ))}
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[--radius-xs] border border-line-2 bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-2">
      {children}
    </code>
  );
}
