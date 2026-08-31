<!--
  This file is published as a public artifact:
  https://open-artifact.com/a/JzsDBQxEomM8N5F2BKm0yjVU

  To update the published page after editing this file:
    open-artifact publish CHANGELOG.md --id art_jS8W4fL4w8amDjGg

  Publishing without --id would create a second changelog on a new URL, and
  the one people have bookmarked would quietly stop being the current one.

  House style for this file:
  - Write each change as a user story: As a ROLE, I want GOAL, so that BENEFIT.
  - Use Simplified Technical English. Short sentences. Active voice. One idea
    per sentence. No idioms.
  - Diagrams are plain text in code fences. Images cannot be used: the renderer
    removes data: URLs and the page policy blocks remote images.
  - Keep diagrams narrower than 56 characters so they fit on a phone.

  Raw HTML is stripped when Markdown is rendered, so this note is invisible on
  the published page and visible to whoever edits the file. That is the point.
-->

# Changelog

This page lists the changes to Open Artifact. The newest change is first. Each
date is the day the change became available on open-artifact.com.

---

## 31 August 2026

### Edit a block as you read it

> **As an author,** I want to edit a block and see the result as I type, **so
> that** I do not need to know Markdown syntax to correct a sentence.

Before, a click opened a box of Markdown source. Now a click opens rich text.

```
  BEFORE                      NOW
  ┌──────────────────┐        ┌──────────────────┐
  │ ## Q3 review     │        │ Q3 review        │  <- large
  │                  │        │                  │
  │ Revenue is       │        │ Revenue is       │
  │ **up 18%** on    │        │ up 18% on        │  <- bold
  │ the quarter.     │        │ the quarter.     │
  └──────────────────┘        └──────────────────┘
   you read the syntax         you read the text
```

What you can do:

- Select text. A small toolbar appears. Use it for bold, italic, code and
  links.
- Type `/` at the start of a line. A menu shows the block types by name. Choose
  a heading, a list, a quote, a table or a code block.
- Edit a table as a grid. You do not type pipe characters.

Some blocks stay as Markdown. These blocks hold footnotes, reference links or
raw HTML. The rich editor cannot show these correctly. Open Artifact keeps them
as source text so that your document does not lose them.

Open Artifact rewrites only the block that you click. The rest of the document
stays the same, byte for byte.

```
  document.md
  ┌───────────────────────────────┐
  │ block 1   unchanged           │
  │ block 2   YOU EDIT THIS ONE   │ <- only this is written
  │ block 3   unchanged           │
  │ block 4   unchanged           │
  └───────────────────────────────┘
```

### Keep your place when you save

> **As an author,** I want the page to stay still when I save, **so that** I do
> not lose my position in a long document.

Before, a save cleared the page and drew it again. The page returned to the
top. If you corrected a word near the end, you had to scroll back down.

Now the document stays on the screen while Open Artifact loads the new version.
Your position does not change.

### See what a link points to

> **As a person who receives a link,** I want the preview to tell me what the
> document is, **so that** I know whether to open it.

Before, every artifact link showed the same preview card. Now the card
describes the document.

```
  PUBLIC              PRIVATE             EXPIRED
  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
  │ Q3 review     │   │ A private     │   │ This link has │
  │               │   │ artifact      │   │ expired       │
  │ Revenue is up │   │               │   │               │
  │ 18% on the    │   │ Sign in to    │   │ Ask the sender│
  │ quarter.      │   │ open it.      │   │ for a new one.│
  └───────────────┘   └───────────────┘   └───────────────┘
   title + first       nothing about       says the link
   line of the doc     the document        is finished
```

A private artifact shows no title and no content. Link previews are made by
services that are not signed in. Anything the card shows is shown to every
person who can see the message.

---

## 14 August 2026

> **As a new user,** I want to know what I agree to, **so that** I can decide
> before I sign in.

- The sign-in page states the terms.
- The project logo is available in the sizes that app directories require.

