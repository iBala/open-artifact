# open-artifact

The command line for [Open Artifact](https://github.com/iBala/open-artifact). It
lets your AI assistant publish a Markdown or HTML file as a web page at a stable
link, share that link, and read back the comments people leave.

Open Artifact is self-hosted, so this talks to whichever instance you point it at.

## Install

```bash
npm install -g open-artifact --registry https://registry.npmjs.org/
```

## Sign in, once

```bash
open-artifact login --instance https://your-instance.example.com
```

This prints a short code and a URL. Open the URL, check the code matches, and
approve. The instance is remembered after that, so later commands do not need
`--instance`.

## Publish

```bash
open-artifact publish report.md
```

You get back a link. Publish the same file again and it updates in place; the
link does not change.

## Everything else

```bash
open-artifact help
```

Every command takes `--json` and prints one JSON object, which is what the
bundled skill reads so an assistant can drive it without parsing prose.

## For assistants

This package ships alongside a skill file (`SKILL.md`) that tells an assistant
when to publish and how to read what comes back. See the
[project README](https://github.com/iBala/open-artifact) for how to install it in
Claude Code, Codex, Cursor and others.

## Licence

Apache 2.0.
