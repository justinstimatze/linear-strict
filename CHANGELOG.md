# Changelog

## 0.1.0 — 2026-09-27

First release as a standalone package.

- Tools: `get_issue`, `description_history`, `list_issues`, `claim`, `check_claim`, `set_state`, `comment`, `set_status`, `set_fields`, `create_issue`, `list_teams`, `list_cycles`, `list_projects`, `list_initiatives`, `notifications`, `mark_notifications_read`, `whoami`.
- A description patch names the description it was written against: `get_issue` returns `description_sha`, and `set_state`, or a `comment` with a patch, passes it as `base`. A patch built from an older read is refused with what changed since.
- The sign-off prompt for dropping a `Done when` item shows each check as it stands, what replaces it, why the agent wants it and what approving gives up, as rows with short labels and the full text beneath, and approves on Accept. It had asked for a ticked box per item, and Accept with the boxes left unticked, as they started, was scored as a decline. A descope now needs `descope_risk` beside `descope_reason`, each at most 100 characters, since the form shows each on one line. The form opens with the ticket's title, and text longer than a row continues on the rows below it. The form waits 30 minutes, up from 10. A refusal says what the person wrote and what the client returned.
- In Claude Code, sign-off goes through `AskUserQuestion` with the change in its preview box, once `linear-strict install` has added the sign-off hooks to `~/.claude/settings.json`. `set_state` issues the question with a token, a PreToolUse hook refuses it if its text was changed, a PostToolUse hook records the answer, and the retry passes the token as `sign_off`. `LINEAR_STRICT_SIGN_OFF=judge` hands the decision to a model instead (`claude-opus-5-5` by default), for sessions nobody is watching; the descope comment names the model and its reason. `linear-strict auth judge-key set` stores its API key in the config directory, mode 600.
- `list_issues` returns every matching ticket in one call: the server pages through Linear to the end and answers with `total`, `by_state` and one row per ticket, so there is no cursor for an agent to stop following. A failed page, or more than 2,000 matches, is refused rather than answered with part of the set. `open: true` leaves out completed and canceled tickets. `first` and `after` are gone. An agent had stopped after 4 pages of a 955-ticket cycle.
- `linear-strict install` under npx writes hooks that run the same pinned version through npx, since npm prunes the cache npx runs from and hooks pointing into it would stop recording answers without a word. `install --status` says whether the installed hooks can still run, and the server asks through the elicitation form instead of `AskUserQuestion` when they can't.
- A server replaced by Claude Code's `/mcp` reconnect exits once the newer one has served for a minute with it idle, instead of running for as long as the client does. It also exits when its parent does or its input closes. `LINEAR_STRICT_SINGLE_INSTANCE=0` turns this off.
- `npm test` runs every sign-off route end to end through the built server over stdio: `AskUserQuestion` with the installed hooks, the form when the hooks can't run, and the judge (`--live-judge` for the real API).
- The npm package includes `examples/` and a `server.json` for the MCP registry (`mcpName` `io.github.justinstimatze/linear-strict`).
- `description_history` reads the snapshots Linear keeps of a description: each version's time, author and diff, and with `blame` the version behind every current line.
- A comment edited after the description accounted for it shows up in `drift.edited_after_reconcile`, and moving the marker needs it accounted for again. The marker records when it was checked (`checked`).
- The reconciled marker is kept in an attachment on the ticket instead of a `<!-- strict:reconciled … -->` line in the description. Linear stores descriptions as rich text with no place for an HTML comment, so the line showed to everyone as literal text they could edit or delete. The attachment also records the hash of the description it was checked against, and `drift.description_changed_elsewhere` reports a description edited outside this server since. A marker line from an earlier version is still read, and the next description write through this server moves it to the attachment.
- Tickets labelled `no-agents` (`LINEAR_STRICT_HANDS_OFF_LABELS`) refuse every write through this server.
- GraphQL over `fetch`. A rate-limited call waits for Linear's reset time and retries twice, then says when the limit resets. A read that meets a gateway error (502, 503, 504) is retried the same way; a write is not, since it may have gone through.
- `claim` makes an agent (app) identity the delegate on every ticket, including an unowned one, which it had taken as assignee.
- Writes to an archived or trashed ticket are refused.
- Moving a ticket to a canceled state needs `reason`, posted as a comment, since canceling skips the Done checks.
- `ask_to` mentions the person by profile link when the name resolves to one member, so they are notified.
- A cited PR whose merge status Linear didn't record no longer refuses Done; the result names it.
- `get_issue` reads the latest 200 history entries rather than all of them, and a description write that changes nothing is not sent.
- The README and package say plainly that this is an unofficial project, not affiliated with Linear.
- Installs from the built package attached to each GitHub release (`npm install -g <release .tgz URL>`); it is not on npm.
- `linear-strict auth login|status|logout`, an OAuth login with PKCE and token refresh, from `tacticlaunch/mcp-linear`.
- An `Observed` line may carry a time after its date.
- Done needs each ticked `Done when` item to cite what showed it: `- [x] item · <evidence>`, where evidence is a commit SHA, a PR, a file:line, a link, a CI run, `Observed N`, or a command and its result. A cited PR linked to the ticket must be merged.
- A ticket written with neither `Observed` nor `Done when` gets one `unstructured` finding instead of two missing sections, and a closed or canceled ticket gets neither.
- An unknown argument is refused with the arguments the tool does take, and a field that belongs to `set_fields` (an assignee on `create_issue`, say) points there.
- Claude Code hooks under `examples/claude-code-hooks`.
