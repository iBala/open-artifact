# Installing the Open Artifact skill

The skill is `SKILL.md` next to this file. It tells an agent when to publish
something and how to read what comes back. It works by running the
`open-artifact` command, so that has to be installed and signed in first.

## 1. Install the command line

```bash
npm install -g open-artifact
```

## 2. Sign in, once

```bash
open-artifact login --instance https://artifacts.example.com
```

This prints a short code and a URL. Open the URL, check the code matches what
your terminal is showing, and approve. After this the instance is remembered, so
later commands do not need `--instance`.

The token is written to `~/.open-artifact/credentials`, readable only by you. It
lasts 90 days and that window slides forward every time it is used, so a
connection in regular use never expires. You can revoke it at any time from the
instance's **Where you are signed in** page.

## 3. Install the skill

**Claude Code.** Copy the folder into your skills directory:

```bash
cp -r skill ~/.claude/skills/open-artifact
```

Or, for one project only, `.claude/skills/open-artifact` inside the project.

**Any other harness.** `SKILL.md` is plain Markdown with YAML frontmatter and
depends on nothing specific to a harness. Put it wherever yours reads
instructions from, or paste its contents into a system prompt. The only thing it
needs is a shell that can run `open-artifact`.

## Checking it works

```bash
open-artifact whoami --json
```

Exit code 0 and an object with your email address means everything is connected.
Exit code 3 means you are not signed in yet.

## Using the API instead

The command line is a thin wrapper over an HTTP API, and the API is the actual
contract. If you would rather call it directly, it is documented at
`<your instance>/api/docs`.

## If you do not want an agent deleting things

`open-artifact delete` requires `--confirm`, so it cannot happen by accident. If
you want it to be impossible rather than deliberate, remove the "Listing and
deleting" section from your copy of `SKILL.md`. Nothing else depends on it.