---

## 13 August 2026

> **As a Claude Code user,** I want to install the skill as a plugin, **so that**
> I do not have to install it by hand.

- Claude Code installs the Open Artifact skill as a plugin.
- Each MCP tool states what it will do before it does it.
- Each instance states what it does with your information.

---

## 7 August 2026

> **As a person who shares a document,** I want the link to stop working after a
> date, **so that** access does not continue after the work is finished.

- Set an expiry date on a shared link.
- A person who opens an expired link sees a clear message and a way to ask for
  a new link.
- A change to the date does not move the date while another person is choosing
  one.

---

## 5 August 2026

> **As an author,** I want the editor to keep my text, **so that** I do not lose
> my work.

- The editor no longer loses text that you type.
- The editor no longer puts the text of one block into another block.

---

## 4 August 2026

> **As an author,** I want to correct a document on the page, **so that** I do
> not have to publish the file again to fix one word.

- Edit a Markdown artifact on the page, one block at a time.
- The edit control is in the top bar. The reading area stays clear.

---

## 1 August 2026

> **As an author,** I want my assistant to read the comments, **so that** it can
> correct the document for me.

```
  reader          agent            document
    │               │                  │
    │ comment       │                  │
    ├──────────────>│                  │
    │               │ reads comments   │
    │               ├─────────────────>│
    │               │ publishes fix    │
    │               ├─────────────────>│
```

- An assistant reads the comments on a document and publishes a new version.
- The page stays still while you read it.
- When you open a comment, the page moves to the text that the comment is
  about.

---

## 29 July 2026

> **As an agent,** I want to read an artifact, **so that** I can revise a
> document that I published before.

- An agent reads an artifact. Before, an agent could only publish one.

---

## 26 July 2026

> **As a reader,** I want to choose light or dark, **so that** the page suits the
> room that I am in.

- Choose light or dark. Before, the page used the setting of your computer.

---

## 24 July 2026

> **As a new user,** I want instructions for the tool that I use, **so that** I
> can start quickly.

- The home page is a setup guide. Choose your tool and follow the steps.
- A free Cloud plan is available. You do not have to run a server.
- `/llms.txt` describes the product to a language model.
- Link previews show an image.

---

## 23 July 2026

> **As a person who uses an assistant in a browser,** I want to connect it
> without a terminal, **so that** I can publish from the tool that I already
> use.

```
  terminal assistant ──> command line ──┐
                                        ├──> Open Artifact
  browser assistant  ──> MCP + OAuth  ──┘
```

- Connect a browser assistant with the hosted MCP endpoint and OAuth.
- Mention a person by email in a comment. Open Artifact tells you what the
  mention did.
- Add a star to an artifact. Starred artifacts have their own list in the
  sidebar.
- Sign in from the terminal with a code that you receive by email.
- Make Open Artifact the default for documents. The setup asks you first.
- The command line tells you when a new version is available.
- The address is now open-artifact.com. Old links continue to work.

---

## 22 July 2026 — first release

> **As a person who works with an AI assistant,** I want to give its work a URL,
> **so that** other people can read it and comment on it.

```
  your assistant
       │  publishes
       v
  ┌──────────┐   share    ┌──────────┐  comment   ┌──────────┐
  │ artifact │ ─────────> │  reader  │ ─────────> │ artifact │
  └──────────┘            └──────────┘            └──────────┘
                                                    revised
```

- Publish HTML and Markdown from the command line. Update what you published.
- Share with one person, with everybody at a company domain, or with a public
  link.
- Add a comment to a passage. The comment stays with that passage when the
  document changes. If the passage is removed, the comment says that it lost
  its position. It does not move to different text without telling you.
- Mention a person. That person receives a notification.
- Delete your account and everything in it.
- Sign in on the web. See your documents. Remove access from a computer that
  you no longer use.
- A public artifact shows a caution to a reader who is not the author.
- A link that leaves a public artifact shows a warning page first.
