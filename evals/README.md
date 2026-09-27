# Evals

Each case puts a model in front of the strict tools with one ticket in the in-memory fake Linear (`src/__tests__/strict-fake-linear.helper.ts`), gives it a request, and runs the tool loop until the model stops. Grading reads the ticket's final state: the description, the workflow state, the comments, whether sign-off was asked. What the model says it did isn't graded, except where a case checks that the final reply names what is still blocking.

```
npm run eval -- --list
npm run eval                                   # every case, claude-opus-5-5, 3 samples
npm run eval -- --case descope --samples 5
npm run eval -- --model claude-opus-5-5 --model claude-sonnet-5
```

`ANTHROPIC_API_KEY` comes from the environment, or from a gitignored `.env` at the repo root.

Each run writes one JSON line per sample to `evals/results/`: checks, tool calls with any errors, the final reply, and the final description. Read the failing samples there before changing a tool description or adding cases.

Costs are kept down two ways. The system block carries a `cache_control` breakpoint, which caches the tool schemas and instructions across every call, and the newest message carries another, so each turn reuses the conversation before it. Every response is also saved in `evals/.cache/`, keyed by a hash of the whole request and the sample number. The fake is deterministic, so rerunning unchanged cases costs nothing, and changing a tool description, the instructions or a fixture re-asks only the requests it affects. `--no-cache` skips the disk cache.

A case is an entry in `cases.ts`: a fixture, a prompt, how the person answers a sign-off form (or no form at all), and checks on the final state.
