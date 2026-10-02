/**
 * create_issue needs a new ticket in a project, directly or
 * through its parent, so it shows in project reports and in any read scoped
 * to a project. A refusal lists the team's open projects, since a filer that
 * doesn't know the project otherwise guesses, and for a parent with no
 * project it suggests the one the parent's neighbours are in.
 */
import { type Gql, paginate } from './graphql.js';
import { PAGE_INFO } from './queries.js';

export interface OpenProject {
  id: string;
  name: string;
}

/** Project status types a ticket can still be filed into. */
const CLOSED_PROJECT = ['completed', 'canceled'];
/** Listed first: work under way, then planned, then the rest. */
const STATUS_ORDER = ['started', 'planned', 'paused', 'backlog'];
/** At most this many projects are written into a refusal; list_projects gives the rest. */
const PROJECTS_LISTED = 40;
/** How many projects closest to the ticket's text go above the list. */
const CLOSEST_SHOWN = 3;
/** Linear refuses a semanticSearch query over 1,024 characters. */
const QUERY_CHARS = 1000;
const CLOSED_ISSUE = ['completed', 'canceled', 'duplicate'];

const OPEN_PROJECTS_QUERY = `query StrictTeamOpenProjects($team: String!, $after: String) {
  projects(first: 100, after: $after, filter: {
    accessibleTeams: { some: { key: { eqIgnoreCase: $team } } }
    status: { type: { nin: ${JSON.stringify(CLOSED_PROJECT)} } }
  }) { nodes { id name status { type } } ${PAGE_INFO} }
}`;

const NEIGHBOURS_QUERY = `query StrictParentNeighbours($id: String!) {
  issue(id: $id) {
    parent { identifier project { id } }
    children(first: 50) { nodes { state { type } project { id } } }
  }
}`;

const CLOSEST_PROJECTS_QUERY = `query StrictClosestProjects($query: String!, $team: String!, $max: Int!) {
  semanticSearch(query: $query, types: [project], maxResults: $max, filters: { projects: {
    accessibleTeams: { some: { key: { eqIgnoreCase: $team } } }
    status: { type: { nin: ${JSON.stringify(CLOSED_PROJECT)} } }
  } }) { results { project { id } } }
}`;

interface ProjectNode {
  id: string;
  name: string;
  status: { type: string } | null;
}

/** The team's open projects, under way first. A short read throws, since a partial list would mislead. */
export async function teamOpenProjects(gql: Gql, team: string): Promise<OpenProject[]> {
  const { nodes, omitted } = await paginate<ProjectNode>('projects', async (after) => {
    const data = await gql<{
      projects: {
        nodes: ProjectNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(OPEN_PROJECTS_QUERY, { team, after });
    return data.projects;
  });
  if (omitted.length > 0) throw new Error(omitted.map((o) => o.reason).join('; '));
  const rank = (p: ProjectNode) => {
    const i = STATUS_ORDER.indexOf(p.status?.type ?? '');
    return i < 0 ? STATUS_ORDER.length : i;
  };
  return [...nodes]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The open projects closest to a ticket's text, by Linear's semantic search,
 * as a hint for the filer: on tickets agents had put in a project themselves,
 * the search ranked that project first about half the time and in its top
 * three about 60%. Nothing when the search fails or finds nothing open.
 */
export async function closestProjects(
  gql: Gql,
  team: string,
  text: string,
  open: OpenProject[],
): Promise<OpenProject[]> {
  const byId = new Map(open.map((p) => [p.id, p]));
  try {
    const data = await gql<{
      semanticSearch: { results: { project: { id: string } | null }[] };
    }>(CLOSEST_PROJECTS_QUERY, {
      query: text.slice(0, QUERY_CHARS),
      team,
      max: CLOSEST_SHOWN,
    });
    return data.semanticSearch.results.flatMap(({ project }) => {
      const found = project ? byId.get(project.id) : undefined;
      return found ? [found] : [];
    });
  } catch {
    return [];
  }
}

const line = (p: OpenProject) => `- ${p.name} (${p.id})`;

/** The projects as refusal lines, name and id, the closest to the ticket first, capped. */
export function projectList(projects: OpenProject[], closest: OpenProject[] = []): string {
  const near = new Set(closest.map((p) => p.id));
  const rest = projects.filter((p) => !near.has(p.id));
  const shown = rest.slice(0, PROJECTS_LISTED).map(line);
  const more = rest.length - PROJECTS_LISTED;
  if (more > 0) shown.push(`- and ${String(more)} more: list_projects gives them all`);
  if (closest.length === 0) return `The team's open projects:\n${shown.join('\n')}`;
  return `Closest to this ticket's text, by Linear's semantic search (a hint, not a match):\n${closest.map(line).join('\n')}\nThe team's other open projects:\n${shown.join('\n')}`;
}

/**
 * The open project a parent with none most likely belongs in: its own
 * parent's, else the one most of its open sub-tickets are in, else the one
 * most of its closed ones are in, said as such, since an old parent's
 * finished work is weaker evidence. Nothing when none points anywhere, or
 * the read fails, since a suggestion is a help and not a requirement.
 */
export async function likelyProject(
  gql: Gql,
  parentId: string,
  open: OpenProject[],
): Promise<{ project: OpenProject; why: string } | null> {
  const byId = new Map(open.map((p) => [p.id, p]));
  let data: {
    issue: {
      parent: { identifier: string; project: { id: string } | null } | null;
      children: { nodes: { state: { type: string } | null; project: { id: string } | null }[] };
    } | null;
  };
  try {
    data = await gql(NEIGHBOURS_QUERY, { id: parentId });
  } catch {
    return null;
  }
  const issue = data.issue;
  if (!issue) return null;
  const above = issue.parent?.project ? byId.get(issue.parent.project.id) : undefined;
  if (above && issue.parent)
    return { project: above, why: `its own parent ${issue.parent.identifier} is in it` };
  const children = issue.children.nodes;
  const live = children.filter((c) => !CLOSED_ISSUE.includes(c.state?.type ?? ''));
  const fromOpen = mostCommon(live, byId);
  if (fromOpen)
    return {
      project: fromOpen.project,
      why: `${String(fromOpen.count)} of its ${String(live.length)} open sub-tickets are in it`,
    };
  const fromAll = mostCommon(children, byId);
  if (!fromAll) return null;
  return {
    project: fromAll.project,
    why: `${String(fromAll.count)} of its ${String(children.length)} sub-tickets are in it, though none of those is still open`,
  };
}

function mostCommon(
  children: { project: { id: string } | null }[],
  byId: Map<string, OpenProject>,
): { project: OpenProject; count: number } | null {
  const counts = new Map<string, number>();
  for (const child of children) {
    const id = child.project?.id;
    if (id && byId.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  // A tie points nowhere.
  if (!top || ranked[1]?.[1] === top[1]) return null;
  const project = byId.get(top[0]);
  return project ? { project, count: top[1] } : null;
}

/** Whether a project status still takes new tickets; a project read without its status counts as open. */
export function projectOpen(status: { type: string } | null | undefined): boolean {
  return !status || !CLOSED_PROJECT.includes(status.type);
}
