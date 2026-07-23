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

Signing in emails the user a six-digit code, the same way the website does. There
is no browser to approve and no command that waits. It is two runs.

You will not know the user's email address, so ask them for it first.

Run the first step to send the code:

```bash
open-artifact login --instance https://artifacts.example.com --email them@example.com --json
```

It prints `{"ok":true,"codeSent":true}` and returns straight away. Tell the user a
code is in their email, and ask them to paste it to you.

Run the second step with the code they give you:

```bash
open-artifact login --instance https://artifacts.example.com --email them@example.com --code 123456 --json
```

On success it saves the token and prints `{"ok":true,"signedIn":true,...}`. A wrong
or expired code exits `3`; run the first step again to send a fresh one.

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

## Sharing

Artifacts are private to whoever published them until they are shared.

```bash
open-artifact share art_x7Kp2mQ9nR4tVw8y show --json
open-artifact share art_x7Kp2mQ9nR4tVw8y add colleague@example.com --json
open-artifact share art_x7Kp2mQ9nR4tVw8y add example.com --json
open-artifact share art_x7Kp2mQ9nR4tVw8y remove colleague@example.com --json
open-artifact share art_x7Kp2mQ9nR4tVw8y public --json
open-artifact share art_x7Kp2mQ9nR4tVw8y private --json
```

`add` works out on its own whether it was given an address or a domain.

The response says who can see it:

```json
{
  "ok": true,
  "isPublic": false,
  "people": [{ "email": "colleague@example.com", "pending": true }],
  "domains": ["example.com"]
}
```

`pending: true` means that person has not signed in to this instance yet. They
have been emailed a link, and the artifact will be waiting for them when they do.
That is expected, not a problem to report.

Things worth knowing before you share something:

- Sharing with a person emails them. Sharing again with the same person does not
  email them twice.
- `public` means anybody with the link can read it, with no account at all.
  Confirm with the user before making anything public; it is not something to
  infer from "share this".
- Sharing with a domain is refused for public email providers such as gmail.com,
  because that would share with most of the internet. Share with the individual
  address instead.

## Comments

This is the feedback loop: somebody reads what you published, leaves a comment,
and you come back later to act on it. The pattern is always the same.

```bash
open-artifact comments list art_x7Kp2mQ9nR4tVw8y --status open --json
```

Read every open comment, fix the artifact for the ones that need it, reply to
say what you did, then resolve the thread:

```bash
open-artifact publish report.md --id art_x7Kp2mQ9nR4tVw8y --json
open-artifact comments reply thr_9mK2pQx7 --body "Fixed, thanks." --json
open-artifact comments resolve thr_9mK2pQx7 --json
```

The response to `list` is:

```json
{
  "ok": true,
  "threads": [
    {
      "id": "thr_9mK2pQx7",
      "status": "open",
      "anchor": { "kind": "text", "headingId": "revenue", "snippet": "up 12% quarter over quarter", "occurrence": 0 },
      "anchorLost": false,
      "comments": [
        { "author": "colleague@example.com", "body": "Source for this number?", "createdAt": "2026-07-21T09:41:07.000Z" }
      ]
    }
  ]
}
```

`anchor.kind` is `"document"` for a comment about the artifact as a whole, or
`"text"` for one attached to a passage, in which case `anchor.headingId` is the
id of the heading it sits under — the same slug the published page uses in its
URL, or `null` if the passage comes before the first heading. `comments` is the
whole thread, oldest first: the first entry started it, the rest are replies.

Next time, only ask for what is new, with `--since` set to a UTC timestamp
(the same rule as everywhere else in this skill: `2026-07-21T09:41:07.000Z`,
never a friendly date):

```bash
open-artifact comments list art_x7Kp2mQ9nR4tVw8y --since 2026-07-21T09:41:07.000Z --json
```

That is what makes the loop cheap: read only what changed since you last
looked, not the whole conversation again.

**`anchorLost: true`** means the passage that comment was about is no longer in
the document — usually because a later publish changed or removed it. The
thread does not disappear; it is now a comment on the document as a whole.
Read it as you would any other comment about the whole document; do not assume
it still refers to the words it originally pointed at.

Leaving a comment yourself:

```bash
open-artifact comments add art_x7Kp2mQ9nR4tVw8y --body "Numbers look right to me." --json
open-artifact comments add art_x7Kp2mQ9nR4tVw8y --body "Can we cite a source?" --heading revenue --snippet "up 12% quarter over quarter" --json
```

Leave out `--snippet` for a comment about the whole document.

With `--snippet` you usually need nothing else: the passage is looked for across
the whole artifact. Two things are refused, and both mean the same thing, that
what you quoted does not say where you meant:

- text that appears under more than one heading. Quote a longer passage that
  only appears once, or add `--heading` to say which one you mean.
- text that is not in the artifact as it now stands. Read it again with
  `comments list` or by fetching the artifact, and quote from the current version.

`--heading` takes the id you see in an existing thread's `anchor.headingId`.
The snippet has to be the exact rendered text, at least a few words: a phrase
too short to be findable again after an edit is refused.

There is no `edit` or `delete`. Rewriting or removing your own earlier words in
a conversation somebody else is reading is not something this skill does; if
that is genuinely needed, it happens in the browser, by a person.

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
npm install -g open-artifact --registry https://registry.npmjs.org/
```

Then sign in once with `open-artifact login --instance <your instance URL>`.

The command line is a thin wrapper over an HTTP API. If you would rather call the
API directly, it is documented at `<instance>/api/docs`.
