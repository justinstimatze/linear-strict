/**
 * list_issues without the paging: the filter it sends Linear and the shape of
 * the whole set it returns.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListNode {
  identifier: string;
  title: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
  delegate: { name: string } | null;
}

export interface ListIssuesArgs {
  query?: string | undefined;
  team?: string | undefined;
  state?: string | undefined;
  assignee_is_me?: boolean | undefined;
  delegate_is_me?: boolean | undefined;
  /** Cycle number; needs team, since every team numbers its own cycles. */
  cycle?: number | undefined;
  /** Project name or id. */
  project?: string | undefined;
  /** Only tickets not in a completed or canceled state. */
  open?: boolean | undefined;
}

/** Past this many matches list_issues refuses rather than return part of the set. */
export const LIST_ISSUES_CAP = 2000;
const LIST_COLUMNS = ['identifier', 'title', 'state', 'assignee', 'delegate', 'updatedAt'] as const;

/** Linear's IssueFilter for the arguments. */
export function listFilter(args: ListIssuesArgs) {
  const state = {
    ...(args.state ? { name: { eqIgnoreCase: args.state } } : {}),
    ...(args.open ? { type: { nin: ['completed', 'canceled'] } } : {}),
  };
  return {
    ...(args.team ? { team: { key: { eqIgnoreCase: args.team } } } : {}),
    ...(Object.keys(state).length > 0 ? { state } : {}),
    ...(args.assignee_is_me ? { assignee: { isMe: { eq: true } } } : {}),
    ...(args.delegate_is_me ? { delegate: { isMe: { eq: true } } } : {}),
    ...(args.cycle !== undefined ? { cycle: { number: { eq: args.cycle } } } : {}),
    // Linear's id comparator accepts only a UUID, so a name has to go to the name comparator.
    ...(args.project
      ? {
          project: UUID.test(args.project)
            ? { id: { eq: args.project } }
            : { name: { eqIgnoreCase: args.project } },
        }
      : {}),
  };
}

/** Every matching ticket as rows under columns, with a count per state. */
export function listResult(nodes: ListNode[], query: string | undefined) {
  const byState: Record<string, number> = {};
  for (const node of nodes) {
    const name = node.state?.name ?? '(none)';
    byState[name] = (byState[name] ?? 0) + 1;
  }
  return {
    total: nodes.length,
    complete: true,
    by_state: byState,
    columns: LIST_COLUMNS,
    rows: nodes.map((node) => [
      node.identifier,
      node.title,
      node.state?.name ?? null,
      node.assignee?.name ?? null,
      node.delegate?.name ?? null,
      node.updatedAt,
    ]),
    order: query ? 'search relevance' : 'most recently updated first',
    note: `This is every matching ticket (${String(nodes.length)}). No descriptions here by design; read a ticket with get_issue before acting on it.`,
  };
}
