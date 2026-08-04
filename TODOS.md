# TODOS

Deferred work, with enough context that someone picking it up in three months
understands the motivation and where to start.

---

## Multi-block batch save

**What:** Let the owner open several blocks in edit mode, fix them all, and save once.
Splice the edits into the source in descending offset order so earlier offsets stay
valid, then send a single `PUT /api/artifacts/:id`.

**Why:** Block editing as shipped creates one version per block saved. Three typo fixes
in one sitting produce three versions. That cost was accepted deliberately when the
feature was designed (see `~/wiki/plans/2026-08-04-markdown-block-editing-design.md`,
decision 2), on the grounds that recoverability matters more than tidy history. This is
the fix if the churn starts to bite. As of 2026-08-04 the instance holds 131 versions
across 52 artifacts.

**Pros:** An editing session produces one version instead of N. Conflict handling does
not change at all, because it is still one whole-document PUT carrying one `baseVersion`.

**Cons:** Needs a global save control rather than per-block save, and the editor has to
hold dirty state for several blocks at once. Only worth it if version churn turns out to
be a real annoyance rather than a theoretical one.

**Context:** Raised as option B of decision D5 during the engineering review on
2026-08-04 and deliberately deferred, to stay consistent with the smallest-build scope
chosen throughout. The descending-offset splice order is the whole trick: apply the
last edit first and every earlier offset is still valid.

**Depends on:** Block editing shipped and in real use, so there is evidence about
whether churn actually hurts.

---

## Gap detection for unreachable source regions

**What:** Sum the source ranges covered by clickable blocks, compare against the source
length, and when gaps exist tell the reader which kinds of content can only be changed
in the full source view.

**Why:** Some source regions belong to no rendered block and cannot be reached by block
editing at all. Verified during the 2026-08-04 review: GFM footnote sections render with
no position data, and footnote bodies plus link reference definitions occupy source that
no element covers. Raw HTML blocks are dropped at render entirely (see
`packages/server/src/render/markdown.ts:8`). The shipped design gives the owner an exit
from this state, a persistent "Edit full source" control, but never explains why the
thing they wanted to click is inert.

**Pros:** Turns a confusing dead area into an explained one. Removes the "why can I not
click this?" moment rather than only offering a way around it.

**Cons:** Roughly fifteen lines, plus a second thing that has to stay correct as remark
and remark-gfm change what they generate.

**Context:** Raised as option B of decision D4 during the engineering review on
2026-08-04. Passed over on the judgement that the persistent full-source control removes
most of the confusion on its own, and that agent-generated Markdown rarely contains
footnotes or link reference definitions. Revisit if that assumption proves wrong.

**Depends on:** Real usage showing people actually try to click these regions.
