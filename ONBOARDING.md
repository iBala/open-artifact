# Onboarding: the user story

How a person goes from never having heard of Open Artifact to having their agent
publish for them without being asked.

Three people arrive here, and they are not the same person:

1. Someone who installed the server themselves. They have a terminal open right
   now.
2. Someone a colleague sent a document to, who did not go looking for anything.
3. Someone who signed up on a public instance.

The second person is the most common and the most valuable, because they arrived
with proof that the product works: a document they wanted to read.

The third barely exists yet. Instances default to invite-only, so on most of them
the only cold signup is the operator. That is worth being honest about, because
it means the invited reader is the real front door.

---

## The paste must be short, trusted, and correct for the user's tool

Everything below serves one moment: a person pastes something into their agent
and their agent does the rest.

We cannot do that with a single block of text that works everywhere. We checked
every tool. They differ in ways that break silently:

| Tool | Config file | Root key | URL field |
| --- | --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers` | `url` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.x]` | `url` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | `httpUrl` |
| Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers` | `url` |
| VS Code Copilot | `.vscode/mcp.json` | `servers` | `url` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` | `url` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `serverUrl` |
| OpenClaw | `~/.openclaw/openclaw.json` | `mcp.servers` | `url` |
| Hermes | `~/.hermes/config.yaml` | `mcp_servers` | `url` |

Three different names for the same idea. Someone who uses the wrong one gets no
error at all — the tool just never appears. So we do not hand out one block. The
person tells us which tool they use, and we hand out the one that is right.

---

## Journey one: someone who signed up

### The connect screen

The dashboard asks which tool you use, once, and then gives you one instruction
with a copy button. Not nine tabs to self-diagnose from.

It appears whenever **no assistant has connected yet**, and not based on whether
there are any documents. Those are different questions, and every new account has
a document in it from the first minute.

The list is ordered by who actually shows up, and it says plainly what works:

- **Claude Code, Codex CLI, Gemini CLI, Copilot CLI, OpenClaw, Hermes, Cursor,
  Windsurf, VS Code** — one command or one config block.
- **Claude on the web, Claude desktop, Cowork, ChatGPT** — connected from their
  settings screen once the hosted endpoint ships. No terminal needed.
- **A plain terminal, no assistant at all** — the last row, and it works today.
  The product does not require an agent and the picker should not imply it does.
- **Codex cloud, Gemini web** — not supported, with the reason. Codex cloud
  blocks outbound network while the agent runs. Gemini web allows only partner
  integrations and has no way to apply. Neither is ours to fix.

Naming a tool we cannot serve, and letting someone find out after ten minutes, is
worse than one line saying it does not work.

### The paste

The person picks their tool first, so we know which one it is. That goes in the
link:

> Set up Open Artifact for me: https://open-artifact.com/setup?tool=claude-code

The page then serves one tool's instructions with certainty. No guessing from the
request, which would misfire constantly — plenty of agents fetch through `curl`
in a shell and look identical no matter which product they are.

Visiting `/setup` with no tool named lists all of them under plain headings, for
an agent that arrives without having been sent.

Three reasons a link beats pasting the real commands:

**It is short enough to be trusted.** Pasting fifteen lines of shell into an
agent asks someone to approve what they did not read. One link they can open
first is a different kind of ask.

**It cannot go stale.** The instructions live on the instance, so they match the
version being run. Nobody follows a two-year-old blog post.

**We can fix it without telling anyone.** When a tool renames a config field, we
change one page.

Under the paste, one line for agents that cannot fetch a URL: use the full
instructions below instead.

### Setup is not finished until the connection is proven

An agent that edits the wrong file and then says "all set" is the failure we
should expect, because it is silent. The person has no way to tell.

So two things:

**The page ends with a check, not a claim.** The last instruction runs
`open-artifact whoami --json` and requires exit code 0. An agent that skips it
has not followed the page. If it fails, the page tells the agent what to report:
which file it edited and what the error said.

**The dashboard tells the truth independently.** The connect screen flips to
"Connected from Claude Code" the moment the first authenticated call arrives. The
server knows whether a token was ever used; the agent's opinion does not enter
into it. If it never flips, the person knows to look again, and that is the whole
recovery path.

