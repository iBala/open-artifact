# Open Artifact — Sprint and Ticket Plan

**Status:** v2 — independent review incorporated. Sprints 1 to 4 are built.
**Date:** 2026-07-22
**Source:** BRD.md v3 (all decisions resolved)

---

## Where the build has got to

Sprints 1 to 4 are done, committed, and green: 415 tests, 13 of them driving a
real browser.

| Sprint | State | Notes |
|---|---|---|
| 1 Publish and view | Done | The sandbox is proven by running the attack in a browser, not by reading headers |
| 2 Accounts and login | Done | Email link, Google, CLI device flow, sessions page |
| 3 CLI and skill | Done | Skill claims are checked against real behaviour by a test |
| 4 Sharing and permissions | Done | 46-case access matrix; pending invites; public-provider blocklist |
| 5 The web UI | Next | Design foundation already exists from 2.6 and can be built on |
| 6 Comments | Not started | |
| 7 Mentions and notifications | Not started | |
| 8 Hardening and deploy | Not started | |

Three things were found by tests and fixed rather than discovered later:

- `/api/artifacts/:id` was matching `shared-with-me` as an artifact id. Moved to
  `/api/shared-with-me` so the ambiguity is gone rather than depending on route
  registration order.
- The OpenAPI drift check found two endpoints that existed but were undocumented
  on its first run.
- A validation error from the server mapped to the CLI's server-failed exit code,
  telling an agent the server had broken when its own request was wrong.

Deviations from this plan, both deliberate:

- **Mailpit.** Ticket 2.2 called for a Mailpit container in tests. Tests instead
  run a real SMTP server in process: same protocol, same nodemailer transport,
  starts in milliseconds, and cannot leave a container running when a test fails.
  Mailpit still belongs in the development compose stack for looking at mail in a
  browser (ticket 8.2).
- **The design foundation (5.1)** was largely built during 2.6, because the web
  shell needed it. Sprint 5 builds on it rather than starting it.

---

## Tech stack (decided here, feeds every ticket)

Chosen for one reason above all: the product promise is "one `docker compose up` and you're running." Every choice below minimizes moving parts.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (server, web, CLI) | One language, one toolchain, shared types between API and clients. |
| Server | Node.js LTS + Hono | Small, fast, testable HTTP framework; the REST API is the product contract. |
| Database | SQLite via Drizzle ORM | Zero extra container. Backups are a file copy. Right size for team-scale instances. |
| Web UI | React + Vite + Tailwind, anime.js for motion | Standard, fast to build, room for the design quality bar. |
| Markdown | unified (remark-gfm → rehype-sanitize → rehype-highlight) | GFM rendering with sanitization as a pipeline step, not an afterthought. |
| Email | nodemailer over SMTP | SES in production, Mailpit container in dev/tests. Self-hosters plug in any SMTP. |
| Auth | Magic link (custom) + Google OAuth; session cookies for UI, bearer tokens for CLI | Per BRD decision 1. Device-code flow for CLI login. |
| CLI | `open-artifact` npm package | The skill wraps the CLI; any harness can use either the CLI or the raw API. |
| Deploy | Docker compose: app container + Caddy | Caddy gives automatic TLS. SQLite lives on a volume. |
| Tests | Vitest (unit/API), Playwright (E2E), Mailpit (email assertions) | Every ticket ships with tests; E2E covers the demo script of each sprint. |

Development follows TDD using the skills in `/Users/balapanneerselvam/projects/skills/`.

Repo layout: pnpm monorepo — `packages/server`, `packages/web`, `packages/cli`, `packages/shared` (types + API client), `skill/` (the harness skill), `deploy/` (compose, Caddy config, smoke test).

---

## Sprint map

