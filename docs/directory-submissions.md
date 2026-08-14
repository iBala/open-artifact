# Directory submissions

The answers each directory form asks for, written down once. Two listings now ask
the same questions, and answering them differently is how a product ends up
described two ways in two places.

For what a reviewer needs in order to actually run the thing, see
[reviewing.md](reviewing.md).

## The answers

| Field | Value |
| --- | --- |
| Name | `open-artifact` |
| Category | Productivity |
| Homepage | <https://open-artifact.com> |
| Repository | <https://github.com/iBala/open-artifact> |
| Support | <https://github.com/iBala/open-artifact/issues> |
| Privacy policy | <https://open-artifact.com/privacy> |
| Terms of use | <https://open-artifact.com/terms> |
| Logo | `assets/logo/open-artifact-logo-1024.png` |
| Licence | Sustainable Use License (fair-code) |
| Contact | hello@open-artifact.com |

**Category.** Productivity, not Developer Tools. The command line is how it is
installed, but the people it is for are the ones reading the documents, and the
taxonomy describes what a thing does rather than who sets it up.

## Where it is submitted

**Claude Code plugin** — `platform.claude.com/plugins/submit`, for the
community marketplace (`anthropics/claude-plugins-community`). The plugin is the
`skill/` folder; the marketplace manifest is `.claude-plugin/marketplace.json`.
Self-hosted install works today without any listing:

```
/plugin marketplace add iBala/open-artifact
/plugin install open-artifact@open-artifact
```

**ChatGPT plugins directory** — `platform.openai.com/plugins`. Submits the MCP
server at `https://open-artifact.com/mcp`, not the skill. Needs the developer
identity verified and an org role with Apps Management write permission before
the form will open.

**Anthropic Connectors Directory** — same MCP endpoint. Blocked on needing a
Team or Enterprise organisation; the submission portal lives in claude.ai admin
settings and is not available on individual plans.

## Things that are easy to get wrong

**Domain verification.** The ChatGPT form issues a token to be served at
`/.well-known/openai-apps-challenge`. Set `OPENAI_APPS_CHALLENGE` to it and
deploy — the route serves it verbatim, and 404s while unset. Confirm with `curl`
before telling the form to check, because a stale deploy answers that address
with the web app's HTML rather than a clean 404.

**Reviewer access.** Sign-in is an emailed six-digit code and nothing else, so a
reviewer with no access to the inbox cannot get in. They get a pre-minted MCP
token instead. Mint it when submitting, not before: it lasts 90 days and the
expiry does not slide.

**Seeding the demo.** A connection only sees what was published *through that
connection*. Publish the sample documents with the reviewer's token, not from the
web app, or `list_artifacts` returns nothing on their first call.

**Tool annotations.** Both directories read `readOnlyHint`, `destructiveHint`
and `openWorldHint` off `tools/list`, and mislabelling is the common rejection
cause. They are asserted by name in `packages/server/test/mcp-annotations.test.ts`,
so changing what a tool does forces a decision about what it claims to do.
