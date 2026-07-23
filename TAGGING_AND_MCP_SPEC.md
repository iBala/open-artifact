# Tagging people in comments, and connecting assistants that have no terminal

Three pieces of work, specified together because they meet in onboarding:
fixing comment tagging, building the hosted MCP endpoint, and making the setup
instructions recommend the right path for each assistant.

---

## Part 1 — Tagging people in comments

### User story

> I am reading a document someone published. I want to pull my colleague into
> the conversation, so I type `@` and her email address in a comment. She gets
> an email with a link, opens the document, and replies.

### What actually happens today, and why it feels broken

Typing `@` opens a suggestion list — but the list only contains people the
document is already shared with, plus people who have already commented. The
person you most want to tag is usually neither.

If you type their full address anyway, three things go wrong:

1. **The suggestion list closes** the moment you type the `@` of the domain
   (`@priya` shows suggestions; `@priya@acme.com` shows nothing). It feels like
   the feature stopped working mid-keystroke.
2. **Nothing visible happens on send.** The mention is recorded as an "access
   request" waiting for the owner's approval, and the notification to the tagged
   person is held until then. No confirmation, no error.
3. **Even when you ARE the owner**, the same thing happens: the system files an
   access request addressed to yourself, instead of just sharing the document
   with the person you clearly want in. The `canGrantAccess` flag is passed into
   the code that records mentions and then never read — the one-step grant the
   design describes was never wired up.

### Spec

**Server — tagging someone as the owner shares the document with them.**
In `recordMentions`, when `canGrantAccess` is true and the named address is not
yet a candidate: share the artifact with that address and treat the mention as
delivered — bell notification if they have a live account, and the mention
email with the link either way. Details that matter:

- The share goes through the existing `SharingService.shareWithEmail`, so
  pending-invite attachment and dedup keep working. `NotificationService`
  gains the `SharingService` as a constructor dependency (it is constructed
  after it in `app.ts`; no cycle).
- The freshly shared address joins `outcome.notified`, so exactly one email
  goes out: the mention email, which carries the link and the context. (No
  share email fires on this path today — the real risk is forgetting the
  address in `notified`, not a duplicate.) The share row is marked notified.
- `recordMentions` must never throw into the request: the comment is already
  committed when it runs. The share call is wrapped; any refusal (invalid
  address, own address) leaves that mention as plain text and the comment
  stands.
- The bell notification keeps the existing `!deletedAt` guard — a mentioned
  address can resolve to a closed account.

**Server — people covered by a domain share are recognised.** The candidate
list is people plus past commenters, so somebody covered by a domain share
looked like a stranger: tagging them filed an access request for access they
already have. `recordMentions` now checks the address's domain against the
artifact's domain shares and treats a match as already-in — notified
immediately, nothing to approve.

**Server — tagging someone as a non-owner keeps the approval step**, unchanged:
the owner is asked, the mention is held until they grant it. A commenter must
not be able to widen access to a document they do not own. One exception,
which is a bug fix: on a **public** artifact, a mentioned person can already
read the document, so their notification and email go out immediately — only
the comment-access grant still waits on the owner. Holding a mention on a
world-readable page was pointing at an open door.

**Server — the comment API says what the mentions did.** The create-thread and
reply responses gain a `mentions` field: which addresses were notified, which
were newly shared, and which are awaiting the owner. Without this the web has
nothing to render after send.

**Web — the suggestion list keeps up with a full address.** The `@`-token
matcher allows `@` inside the query, so the list stays open while a whole email
address is typed. (Addresses typed mid-word in prose still do not trigger it.)
The insert must anchor on the `@` that starts the mention token — not
`lastIndexOf('@')`, which would find the domain's `@` and corrupt
`@priya@acme.com` into `@priyaacme.com`. A component test covers inserting
while the partial already contains an `@`.

**Web — an address not in the list gets an explicit offer.** When the typed
query looks like an email and matches no candidate, the list shows one row:
"Tag priya@acme.com" — with a plain subtitle saying what will happen:
- owner: "Shares this document with them"
- non-owner: "Asks the owner to let them in"

The synthetic row is its own type (it inserts the raw typed address, not a
candidate), and the composer learns `isArtifactOwner` from the panel to pick
the subtitle.

