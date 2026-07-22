/**
 * A document that is not a document.
 *
 * This is what sits behind the sign-in wall. It is drawn here, in the browser,
 * out of nothing: a heading bar, some paragraph lines, a table block. It is not
 * the artifact, and it is not derived from the artifact. No part of the real
 * content is sent to a browser that has not signed in.
 *
 * That is the whole point, and it is worth being blunt about why. Blurring the
 * real content would look more convincing and would be a hole: CSS blur is a
 * display filter, and anybody can turn it off in devtools in about ten seconds.
 * A wall you can see through is not a wall. So the shape is honest about being a
 * shape, and the blur is there to say "a document lives here", not to hide one.
 *
 * Do not be tempted to make this more realistic by feeding it anything real.
 */

/** Line lengths chosen to look like prose rather than a loading state. */
const BLOCKS: { width: string; kind: 'heading' | 'line' | 'gap' | 'table' }[] = [
  { width: '46%', kind: 'heading' },
  { width: '92%', kind: 'line' },
  { width: '97%', kind: 'line' },
  { width: '64%', kind: 'line' },
  { width: '0', kind: 'gap' },
  { width: '34%', kind: 'heading' },
  { width: '88%', kind: 'line' },
  { width: '95%', kind: 'line' },
  { width: '0', kind: 'table' },
  { width: '0', kind: 'gap' },
  { width: '90%', kind: 'line' },
  { width: '71%', kind: 'line' },
  { width: '83%', kind: 'line' },
];

export function DocumentSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="h-full select-none overflow-hidden"
      style={{ filter: 'blur(6px)' }}
    >
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-2.5 px-6 py-14">
        {/* Twice through, so the shape runs off the bottom of any window rather
            than stopping half way and reading as a page that failed to load. */}
        {[...BLOCKS, ...BLOCKS].map((block, index) => {
          if (block.kind === 'gap') return <div key={index} className="h-5" />;

          if (block.kind === 'table') {
            return (
              <div
                key={index}
                className="my-1.5 grid grid-cols-3 gap-px overflow-hidden rounded-[--radius-sm] bg-ink/15"
              >
                {Array.from({ length: 12 }).map((_, cell) => (
                  <div key={cell} className="h-6 bg-canvas" />
                ))}
              </div>
            );
          }

          return (
            <div
              key={index}
              className="rounded-full bg-ink"
              style={{
                width: block.width,
                height: block.kind === 'heading' ? 17 : 10,
                marginTop: block.kind === 'heading' ? 12 : 0,
                // Headings sit darker than body lines, which is what makes the
                // shape read as a document rather than a loading state.
                opacity: block.kind === 'heading' ? 0.34 : 0.15,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
