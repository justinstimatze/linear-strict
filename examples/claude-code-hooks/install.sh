#!/usr/bin/env bash
# Puts a project on linear-strict: writes its gitignored .claude/settings.local.json so ticket
# writes through the other Linear servers are refused and strict writes run through the
# project's gates. Nothing tracked in the project changes.
#
#   examples/claude-code-hooks/install.sh <project-dir>...            install
#   examples/claude-code-hooks/install.sh --uninstall <project-dir>...
#   examples/claude-code-hooks/install.sh --status <project-dir>...
#
# Read from the environment when installing:
#   STRICT_DENY_SERVERS    the other Linear servers' names in .mcp.json, "|"-separated (default: linear)
#   STRICT_GATES, STRICT_GATES_TICKETVOICE, STRICT_GATES_REQUIRE_IMPACT
#                          passed to strict-gates.sh; see its header
#   PRSTATE                a PostToolUse command to run on strict reads (default: none)
#
# Registering the linear-strict server itself in the project's .mcp.json is a separate step.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# The hooks run these scripts by path, and npm prunes its npx cache.
if [[ "$here" == */_npx/* ]]; then
  echo "Run this from a checkout or a global install of the release .tgz, not through npx: the hooks would point into npm's cache, which npm prunes." >&2
  exit 1
fi
mode=install
case "${1:-}" in
--uninstall) mode=uninstall; shift ;;
--status) mode=status; shift ;;
esac
[[ $# -gt 0 ]] || { echo "usage: $0 [--uninstall|--status] <project-dir>..." >&2; exit 2; }

TAG="linear-strict"
PRSTATE=${PRSTATE:-}
DENY_SERVERS=${STRICT_DENY_SERVERS:-linear}

# The gate settings travel in the command itself, so the hook sees them however Claude Code starts it.
gates_cmd=''
for var in STRICT_GATES STRICT_GATES_TICKETVOICE STRICT_GATES_REQUIRE_IMPACT; do
  [[ -n "${!var:-}" ]] && gates_cmd+="$var=$(printf '%q' "${!var}") "
done
gates_cmd+=$(printf '%q' "$here/strict-gates.sh")

entries=$(jq -n --arg gates "$gates_cmd" --arg deny "$here/deny-other-linear-writes.sh" --arg servers "$DENY_SERVERS" --arg prstate "$PRSTATE" '{
  PreToolUse: [
    {matcher: "mcp__linear-strict__(set_state|comment|create_issue|set_status)", hooks: [{type: "command", command: $gates, timeout: 30}]},
    {matcher: "mcp__(\($servers))__.*", hooks: [{type: "command", command: $deny}]}
  ]
} + if $prstate == "" then {} else {
  PostToolUse: [
    {matcher: "mcp__linear-strict__(get_issue|list_issues)", hooks: [{type: "command", command: $prstate}]}
  ]
} end')

# An entry is ours when one of its commands names this directory, or when it is the strict-read
# entry PRSTATE was installed as; that is how uninstall and reinstall find it again.
# shellcheck disable=SC2016 # a jq program; $here is a jq variable, not a shell one
ours='(.matcher == "mcp__linear-strict__(get_issue|list_issues)") or ((.hooks // []) | any(.command | contains($here)))'

for dir in "$@"; do
  file="$dir/.claude/settings.local.json"
  # The hooks name this machine's paths, so they must not be committable. Outside git nothing is.
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 && ! git -C "$dir" check-ignore -q "$file"; then
    echo "$file is not gitignored, so these hooks, which hold this machine's paths, could be committed. Add .claude/settings.local.json to $dir/.gitignore and run this again." >&2
    exit 1
  fi
  if [[ ! -f "$file" ]]; then
    [[ "$mode" == install ]] || { echo "$dir: not installed (no $file)"; continue; }
    mkdir -p "$dir/.claude"
    echo '{}' >"$file"
  fi

  case "$mode" in
  status)
    jq -r --arg here "$here" \
      '[.hooks // {} | to_entries[] | .key as $event | .value[] | select('"$ours"') | "\($event) \(.matcher)"] | if length == 0 then "not installed" else .[] end' "$file" |
      sed "s|^|$dir: |"
    ;;
  uninstall | install)
    next=$(jq --arg here "$here" --argjson add "$entries" --arg mode "$mode" '
      .hooks = ((.hooks // {}) | with_entries(.value |= map(select(('"$ours"') | not))))
      | if $mode == "install" then
          reduce ($add | to_entries[]) as $e (.; .hooks[$e.key] = ((.hooks[$e.key] // []) + $e.value))
        else . end
      | .hooks |= with_entries(select(.value | length > 0))
      | if .hooks == {} then del(.hooks) else . end' "$file")
    printf '%s\n' "$next" >"$file"
    echo "$dir: $mode done ($TAG hooks in $file)"
    ;;
  esac
done
