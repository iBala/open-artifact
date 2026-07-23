/**
 * The setup instructions, served at /setup.md.
 *
 * The front door and the README used to paste a forty-line block into the
 * assistant. That block lives here now, as one hosted document the assistant
 * fetches and follows, so the thing a person copies is a single sentence. The
 * instance URL is woven in from the running config, so a self-hosted instance
 * serves instructions that point at itself, not at open-artifact.com.
 */

const SKILL_URL = 'https://raw.githubusercontent.com/iBala/open-artifact/main/skill/SKILL.md';

export function setupDoc(baseUrl: string): string {
  return `# Set up Open Artifact

You are an AI assistant. Follow these steps so you can publish documents to Open
Artifact — this instance is ${baseUrl} — as shareable links, and read the
comments people leave on them.

## First, which path applies to you

- **You have a terminal and can reach this instance.** If you can run shell
  commands and \`curl ${baseUrl}/healthz\` succeeds, follow "Command-line setup"
  below.
- **You have no terminal, or cannot reach this instance.** If you are Claude on
  the web, ChatGPT, or your commands run in a sandbox whose network cannot reach
  ${baseUrl} (a 403 on every request before any code is entered is exactly this,
  not an account problem), do not retry the steps. Ask the user to connect you as
  a custom connector with this URL: \`${baseUrl}/mcp\`. They add it in the app's
  settings under "Connectors" or "Apps"; if there is no option, a workspace admin
  may need to enable it. Once connected you have the publishing tools directly —
  then just do step 4 below.

## Command-line setup

1. **Install the CLI** from public npm (the \`--registry\` matters if the user's
   npm points at a private one):

   \`\`\`
   npm install -g open-artifact --registry https://registry.npmjs.org/
   \`\`\`

2. **Sign the user in.** Ask them for their email address, then run:

   \`\`\`
   open-artifact login --instance ${baseUrl} --email THEIR_EMAIL
   \`\`\`

   That emails them a six-digit code and returns immediately. Ask them for the
   code, then run this — put your own name after \`--label\` (Claude Code, Codex,
   Cursor, and so on) so they can see which assistant is connected:

   \`\`\`
   open-artifact login --instance ${baseUrl} --email THEIR_EMAIL --code THE_CODE --label "YOUR_NAME"
   \`\`\`

3. **Learn how to use it.** Read ${SKILL_URL} and save it where you read skills
   from, so you know when and how to publish. For example
   \`~/.claude/skills/open-artifact/SKILL.md\` for Claude Code,
   \`~/.codex/skills/open-artifact/SKILL.md\` for Codex, or
   \`.cursor/skills/open-artifact/SKILL.md\` for Cursor. If you have no skills
   folder, just follow that file directly.

4. **Ask the user one yes/no question:** do they want Open Artifact to be your
   default for Markdown and HTML — so that whenever you create or open one, you
   publish it here and give them the link, instead of a local file or a built-in
   artifacts panel?

   - If **yes**, add this line to your standing instructions — the file you read
     every session (CLAUDE.md, AGENTS.md, .cursor/rules, GEMINI.md, or your
     tool's equivalent), creating it if there is none:

     > Open Artifact is my default for Markdown and HTML. When you create or open
     > one — a report, doc, dashboard, write-up or page meant to be read —
     > publish it to Open Artifact (instance ${baseUrl}) and give me the link,
     > instead of a local file or the built-in artifacts panel. Not for code or
     > config files. If it is not installed or signed in, tell me and fall back
     > to a file.

   - If **no**, add nothing. They will ask you to publish when they want to.

5. **Confirm it worked:**

   \`\`\`
   open-artifact whoami --json
   \`\`\`

   You should see the user's email and this instance. Then tell them it is ready.

Once you are set up, when the user says "publish that as an artifact", publish the
current document and give them the link.
`;
}