**Signing in interrupts the agent, and the page must say so.** `open-artifact
login` waits for the person to approve in a browser. Mid-run, that means the
agent has to stop, show the URL and code, and wait. Some tools kill commands that
sit there. The page spells this out rather than letting it surprise anyone.

### How setup ends

Not with a message. With something to look at.

The last step republishes their welcome document **through the connection just
made**, so it belongs to that connection and can be edited by it afterwards. This
matters more than it sounds: connections can only touch what they published, so a
document seeded by the server would be invisible to the assistant that just
connected, and the next step would fail.

That document already has a comment on it, anchored to a real paragraph. They see
the real thing, in their account, in their browser.

The comment asks them to reply. Then it says what to say next:

> Now tell your assistant: "check the comments on that doc."

The agent reads their reply and republishes with a change. Publish, comment, feed
back, republish — the whole product, on their machine, in under a minute. No
video, no tour, no tooltips.

This is the part worth real effort.

### The welcome document

One file in the repo. One place to edit it. It has two lives:

- Public at `/welcome`, so it can be linked anywhere and read without an account.
- Copied into the account at signup, so the seeded comment and the reply belong
  to that person alone.

Same file, not two documents. Copying it at signup means someone who never
connects anything still opens their dashboard to something rather than nothing.

**The seeded comment is from the software, and it says so.** No invented name, no
avatar, nothing pretending to be a colleague in a product where every other
comment is a real person. It carries the "tell your assistant" instruction
itself, and it is written to be complete even if nobody ever answers it, because
a person who connects no agent should not be left with a robot's open question
sitting on their dashboard forever. They can resolve it and be done.

The document explains what to say to an agent to publish, share, and pull
comments back, with the sentences written out, because someone reading it is
about to say one of them.

It also says that sharing a document with someone creates their account. That is
how a team spreads, and nothing else in the product tells anyone.

---

## Journey two: someone sent a document by a colleague

### What already works

The invite email handles the hard part. Someone with no account is told: open the
link, give your email, get a code, and it will be waiting. That copy is good and
does not change.

They arrive, sign in, and the sidebar is collapsed so the document fills the
screen. Correct. They came to read.

### What actually sells them

Not a call to action. Watching a comment they left get answered.

They leave a note on a paragraph. The author's agent reads it and republishes.
The reader sees the document change in response to something they wrote. That is
the product demonstrating itself to someone who did no work, and it is the real
hook for this journey.

Everything else here is secondary to making that loop fast and visible.

### Where we ask for anything

One quiet line after the last paragraph:

> Published with Open Artifact. Publish your own →

No banner. No modal. No dismissible card that follows them around. They are here
because someone they know sent them something. If we interrupt their reading, the
colleague who shared it looks bad.

A line at the end is only reached by someone who finished reading. That is
exactly the person worth asking, and they are asked once, when they are most
likely to be thinking they could use this.

It shows for anonymous readers of public documents too, not only signed-in ones.
That is the widest group who ever see a document and the cheapest place to be
found.

For someone invited, the link goes to the connect screen, not to a sign-up page.
They already have an account — it was created when the document was shared with
them, and the welcome document is already sitting in it. The only thing left is
connecting their assistant.

### Why people keep using this

Written on the welcome document and on the connect screen, because these are the
actual reasons:

- You want to send a document to someone without attaching a file.
- You want a readable way to look at what your agent wrote, instead of a file on
  your laptop that nobody else can open.

---

## What we are deliberately not doing

**No product tour.** No tooltips pointing at buttons. The welcome document is the
tour, and it is a document, which is what we sell.

**No progress checklist.** "3 of 5 steps complete" turns a person into an unfinished
task. Setup either worked or it did not, and the connect screen says which.

**No email sequence.** One email, when someone shares something. That is the only
one that has earned its place in an inbox.

**No listing tools we cannot serve.** Named above, with reasons.

---

## Sprints

Each sprint ends with something demonstrable. Each ticket is one commit with a
check that can fail.

The hosted endpoint has its own design and tickets in
[MCP_DESIGN.md](MCP_DESIGN.md). Sprints 10 and 11 sit on top of it.

### Sprint 9 — the welcome document and the connect screen

Works with the CLI that exists today. No hosted endpoint needed.

*Demo: sign up, land on a dashboard holding a document with a comment on it,
follow the connect instructions for Claude Code, watch the screen say connected,
reply to the comment, ask the agent to read it back.*

