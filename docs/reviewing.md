# Reviewing the Open Artifact plugin

Written for a directory reviewer. Everything below is doable with your own email
address in about five minutes. There is no test account to request and no
credential to share: **open-artifact.com** has open sign-up, and a sign-in code
is emailed to whatever address you use.

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
