# Design

Why linear-strict works the way it does, what it deliberately leaves out, and what is still open. The README says what the server does; `TOOLS.md` gives each tool's arguments. When a decision here changes, change this file in the same commit.

## The problem

A team whose agents coordinate through Linear finds that Linear keeps full history but does not work as shared state:

- **State drifts into comments.** Agents append comments asserting state instead of keeping the description current. A comment answers a ticket's blocking question, and the description still says the question is open days later. Another comment says a limit does not exist when the code has had it for a week. Nothing marks which claim is current.
- **Reads are lossy without saying so.** Listings cut descriptions to a few hundred characters, comment APIs default to newest first, and hand-rolled queries take `comments(last: 2)`. Each produces a confident, wrong summary.
- **Tickets change after they are read.** An agent works from the ticket as it was when it started; acceptance criteria are added later, and the work ships without them ([herdr-factory#97](https://github.com/sonhyrd/herdr-factory/issues/97)).
- **Rules in client hooks go dark.** Hooks that matched `mcp__linear__…` fired on nothing, with no warning, once the servers were renamed.
- **Authorship is meaningless** when every loop and agent posts under one person's name.

## Why git can be trusted and Linear, as used, can't

Linear is versioned too: issue history, description content history, a timestamp on every comment. The raw material is the same. What differs is the discipline around it, and each piece of that discipline is something a server can supply.

| Git | Linear as used | What this server does |
|---|---|---|
| A HEAD: the tree is where current state lives; commit messages are events | Every comment stays live with equal weight, so a claim and its correction sit side by side | The description is the tree and comments are the log. A reconciled marker records the last comment the description accounts for; later comments, and comments edited since, are `drift` |
| Readers show everything or say they didn't | Cut listings, newest-first comments, summaries by another model | Whole reads, oldest first, every page; anything not fetched is named in `omitted` |
| Content addressed by hash; a SHA can't change under you | A ticket can be edited after you read it and nothing tells you | `get_issue` returns `description_sha`. A description write passes it as `base` and is refused, with a diff, if the description moved. `claim` snapshots the description, and Done is refused if it changed since |
| `git log` and `git blame` | Content history exists but no client shows it to an agent | `description_history`: every version, who made it, the diff, and blame per line |
| Gates: hooks, CI | Almost none, and the client-side ones went dark | The gates are in the server's write paths, where a rename can't reach them |
| Authorship means something | Agents post as a person | An app token writes as the agent; a personal key writes `🤖 <agent> via <person>`; reads mark each comment agent or person, with the basis |

Facts git can derive (a PR's state, whether it is on main) keep coming from git, through Linear's GitHub attachments, and are never typed into a ticket. Rebuilding planning, cycles and reporting on raw git is not the conclusion; Linear stays the planning tool.

## Decisions

**The description is state, changed only through section patches.** Named sections (`Observed`, `Cause`, `Fix`, `Done when`, `Open questions`) give a patch something to address. A free-text description write would let an agent restate the whole ticket from an older read. Format rules live in `src/sections.ts` and refuse before anything is written.

**Repair on read.** Most of a team won't use this server, so it can't only guard its own writes. `get_issue` lints whatever it reads and reports drift from comments posted through any client, and the agent that reads a broken ticket is told to fix it.

**The reconciled marker is an attachment on the ticket.** It started as an HTML comment in the description, meant to travel with the text unseen. Linear stores a description as a ProseMirror document with no node for an HTML comment, so it kept the comment as a paragraph of literal text that anyone reading the ticket saw and could edit away. An attachment is where Linear keeps an integration's state: one card in the sidebar, metadata hidden, and `attachmentCreate` with the same URL on the same issue updates that record in place, replacing its metadata whole. The marker's metadata is `through`, `at`, `by`, `checked` and `sha`, the hash of the description as this server last wrote it. The description is written first and the attachment second, so a failure between the two leaves an older marker, which reports more drift rather than less. A different hash on read means the description was changed elsewhere; that is reported but doesn't by itself set `needs_reconcile`, since most such edits are people tidying text. Moving the marker past a comment needs that comment accounted for: folded into a patch in the same call, or marked as changing nothing, with a reason.

**`base` on description writes.** Linear's `issueUpdate` has no compare-and-swap. The server hashes the description it returns (`description_sha`), and `set_state` and a `comment` carrying a patch must pass the hash they were written against. A mismatch is refused, with a diff when this server returned the older text. Separately, every description write reads the ticket again just before writing. What is left is the gap between that re-read and the write, one request long. Comments without a patch, and the rows `ask`, `answer` and `closed_by` write, need no `base`: the server builds those from the text it has just read.

**The comment header is the server's alone.** Projects tell agents to open comments with the header, so a body often arrives with its own copy, and in live use one named `evidence` above a header saying `correction`. The header built from `kind` is the one whose rules were checked, so a header in the body is dropped rather than refused: refusing would cost a round trip and teach nothing the tool description doesn't already say. A hand-typed `Description updated` line is dropped when the call carries a patch, and an `author_label` that is a whole header keeps only the name. A body that is nothing but a header is refused.

**Claims follow Linear's delegation model.** A person stays the assignee and is accountable; the agent is the delegate. Linear's agent docs say the same: assigning an issue to an app "now sets it as the delegate, not the assignee". An agent (app) identity is therefore always claimed as delegate, even on an unowned ticket, which keeps its assignee empty for a person to take. A person's key can't be a delegate, so it claims as assignee. Claim records, with the full description text for diffs, stay on the machine running the server, so nothing about a claim is written into the ticket. The cost: a Done check from another machine has no claim and is refused.

**The Done gate asks for cited evidence, and lets the claimant supply it.** Every `Done when` item ticked, each with a citation after ` · `, and any cited PR linked to the ticket merged. The server checks a citation's form and that `Observed N` exists; it does not resolve a SHA or a file:line (a client hook can). A gate needing evidence from someone other than the claimant ([openclaw-linear-plugin](https://github.com/calltelemetry/openclaw-linear-plugin)) would block every solo agent until there is a reviewer role.

**Dropping a check needs someone other than the agent.** Removing or rewording an unticked `Done when` item asks the person at the client. MCP elicitation is the portable route, a form the model cannot fill, but Claude Code cuts each row of it at about 100 characters. In Claude Code the server hands the agent an `AskUserQuestion` instead, whose preview box shows the whole change; since the model asks that question, hooks keep the model out of the answer: one refuses the question unless it is shown as issued, one records the pick, and the server approves only from that record. For unattended sessions, `LINEAR_STRICT_SIGN_OFF=judge` asks a model with no stake in the ticket, and the descope comment says so. A person reviewing later can undo a judge's call; a session blocked on a person who isn't there does no work at all. Without any of these, a person makes the edit in Linear.

**Hooks name a program that stays put.** A hook that runs a deleted script fails on every question, and a sign-off would then wait for an answer nothing records. Installed from a checkout or globally, the hooks run that path; installed through npx, whose cache npm prunes, they run the same pinned version through npx. The server checks that the hooks' program still exists, and their version matches its own, before choosing the `AskUserQuestion` route, and uses the form when either fails.

**One server per client connection.** Claude Code's `/mcp` reconnect starts a new stdio server while holding the old one's pipes open, so the old one never sees EOF and runs until the client exits. Each server records its pid in a file keyed by its parent and launch settings; an older one that finds a newer live pid there, and has served no tool call for a minute since, exits. The idle condition means a client that runs two connections to one command on purpose loses neither.

**No Agent Sessions.** Linear's Agent Sessions and Activities are built for an agent that Linear dispatches and watches: an app installed by a workspace admin with `actor=app`, a webhook it must answer within 5 seconds, and a first activity within 10 seconds or the session shows as unresponsive. The agents this server is for run on someone's machine, started by a person, and use Linear as the task list they share with the rest of the team; their logs are local, and there is no webhook for Linear to call. Everything they do is recorded in the ticket itself, in the description and in typed comments that every Linear client shows. A team that runs agents Linear dispatches should use Sessions for them.

**A hands-off label, enforced in the server.** A prompt telling agents to leave some tickets alone is advice; a refused write isn't.

**A standalone package.** It began as a fork of `tacticlaunch/mcp-linear`, which shipped about 195 tools; the strict tools hid them behind an allowlist. Now it holds only its own tools, with GraphQL over `fetch` and one runtime dependency. The OAuth login is the one part kept from the fork.

## Limits

- **Writes through other Linear servers never reach this one.** If Linear's official server is also connected, an agent can edit a ticket there. `examples/claude-code-hooks` refuses those writes, which puts that part of the guarantee back in the client, where a rename can switch it off. The honest scope of "enforced in the server" is every write that goes through this server.
- **Claim contention has a window.** `claim` reads the ticket, then writes the assignee or delegate. Two agents claiming within the same second can both pass.
- **Sign-off outside Claude Code.** The `AskUserQuestion` route needs Claude Code's hooks. Other clients get an elicitation form if they support one; a client without elicitation refuses the descope, and a person edits the ticket in Linear or the server runs with the judge.
- **A section patch rewrites the whole description.** Linear's API takes a description as markdown and rebuilds its rich-text document from it, so every write through this server replaces the text attribution Linear keeps per span, and any formatting markdown can't express. `description_history` still has each version and its author. A write that would change nothing isn't sent.
- **Linear-side writers.** Linear's own agent features can rewrite a description. Such an edit shows up in `description_history` and trips `base` and the Done gate like any other edit, but it doesn't move the marker.

## Open

- A `Blocked when` section: a stop condition the agent checks before continuing, after GitHub Next's Goal.
- Whether the other Linear servers can be dropped from a setup entirely, which would remove the client-side limit above. It needs the reads agents still make through them measured against what this server covers.
- The judge on MCP sampling, so it runs on the client's model with no API key of its own, once clients offer sampling to servers (Claude Code 2.1.283 doesn't).
- A remote HTTP server with per-user OAuth, the only way to reach claude.ai on the web and mobile, and a Claude Desktop extension bundle for people who never open a terminal.

## Prior art

Beyond the README's Related work:

- [trac-mcp#57](https://github.com/WordPress/trac-mcp/issues/57): after one silent data loss, an agent stopped trusting an MCP server and routed around it. "Without it, gaps read as truncation." The source of `omitted`.
- [beads#3708](https://github.com/gastownhall/beads/issues/3708), [catalyst-otel#68](https://github.com/coalesce-labs/catalyst-otel/issues/68): Linear mirrors went stale without saying so.
- [dev-loop](https://github.com/dyzsasd/dev-loop) moved its record off Linear for lack of compare-and-swap and per-agent identity. `base` and app identities are this server's answer to each.
- [streamlinear](https://github.com/prime-radiant-inc/streamlinear): tool-definition and response size matter at volume. The strict tools' definitions cost about 6,000 tokens (measured 2026-09-25).
- jj's operation log, Radicle's collaborative objects, Dolt's blame: the version-control ideas behind `description_history` and the marker's check time.
