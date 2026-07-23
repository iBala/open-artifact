/**
 * The /llms.txt overview, following the llmstxt.org convention.
 *
 * A short, link-first description of what this project is, for a language model
 * that lands here and needs to understand it fast. Built from the running
 * config so a self-hosted instance points at its own address.
 */

export function llmsTxt(baseUrl: string): string {
  return `# Open Artifact

> Open Artifact turns a document your AI assistant writes — a report, a design
> doc, a dashboard, a write-up — into a web page at a stable URL. You share the
> link, people comment on the exact line they are reacting to, and the assistant
> reads those comments back and publishes a new version. Self-hostable and
> fair-code.

Open Artifact publishes HTML and Markdown from any LLM harness (Claude Code,
Codex, Cursor, and — over a hosted MCP endpoint — Claude on the web or ChatGPT).
Documents are private by default and can be opened to named people, to everyone
at an email domain, or to anyone with the link. Markdown renders as a clean
document with line-level comments; HTML runs in a sandboxed iframe with
document-level comments. Comments keep their position when a document is
republished, and say so plainly when the text they pointed at is gone.

## Connect an assistant

- [Set up an assistant](${baseUrl}/setup.md): install the CLI and follow the
  steps, or connect over MCP. Terminal assistants run
  \`npm install -g open-artifact\` and read ${baseUrl}/setup.md; assistants with
  no terminal add ${baseUrl}/mcp as a custom connector.

## Docs and source

- [GitHub repository](https://github.com/iBala/open-artifact): source code,
  self-hosting guide, and issues.
- [API reference](${baseUrl}/api/docs): the OpenAPI contract the CLI, web app and
  MCP endpoint all speak.

## Key facts

- Formats: Markdown (rendered, line-level comments) and HTML (sandboxed,
  document-level comments).
- Sharing: private by default; open to people, a domain, or the public link.
- Hosted instance: ${baseUrl} — free, nothing to deploy.
- Licence: Sustainable Use License (fair-code) — free to self-host and use
  internally; cannot be sold or run as a commercial hosted service without a
  commercial licence.
- Contact: hello@open-artifact.com
`;
}