| # | Ticket | Check |
| --- | --- | --- |
| 9.0 | Publish the CLI to npm as `open-artifact` | `npm install -g open-artifact` works on a machine that has never seen this repo |
| 9.1 | Confirm the config paths for all nine tools against current first-party docs | Six paths currently unverified are confirmed, or the tool moves to unsupported |
| 9.2 | `welcome.md` as the single source, with the seeded comment's anchor marked | The anchor snippet is found exactly once under its heading |
| 9.3 | Copy the welcome document into every new account at signup, with its comment | A new account has one document and one open thread; a second signup never sees the first person's reply |
| 9.4 | The comment is authored by the instance, not a person, and is resolvable | Renders without a name or avatar; resolving it leaves no task behind |
| 9.5 | Serve the same file publicly at `/welcome` | Reachable signed out; editing the public copy does not touch anyone's account copy |
| 9.6 | `/setup?tool=` serving one tool, `/setup` serving all nine | Each of nine produces a config a real client parses; no request sniffing anywhere in the handler |
| 9.7 | `/setup` ends with the `whoami` check and the sign-in handoff written out | The final instruction is a verification command; a run that skips it fails the page's own contract |
| 9.8 | The connect screen, keyed on no connection ever having been made | Shows for an account that has the welcome document but no token; hides after the first authenticated call |
| 9.9 | "Connected from X" state, driven by the server seeing a call | Flips on first use; does not flip when a token is minted but never used |
| 9.10 | The one-line paste, per tool, plus the no-web-fetch fallback line | Copies clean; contains no token |
| 9.11 | The footer line on artifact pages, including for anonymous readers | Appears after the last paragraph, not fixed to the viewport; absent for the owner; links to the connect screen |
| 9.12 | Windows paths in every snippet, or the tool is marked untested on Windows | Each of nine states its Windows path or says it is untested |
| 9.13 | Count how many people reach each step: signed up, connected, published, shared | Four numbers, no per-person tracking |

### Sprint 10 — connecting a terminal assistant over the hosted endpoint

Depends on MCP Sprint A.

*Demo: connect Claude Code with one command, publish from a chat with no file on
disk, see it appear.*

| # | Ticket | Check |
| --- | --- | --- |
| 10.1 | "Connect an assistant" on the sessions screen: mint, show once | Shown exactly once; revoking kills the next call |
| 10.2 | Per-tool snippets with the token filled in | Each of nine parses in a real client |
| 10.3 | `/setup` offers the hosted path alongside the CLI path | An agent following either ends up connected and verified |
| 10.4 | The last setup step republishes the welcome document through the new connection | The connection can then read its comments and update it; before this ticket, that call fails |
| 10.5 | One sentence in `skill/README.md` on why CLI tokens slide and hosted ones do not | Both expiry rules are described in the same place |

### Sprint 11 — connecting a browser assistant

Depends on MCP Sprint B.

*Demo: add the instance as a connector in Claude on the web, approve it, publish
from a chat with no terminal.*

| # | Ticket | Check |
| --- | --- | --- |
| 11.1 | Connect instructions for Claude web, desktop and Cowork on one page | Menu names match the current interface |
| 11.2 | Connect instructions for ChatGPT, including developer mode and the admin gate | Someone on a business plan is told why it may be switched off for them |
| 11.3 | The wording on the consent screen built in MCP ticket B4 | Plain language; states it cannot delete or make anything public |

### Sprint 12 — keep the instructions from going stale

| # | Ticket | Check |
| --- | --- | --- |
| 12.1 | A scheduled job on our repo that re-fetches each tool's docs and opens an issue when a path changes | Renaming a field in a fixture opens an issue naming the tool. Not a test in the suite, which would fail in every fork for people who cannot fix it |
| 12.2 | Publish the skill to ClawHub and equivalents | One-line install works |

---

## Still open

**Nine config paths will change.** They are a maintenance liability. Ticket 12.1
is the only thing standing between us and documentation that quietly stops
working, which is worse than none because people trust it.

**Cowork has no terminal and no documented Node.** It cannot be onboarded until
Sprint 11. Worth knowing because it is the newest and most visible Anthropic
surface.

**Nothing has been tested against a real browser connector.** If Claude on the
web or ChatGPT needs something we did not build, Sprint 11 slips with it.
