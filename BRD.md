# Open Artifact — Business Requirements Document

**Status:** v3 — all open questions decided, ready for sprint planning
**Date:** 2026-07-22
**Owner:** Bala

---

## 1. What this product is

Open Artifact is an open-source artifact manager. It lets anyone using an LLM harness (Claude Code, Codex, or similar) publish HTML and Markdown files as hosted web pages ("artifacts") on a public server, share them with specific people or groups, and collect comments on them.

Think of it as a self-hostable, open-source version of Claude's Artifacts feature — with sharing and commenting built in — that any LLM harness can use through a skill.

There are two ways to use it:

1. **The skill (CLI/agent interface):** the LLM harness logs in, publishes files, changes sharing settings, and reads/adds comments on behalf of the user.
2. **The web UI:** people open artifacts in a browser, manage sharing, and hold comment discussions.

## 2. The problem we are solving

- LLM harnesses produce useful HTML and Markdown outputs (reports, dashboards, docs, mockups), but they live on the user's machine. Sharing them means emailing files or pasting content into other tools.
- Existing artifact hosting (e.g., Claude's built-in artifacts) is closed, tied to one vendor, and cannot be self-hosted.
- There is no lightweight way for a reviewer to comment on a specific part of a published artifact and for the author's agent to read those comments and act on them.

## 3. Goals

- Publishing an artifact from any LLM harness takes one skill invocation and returns a shareable link.
- Sharing supports three levels: specific people (by email), everyone in an email domain, and fully public.
- Comments are first-class: readable and writable both from the skill and from the UI, anchored to positions in the document.
- The agent feedback loop works: a reviewer comments in the UI, the author's agent reads the comments via the skill and revises the artifact.
- The whole system is open source and self-hostable.

## 4. Not in scope (for v1)

- Real-time collaborative editing of artifacts.
- Artifact formats other than HTML and Markdown (no PDF, images-only, or arbitrary file hosting).
- Organizations/teams as managed entities (domain-based sharing covers the group case).
- Mobile apps. The web UI should work on mobile browsers, but no native apps.
- Editing artifact content in the UI. Artifacts are published from files; updates come by re-publishing.

## 5. Who uses it

| Persona | Who they are | What they need |
|---|---|---|
| **Author** | A developer/analyst using an LLM harness. Owns artifacts. | Publish fast, control who sees what, hear feedback without leaving the terminal. |
| **Collaborator** | A person the artifact is shared with (by email or domain). | Open the link, read the artifact, leave comments at specific spots, get notified when mentioned. |
| **Public viewer** | Anyone with the link to a public artifact. | Read the artifact. No account needed. |
| **Self-hoster / operator** | Someone running an Open Artifact server for their team or community. | Simple deployment, sane defaults, control over signups. |

## 6. Core concepts

- **Artifact:** a published HTML or Markdown document with a stable URL. Owned by exactly one user. Re-publishing the same artifact updates the content at the same URL.
- **Sharing level:** every artifact is one of: **private** (owner only — the default on publish), **shared with people** (a list of email addresses), **shared with a domain** (everyone who signs in with an email at that domain, e.g. `zorp.one`), or **public** (anyone with the link, no sign-in). People-list and domain sharing can be combined.
- **Comment:** a note attached to an artifact, optionally anchored to a specific position in the document. Comments support one level of replies (a single thread under each top-level comment — no nested trees). Every top-level comment is either **open** or **resolved** — this is how an author marks feedback as addressed.
- **Position anchor:** how a comment points at a spot in the document (a section, paragraph, or text range). When the document is updated, the anchor is re-matched by exact text/heading match. If no exact match is found, the comment falls back to document-level. No fuzzy re-anchoring in v1 — a comment must never point at the wrong text.
- **Mention:** tagging a user inside a comment (e.g. `@bala@zorp.one`), which notifies them.
- **Notification:** an email (and an in-UI indicator) triggered by sharing and mentions.

## 7. User stories

Stories are grouped into epics. Each story has acceptance criteria — the story is done only when all criteria pass.

### Epic A — Accounts and authentication

**A1. Sign up / sign in on the web**
As a person, I can create an account and sign in on the web UI with my email address, so that artifacts can be shared with me and my comments carry my identity.
- Two sign-in methods, both supported: magic-link email (works on any self-hosted instance with just SMTP) and Google OAuth (one-click for Google-workspace teams). Both prove control of the email address, which is what sharing and domain access key on.
- After sign-in I land on my artifact dashboard — unless I arrived via a share or notification link, in which case I land on that artifact (deep link wins over dashboard).
- My display name and email are visible on my comments.

**A2. Log in via the skill**
As an author, I can run the skill's login operation from my LLM harness and authenticate my terminal session, so that subsequent skill operations act as me.
- Login from a terminal works without copy-pasting passwords into the agent (device-code or browser-handoff flow; the agent never sees my password).
- The credential is stored locally and reused across harness sessions until it expires or I log out. Tokens expire after 90 days of no use (self-host configurable).
- A clear error tells me when I am not logged in and how to log in.

**A3. Log out via the skill**
As an author, I can run the skill's logout operation, so that my credential is revoked on this machine.
- Logout deletes the local credential and revokes the token server-side.
- Skill operations after logout fail with "not logged in".

**A4. See and revoke my active sessions from the web UI**
As a user, I can see every device/skill session logged in as me and revoke any of them, so that a lost or stolen token can be killed from anywhere.
- Settings page lists active sessions with device label and last-used time.
- Revoking a session invalidates its token server-side immediately; the next skill call from that machine fails with "not logged in".

**A5. Operator controls who can sign up**
As a self-hoster, I can set the signup mode of my server, so that I control who gets accounts.
- Three modes: open (anyone), invite-only (existing users invite by email), domain-allowlist (only emails at listed domains).
- Mode is set in server config; changing it does not affect existing accounts.

### Epic B — Publishing artifacts (skill)

**B1. Publish a file as an artifact**
As an author, I can publish a local HTML or Markdown file via the skill and get back a URL, so that I can share my work in seconds.
- Accepts `.html` and `.md` files; rejects other types with a clear message.
- Rejects files over the size limit (default 5 MB, self-host configurable) with a clear message.
- Returns a stable, unguessable URL.
- A newly published artifact is **private** by default — nobody but me can open it.
- Markdown is rendered server-side as GitHub-Flavored Markdown (tables, code highlighting, task lists). Raw HTML embedded inside a `.md` file is sanitized/stripped — Markdown artifacts must never carry live scripts.
- `.html` files are served as-is but sandboxed (see §9 security) — this is the deliberate fork: Markdown gets sanitized, HTML gets isolated.
- The artifact has a title (from the file's `<title>`/first heading, overridable via a skill parameter).

**B2. Update an existing artifact**
As an author, I can re-publish a file to an existing artifact URL, so that the link I already shared shows the new content.
- Publishing with the artifact's ID/URL replaces the content; the URL does not change.
- Previous versions are stored internally (recovery and debugging only) — neither the UI nor the skill exposes version history in v1.
- Sharing settings and comments are preserved across updates.
- Comment anchors are re-matched by exact text/heading match; anchors that no longer match fall back to document-level (they are not lost, and never point at wrong text).
- If two sessions update the same artifact at once, the server detects the conflict (the update carries the version it was based on) and rejects the stale write with a clear error, instead of silently overwriting.

**B3. Delete an artifact**
As an author, I can delete an artifact via skill or UI, so that content I no longer want published is gone.
- Deletion removes the content, all comments, and all shares.
- The URL stops serving the content (returns "gone", never stale content).
- The artifact disappears from recipients' "Shared with me".
- Deletion is irreversible; the UI requires a confirmation, the skill requires an explicit confirm flag.

### Epic C — Sharing and permissions (skill + UI)

**C1. Share with specific people**
As an author, I can share an artifact with a list of email addresses (via skill or UI), so that only those people can open it.
- Recipients must sign in with the invited email to view.
- If the recipient has no account yet, the share is held as a pending invite keyed to that email; the moment they first sign in with that verified email, access attaches automatically. Signing in with a different email does not grant access.
- Recipients get an email notification with the link (with my name and the artifact title).
- I can remove a person; they lose access immediately.

**C2. Share with a domain**
As an author, I can open an artifact to everyone at an email domain (e.g. `zorp.one`), so that my whole team can view it without me listing every address.
- Anyone signed in with a verified email at that domain can view. (Domain membership means proven control of an address at that domain — that is exactly what email verification proves.)
- Sharing to well-known public email providers (gmail.com, outlook.com, yahoo.com, etc.) is blocked with an explanation — it would silently share with the whole world.
- Domain sharing does not notify the whole domain (no mass email); the author shares the link themselves.
- I can add multiple domains and remove them.

**C3. Make an artifact public**
As an author, I can make an artifact public, so that anyone with the link can read it without an account.
- Public artifacts require no sign-in to view.
- Commenting is never public: on any artifact, only the owner and explicitly shared users (by email or domain) can comment. Signed-in strangers on a public artifact can read but not comment. This keeps public artifacts from becoming spam targets.
- I can flip an artifact back to private/shared at any time; access changes immediately.

**C4. Change permissions from the skill**
As an author, I can view and change an artifact's sharing settings from the skill, so that my agent can manage access as part of my workflow.
- Skill can: set sharing level, add/remove emails, add/remove domains, and report current settings.
- Same rules and same notifications as the UI — one permission model, two interfaces.

### Epic D — Comments via the skill (the agent feedback loop)

**D1. Read comments, newest activity filterable by time**
As an author, I can read an artifact's comments through the skill, filtered by when they were made, so that my agent can pick up feedback since the last revision.
- Skill returns comments with: author, timestamp, position anchor, body, open/resolved status, and thread replies.
- Supports "comments since <timestamp>" and filtering by open/resolved, so the agent can fetch only feedback that still needs action.
- Output is structured (JSON) so agents can act on it reliably.

**D2. Add a comment at a specific position**
As an author, I can add a comment anchored to a specific position in the document through the skill, so that my agent can respond to feedback in place or annotate the document.
- Skill accepts a position (heading/paragraph/text-snippet reference) and a body.
- Position anchors work on Markdown artifacts. HTML artifacts accept document-level comments only in v1 (anchoring inside arbitrary HTML is unreliable).
- The comment shows up in the UI at that position, attributed to me.
- Skill can also reply within an existing thread.

**D3. Resolve a comment via the skill**
As an author, I can mark a comment thread resolved through the skill, so that after my agent addresses feedback, the reviewer can see it was handled.
- Resolving flips the thread to resolved; the UI shows it as resolved (collapsed but reopenable).
- The comment's author or the artifact owner can resolve; either can reopen.
- Scope note: the skill can add, reply, and resolve — editing and deleting comments is UI-only in v1. This asymmetry is deliberate: destructive comment changes should be done by a person in the UI, not an agent.

### Epic E — Comments in the UI

**E1. Add a comment at a position**
As a collaborator, I can select a spot in the artifact and leave a comment there, so that my feedback lands exactly where it applies.
- On Markdown artifacts I can attach a comment to a text selection or a section; the comment appears alongside that spot.
- On HTML artifacts, comments are document-level only in v1.
- I can also leave a document-level comment not tied to any position.

**E2. Edit and delete my own comments**
As a collaborator, I can edit or delete comments I wrote.
- Edited comments show an "edited" marker.
- I can only edit/delete my own comments; the artifact owner can additionally delete any comment on their artifact.
- Deleting a top-level comment with replies keeps the thread readable (shows "comment deleted" placeholder rather than orphaning replies).

**E3. Reply in a single thread**
As a collaborator, I can reply to a comment, and replies stack one below the other under it, so that discussions stay in one readable thread.
- Exactly one level of nesting: top-level comments, each with a flat list of replies.
- Replies are ordered oldest-first within a thread.

**E4. Mention someone**
As a collaborator, I can tag another user in a comment with `@`, so that they are pulled into the discussion.
- Typing `@` suggests people explicitly shared on the artifact (by email) plus anyone who has already commented on it. On public artifacts the suggestion list is the same — never "all users".
- Mentioned users get a notification (email + in-UI) linking straight to the comment.
- Mentioning someone who does not have access never silently grants access. If the artifact owner does it, the UI offers to share in one step. If a non-owner does it, an access request is queued for the owner, and the mention notification is held until the owner grants access.

**E5. Resolve and reopen a thread**
As a collaborator or owner, I can mark a comment thread resolved or reopen it, so that everyone can see which feedback is still outstanding.
- The comment's author or the artifact owner can resolve/reopen.
- Resolved threads collapse in the UI but remain viewable and reopenable.
- Open and resolved threads are visually distinct at a glance.

### Epic F — Dashboard (UI home)

**F1. See my artifacts and artifacts shared with me**
As a signed-in user, when I open the UI I see two sections — "My artifacts" and "Shared with me" — so that I can find everything in one place.
- "My artifacts": everything I published, newest first, with title, sharing level, and last-updated time.
- "Shared with me": everything shared with my email or my domain, with the owner's name.
- Each row links to the artifact; my own rows link to its sharing settings too.

### Epic G — Notifications

**G1. Sharing notifies the recipients**
As a collaborator, when someone shares an artifact with my email, I get an email with the link, so that I know it exists.
- Email includes: who shared, artifact title, and a direct link.
- No notification spam: re-sharing the same artifact with the same person does not re-send.

**G2. Mentions notify the mentioned person**
As a collaborator, when someone mentions me in a comment, I get a notification, so that I can respond.
- Email + an in-UI unread indicator.
- The notification deep-links to the specific comment.

**G3. See and clear my notifications**
As a user, I have a notification list in the UI, so that the unread indicator has somewhere to point.
- Lists shares and mentions, newest first, unread ones marked.
- Opening a notification (or its deep link) marks it read; a clear-all action exists.

## 8. What v1 must include (summary checklist)

**Skill operations:** login, logout, publish (create + update), delete, get/set sharing, read comments (since-timestamp and open/resolved filters), add comment at position, reply to comment, resolve/reopen comment.

**UI:** sign in, dashboard (my artifacts / shared with me), artifact viewing (rendered Markdown, sandboxed HTML), sharing management, delete, comments (add at position, edit, delete, resolve/reopen, single-thread replies, mentions), notifications (share + mention emails, notification list with unread indicator), session management (view/revoke).

**Server:** open-source, self-hostable, one-command local setup (e.g. Docker compose), with a hosted "reference" instance optional.

## 9. Non-functional requirements

- **Security of published HTML:** artifacts contain arbitrary user HTML/JS. Each instance runs on a single domain; artifact HTML is rendered inside a sandboxed iframe with an opaque (null) origin, so artifact scripts run normally but can never read the viewer's cookies or call our API as them. Access control happens server-side before the content is ever served into the frame. This is a hard requirement, not a nice-to-have.
- **Private means private:** unguessable URLs are not access control. Private/shared artifacts require authentication; public ones rely on the link.
- **Limits and abuse protection:** max artifact file size (default 5 MB), per-user storage and artifact-count caps, and rate limits on publish and comment endpoints. All limits are self-host configurable; the defaults protect a hosted instance.
- **Self-hosting:** a documented `docker compose up` brings the whole stack up, and a scripted smoke test (publish → view → comment) passes against the fresh instance. No mandatory third-party services except an email provider (SMTP-configurable).
- **Skill compatibility:** the skill is a thin client over a documented HTTP API, so any harness (Claude Code, Codex, custom agents) can implement it. The API is the contract; the skill is a convenience.
- **Performance:** p90 first contentful paint under 1 second for a ≤500 KB artifact on a 10 Mbps connection.
- **Data ownership:** owners can delete an artifact (story B3); deletion removes content and comments.
- **Account deletion:** deleting an account deletes all artifacts the person owns, and anonymizes their comments on other people's artifacts (body stays, author becomes "deleted user") so other people's discussions stay readable.

## 10. Decisions (all resolved — 2026-07-22)

Every open question is now decided. Change them here if anything shifts.

1. **Auth method:** both magic-link email and Google OAuth. Magic link keeps self-hosting simple (SMTP only); OAuth gives one-click sign-in for Google-workspace teams. (A1)
2. **HTML isolation:** single domain per instance; artifact HTML runs in a sandboxed iframe with an opaque origin. No subdomain-per-artifact, no wildcard TLS. Artifact scripts work but can never touch the viewer's session or our API. (§9)
3. **Comment anchoring:** position anchors fully supported on Markdown artifacts; HTML artifacts take document-level comments only in v1. (D2, E1)
4. **Versioning:** old versions stored internally only (recovery/debugging). Not exposed in the UI or the skill in v1. (B2)
5. **Hosted instance:** we host one instance for our own use on a Hetzner VPS, running the exact same Docker compose stack as self-hosters (we dogfood the self-host path), with Caddy for automatic TLS and Amazon SES as the SMTP provider for emails. No public flagship server in v1, so abuse limits ship with team-scale defaults.
6. **Account deletion:** deleting an account deletes the person's artifacts and anonymizes their comments on others' artifacts. (§9)

Decisions from the earlier review, still standing:
- Commenting requires an account AND explicit access (share or domain). Public viewers and signed-in strangers can read, not comment. (C3)
- Anchor re-matching is exact-match-or-fallback-to-document-level; no fuzzy matching in v1. (§6, B2)
- Skill can add/reply/resolve comments but not edit/delete them — those are UI-only in v1. (D3)
- Markdown is GFM; raw HTML inside `.md` files is stripped. (B1)
- Skill tokens expire after 90 days of no use; revocable from the UI. (A2, A4)
- Public email domains (gmail.com etc.) cannot be used for domain sharing. (C2)
- Concurrent updates to the same artifact are rejected with a version-conflict error, not last-write-wins. (B2)

## 11. How we will know v1 works (acceptance walkthrough)

The end-to-end demo that proves the product:

1. Bala runs the skill from Claude Code: logs in, publishes `report.html`, gets a link. The artifact is private.
2. Bala shares it with `teammate@zorp.one` via the skill. The teammate gets an email.
3. The teammate signs in, sees it under "Shared with me", selects a paragraph, and comments "this number looks off", mentioning `@bala@zorp.one`.
4. Bala gets the mention notification. Bala's agent runs the skill: "read open comments since yesterday", gets the comment with its position, fixes the file, re-publishes to the same URL.
5. The teammate refreshes: new content, same link, their comment thread intact. Bala replies in-thread via the skill and marks the thread resolved; the teammate sees the reply and the resolved state in the UI.
6. Bala flips the artifact to public and posts the link; a logged-out person can read it (but cannot comment).

If every step works, v1 is real.
