# PRD — Collaborative markdown editing

**Status:** Parked. Revisit after we have adoption. Not scheduled for build.
**Date:** 2026-07-24
**Owner:** Bala

---

## Why this is parked

The design below is complete enough to build, but we're prioritizing adoption of the
current publish-and-share product first. When usage justifies it, this is the starting
point — no re-discovery needed. Five open decisions (bottom of doc) must be settled
before any build.

---

## What we're building

Collaborative editing on markdown documents, in the style of RoughDraft, adapted to
open-artifact's existing model.

**Core model: suggestion + approval.** Every change — from a human or from AI — lands as
a tracked suggestion first. Nothing modifies the real document until a human with the
right permission accepts it. This fits our current setup (whole-document saves, optimistic
version check, no realtime infra) instead of fighting it.

**Three ways to invoke AI:**
1. Edit a line yourself.
2. Comment on a line asking AI to change that line or block.
3. Comment on the whole doc asking AI to rewrite across the document.

**Per-person colors** so you can see at a glance who proposed what, with AI in its own color.

**AI acceptance authority (the key nuance):** an AI suggestion belongs to whoever prompted
it. Only that person — or the owner — can accept or reject it. Everyone else can see it and
comment, but cannot merge it.

**Architectural flag:** today AI can only edit artifacts *it* published, through its own MCP
connection. "A person asks AI to rewrite a shared doc they don't own" is a new path — the
app itself must call the model on the person's behalf and write a suggestion. This is the
biggest build fork (see open decision #5).

---

## Roles (one new role needed)

Today: **owner** (edits, API only), **commenter** (view + comment), **viewer** (public link,
read only). Collaborative editing adds **editor**.

| Role | Read | Comment | Ask AI | Edit / suggest | Accept / reject | Manage sharing & roles |
|---|---|---|---|---|---|---|
| **Viewer** (public link) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Commenter** (shared) | ✅ | ✅ | ✅ (produces a suggestion) | ❌ | ❌ | ❌ |
| **Editor** *(new)* | ✅ | ✅ | ✅ | ✅ | ✅ (own + others' human suggestions; AI only if they requested it) | ❌ |
| **Owner** | ✅ | ✅ | ✅ | ✅ | ✅ (everything, incl. any AI suggestion) | ✅ |

---

## User stories

### Epic A — Editing access and roles
- **A1.** Owner invites someone as an *editor* (not just commenter), by email or domain, and can downgrade or revoke.
- **A2.** Editor edits a shared doc they don't own; edits are attributed to them; cannot delete, toggle public, or change roles.
- **A3.** Commenter asks AI to fix a line; it produces a *suggestion* that waits for an editor/owner to accept.
- **A4.** Any collaborator sees the people-and-roles list, so they know who can approve.

### Epic B — Human editing and suggestions
- **B1.** Editor edits a line inline; it shows as a colored suggestion attributed to them until accepted.
- **B2.** Editor selects a paragraph and proposes replacement text; original and proposed shown together (track-changes style).
- **B3.** Suggestion author sees status — pending / accepted / rejected, and by whom.
- **B4.** Author withdraws their own suggestion.

### Epic C — Comment-driven AI edits
- **C1.** Comment on a line "make this concise" → AI proposes the rewrite as a suggestion in AI's color, tagged "requested by [me]".
- **C2.** Doc-level instruction "tighten the whole thing" → AI returns a batch of suggestions across the doc, tied to one request, acceptable together or individually.
- **C3.** AI reads the comment thread on a line for context when asked to revise.
- **C4.** AI includes a short note on what it changed and why.
- **C5.** Requester replies "keep it shorter" and gets a revised suggestion.

### Epic D — Reviewing, colors, attribution
- **D1.** Each person's suggestions in a distinct color; AI in its own color.
- **D2.** Authorized reviewer accepts a suggestion → text merges, version increments.
- **D3.** Reviewer rejects with an optional reason.
- **D4.** Requester of a doc-wide AI rewrite accepts all or cherry-picks individual changes.
- **D5.** Reviewer filters the view — pending only, one person only, AI only.

### Epic E — The multi-person AI-acceptance nuance (core)
- **E1.** AI suggestion is owned by its requester; accept/reject enabled only for them and the owner.
- **E2.** Others can comment on an AI suggestion but cannot merge it.
- **E3.** Owner can accept/reject any AI suggestion, so the doc doesn't get stuck if the requester goes away.
- **E4.** A commenter who asked AI cannot accept their own AI suggestion (accepting is an edit) — it waits for an editor/owner.

### Epic F — Presence and awareness
- **F1.** See who has the doc open right now.
- **F2.** See that new suggestions/comments arrived while reading, so you refresh before acting.

### Epic G — Conflicts and merge
- **G1.** See when two suggestions target the same text.
- **G2.** Accepting a suggestion written against an older version re-applies cleanly or reports it no longer fits — never a silent wrong merge.
- **G3.** When the owner edits directly, pending suggestions re-anchor to new text or flag if they can't.

### Epic H — Anchoring across edits
- **H1.** Comments and pending suggestions follow their text as the document changes (extends existing `relocateAll`).
- **H2.** When target text is deleted, the suggestion is marked "orphaned / no longer applies" rather than silently vanishing.

### Epic I — Notifications
- **I1.** Requester notified when AI's suggestion is ready (AI is not instant).
- **I2.** Owner/editor notified of suggestions waiting for a decision.
- **I3.** Author notified when their suggestion is accepted or rejected.

---

## Corner cases

**Authority and the requester / edit-rights gap**
1. A commenter asks AI but can't accept (no edit rights) → falls to any editor or owner; commenter sees "waiting for an editor".
2. Requester loses access before accepting → ownership of that suggestion falls back to the owner.
3. Editor cannot accept an AI suggestion another editor requested — requester + owner only, even between equal editors.
4. Owner asks AI on their own *solo* doc → decide whether it applies directly or still suggests (open decision #1).
5. Two people ask AI the same thing on the same line → two separate suggestions, each owned by its requester; show both.

**Multiple suggestions colliding**
6. Human and AI suggestion on the same line → both visible; accepting one marks the other conflicting, not dropped.
7. Accepting A changes the text B was written against → B re-anchors or is flagged stale.
8. A doc-wide AI batch partially overlaps a human's pending edit → per-change conflict flags inside the batch.
9. Someone accepts while you're reading the old version → "document changed, refresh" before your next accept.

**AI-specific**
10. AI fails / times out / returns nothing → show "AI couldn't produce a suggestion", allow retry, no ghost pending item.
11. AI returns a huge doc-wide rewrite → cap or chunk; present as a reviewable diff; never auto-accept.
12. Prompt injection via document or comment content → AI output is always a suggestion needing human accept; content fed as data-not-instructions (existing MCP framing); AI can never accept, delete, share, or make public.
13. AI edits a line with an unresolved comment thread → keep the thread, re-anchor to proposed text, surface to reviewer.
14. A commenter spams AI requests on a doc they don't own → rate-limit per user per doc; owner can disable "commenters may ask AI".
15. AI request path: comment-driven AI on a human-owned doc needs a new server-side model call attributed to the app, not an MCP connection (open decision #5).

**Access and roles**
16. Editor downgraded to commenter with pending suggestions → suggestions remain; they can no longer accept.
17. Person removed mid-session → their editor stops accepting input; unaccepted suggestions stay (attributed), owner can clean up.
18. Public/link viewer tries to comment or ask AI → blocked (public read ≠ open comment box).
19. Domain-share edit rights may be too broad → consider restricting edit-level grants to explicit per-person invites; keep domain shares at comment level.

**Concurrency and versioning**
20. Two reviewers accept different suggestions at once → optimistic version check serializes; second accept re-bases or reports conflict (extends today's `version_conflict`).
21. A suggestion accept bumps the version while an MCP/API client updates against the old `baseVersion` → existing conflict path fires; must not wipe pending suggestions.
22. Offline while composing a suggestion → local until submitted; re-anchor against latest version on reconnect.

**Anchoring and content**
23. Target text edited by someone else before acceptance → re-anchor via context; if impossible, mark orphaned, don't guess.
24. Target text deleted by an accepted edit → orphaned; notify author.
25. Markdown structure changes (heading → list, table reformat) → anchor by surrounding context, not line number.

**Notifications and presence**
26. Requester offline when AI responds → notify (email/in-app) to come back and accept.
27. High-traffic doc → batch notifications ("5 new suggestions") instead of one per change.
28. Large domain share → don't leak the full member list; show only active-now presence.

---

## Open decisions (settle before build)

1. **Solo-owner fast path:** on an unshared doc, does the owner's own edit/AI request apply directly, or still go through suggest/accept? *(Leaning: direct when solo, suggest when shared.)*
2. **Editor accepting another editor's *human* suggestion:** allowed (normal review), while AI suggestions stay requester-only. Confirm this split.
3. **Can a commenter ask AI at all,** or is asking-AI editor-only? *(Leaning: allow commenters, which creates corner case #1.)*
4. **Live presence vs pure async:** do we want "who's here now", or is suggestion + notification enough for v1?
5. **AI request plumbing:** new in-app server-side model call for human-owned docs vs. extending the MCP model. Biggest architectural fork.

---

## Grounding — current system this builds on

- Access rules: `packages/server/src/artifacts/access.ts` (actions: view / comment / manage; no editor role yet)
- Schema + versions + shares: `packages/server/src/db/schema.ts` (artifacts 271–315, versions 402–416)
- Sharing service: `packages/server/src/artifacts/sharing.ts` (per-email, per-domain, public flag)
- Optimistic versioning + CRUD: `packages/server/src/artifacts/service.ts` (`baseVersion` → `version_conflict`)
- Comment anchoring / relocation: `packages/server/src/comments/`, `relocateAll` called on every update
- AI/MCP tools: `packages/server/src/mcp/tools.ts` (8 tools; a connection may only touch artifacts it published)
- Viewer (no editor exists yet): `packages/web/src/pages/Artifact.tsx`

**Three gaps the feature confronts:** no editor role, no in-app editing UI, no realtime/merge layer.
