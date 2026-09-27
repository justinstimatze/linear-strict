#!/usr/bin/env bash
# PreToolUse on mcp__linear-strict__(set_state|comment|create_issue|set_status).
#
# The gates that already guard Linear writes (ticketvoice, which runs cope-gate and basanite
# writecheck itself, plus a project's own linear-*-gate.sh scripts) read the official server's
# payloads: save_issue {id, description, state, title, labels}, save_comment {issueId, body}.
# None of them reads patch[].body or sections. This translates a strict call into the official
# shape, runs each gate on it, and returns the strictest answer: any deny wins, then any ask,
# and everything else is additionalContext.
#
# A strict write names a ticket and a patch, not the text that results. What each gate sees:
#   - ticketvoice reads linear-strict's own tool calls, so it gets the call as it is. It judges a
#     comment's text and each section on their own, against that section's budget, and returns
#     any rewrite already in place. set_status carries no new text and skips it.
#   - The Impact line is checked on the whole description after the patch, with ticketvoice's
#     own pattern: the patches are applied with the server's section code from dist/ to the
#     ticket as fetched from Linear.
#   - set_status passes the fetched title, description, labels and project to the close gates,
#     which look for their evidence in the ticket text.
# The token is the one the linear-strict server uses, read from the project's .mcp.json. If the
# fetch fails, the Impact check is skipped and the close gates see only the state.
#
# Configuration, all optional (install.sh bakes whatever is set into the hook command):
#   STRICT_GATES           colon-separated gate commands to run on the translated payload; a bare
#                          name is looked up in the project's .claude/hooks/
#   STRICT_GATES_TICKETVOICE  a ticketvoice binary; defaults to the one on PATH, and is skipped
#                          when there is none
#   STRICT_GATES_REQUIRE_IMPACT=1  refuse a set_state that leaves the description with no
#                          "Impact:" line
# With none of them set, the script translates each call and has nothing to run it through.

set -uo pipefail

payload=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$payload")
kind=${tool##*__}
project_dir=${CLAUDE_PROJECT_DIR:-$(jq -r '.cwd // "."' <<<"$payload")}

TICKETVOICE=${STRICT_GATES_TICKETVOICE:-$(command -v ticketvoice || true)}
SECTIONS_JS="$(cd "$(dirname "$0")/../.." && pwd)/dist/sections.js"
IFS=: read -ra PROJECT_GATES <<<"${STRICT_GATES:-}"

fetch_issue() {
  local id=$1 token auth
  token=$(jq -r '.mcpServers["linear-strict"].env.LINEAR_API_TOKEN // empty' "$project_dir/.mcp.json" 2>/dev/null)
  token=${token:-${LINEAR_API_TOKEN:-}}
  [[ -n "$token" ]] || return 1
  if [[ "$token" == lin_api_* ]]; then auth=$token; else auth="Bearer $token"; fi
  jq -n --arg id "$id" '{query: "query($id: String!) { issue(id: $id) { identifier title description project { name } labels(first: 100) { nodes { name } } } }", variables: {id: $id}}' |
    curl -sS --max-time 5 -H "Content-Type: application/json" -H "Authorization: $auth" --data @- https://api.linear.app/graphql |
    jq -e '.data.issue // empty'
}

# The description after applying a list of section patches, using the server's own code.
apply_patches() {
  local description=$1 patches=$2
  DESCRIPTION=$description PATCHES=$patches node --input-type=module -e '
    const { applySectionPatches } = await import(process.argv[1]);
    process.stdout.write(applySectionPatches(process.env.DESCRIPTION, JSON.parse(process.env.PATCHES)));
  ' "$SECTIONS_JS"
}

resulting_description=''
case "$kind" in
set_state)
  issue_id=$(jq -r '.tool_input.issue' <<<"$payload")
  patches=$(jq -c '[.tool_input.patch[]? | select(.section | ascii_downcase != "impact")]' <<<"$payload")
  canonical=$(jq '{tool_name: "mcp__linear__save_comment", tool_input: {issueId: .tool_input.issue, body: ([.tool_input.patch[]?.body] | join("\n\n"))}}' <<<"$payload")
  if ticket=$(fetch_issue "$issue_id") && full=$(apply_patches "$(jq -r '.description // ""' <<<"$ticket")" "$(jq -c '.tool_input.patch // []' <<<"$payload")" 2>/dev/null); then
    resulting_description=$full
  fi
  ;;
comment)
  canonical=$(jq '{tool_name: "mcp__linear__save_comment", tool_input: {issueId: .tool_input.issue, body: ([.tool_input.body, (.tool_input.patch[]?.body)] | map(select(. != null)) | join("\n\n"))}}' <<<"$payload")
  ;;
