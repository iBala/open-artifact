# Open Artifact

Your coding agent writes a report, a design doc, a dashboard. Right now that
lands as a file on your laptop that nobody else can see.

Open Artifact gives it a URL. The agent publishes, you get a link, you share it
with the people who need to read it. They comment on the exact paragraph they
are reacting to, and the agent reads those comments back and revises. You host
all of it yourself.

- **Publish from the agent.** One command, or the bundled skill so the agent
  does it without being asked.
- **HTML and Markdown.** HTML runs in a sandbox with no access to your session.
  Markdown is rendered with headings, tables and syntax highlighting.
- **Share deliberately.** Private by default. Open it to named people, to
  everyone at your email domain, or to anyone with the link.
- **Comment on a specific line.** Comments hold their position when the
  document is republished, and say so plainly when the text they pointed at is
  gone.
- **Feedback loop.** The agent reads the comments and publishes a new version.

## Try it in two minutes

```bash
git clone https://github.com/iBala/open-artifact.git
cd open-artifact
pnpm install
pnpm --filter @open-artifact/server dev
```

Open http://localhost:3000. With no mail server configured, sign-in codes are
printed to the terminal, so you can sign in and click around without setting up
anything else.

## Run it for real

Everything you need is in `deploy/`.

```bash
cp deploy/env.example .env      # then fill in BASE_URL, SESSION_SECRET, SMTP
docker compose -f deploy/docker-compose.yml up -d
```

Two things to know before you go live:

**Put a reverse proxy in front of it.** The container binds to localhost only,
on purpose. Terminate TLS with Caddy, nginx or Traefik and forward to it.

**You need a mail server.** Sign-in codes and share notifications go out over
SMTP. Amazon SES, Postmark, Fastmail, your own — anything that speaks SMTP.
Without it, nobody can sign in.

Then prove the install works:

```bash
./deploy/smoke.sh https://artifacts.example.com
```

That signs in, publishes, checks the sandbox headers are really being sent,
shares, comments, republishes and confirms the comment kept its place. If it
passes, the instance is good.

### Who can sign up

`SIGNUP_MODE` decides. `invite-only` is the default: an account is created only
for someone an artifact was shared with. `domain-allowlist` opens it to listed
email domains. `open` lets anyone in. Every setting is explained in
`deploy/env.example`, and the server refuses to boot with a clear message if
something is missing or contradictory.

## Connect your agent

```bash
npm install -g open-artifact --registry https://registry.npmjs.org/
open-artifact login --instance https://artifacts.example.com
```

Then copy `skill/` into your agent's skills directory. `skill/README.md` has
the details for Claude Code and for anything else that reads Markdown
instructions.

## How the pieces fit

| Folder | What it is |
| --- | --- |
| `packages/server` | Hono API, SQLite via Drizzle, auth, sharing, comments |
| `packages/web` | React and Vite front end |
| `packages/cli` | The `open-artifact` command the agent runs |
| `packages/shared` | Types and validation both sides use |
| `packages/e2e` | Playwright tests against a real browser |
| `skill/` | The agent instructions |
| `deploy/` | Compose file, environment template, smoke test |

The database is one SQLite file. Back that file up and you have backed up the
whole instance. The compose file includes a nightly backup that uses SQLite's
own `.backup` command, not a file copy, because copying a live database gives
you a corrupt one.

## Two decisions worth explaining

**Published HTML cannot touch your session.** It runs in a sandboxed iframe on
an opaque origin, and the same restriction is sent as a header on the content
itself, so pasting the URL straight into a tab is equally contained. Inside it,
`document.cookie` throws and a credentialed request to the API is refused. An
artifact is untrusted code and is treated that way.

**A comment either finds its text or admits it is lost.** On republish we look
for the same snippet under the same heading. Found, it keeps its position. Not
found, it becomes a comment about the document and says so on screen. We never
fuzzy match, because a comment that silently reattaches itself to different
text is worse than one that tells you it lost its place.

## Working on it

```bash
pnpm install
pnpm test          # unit and integration
pnpm lint
pnpm typecheck
pnpm --filter @open-artifact/e2e test    # browser tests
```

Tests come first here. If you are adding behaviour, the test that describes it
should exist before the code that satisfies it.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