| Sprint | Name | Demo at the end |
|---|---|---|
| 1 | Publish and view | Publish a file with curl, see it rendered safely in a browser |
| 2 | Accounts and login | Sign in via magic link and Google; CLI logs in; artifacts are private to their owner |
| 3 | CLI and skill | Publish from Claude Code with one skill call |
| 4 | Sharing and permissions | Share by email/domain/public; recipient gets email and access |
| 5 | The web UI | Dashboard, viewer, sharing dialog — the product looks like a product |
| 6 | Comments | Positioned comments in UI and skill; the agent feedback loop works |
| 7 | Mentions, notifications, account lifecycle | Mentions notify; notification center; account deletion |
| 8 | Hardening and production deploy | Live on Hetzner with TLS, SES, rate limits, passing smoke test |

Each sprint builds on the previous and ends runnable. Sprint numbers are dependency order.

---

## Sprint 1 — Publish and view

Goal: the core pipeline — file in, safe web page out. Auth is a temporary dev token, replaced in Sprint 2.

**Demo:** `curl` publishes `report.md` and `dashboard.html`; both render in a browser at unguessable URLs; Markdown is GFM with scripts stripped; HTML runs in a sandboxed iframe; re-publishing updates the same URL; a stale update is rejected.

- **1.0 Typed config loader.** One module parses and validates all env config at boot (port, size limits, SMTP, OAuth, signup mode, rate limits — keys added as later tickets need them) and fails fast with a clear message on missing or invalid required vars. Every key documented. Self-host failures are almost always env typos; this turns them into boot-time errors instead of silent runtime bugs. *Done when: tests cover valid config, missing-required-var failure with a readable message, and defaults applied.*
- **1.1 Repo scaffold and CI.** pnpm monorepo, TypeScript strict, Vitest wired, lint, Apache-2.0 license, GitHub Actions running lint+tests on push. *Done when: CI is green on a trivial passing test in each package.*
- **1.2 Database layer and migrations.** SQLite + Drizzle; tables: `users` (stub), `artifacts`, `artifact_versions`; migration runner that applies on boot. *Done when: migration tests pass on a fresh and an already-migrated database.*
- **1.3 Create artifact endpoint.** `POST /api/artifacts` accepts Markdown or HTML content, validates type and size (default 5 MB, config-driven), stores content and a version row, generates an unguessable slug, derives the title from `<title>`/first heading (overridable via a `title` parameter), returns id/slug/URL. *Done when: tests cover happy path, wrong type, oversize, slug uniqueness, and title derivation/override.*
- **1.4 Markdown rendering pipeline.** GFM (tables, task lists, code highlighting), heading ids (anchors need them later), raw HTML stripped via rehype-sanitize. *Done when: golden-file tests pass, including XSS attempt fixtures (script tags, event handlers, javascript: URLs all neutralized).*
- **1.5 Artifact serving with sandbox.** View route serves a shell page; content renders inside `<iframe sandbox="allow-scripts">` from a content endpoint with a strict CSP including `connect-src 'none'`; the iframe origin is opaque. *Done when: tests assert the sandbox attribute and CSP headers, that content responses carry no session cookies, AND a browser test proves the real threat is closed: a script running inside the frame attempting `fetch('/api/...', {credentials:'include'})` is blocked or arrives unauthenticated. Header assertions alone don't count — verify in an actual browser during implementation.*
- **1.6 Update artifact with conflict detection.** `PUT /api/artifacts/:id` carries the version it was based on; stale writes get 409; every update stores a new internal version row; title re-derived unless overridden. *Done when: tests cover update, 409 on stale, version rows accumulating, and comments/shares surviving (placeholder assertions until those exist).*
- **1.7 Delete artifact.** `DELETE /api/artifacts/:id` requires a confirm flag; content, versions gone; URL returns 410. *Done when: tests cover delete, missing confirm flag rejected, 410 after.*
- **1.8 Dev token guard.** All write routes require a bearer token from env config. Throwaway, replaced by 2.9. *Done when: requests without the token get 401.*
- **1.9 Health endpoint.** `GET /healthz` returns 200 when the database is reachable and migrations are current; used by compose healthchecks (8.2) and uptime monitoring (8.6). *Done when: tests cover healthy and database-down responses.*
- **1.10 Structured logging.** Requests log method, path, status, latency; unhandled errors log with a request id; log level configured via 1.0. Self-host operators debug with these logs. *Done when: tests assert log output for a request and an unhandled error.*