create_issue)
  sections=$(jq -c '.tool_input.sections // []' <<<"$payload")
  description=$(apply_patches "" "$sections" 2>/dev/null) || description=$(jq -r '[.tool_input.sections[]?.body] | join("\n\n")' <<<"$payload")
  canonical=$(jq --arg d "$description" '{tool_name: "mcp__linear__save_issue", tool_input: ({title: .tool_input.title, team: .tool_input.team, description: $d} + (if .tool_input.project_id then {project: .tool_input.project_id} else {} end))}' <<<"$payload")
  ;;
set_status)
  issue_id=$(jq -r '.tool_input.issue' <<<"$payload")
  if ticket=$(fetch_issue "$issue_id"); then
    canonical=$(jq --argjson t "$ticket" '{tool_name: "mcp__linear__save_issue", tool_input: {id: $t.identifier, state: .tool_input.state, title: $t.title, description: ($t.description // ""), labels: [$t.labels.nodes[].name], project: ($t.project.name // null)}}' <<<"$payload")
  else
    canonical=$(jq '{tool_name: "mcp__linear__save_issue", tool_input: {id: .tool_input.issue, state: .tool_input.state}}' <<<"$payload")
  fi
  ;;
*)
  exit 0
  ;;
esac
# Keep the fields every hook reads besides tool_input.
canonical=$(jq --argjson p "$payload" '. + ($p | {session_id, transcript_path, cwd, hook_event_name, permission_mode} | with_entries(select(.value != null)))' <<<"$canonical")

errfile=$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/strict-gates.XXXXXX")
trap 'rm -f "$errfile"' EXIT

deny=() ask=() context=()
updated_input=''
# ticketvoice's pattern for an impact line (internal/impactline/impactline.go).
if [[ "${STRICT_GATES_REQUIRE_IMPACT:-}" == 1 && -n "$resulting_description" ]] && ! grep -qiP '^[ \t]*(?:\x{1F916}[ \t]*)*impact[ \t]*:[ \t]*\S' <<<"$resulting_description"; then
  deny+=("[impact] This ticket's description has no Impact line. Add one in the same call: a set_state patch with section \"Impact\", mode \"replace\", and one plain-language line a PM or exec would understand, e.g. \"users on the map page see load times drop from ~4s to under 1s\", or \"none, internal maintenance, no user-facing change\".")
fi
# run_gate <name> <command> [input]: the input defaults to the translated payload. Only
# ticketvoice gets the strict call itself, so only its updatedInput can be applied.
run_gate() {
  local name=$1 cmd=$2 input=${3:-$canonical} out status decision reason extra
  out=$(printf '%s' "$input" | "$cmd" 2>"$errfile")
  status=$?
  if [[ $status -eq 2 ]]; then
    deny+=("[$name] $(cat "$errfile")")
    return
  fi
  [[ -n "$out" ]] || return
  decision=$(jq -r '.hookSpecificOutput.permissionDecision // empty' <<<"$out" 2>/dev/null)
  reason=$(jq -r '.hookSpecificOutput.permissionDecisionReason // empty' <<<"$out" 2>/dev/null)
  extra=$(jq -r '.hookSpecificOutput.additionalContext // empty' <<<"$out" 2>/dev/null)
  if [[ "$name" == ticketvoice ]]; then
    updated_input=$(jq -c '.hookSpecificOutput.updatedInput // empty' <<<"$out" 2>/dev/null)
  fi
  case "$decision" in
  deny) deny+=("[$name] $reason") ;;
  ask) ask+=("[$name] $reason") ;;
  esac
  [[ -n "$extra" ]] && context+=("[$name] $extra")
}

if [[ -n "$TICKETVOICE" && -x "$TICKETVOICE" && "$kind" != set_status ]]; then
  run_gate ticketvoice "$TICKETVOICE" "$payload"
fi
for gate in "${PROJECT_GATES[@]}"; do
  [[ -n "$gate" ]] || continue
  if [[ "$gate" == */* ]]; then path=$gate; else path="$project_dir/.claude/hooks/$gate"; fi
  [[ -x "$path" ]] && run_gate "$(basename "${gate%.sh}")" "$path"
done

join() { local IFS=$'\n'; printf '%s' "$*"; }

if [[ ${#deny[@]} -gt 0 ]]; then
  jq -n --arg r "$(join "${deny[@]}")" --arg c "$(join "${context[@]}")" \
    '{hookSpecificOutput: ({hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r} + (if $c != "" then {additionalContext: $c} else {} end))}'
elif [[ ${#ask[@]} -gt 0 ]]; then
  jq -n --arg r "$(join "${ask[@]}")" --arg c "$(join "${context[@]}")" \
    '{hookSpecificOutput: ({hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r} + (if $c != "" then {additionalContext: $c} else {} end))}'
elif [[ -n "$updated_input" || ${#context[@]} -gt 0 ]]; then
  jq -n --arg c "$(join "${context[@]}")" --arg u "$updated_input" \
    '{hookSpecificOutput: ({hookEventName: "PreToolUse"} + (if $c != "" then {additionalContext: $c} else {} end) + (if $u != "" then {permissionDecision: "allow", updatedInput: ($u | fromjson)} else {} end))}'
fi
exit 0
