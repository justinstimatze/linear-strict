# Claude Code hooks for a project on linear-strict

The server enforces its own rules. These hooks cover two things it can't do from inside: they stop an agent routing around it through another Linear server, and they run the checks a project already has for Linear writes on strict calls too.

`install.sh <project-dir>` writes the project's gitignored `.claude/settings.local.json`. Nothing tracked in the project changes. `--uninstall` removes exactly what it added, and `--status` lists it.

- **`deny-other-linear-writes.sh`** runs on every tool of the other Linear servers. It refuses ticket and comment writes and names the strict tool to use instead. Reads still work, and so do writes strict has no tool for: documents, projects, cycles, deleting a relation. Set `STRICT_DENY_SERVERS` to those servers' names in `.mcp.json`, `|`-separated. The default is `linear`.
- **`strict-gates.sh`** runs on `set_state`, `comment`, `create_issue` and `set_status`. Existing Linear gates read the official server's payloads (`save_issue`, `save_comment`), and none of them reads a strict patch. This script translates each strict call into that shape and runs it through:
  - `STRICT_GATES`: a colon-separated list of gate commands. A bare name is looked up in the project's `.claude/hooks/`.
  - [ticketvoice](https://github.com/justinstimatze/ticketvoice), when it is on `PATH` or set in `STRICT_GATES_TICKETVOICE`. It needs v0.5.0 or later, which reads linear-strict's calls itself. It judges a comment's text and each section on their own, against that section's budget, and a section it rewords is rewritten in the call before it goes through.
  - `STRICT_GATES_REQUIRE_IMPACT=1` refuses a `set_state` that leaves the ticket with no `Impact:` line.

  Any deny wins, then any ask. The script's header has the details.
- **`PRSTATE`**, if set, is a command installed as a PostToolUse hook on strict `get_issue` and `list_issues`.

The installer writes the settings above into the hook command itself, so set them when you run it:

```sh
STRICT_DENY_SERVERS='linear|linear-official' STRICT_GATES=linear-close-gate.sh examples/claude-code-hooks/install.sh ~/my-project
```

For `set_state` and `set_status`, `strict-gates.sh` fetches the ticket using the token in the project's `.mcp.json` under `linear-strict`. It applies patches with this repo's `dist/sections.js`, so run `npm run build` first.

The hooks run these scripts by path, so run `install.sh` from a checkout, or from a global install of the release `.tgz` (see the top-level README) at `"$(npm root -g)/linear-strict/examples/claude-code-hooks/install.sh"`. Not through npx, whose cache npm prunes; it refuses to run from there.

In a git repo, `.claude/settings.local.json` has to be gitignored, since the hooks hold this machine's paths; the installer refuses otherwise and says what to add.

These hooks are separate from the sign-off hooks `linear-strict install` adds to `~/.claude/settings.json`; the two can both be installed.

Registering the `linear-strict` server in the project's `.mcp.json` is a separate step; see the top-level README.