---

## Sprint 2 — Accounts and login

Goal: real identity. Passwordless accounts, two sign-in methods, CLI device flow, ownership enforced.

**Demo:** sign up in the browser via magic link (Mailpit shows the email); sign in with Google; the CLI runs a device-code login approved in the browser; a published artifact is visible to its owner and 404s for anyone else; the sessions page revokes a token and the CLI immediately fails with "not logged in."

- **2.1 Identity schema.** `users` (email, display name, verified), `auth_sessions` (UI cookies), `api_tokens` (CLI, 90-day sliding expiry), `magic_links` (single-use, 15-min expiry). *Done when: schema migration tests pass.*
- **2.2 Email sender.** nodemailer abstraction, SMTP config from env; Mailpit container in dev and tests. *Done when: an integration test sends through Mailpit and asserts the received message.*
- **2.3 Magic link flow.** Request link → email → verify → session cookie (HttpOnly, Secure, SameSite=Lax). Links are single-use and expire. *Done when: tests cover happy path, expired link, reused link, and unknown email creating an account only when signup mode allows.*
- **2.4 Google OAuth flow.** Standard OAuth code flow; verified email from Google maps to the same user record as magic link (email is the identity key). Google sign-in is enabled only when OAuth credentials are set in config (1.0); without them the login page shows magic link only — so no sprint demo ever blocks on obtaining Google credentials. *Done when: tests with a mocked provider cover new user, existing user, email-mismatch, and credentials-not-configured cases.*
- **2.5 Signup modes.** Server config: `open` / `invite-only` / `domain-allowlist`. Enforced in both auth flows. *Done when: table-driven tests cover all three modes for both flows.*
- **2.6 Web app shell.** Vite app with routing, login page (both methods), authenticated layout, logged-in placeholder home. *Done when: Playwright logs in via magic link (Mailpit) and reaches the home page.*
- **2.7 CLI device-code login.** `POST /api/auth/device` issues a code; user approves at a URL in the browser; CLI polls and stores the token in `~/.open-artifact/credentials`. Logout revokes server-side and deletes the local file. *Done when: integration test drives the full flow; token file has 0600 permissions.*
- **2.8 Sessions page.** UI lists active sessions and API tokens (device label, last used); revoke any of them; revocation is immediate. *Done when: Playwright revokes a token and an API call with it gets 401.*
- **2.9 Ownership enforcement.** Migration adds `owner_id` to `artifacts` (dev-created rows backfilled to a seed user); artifacts belong to their creator; private by default: only the owner can view, update, share, or delete. Replaces the 1.8 dev token. *Done when: migration tests pass and an authorization test matrix covers owner/non-owner/anonymous against every artifact endpoint.*

---

## Sprint 3 — CLI and skill

Goal: the harness experience. Everything an agent needs to publish, as a clean CLI and a skill wrapping it.

**Demo:** inside Claude Code, invoke the skill: login (browser approval), publish `report.md`, get a URL back, update it, delete it, logout. All output machine-readable.

- **3.1 CLI core commands.** `login`, `logout`, `whoami`, `publish <file>` (creates, or updates with `--id`), `delete <id> --confirm`. `--json` flag on everything for agent consumption. *Done when: integration tests run every command against a test server.*
- **3.2 CLI error contract.** Distinct exit codes and stable JSON error shapes for: not logged in, file too large, wrong file type, version conflict, no access, server unreachable. *Done when: each error case has a test asserting exit code and message.*
- **3.3 Shared API client.** `packages/shared` exports typed API client + request/response types, used by CLI and web. *Done when: CLI and web both compile against it; a type-level test pins the API surface.*
- **3.4 The skill.** `skill/` contains SKILL.md instructing a harness to use the CLI: when to publish, how to parse `--json` output, how to surface the URL. Install docs for Claude Code and generic harnesses. *Done when: a deterministic script that invokes the CLI exactly as SKILL.md instructs runs login → publish → update → delete against a test server, asserting the parsed `--json` output at each step (this is the CI gate); a real Claude Code transcript is checked into `skill/examples/` as reference evidence, not as the gate.*
- **3.5 API reference.** OpenAPI spec generated from route definitions, served at `/api/docs`. The API is the contract; the spec is how third parties build their own clients. *Done when: spec validates, and a CI test fails if routes and spec drift.*

