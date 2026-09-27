/**
 * The one seam the strict tools talk to Linear through. Raw GraphQL rather
 * than an SDK's model objects because every strict read needs exact control
 * over pagination (page size, cursor, knowing which page failed) and SDK model objects'
 * lazy relations issue one request per related entity per node. Tests pass a
 * fake of this type.
 */
export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Connection<N> {
  nodes: N[];
  pageInfo: PageInfo;
}

/** A part of the answer that was not returned, and why. Never a silent gap. */
export interface Omission {
  field: string;
  reason: string;
  fetched?: number;
}

export const PAGE_SIZE = 100;
export const MAX_PAGES = 50;

/**
 * Walks a connection to the end. The first page failing throws, because an
 * answer with nothing in it is not an answer. A later page failing returns
 * what was fetched plus an Omission naming the field, the count fetched and
 * the error, so a short list can never pass for a complete one.
 */
export async function paginate<N>(
  field: string,
  fetchPage: (after: string | null) => Promise<Connection<N>>,
  pageSize: number = PAGE_SIZE,
  maxPages: number = MAX_PAGES,
  /** Said in the omission when maxPages stops the walk. */
  stoppedBecause?: string,
): Promise<{ nodes: N[]; omitted: Omission[] }> {
  const nodes: N[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let connection: Connection<N>;
    try {
      connection = await fetchPage(after);
    } catch (error) {
      if (page === 0) throw error;
      return {
        nodes,
        omitted: [
          {
            field,
            reason: `page ${page + 1} failed: ${errorMessage(error)}; later ${field} were not fetched`,
            fetched: nodes.length,
          },
        ],
      };
    }

    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return { nodes, omitted: [] };
    after = connection.pageInfo.endCursor;
  }

  return {
    nodes,
    omitted: [
      {
        field,
        reason: stoppedBecause ?? `stopped after ${String(maxPages)} pages of ${String(pageSize)}; later ${field} were not fetched`,
        fetched: nodes.length,
      },
    ],
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
