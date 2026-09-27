# Working on linear-strict

- Every Linear call goes through the `Gql` seam (`src/graphql.ts`); `src/linear.ts` is the real one and `src/__tests__/strict-fake-linear.helper.ts` the fake. Keep queries minimal and paginate with `paginate`, which reports a failed later page in `omitted` instead of dropping it.
- A tool is a definition and a handler in `src/tools.ts` and a method on `StrictLinear` (`src/strict-linear.ts`) or `StrictWorkspace` (`src/workspace.ts`). `src/__tests__/tools.test.ts` fails if the two lists disagree. Update `TOOLS.md`, the README table and `scripts/mcp-smoke-test.mjs` in the same change.
- Description format rules live in `src/sections.ts`. A refusal says what to do instead, not only what was wrong.
- `docs/design.md` holds why each rule exists, its limits and what is open. Change it in the same commit as a decision it describes.
- Tests use invented names only (`agent-a`, `Ada`, `Grace`), never a real person or workspace.
- `npm test` runs typecheck, lint, unit tests and the smoke test. `npm run test:live` writes to a real workspace and deletes what it creates; run it only when asked.