---

## Sprint 4 — Sharing and permissions

Goal: the three sharing levels, enforced server-side, with share notifications.

**Demo:** share an artifact with an email — recipient gets the email, signs in (as a brand-new user), sees the artifact; share to a domain — a colleague signs in with that domain and has access; flip public — a logged-out browser reads it; remove the person — their access dies instantly.

- **4.1 Sharing schema.** `artifact_shares` (email shares, pending or attached), `artifact_domain_shares`, `is_public` flag on artifacts. *Done when: migration tests pass.*
- **4.2 Access decision function.** One function answers "can this principal view/comment-on/manage this artifact?" covering owner, email share, domain share, public, anonymous. Everything else calls it. *Done when: an exhaustive table-driven test covers the full matrix (principal type × sharing state × action).*
- **4.3 Sharing API.** Get and set sharing: add/remove emails, add/remove domains, set public/private. Owner-only. *Done when: tests cover each mutation, non-owner rejection, and immediate effect of removal.*
- **4.4 Pending invites.** Sharing to an address with no account creates a pending share; on first verified sign-in with that email, access attaches automatically. *Done when: tests cover invite-before-signup, signup with a different email (no access), and both auth methods.*
- **4.5 Public email domain blocklist.** Domain sharing rejects gmail.com, outlook.com, yahoo.com, and a maintained list, with a clear error. *Done when: tests cover blocked and allowed domains.*
- **4.6 Share notification email.** Recipient gets an email (who shared, artifact title, link). Re-sharing the same artifact to the same address does not re-send. *Done when: Mailpit tests assert content and the dedupe.*
- **4.7 Public viewing.** Public artifacts render without a session — still sandboxed, still no cookies on content responses. *Done when: tests fetch a public artifact with no auth and a private one gets 404, not 403 (don't leak existence).*
- **4.8 CLI and skill sharing operations.** `share <id>` subcommands: add/remove email, add/remove domain, set public/private, show current settings. Skill docs updated. *Done when: integration tests cover each operation end to end, including the notification email firing.*
- **4.9 Deep-link sign-in.** Opening a shared artifact while logged out routes through login and back to the artifact's view URL (BRD A1). In this sprint that target is the server-rendered shell from 1.5; the polished React viewer takes over in 5.3. *Done when: Playwright covers logged-out → magic link → lands on the artifact's view URL.*

---

## Sprint 5 — The web UI

Goal: the product's face. Dashboard, viewer chrome, sharing dialog — to the design quality bar (motion, empty states, delight in the details).

**Demo:** log in and land on a dashboard with "My artifacts" and "Shared with me"; open an artifact; manage sharing from a dialog; delete with confirmation; everything works on a phone browser.

- **5.1 Design foundation.** Design tokens (type scale, spacing, color), base components, page transitions and micro-interactions with anime.js, designed empty states for both dashboard sections. *Done when: a design checklist review passes (the primary gate). Playwright visual snapshots run inside a pinned container image with a small diff tolerance — supporting signal only, since pixel-exact diffs across environments are false-failure machines.*
- **5.2 Dashboard.** Two sections: My artifacts (title, sharing level, last updated, newest first) and Shared with me (title, owner name). Rows link to the artifact. *Done when: Playwright covers both sections populated and empty.*
- **5.3 Artifact viewer chrome.** Title bar with owner, updated time, share button (owner only), the sandboxed content below. Responsive. *Done when: Playwright covers owner and recipient views, desktop and mobile viewport.*
- **5.4 Sharing dialog.** Manage emails, domains, and the public toggle in one place; shows pending invites distinctly; copy-link button. *Done when: Playwright covers add/remove of each type and the public flip.*
- **5.5 Delete flow.** Delete from the viewer or dashboard, with a confirmation that names the artifact. *Done when: Playwright covers confirm and cancel paths.*
- **5.6 UI polish pass.** Loading states, error states, focus states, keyboard navigation on dialogs. *Done when: an accessibility/interaction checklist passes; no layout shift on load (measured); the BRD performance budget is enforced in CI — p90 first contentful paint under 1s for a 500 KB fixture artifact, measured via Playwright trace/Lighthouse on the pinned CI environment.*
- **5.7 Not-found and no-access pages.** A designed page for "this artifact doesn't exist or you don't have access" (one page — never reveal which), plus an app-wide 404 route. *Done when: Playwright covers a logged-in user opening an artifact they can't see and a nonexistent URL; neither leaks existence.*

---

## Sprint 6 — Comments

Goal: the feedback loop. Positioned comments on Markdown artifacts, document-level on HTML, full thread lifecycle, all mirrored in the skill.

**Demo:** a teammate selects a paragraph and comments; the owner's agent reads open comments as JSON via the skill, replies in-thread, resolves; the teammate sees the resolved thread collapse in the UI. On an HTML artifact, the same works at document level.

- **6.1 Comments schema.** `comment_threads` (artifact, anchor, status open/resolved), `comments` (thread, author, body, edited flag, deleted placeholder flag). One nesting level by construction. *Done when: migration tests pass.*
- **6.2 Anchor model.** Anchor = heading id + text snippet (or document-level). On artifact update, re-match by exact snippet; no match → fall back to document-level, never mis-attach. *Done when: unit tests cover match, content-moved, content-deleted, and duplicate-snippet cases.*
- **6.3a Comment write operations.** Create thread (with anchor), reply, edit own, delete (own; artifact owner deletes any; deleted-with-replies leaves a placeholder). Commenting requires view access via an explicit share or domain — public viewers and unshared users cannot comment. *Done when: permission and lifecycle tests cover the write rules in BRD Epics D and E.*
- **6.3b Comment lifecycle and read.** Resolve/reopen (comment author or artifact owner), list with `since` and `status` filters, replies oldest-first. *Done when: tests cover resolve/reopen permissions and every filter combination.*
- **6.4 Commenting UI: create and read.** Select text → comment popover (Markdown artifacts); margin markers at anchored positions; thread panel with replies oldest-first; document-level comment entry always available. HTML artifacts show only the document-level entry. *Done when: Playwright covers anchored and document-level creation on both artifact types.*
- **6.5 Commenting UI: lifecycle.** Edit own (shows "edited"), delete own, artifact owner deletes any, deleted-with-replies placeholder, resolve/reopen with collapsed-but-expandable resolved threads. *Done when: Playwright covers each action and the visual open/resolved distinction.*
- **6.6 Skill comment operations.** `comments list <id> [--since ts] [--status open|resolved] --json` (`--since` takes UTC ISO-8601, per the cross-cutting timestamp rule), `comments add <id> --anchor ... --body ...`, `comments reply <thread> --body ...`, `comments resolve <thread>` / `reopen`. JSON includes author, timestamp, anchor, status, replies. *Done when: an integration test replays the full BRD §11 agent loop: read open comments → reply → resolve.*
- **6.7 Anchor survival across updates.** Wire 6.2 into the update path; comments and threads survive re-publish; fallen-back threads are marked so the UI can say "position lost in an update." *Done when: E2E test publishes, comments, re-publishes with moved/removed content, and asserts anchors re-matched or fell back correctly.*

---

## Sprint 7 — Mentions, notifications, account lifecycle

Goal: people find out. Mentions with access-aware behavior, a notification center, and account deletion.

**Demo:** a comment with `@teammate` sends an email that deep-links to the comment; the bell shows unread; a non-owner mentioning an outsider queues an access request for the owner; deleting a test account removes its artifacts and anonymizes its comments.

- **7.1 Mention parsing and suggestions.** `@` in the composer suggests explicitly shared users plus prior commenters (same list on public artifacts — never all users). Mentions stored structurally, not by string-matching later. *Done when: unit tests cover parsing; API test covers the suggestion source rules.*
- **7.2 Notifications model and fan-out.** `notifications` table (type: share, mention, access-request; read flag). Share and mention events create rows and send email. *Done when: tests cover each event type creating exactly one notification and one email.*
- **7.3 Access-aware mention rules.** Owner mentions an outsider → one-step share offer. Non-owner mentions an outsider → access request queued to the owner; the mention notification is held until access is granted. *Done when: tests cover both paths, including the held notification releasing on grant.*
- **7.4 Notification center UI.** Bell with unread count; list newest-first; opening one (or its deep link) marks it read; clear all. Deep links scroll to and highlight the comment. *Done when: Playwright covers unread → read transitions and the comment highlight.*
- **7.5 Account deletion.** Settings action with confirmation: deletes owned artifacts (and their comments/shares), anonymizes the user's comments elsewhere ("deleted user", body intact), revokes all sessions and tokens, deletes the user's notifications, and removes pending shares created by or addressed to them. No dangling rows. *Done when: tests assert every listed effect.*

---

## Sprint 8 — Hardening and production deploy

Goal: live on Hetzner, and the self-host promise proven by a script.

**Demo:** on a fresh Hetzner VPS: clone, set env, `docker compose up -d` — the smoke test passes against the live domain with real TLS and a real SES email landing in an inbox.

- **8.1 Rate limits and caps.** Config-driven: publish and comment rate limits per user, auth endpoint limits per IP, per-user storage and artifact-count caps (team-scale defaults per BRD). *Done when: tests hit each limit and assert 429/clear errors; limits are documented.*
- **8.2 Production packaging.** Multi-stage Docker image; compose file with app + Caddy (automatic TLS); SQLite on a named volume; nightly backup via Litestream or a documented cron copy. *Done when: CI boots the full compose stack from nothing and the 1.9 healthcheck passes (fresh-VM verification happens manually in 8.6 — a VM-per-CI-run is too flaky to gate on).*
- **8.3 Smoke test script.** `deploy/smoke.sh` against any instance: device login → publish → view → share → comment → resolve → delete. This is the BRD §9 self-host acceptance test. *Done when: it passes against a locally composed stack in CI.*
- **8.4 SES and DNS setup.** Production config for SES SMTP; docs for domain DNS, SPF, DKIM, DMARC so notification emails actually deliver. *Done when: a real email from the staging instance lands in a non-spam inbox (manual check recorded).*
- **8.5 Security pass.** Re-audit against BRD §9: sandbox and CSP headers on every content path, the 4.2 access matrix re-run, cookie flags, token storage, 404-not-403 on private artifacts, dependency audit. *Done when: automated header/authz tests pass and the checklist is committed with findings.*
- **8.6 Deploy to Hetzner.** Provision VPS, DNS, deploy, run smoke test against production, uptime monitoring on the health endpoint. *Done when: smoke test passes against the production domain.*
- **8.7 Documentation.** README (what/why/quickstart), self-host guide (the 15-minute path), skill install guide, API reference linked, CONTRIBUTING. *Done when: a doc review confirms a newcomer can go from zero to published artifact using only the docs.*

---

## Cross-cutting rules (apply to every ticket)

- TDD: failing test first, using `/Users/balapanneerselvam/projects/skills/`.
- Timestamps: stored and returned as UTC ISO-8601 everywhere (API, CLI `--since`, database); the UI renders in the viewer's local timezone. One convention, no exceptions — the agent comment loop depends on it.
- Every endpoint change updates the OpenAPI spec (CI enforces drift).
- Every sprint's demo script is automated as an E2E test before the sprint closes.
- No ticket is done with skipped or flaky tests.
- Documentation updated in the same PR as the behavior change.
