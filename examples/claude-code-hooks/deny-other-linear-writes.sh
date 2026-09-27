#!/usr/bin/env bash
# PreToolUse on every tool of the other Linear servers (install.sh: STRICT_DENY_SERVERS).
# In a project that has linear-strict, every write to a ticket or its comments goes through it,
# so the checks it makes (section format, the Done gate, sign-off for dropped checks) cannot be
# skipped by reaching for another server. The refusal names the strict tool to use instead.
# Reads pass, and so do writes strict has no equivalent for: documents, projects, cycles,
# releases, deleting a relation, custom fields.

set -uo pipefail
payload=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$payload")

fields="set_fields (priority, labels, assignee, delegate, cycle, project, milestone, parent, due date, estimate, relations)"
case "${tool##*__}" in
save_issue | linear_updateIssue)
  instead="set_state for the description, set_status for the workflow state, $fields, or create_issue for a new ticket"
  ;;
linear_createIssue | linear_createIssueFromTemplate | linear_duplicateIssue) instead="create_issue" ;;
save_comment | delete_comment | linear_createComment | linear_updateComment | linear_deleteComment)
  instead="comment (kinds evidence, correction, ask, answer, closed_by); comments are not edited or deleted"
  ;;
linear_archiveIssue | linear_transferIssue)
  instead="set_status (a canceled or duplicate state) or comment kind closed_by"
  ;;
linear_setIssuePriority | linear_assignIssue | linear_addIssueLabel | linear_removeIssueLabel | \
  linear_addIssueToCycle | linear_removeIssueFromCycle | linear_addIssueToProject | linear_removeIssueFromProject | \
  linear_convertIssueToSubtask | linear_createIssueRelation)
  instead=$fields
  ;;
*) exit 0 ;;
esac

jq -n --arg tool "$tool" --arg instead "$instead" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
  permissionDecisionReason: "This project writes Linear tickets only through the linear-strict server. Instead of \($tool), use mcp__linear-strict__ \($instead). Reads through other servers are fine."}}'