**Web — after sending, say what happened.** The composer's `onSubmit` returns
the mention outcome from the API. Non-owner tagging an outsider: "The owner
has been asked to add priya@acme.com." Owner: "Shared with priya@acme.com and
let them know." Silence is what makes today's behaviour feel broken.

**Tests.** Owner tags outsider → share row exists, mention email sent, no
access request. Non-owner tags outsider → access request, held notification,
no share. Non-owner tags outsider on a public artifact → notification and
email go out, comment-access still waits. Invalid address → plain text,
comment still posts. Existing candidate tagging unchanged. Owner tagging their
own address → skipped, no throw.

---

## Part 2 — The MCP endpoint

The full design, including the security reasoning, is in `MCP_DESIGN.md`. This
section is the delta: what gets built now, in what order, and the decisions
that were still open.

### User stories

> I use Claude on the web — no terminal at all. I paste the same setup text
> everyone else pastes. Claude tells me: "I can't run commands, but you can
> connect me directly — add this connector." I add the URL in Claude's
> settings, approve the connection on the Open Artifact consent page, and say
> "publish this as a page." I get a link back.

> I already use Open Artifact from Claude Code. I also want it in Claude on
> the web. I connect the web app too — same account, same email. Documents I
> publish from either place appear on the same dashboard. Each connection can
> edit what it published; the browser can manage everything.

### Shape

- `POST /mcp`, stateless JSON-RPC (streamable HTTP transport, no SSE, no
  session state). `GET`/`DELETE` → 405.
- Eight tools: `publish_artifact`, `update_artifact`, `get_artifact`,
  `list_artifacts`, `share_artifact` (one email only), `list_comments`,
  `reply_to_comment`, `resolve_comment_thread`. No delete, no make-public, no
  domain shares, no reading other people's documents — the withheld list and
  the reasons are in the design doc and are not up for casual widening.
- **Connections, not tokens, own artifacts.** A new `mcp_connections` table
  (id, user, product label, created, revoked). Every MCP credential — personal
  token now, OAuth grant later — points at a connection: `api_tokens` gains a
  `connectionId`, and minting an MCP token creates its connection in the same
  step. Artifacts record the connection that created them, stamped from the
  authenticated token's connection at publish. This is the decision the design
  doc flags as the trap: recorded per token, OAuth's hourly rotation would
  orphan everything.
- **Token kinds, enforced in the authenticator itself.** `api_tokens` gains a
  `kind` column: `cli` (default, sliding 90-day expiry, exactly today's
  behaviour) and `mcp` (absolute 90-day expiry, never slides). The enforcement
  point is not middleware routing: `authenticateApiToken` itself matches only
  `kind = 'cli'`, and a separate `authenticateMcpToken` matches only
  `kind = 'mcp'` and does not slide expiry. The `/mcp` handler reads its
  identity purely from the `Authorization` header via the latter and never
  reads the request's attached user — so a stray session cookie can never
  authenticate `/mcp`, even though the global middleware still runs. Skipping
  cookies on `/mcp` is defence in depth, not the guard.
- **Scope checks travel to the artifact.** The comment tools are addressed by
  thread id; their connection check traverses thread → artifact →
  `connectionId`. Easy to implement artifact scoping and forget the
  thread-addressed tools; the tests cover them explicitly.
- **Auth, two stages.** Stage one: a personal MCP token in the
  `Authorization` header, minted from a new "Connect an assistant" section on
  the sessions page, shown once. Serves every header-capable client
  immediately. Stage two: OAuth — PKCE (S256 only), dynamic client
  registration for Claude's connector flow, rotating single-use refresh
  tokens — because the connector screens in Claude on the web and ChatGPT
  accept nothing but a URL. The URL never changes between stages; header
  tokens keep working.
- **Refresh reuse is fatal, with no grace period.** A grace window done
  right needs a token-family state machine that caches and replays issued
  responses; done half-right it forks the family or replays stale tokens.
  Strict is simpler and safer: a spent refresh token presented again kills
  the connection, and the client re-authorises. That costs a rare
  reconnect after a dropped response, which is the acceptable side of the
  trade.
- **Discovery is exact, not approximate.** Protected-resource metadata is
  served at `/.well-known/oauth-protected-resource/mcp` (the RFC 9728
  path-aware location for the `/mcp` resource), with `resource` exactly
  `<baseUrl>/mcp`. A 401 carries
  `WWW-Authenticate: Bearer resource_metadata="…"`. Clients send the
  RFC 8707 `resource` parameter on authorize and token calls; issued tokens
  carry it as audience and `/mcp` validates it. Get any of these slightly
  wrong and connector discovery fails silently.
