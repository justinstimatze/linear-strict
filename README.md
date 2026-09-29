# linear-strict

> **Unofficial and opinionated.** This is an independent project, not affiliated with or endorsed by Linear. It enforces one team's way of keeping tickets current, and it refuses writes that other Linear servers would make. For Linear's own MCP server, see [linear.app/docs/mcp](https://linear.app/docs/mcp).

An MCP server for Linear for teams where agents keep tickets up to date. It reads a ticket whole and treats the description as the ticket's current state. The rules are enforced in the server, so a prompt that goes unread or a client hook that stops matching can't switch them off.

It has one runtime dependency, the MCP SDK. It began as a fork of [`tacticlaunch/mcp-linear`](https://github.com/tacticlaunch/mcp-linear) (MIT), whose OAuth login it keeps.

## The problem it addresses

Linear keeps full history, yet agents working from it drift:

- **State ends up in comments.** A comment answers the ticket's open question and the description still says it is open. Nothing marks which claim is current.
- **Reads are lossy without saying so.** Listings cut descriptions short, comment APIs default to newest first, and summaries read like the whole ticket.
- **Tickets change after they are read.** An agent works from a snapshot, acceptance criteria are added later, and the work ships without them.
- **Rules in client hooks go dark** when a server is renamed and the matcher no longer fires.

## How it works

- **Description is state, comments are the log.** The description has named sections: `Observed`, `Cause`, `Fix`, `Done when`, `Open questions`. It changes only through validated section patches. An `Observed` line must read `YYYY-MM-DD · source · result` (a time after the date is fine), and `Done when` lines must be checklist items.
- **A reconciled marker is the description's HEAD.** It records the last comment the description accounts for, when that was checked, and the hash of the description it was checked against. It lives in one attachment on the ticket, titled "linear-strict: description reconciled through …", so the description stays clean. Every read reports comments after it, comments edited since the check, and edits to the description made outside this server, as `drift`.
- **Repair on read.** Not everyone on a team will use this server. `get_issue` reports format `findings` and `drift` on tickets written from any client, and tells the agent to fold them into the description.
- **Whole reads.** Every comment, oldest first, across all pages. `list_issues` and the workspace lists (teams, cycles, projects, initiatives) walk every page too, so an agent never holds a cursor it can stop following. Anything not fetched is listed in `omitted`; a gap is never silent.
- **Typed comments.** `evidence`, `correction`, `ask`, `answer` and `closed_by`. A correction must carry the description patch that makes it true. An answer flips its question row. `closed_by` also sets the Linear relation.
- **Writes name what they were written against.** `get_issue` returns a hash of the description, `description_sha`. A patch passes it as `base` and is refused, with what changed, if the description moved since that read. Linear has no conditional update, so this is how a patch shows it was built from the current text.
- **Claim, then a Done gate.** `claim` records the description as it stands. Moving to a completed state needs a `Done when` section with every item ticked and cited (`- [x] item · <SHA, PR, file:line, link, CI run, Observed 2, or a command and its result>`), any cited PR that is linked to the ticket merged, and your claim, and is refused with a diff if the description changed since then. Priority or label changes don't count. Dropping an unticked item needs a reason and a yes from the person at the client, or from a model judge in unattended sessions.
- **Shipped-state facts.** A ticket marked Done or Merged with no linked pull request, or with PRs merged only into a non-main branch, gets a finding. The facts come from Linear's GitHub attachment metadata.
- **A hands-off label.** A ticket labelled `no-agents` (configurable) is people-only: every write through this server is refused, and reads still work.
- **Authorship.** An agent (app) token writes as the agent. A personal key writes comments headed `🤖 <agent> via <person>`. Each comment on a read is marked `agent` or `person`, with the basis for that call.

## Related work

- Linear's [agent best practices](https://linear.app/developers/agent-best-practices) warn that "Comments may not be reliable to read from, as they are editable and may have changed since your agent’s last run." Their answer, Agent Activities, covers agents running in Linear's Agent Sessions. Here, `drift` lists comments edited after the description accounted for them.
- Linear's agent team [found it](https://linear.app/now/how-we-built-linear-agent) "more effective to encode constraints into the design of Linear Agent’s tools than to spell them out in a prompt", which is the approach this server takes. `claim` follows their [delegation model](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk): a person stays the assignee, accountable for the result, and the agent is the delegate.
- Linear keeps [version history and text attribution](https://linear.app/changelog/2026-07-23-agent-assisted-editing) for documents. `description_history` reads the same snapshots for an issue's description.
- OpenAI's [Symphony](https://github.com/openai/symphony) keeps an agent's progress in one persistent comment per ticket and tells the agent to leave Backlog tickets alone. This server keeps that state in the description, which Linear versions and every client shows first, and enforces the hands-off label in the server rather than in the prompt.
- [Cyrus](https://github.com/ceedaragents/cyrus) has each sub-issue's agent hand back verification commands for the parent to run, and [openclaw-linear-plugin](https://github.com/calltelemetry/openclaw-linear-plugin) has a separate auditor so the worker "cannot self-certify". The Done gate here asks for cited evidence but still lets the agent that did the work supply it.
- Staleness in the wild: [herdr-factory#97](https://github.com/sonhyrd/herdr-factory/issues/97) shipped work against a ticket snapshot that lacked acceptance criteria added later, [trac-mcp#57](https://github.com/WordPress/trac-mcp/issues/57) had an agent stop trusting an MCP server after silent data loss, and [beads#3708](https://github.com/gastownhall/beads/issues/3708) and [catalyst-otel#68](https://github.com/coalesce-labs/catalyst-otel/issues/68) had Linear mirrors go stale without saying so.

## Install

### Quickstart (Claude Code)

1. Get a Linear credential. A **personal API key** (Linear → Settings → Security & access → Personal API keys) writes as you. An **agent (app) token**, an OAuth token for a Linear app with `actor=app` starting with `lin_oauth_`, writes under the agent's own identity and can be set as a ticket's delegate.
2. Add the server and the sign-off hooks:

   ```bash
   npm install -g https://github.com/justinstimatze/linear-strict/releases/download/v0.1.1/linear-strict-0.1.1.tgz
   claude mcp add linear-strict -e LINEAR_API_TOKEN=<token> -- linear-strict
   linear-strict install
   ```

3. Reconnect with `/mcp`, then ask the agent to read a ticket.

You need Node 22 or later. Each [GitHub release](https://github.com/justinstimatze/linear-strict/releases) carries the built package; it is not on npm. To upgrade, `npm install -g` the newer release's `.tgz`, then run `linear-strict install` again and reconnect.

To work on it, run it from a checkout instead:

```bash
git clone https://github.com/justinstimatze/linear-strict.git
cd linear-strict && npm ci && npm run build
claude mcp add linear-strict -e LINEAR_API_TOKEN=<token> -- node "$PWD/dist/index.js"
node dist/index.js install
```

After a `git pull`, run `npm run build` again and reconnect the server.

Pin the version, and give the server its own name, `linear-strict`. Tool names such as `get_issue` also exist on Linear's official server, so the server name is what tells an agent and any hook matcher which rules apply. To sign in through the browser instead of pasting a token, see [OAuth login](#oauth-login).

### The two hook installers

- **`linear-strict install`** adds the [sign-off hooks](#sign-off) to `~/.claude/settings.json`, once per machine. `install --status` says whether they are installed and whether they can still run; `install --uninstall` removes them and nothing else. Installed through npx, the hooks run the same pinned version through npx, since npm prunes the cache npx runs from. After upgrading, run `install` again so the hooks match the server; until then the server asks through the form.
- **`examples/claude-code-hooks/install.sh`** is optional and per project: it refuses ticket writes through other Linear servers and runs a project's own Linear checks on strict writes ([Blocking writes through other Linear servers](#blocking-writes-through-other-linear-servers)). Its hooks run its scripts by path, so run it from a checkout or the global install above, not through npx.

The two write different entries and can both be installed.

### Other clients

Claude Desktop, in `claude_desktop_config.json`, after the global install above:

```json
{
  "mcpServers": {
    "linear-strict": {
      "command": "linear-strict",
      "env": { "LINEAR_API_TOKEN": "<token>" }
    }
  }
}
```

Everything except sign-off works the same in any MCP client. Sign-off depends on what the client offers:

| Client | How a descope is approved |
|---|---|
| Claude Code with `linear-strict install` | `AskUserQuestion`, with the whole change in its preview box |
| Claude Code without the hooks | An elicitation form, with rows of about 100 characters |
| Other clients that support MCP elicitation | That client's elicitation form |
| Clients without elicitation, Claude Desktop included as far as its docs say | Refused; a person makes the edit in Linear, or run with `LINEAR_STRICT_SIGN_OFF=judge` |

Hooks are a Claude Code feature, so no other client gets the preview route.

### Sign-off

Dropping or rewording an unticked `Done when` item removes a check that has not passed, so someone other than the agent approves it. `LINEAR_STRICT_SIGN_OFF` picks who:

- **`person`** (the default): the person at the client. In Claude Code with the sign-off hooks installed, `set_state` hands the agent an `AskUserQuestion` to put to them, and the change is shown in full in its preview box. A hook refuses the question if the agent changes a word of it, another hook records the answer, and the retry is approved from that record, never from what the agent says. Elsewhere, and in Claude Code without the hooks, the server asks through an MCP elicitation form, which Claude Code shows as rows of about 100 characters.
- **`judge`**: a model with no stake in the ticket decides, so an unattended session never waits for someone who isn't there. It reads the ticket's description, the change, the reason and the risk, approves only when the description backs the reason, and the descope comment names the model and gives its reason for a person to review later. It needs an Anthropic API key: `linear-strict auth judge-key set` saves one from a hidden prompt to `$XDG_CONFIG_HOME/linear-strict/anthropic-api-key` (mode 600), next to the `auth login` credentials, or set `ANTHROPIC_API_KEY` in the server's environment, which wins. A key of its own, in a workspace with a spend limit, keeps the judge's cost on its own line. `LINEAR_STRICT_JUDGE_MODEL` overrides the model (default `claude-opus-5-5`). Each verdict is one API call of about 2 seconds, roughly 900 input tokens (most of them the cached brief) and 90 output tokens, well under a cent at Opus 5.5's rates (measured 2026-09-27). If the call fails (no credit, an outage, a refusal), the descope is refused with the error and nothing changes. MCP sampling would let the judge run on the client's own model with no key, but Claude Code doesn't offer it to servers (2.1.283 declares `elicitation` and `roots` only).

The hooks only guard against an agent cutting corners. An agent with a shell could still write an answer record by hand; a third hook refuses tool calls that name the records' directory, which closes the obvious route.

### Blocking writes through other Linear servers

The server can only enforce its rules on writes that go through it. If Linear's official server is also connected, an agent can still edit a ticket there. [`examples/claude-code-hooks`](./examples/claude-code-hooks) has Claude Code hooks that refuse ticket writes through other Linear servers and run a project's own Linear checks on strict writes. They are optional, and they are the only part of this setup that lives in the client.

### OAuth login

`linear-strict auth login` signs in through the browser and stores a refreshing token, which the server uses when no token is set in its environment. It needs a Linear OAuth application of your own: create one at <https://linear.app/settings/api/applications/new> with the redirect URI `http://localhost:8734/callback`, then:

```bash
linear-strict auth login --client-id <client id>        # global install
node dist/index.js auth login --client-id <client id>   # from a checkout
```

The flow uses PKCE, so a client secret is optional. `auth status` shows whether you're signed in and when the token expires. `auth logout` revokes the token and deletes it. Credentials live in `$XDG_CONFIG_HOME/linear-strict/credentials.json`, readable only by you.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LINEAR_API_TOKEN` | — | Personal API key, or a `lin_oauth_` token (sent as Bearer); `--token` on the command line also works |
| `LINEAR_OAUTH_ACCESS_TOKEN` | — | Any OAuth access token, sent as Bearer |
| `LINEAR_STRICT_MAIN_BRANCH` | `main` | Branch a PR must merge into for Done to count as shipped |
| `LINEAR_STRICT_PRODUCTION_ENV` | `production` | Environment named in `posthog-<env>:` flag labels that counts as live |
| `LINEAR_STRICT_HANDS_OFF_LABELS` | `no-agents` | Comma-separated labels that make a ticket people-only: every write through this server is refused, reads still work |
| `LINEAR_STRICT_SIGN_OFF` | `person` | Who approves dropping an unticked `Done when` item: `person` or `judge` ([Sign-off](#sign-off)) |
| `LINEAR_STRICT_JUDGE_MODEL` | `claude-opus-5-5` | The model that decides when `LINEAR_STRICT_SIGN_OFF=judge` |
| `ANTHROPIC_API_KEY` | — | The judge's key, if not saved with `auth judge-key set` |
| `LINEAR_STRICT_STATE_DIR` | `$XDG_STATE_HOME/linear-strict` | Where claim records and pending sign-offs are kept |
| `LINEAR_STRICT_CONFIG_DIR` | `$XDG_CONFIG_HOME/linear-strict` | Where `auth login` stores credentials |
| `LINEAR_STRICT_SINGLE_INSTANCE` | `1` | `0` turns off the check that lets a replaced server exit ([below](#one-server-per-connection)) |
| `LINEAR_STRICT_DEBUG` | — | `1` logs startup detail to stderr |

Claim records live on the machine running the server. A Done check from a machine with no claim on record is refused.

### One server per connection

Claude Code's `/mcp` reconnect starts a new server and leaves the old one running with its pipes open, so the old one never sees its input close. Each server records its pid under `LINEAR_STRICT_STATE_DIR/instances`, keyed by its parent process and launch settings. When a newer server has replaced it and it has served no tool call for a minute since, the older one exits. A server whose parent exits, or whose input closes, exits too.

## Reconciled marker

Each ticket this server has reconciled carries one attachment titled "linear-strict: description reconciled through *date*". It records the last comment the description accounts for, when that was checked, and a hash of the description at the time, so the next agent to read the ticket knows which comments are new and whether the description was edited elsewhere since. Deleting it does no harm: agents then check the whole thread again, and the next reconcile puts it back. It is written by whoever runs this server, not by Linear.

## Tools

| Tool | What it does |
|---|---|
| `get_issue` | Whole ticket, plus `findings`, `drift`, `pull_requests`, `releases`, `claim` and `omitted` |
| `description_history` | Past versions of the description with who made each and a diff; `blame` names the version behind every current line |
| `list_issues` | Every matching ticket in one call, paged to the end by the server: identifier, title, state, assignee, delegate and `updatedAt`, filterable by team, state, open, cycle and project; no description excerpts |
| `claim` | Take a ticket and snapshot its description; refuses one another agent holds |
| `check_claim` | Whether the description changed since your claim, with a diff |
| `set_state` | Patch description sections and/or move the reconciled marker |
| `comment` | Typed comment: `evidence`, `correction`, `ask`, `answer`, `closed_by` |
| `set_status` | Move to a workflow state; completed states pass the Done gate |
| `set_fields` | Priority, owner, labels, cycle, project, milestone, parent, dates, relations and linked PRs; never the description or state |
| `create_issue` | New ticket with validated sections |
| `list_teams` | Teams with their workflow states in board order |
| `list_cycles` | Cycles, active and next by default; pair a number with `list_issues` |
| `list_projects`, `list_initiatives` | Open projects and initiatives with status, owner and dates |
| `notifications` | Your inbox as pointers (ticket, type, actor, time), no excerpt text, paginated |
| `get_principal_notifications` | The same, for the human this identity acts for, on their own credential — needs `LINEAR_PRINCIPAL_TOKEN`/`LINEAR_PRINCIPAL_ID` configured |
| `mark_notifications_read` | Mark handled notifications read |
| `whoami` | The user or app behind the token, which is who claims and `_is_me` filters mean |

The server also returns these rules as MCP `instructions` on `initialize`, so an agent learns the workflow when it connects. [`TOOLS.md`](./TOOLS.md) has each tool's arguments, and [`docs/design.md`](./docs/design.md) the reasoning behind the rules, their limits, and what is still open.

## Development

```bash
npm test         # typecheck, lint, format and unused-code checks, unit tests, MCP smoke test, and the sign-off routes end to end
npm run build
node scripts/e2e/sign-off.mjs --live-judge  # the same, with the judge on the real API (one call, well under a cent)
npm run test:live  # against a real workspace: creates temporary tickets on LIVE_TEAM and deletes them
npm run eval       # a model works tickets in the fake Linear through the strict tools; graded on final state
npm run format     # Prettier; `npm test` fails on unformatted code
```

`git config core.hooksPath hooks` once, after cloning, turns on the tracked pre-commit hook: a non-blocking CodeScene delta check on staged changes when `cs` is on `PATH`. It warns and never blocks the commit.

`npm run test:live` needs `LINEAR_API_TOKEN` and `LIVE_TEAM` (a team key). It writes to that workspace. `npm run eval` needs `ANTHROPIC_API_KEY`; `evals/README.md` covers cases, caching and results.

## License

MIT. See [`LICENSE.md`](./LICENSE.md); the OAuth login code is from `tacticlaunch/mcp-linear` and keeps its notice.
