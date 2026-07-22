---
name: open-artifact
description: Publish HTML and Markdown files as shareable web pages, update them, and manage who can see them. Use when the user wants to share a document, report, dashboard or write-up as a link rather than as a file.
---

# Open Artifact

Turns a file you have written into a web page at a stable URL, which you can hand
to somebody as a link and update in place afterwards.

Use this when the user says things like "publish this", "share this as a link",
"put this somewhere I can send to the team", or when you have written a report or
a dashboard that is more useful as a page than as a file on their disk.

Do not use it for files that are not Markdown or HTML. Nothing else is supported,
and the command will refuse rather than guess.

## Before anything else

Every command takes `--json` and prints exactly one JSON object, on success and
on failure. Always pass it, and read the object rather than the prose.

```bash
open-artifact whoami --json
```

- Exit code `0`: signed in. The object has `email` and `instance`.
- Exit code `3`: not signed in. Follow "Signing in" below.
- Exit code `8`: the server cannot be reached. Say so and stop; do not retry in
  a loop.

## Signing in

`login` prints a short code and a URL, then waits for the user to approve it in
their browser. The user has to do that part; you cannot.

```bash
open-artifact login --instance https://artifacts.example.com --json
```

Tell the user to open the URL and check the code matches. The command finishes
once they approve. If they refuse, it exits `3`.

After the first sign-in, the instance is remembered and `--instance` is optional.

## Publishing

```bash
open-artifact publish report.md --json
```

The response is:

```json
{
  "ok": true,
  "id": "art_x7Kp2mQ9nR4tVw8y",
  "url": "https://artifacts.example.com/a/9mK2pQx7nR4tVw8yZ3bC",
  "title": "Quarterly report",
  "type": "markdown",
  "version": 1,
  "updated": false
}
```

Give the user the `url`. Keep the `id`: it is how you update the artifact later.

The file extension decides the format, so do not pass a type. `.md` and
`.markdown` publish as Markdown; `.html` and `.htm` publish as HTML.

The title comes from the first heading, or from `<title>` in HTML. Pass
`--title "Something else"` only if the user asked for a particular title; a title
set that way is kept and never re-derived when you update the artifact.

## Updating

Publishing again with `--id` replaces the content and keeps the same URL, so any
link already sent out keeps working.

```bash
open-artifact publish report.md --id art_x7Kp2mQ9nR4tVw8y --json
```

Exit code `7` means somebody else changed the artifact since you read it. Do not
retry blindly: that is exactly the case where retrying destroys their change.
Tell the user what happened and ask what they want to do.

## Listing and deleting

```bash
open-artifact list --json
open-artifact delete art_x7Kp2mQ9nR4tVw8y --confirm --json
```

Deleting is permanent and takes the artifact's history with it. `--confirm` is
required. Only ever run it when the user has asked for that specific artifact to
be deleted, and read the id back to them first.

## What HTML artifacts can and cannot do

An HTML artifact runs in a sandbox. Its own inline script and styles work, which
is what makes a self-contained dashboard useful. It cannot:

- load anything from another site: no CDN scripts, no remote images, no
  web fonts;
- make network requests of any kind;
- reach the reader's session or cookies.

So write HTML artifacts as one self-contained file, with any data inlined and any
images embedded as `data:` URLs. If you were about to add a `<script src="https://…">`
tag, inline that library instead or do without it.

## Exit codes

Branch on these rather than on the message text.

| Code | Meaning | What to do |
|---|---|---|
| 0 | Worked | Carry on |
| 2 | The command was wrong | Fix the arguments |
| 3 | Not signed in | Run `login` |
| 4 | Not yours, or no such artifact | Check the id; do not retry |
| 5 | Not Markdown or HTML | Convert the file, or tell the user |
| 6 | Larger than the instance allows | Say so; the message states the limit |
| 7 | Somebody else changed it | Stop and ask the user |
| 8 | The server cannot be reached | Say so; do not retry in a loop |
| 9 | The server failed | Say so; retrying once is reasonable |
| 10 | No such file | Check the path |

## Installing

The CLI is an npm package:

```bash
npm install -g open-artifact
```

Then sign in once with `open-artifact login --instance <your instance URL>`.

The command line is a thin wrapper over an HTTP API. If you would rather call the
API directly, it is documented at `<instance>/api/docs`.