- **Same account, both ways.** CLI tokens, MCP tokens and OAuth connections
  all hang off one user. The sessions page lists all of them with their
  labels; `connectedApps` in `/api/auth/me` counts MCP connections too, so
  the publish nudges disappear whichever way someone connects.
- The honest limitation, stated in every error it produces: a connection can
  only edit artifacts it created. Something published from Claude Code cannot
  be edited from Claude on the web; the browser can manage everything. The
  error says exactly that.

### Limits and hardening

Publish, comment and share draw on the same per-user budgets as the existing
API — the same limiter buckets (`artifact`, `comment`, `share`), keyed by the
connection's **user** id, via the limiter's non-middleware `check()`. Keyed
any other way, connecting an assistant would silently double someone's
allowance. New: a body-size cap on `/mcp` before buffering, a failed-auth
limiter keyed by client address (honouring the same forwarded-for trust the
rest of the app uses), and tool errors returned as tool results (never
protocol errors), so the model actually sees them.

Two guard tests that must never be deleted: an MCP token is refused on
`/api/artifacts` (publish) and on account deletion; and an MCP token's expiry
does not move when it is used.

---

## Part 3 — Onboarding recommends the right path by itself

### User story

> Someone lands on the instance — front door, or a document that was shared
> with them. They copy one block of text into whatever assistant they use.
> If it can run commands, it installs the CLI. If it cannot, it does not
> apologise and stop — it tells them to add the connector and how.

### Spec

**The pasted setup prompt branches — and the branch is the first line.** The
prompt opens with: "If you cannot run shell commands, skip to the last step —
you connect a different way." Putting it first matters: a weaker browser
assistant would otherwise try the install command, fail, and stall before ever
reaching a footnote. The no-terminal step tells the user to connect over MCP,
with the connector URL (`<instance>/mcp`) and the click-path for the two big
apps (Claude: Settings → Connectors → Add custom connector; ChatGPT: Settings
→ Apps, with developer mode enabled — their connector screens move, so the
prompt says "look under Settings for Connectors or Apps"), plus one line of
honesty: "If you don't see an option to add a custom connector, your
workspace admin may need to enable it." The assistant
knows whether it has a shell; nobody has to ask the user what kind of
assistant they use.

**The website shows both paths.** The setup guide (front door, dashboard,
reader nudges) gets a second, quieter path under the paste block: "No
terminal? Add Open Artifact as a connector instead" with the URL and the same
click-paths. The paste block stays primary — it serves both cases, since the
assistant itself redirects browser users.

**MCP needs no skill file.** The CLI path installs SKILL.md so the assistant
knows the workflow. Over MCP, the tool descriptions themselves carry that
knowledge — each tool's description says when to reach for it, and the
publish tool's description carries the sharing and commenting loop in brief.

**The default-for-documents question stays.** Whichever path connected, the
assistant asks the same yes/no question about making Open Artifact the
default for Markdown and HTML. On the CLI path, a yes means the assistant
writes the user's standing-instructions file itself. Over MCP the assistant
cannot write files — so on a yes it gives the user the exact line to paste
into that product's custom instructions (Claude: profile/project
instructions; ChatGPT: custom instructions) and asks them to add it. It never
claims to have set a default it cannot set.

---

## Build order

Each sprint is demoable on its own and lands as one or more atomic commits
with tests.

**Sprint 1 — tagging.**
Demo: in the browser, the owner tags an unshared email in a comment; the
tagged person's inbox has one email with a working link; the share dialog now
lists them. A non-owner tagging someone produces the owner's approval request
and the explanatory note.

| # | Task | Verified by |
|---|------|-------------|
| 1.1 | `recordMentions` honours `canGrantAccess` (owner-mention shares and notifies, wrapped so it never throws); public-artifact mentions deliver immediately; comment create/reply responses carry the `mentions` outcome | server tests listed above |
| 1.2 | Composer keeps the list open across a full address; insert anchors on the mention-start `@`; unmatched valid email offers "Tag …" with the ownership-aware subtitle | component behaviour + e2e |
| 1.3 | Post-send note, both cases (owner: shared; non-owner: owner asked), fed by the API outcome | e2e |

