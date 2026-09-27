/**
 * Returned from MCP `initialize`. With tool search on, this is what a client
 * sees before loading any tool, so it says what the server is for and when to
 * reach for it; how each tool behaves lives in that tool's description. Kept
 * well under Claude Code's 2,048-character cap on server instructions.
 */
export const STRICT_INSTRUCTIONS = `Use this server for Linear ticket work in this session, in place of any other Linear server: reading tickets, updating what they say, commenting, claiming and closing, and your Linear notifications. It keeps each ticket's description as the current state and treats comments as the log; description_history shows who changed the description, when, and what.

Reads are complete: anything not fetched is listed in omitted, so a result with an empty omitted is the whole picture. Writes are checked here; when one is refused, the error says what to do instead. A patch to the description passes the description_sha it was written against as base, so a patch built from an older read is refused rather than landing on text it never saw. get_issue also reports drift and findings on tickets written from other clients, and repairing them with set_state as you go is part of the job.`;
