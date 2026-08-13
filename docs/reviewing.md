# Reviewing the Open Artifact plugin

Written for a directory reviewer. There are two ways in, depending on what you
are reviewing.

**Reviewing the skill, in Claude Code.** Use your own email address; the whole
thing takes about five minutes. **open-artifact.com** has open sign-up, and a
sign-in code is emailed to whatever address you use. Start at
[Install](#install) below.

**Reviewing the MCP server, where you cannot read an inbox.** Sign-in here is a
six-digit code sent by email and nothing else — there is no password to give
you. So instead of an account, ask us for a **pre-minted access token** and send
it as a header:

```
Authorization: Bearer <token>
```

The token authenticates on `/mcp` through exactly the same path an OAuth access
token does, so what you are exercising is the real thing. It is scoped the same
as any connection: it can publish, update and share **its own** documents and
read their comments, and it cannot delete anything, make anything public, or
read documents other people shared with that account.

"Its own" is the part worth knowing before you start. A connection sees only
what was published *through that connection* — not what the same person
published from the web app or the command line. The demo token has a few
documents and comment threads already published through it, so
`list_artifacts` returns something on the first call. Anything you publish
yourself joins them.

Two things worth knowing about the token. It lasts **90 days from the day it was
minted and the expiry does not slide** — if a review runs long, ask for a fresh
one rather than assuming it still works. And revoking it is one click for us, so
say when you are done and it stops existing.

The server is at `https://open-artifact.com/mcp`. It also speaks OAuth 2.0 with
dynamic client registration if you would rather exercise that path; the consent
screen names the connection and lists what it may do.

## What the plugin is

One skill. It publishes a Markdown or HTML file you already have to a URL you can
share, updates that page in place afterwards, controls who can see it, and reads
reader comments back. The skill drives a command line tool, `open-artifact`,
which talks to an instance over HTTPS. The hosted instance is open-artifact.com;
the same server is open source and self-hostable, so the plugin works against
your own instance too.

The plugin ships no MCP server, no hooks and no agents — it is a skill and
nothing else. `claude plugin details open-artifact` confirms that inventory.

## Install

```
/plugin marketplace add iBala/open-artifact
/plugin install open-artifact@open-artifact
```

The skill is model-invoked, so there is no command to type: asking Claude to
publish something is what fires it.

## Run through it

**1. Install the command line.** The skill does this itself on the first run if
it is missing. To do it up front:

```bash
npm install -g open-artifact
```

**2. Sign in.** Ask Claude to publish anything and it will walk you through this,
or do it yourself. Two steps, because the code arrives by email:

```bash
open-artifact login --instance https://open-artifact.com --email you@example.com --json
open-artifact login --instance https://open-artifact.com --email you@example.com --code 123456 --label "Review" --json
```

The first command emails a six-digit code and returns immediately. There is no
password at any point.

**3. Publish something.** Write any Markdown file, then ask Claude:

> Publish this as a link I can share.

You get back a URL. Open it — the document is rendered, private to you, and
signed-in-only until you share it.

**4. Update it in place.** Change the file, ask Claude to update the published
version. The URL does not change.

**5. Comment and read it back.** On the published page, select a passage and
leave a comment. Then ask Claude what the comments say. It reads them back with
the passage quoted, which is the loop the plugin exists for.

## Clean up

```bash
open-artifact list --json
open-artifact delete <id> --confirm --json
```

Or close the account entirely — **Settings → Sessions → Close account** in the
web app. That deletes the documents, the versions, the shares and the sessions in
one transaction; nothing is retained.

## Test cases

Written against the MCP tools, so they work with a bearer token and no inbox.
Every tool is annotated with what it does — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint` — and `tools/list` returns those, so the first
thing worth checking is that the labels match the behaviour you observe.

### Expected to succeed

1. **Publish.** `publish_artifact` with `format: "markdown"` and a few
   paragraphs. Expect a URL back. Open it: the document renders, and it is
   private — a signed-out browser is asked to sign in rather than shown the text.
2. **Update in place.** `update_artifact` on that id with different content.
   Expect the same URL to show the new text. This is the one tool labelled
   destructive, because what a reader opens is replaced.
3. **Read back.** `get_artifact` on the same id returns the current content and
   does not change it. Call it twice; nothing differs.
4. **List.** `list_artifacts` returns the documents this connection published,
   newest change first — the seeded ones plus whatever you just published, and
   nothing published by anyone else or from anywhere but this connection.
5. **Comments round trip.** `list_comments` on one of the seeded documents
   returns its threads, each with the passage it is attached to quoted — that
   quoting is the point of the product, so it is the case worth dwelling on.
   `reply_to_comment` posts a reply that appears on the page when you open it.
   `resolve_comment_thread` marks the thread resolved without deleting anything,
   which a second `list_comments` confirms.

   Use the seeded threads rather than leaving your own comment: commenting
   happens in the browser and needs a signed-in reader, which is the thing the
   token exists to avoid.

### Expected to fail, cleanly

1. **A format that was not stated.** `publish_artifact` with `format: "pdf"`, or
   with the field missing. Expect a refusal naming the problem — the tool never
   guesses a format.
2. **Somebody else's document.** `update_artifact` or `share_artifact` against an
   id this connection did not publish. Expect a refusal saying it was published
   outside this connection, not a 500 and not a silent success.
3. **A document that is not there.** `get_artifact` with an id that does not
   exist. Expect the *same* refusal as case 2, word for word. That is
   deliberate: an id nobody published and an id somebody else published are
   answered identically, so the tool cannot be used to find out which documents
   exist.

In all three, the failure is a sentence a model can act on rather than a stack
trace, and nothing partial is written.

## The things a reviewer usually asks

**Where does the data go?** To the instance you signed into, and nowhere else.
The full policy is at <https://open-artifact.com/privacy>, and the source of that
page is in this repository at `packages/server/src/setup/privacy-doc.ts` — every
claim in it is a claim about code you can read.

**Is there telemetry?** None. No analytics SDK, no session recording, no
third-party script. The content security policy the app is served under would
block one.

**What can a connected assistant do?** Publish, update and share its own
documents, and read the comments on them. It cannot delete anything, make
anything public, or read documents other people shared with you.

**Is published HTML dangerous?** It runs in a sandboxed frame at an opaque
origin, under a policy with no network access, so it cannot reach the reader's
session or call out. `packages/server/test/app-shell-csp.test.ts` asserts it.

**Licence.** Fair-code, under the Sustainable Use License — free to use and to
self-host, including inside a company; not free to resell as a hosted service.

## Questions

<hello@open-artifact.com>, or an issue at
<https://github.com/iBala/open-artifact/issues>.