**Sprint 2 — `/mcp` with personal tokens.**
Demo: mint an MCP token on the sessions page, add the server to Claude Code
as an MCP server, publish and update a document from a chat, read a comment.

| # | Task | Verified by |
|---|------|-------------|
| 2.0 | Pin the protocol: supported MCP protocol revisions, `MCP-Protocol-Version` header, notifications answered 202 with no body, content-type handling, Origin checked | protocol conformance tests |
| 2.1 | `kind` + `connectionId` on api_tokens, `mcp_connections` table, migration; `authenticateApiToken` accepts only `cli` | the two guard tests + an upgrade test over a database holding existing CLI tokens |
| 2.2 | `authenticateMcpToken`: mint creates the connection, absolute expiry, no slide | expiry-does-not-slide test |
| 2.3 | JSON-RPC framing + protocol handshake (`initialize`, `tools/list`, `tools/call`) | malformed envelope, unknown method, notification cases |
| 2.4 | Route: header-only auth, session middleware skipped, body cap, 405s, failed-auth limiter | cookie refused; CLI token refused; oversized body refused |
| 2.5 | `artifacts.connectionId`; CLI/web publishes leave it null | migration test |
| 2.6 | `publish_artifact`, `get`, `list`, `update` — scoped to the connection, stamped at publish | CLI-published invisible; error names the reason |
| 2.7 | Comment tools; scope traverses thread → artifact; bodies marked as other people's text | thread-scoping test + tool result shape test |
| 2.8 | `share_artifact`: one email, no domains, same limiter bucket keyed by user id | domain refused; 31st share in the hour refused |
| 2.9 | Guard test pinning the tool list | fails on casual additions |
| 2.10 | Sessions page: "Connect an assistant" — mint, show once, list, revoke; `connectedApps` includes MCP connections | e2e + updated connectedApps test |

**Sprint 3 — OAuth, so browsers can connect.**
Demo: add the instance as a custom connector in Claude on the web, approve on
the consent page, publish from a chat with no terminal.

| # | Task | Verified by |
|---|------|-------------|
| 3.1 | Protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`, `resource` exactly `<baseUrl>/mcp`, + `WWW-Authenticate` with `resource_metadata` on 401 | header-token clients never see it; discovery path test |
| 3.2 | AS metadata, PKCE S256-only, `offline_access` advertised | metadata shape test |
| 3.3 | Dynamic client registration (Claude's flow), redirect validation, rate limit | wildcard/mismatch refused |
| 3.4 | **Early probe:** point a real Claude web connector at the metadata endpoints on a live instance before building further; write down what it actually requests | manual gate, findings written down |
| 3.5 | Authorize + consent page (web session required, signed-out bounce returns intact, never auto-approved); RFC 8707 `resource` accepted and bound | e2e |
| 3.6 | Auth codes: single-use, 60 s, PKCE-bound | replay/wrong-verifier/expiry refused |
| 3.7 | Token endpoint, rotating single-use refresh; any reuse kills the connection — no grace | rotation tests |
| 3.8 | Access tokens carry the `/mcp` resource as audience; wrong audience refused | audience test |
| 3.9 | End-to-end: connect Claude web and ChatGPT for real, publish from each | manual gate + e2e against our own flow |
| 3.10 | Connections listed by product name on sessions page; revoke kills access+refresh | e2e |

**Sprint 4 — onboarding.**
Demo: paste the setup text into Claude on the web → it tells you to add the
connector, and the website's guide shows the no-terminal path.

| # | Task | Verified by |
|---|------|-------------|
| 4.1 | Setup prompt branches on no-terminal, with connector URL and click-paths | prompt text test |
| 4.2 | Website guide: secondary "No terminal?" path on all three surfaces | e2e |
| 4.3 | Tool descriptions carry the workflow (the MCP "skill") | description review + guard test |
| 4.4 | README/ONBOARDING updated | reading them |

---

## Out of scope, on purpose

- Per-document "let this connection edit" toggle (design doc Sprint C) —
  after real usage shows the need.
- Tagging people on public artifacts by directory search — the candidate
  list stays scoped to people already involved; a public artifact must not
  become a directory of every account.
- MCP tools for deleting, making public, or domain sharing — withheld by
  design, see `MCP_DESIGN.md`.
