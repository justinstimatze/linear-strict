# Tools

The server advertises the tools below and registers no MCP resources or prompts. Calling any other tool name returns `Unknown tool`, and an argument a tool does not list is refused.

`issue` arguments take an identifier such as `ENG-123` or a Linear issue id.

## Reading

### `get_issue`

The whole ticket: full description, every comment oldest first across all pages, who edited the description and when, relations, children, linked pull requests and other attachments.

| Argument | Required | |
|---|---|---|
| `issue` | yes | |

Along with the ticket it returns:

- `issue.description_sha` — a hash of the description as read. Pass it as `base` to the write that patches the description.
- `omitted` — anything not fetched, with the reason. An empty list means nothing was left out. Only the latest 200 entries of the ticket's history are read, which always includes the latest description edit; on a busier ticket `omitted` says so, and `description_history` has every version.
- `findings` — format problems in the description (`unstructured` for an open ticket with neither Observed nor Done when, `missing_section`, `empty_section`, `invalid_line`, `duplicate_section`; a closed ticket is not asked for sections it never had), and shipped-state problems on tickets whose state says the work landed (a completed state, or one with "Merged" in its name). When the ticket is in a Linear release, it counts as shipped once any of its releases reaches a completed stage (`not_released` otherwise); without a release, a linked PR must be merged into the main branch (`no_linked_pr`, `no_merged_pr`, `not_on_main`). On a completed ticket, a `posthog-flag` label needs a `posthog-<env>:` label for the production environment (`flag_unverified`), and one ending in `:dark` means users can't see it yet (`flag_dark`). A PR mentioned in the description or comments but not linked gives `pr_mentioned_not_linked`.
- `releases` — the Linear releases the ticket is in, each with its stage and whether that stage is completed.
- `drift` — the reconciled marker, the comments after it, `needs_reconcile`, and `next_step`. `edited_after_reconcile` lists comments the description already accounted for that were edited after that check; Linear keeps no earlier text of a comment, so the fold may no longer match. A marker written before check times were recorded can't date such edits, and `edits_unchecked` says so until the next reconcile. `description_changed_elsewhere` says the description was edited outside this server after the marker was written, which may have undone a fold. `reconciled_through.stored_in` is `attachment`, or `description` for a marker line written by an earlier version, which the next description write moves to the attachment.
- `claim` — your claim on this ticket, if any, and whether the description changed since.
- `comments[].author_kind` — `agent`, `person` or `unknown`, with `author_kind_basis` saying what the call rests on.

### `description_history`

The description's past versions, from the snapshots Linear saves as the description is edited. Each version has its time, who made it, and a line diff against the version before; version 1 comes whole. Snapshots that changed nothing in the text are not counted as versions.

| Argument | Required | |
|---|---|---|
| `issue` | yes | |
| `blame` | no | Also attribute each line of the current description to the version that introduced it |

- `current` — whether the live description is in a version yet. Edits made close together can share one version, and the newest edit may not be in one; when it is not, `diff_from_latest_version` shows what is newer. Under `blame`, such lines have `version: null`.
- `unrendered` — any node type in a snapshot this server cannot render as markdown. Its text is kept, so a diff near it can show formatting that did not change.

### `list_issues`

Every ticket matching the filters, in one call. The server pages through Linear to the end, so there is no cursor to stop following: the answer holds `total`, `by_state` (a count per workflow state), and one row per ticket under `columns` (identifier, title, state, assignee, delegate, `updatedAt`). There are no description excerpts; read a ticket with `get_issue` before acting on it.

A failed page is refused outright rather than answered with part of the set, and so is a set of more than 2,000 tickets, with the filters to narrow it by.

| Argument | Required | |
|---|---|---|
| `query` | | Full-text search |
| `team` | | Team key |
| `state` | | State name |
| `assignee_is_me`, `delegate_is_me` | | Boolean filters |
| `cycle` | | Cycle number within `team` (required with it) |
| `project` | | Project name or id |
| `open` | | Only tickets not in a completed or canceled state |

### `list_teams`

Every team with its key and workflow states in board order. The state names are what `set_status` takes. No arguments.

### `list_cycles`

Cycles, earliest first.

| Argument | Required | |
|---|---|---|
| `team` | | Team key; omit for every team |
| `when` | | `current` (active and next, the default), `upcoming`, `past` or `all` |

### `list_projects`

Projects with status, lead, teams, dates, progress and health.

| Argument | Required | |
|---|---|---|
| `team` | | Team key |
| `include_closed` | | Include completed and canceled projects |

### `list_initiatives`

Initiatives with status, owner, target date and health. `include_closed` adds completed ones.

These four lists walk every page. Anything not fetched, including a nested list cut short, is named in `omitted`.

## Notifications

### `notifications`

Your inbox, newest first, as pointers: notification id, type, time, whether it is read, the actor and whether they are an agent or a person, and the ticket. Linear's title and subtitle are excerpts, so they are left out; read the ticket with `get_issue`. Snoozed notifications are not unread until the snooze ends. Unread-only reads at most 10 pages per call, and stops once it has every unread notification Linear counts; `next_cursor` continues.

| Argument | Required | |
|---|---|---|
| `unread_only` | | Default true |
| `since` | | Only notifications created on or after this date |
| `first` | | How many to return, 1–100, default 50 |
| `after` | | `next_cursor` from the previous call |

When `has_more` is true, pass `next_cursor` as `after`. If a later page fails, the call returns what it has with `stopped_early` and a cursor that resumes at the failed page.

### `get_principal_notifications`

The inbox of the human this identity acts for, not the identity's own — same arguments and shape as `notifications`, a deliberately separate tool rather than a parameter, so which inbox a call reads is never ambiguous. Needs `LINEAR_PRINCIPAL_TOKEN` and `LINEAR_PRINCIPAL_ID` set in the server's environment; refuses if either is missing, and refuses if the token resolves to a different Linear user than `LINEAR_PRINCIPAL_ID` names. `mark_principal_notifications_read` is its write twin.

| Argument | Required | |
|---|---|---|
| `unread_only` | | Default true |
| `since` | | Only notifications created on or after this date |
| `first` | | How many to return, 1–100, default 50 |
| `after` | | `next_cursor` from the previous call |

### `mark_principal_notifications_read`

Marks notifications in the principal's inbox read. Only notifications `get_principal_notifications` returned in this server process can be marked; any other id is refused in its own result. The principal token can write anything its human can, and this list is what narrows it to marking read what an agent was shown. Pass `ids`, or `only_agent_actors: true` to mark every unread one whose actor is an agent or integration, optionally only those created before `before`. A principal token without write access is refused with a message saying so, rather than Linear's scope error.

| Argument | Required | |
|---|---|---|
| `ids` | one of | Ids from `get_principal_notifications` |
| `only_agent_actors` | one of | `true`: every unread one an agent or integration caused |
| `before` | | With `only_agent_actors`, only those created before this date |

### `mark_notifications_read`

| Argument | Required | |
|---|---|---|
| `ids` | yes | Notification ids from `notifications` |

Each id is reported separately; one failure does not stop the rest.

## Claiming

### `claim`

Takes the ticket and records its description as it stands. An agent (app) identity becomes the delegate, whether or not a person is assignee, following Linear's delegation model. A person's key becomes the assignee. Refuses a ticket assigned or delegated to another agent. Claiming again is how you acknowledge a changed description.

| Argument | Required | |
|---|---|---|
| `issue` | yes | |
| `as` | | `assignee` or `delegate`, overriding the automatic choice |
| `take_over` | | Take the assignment from the person who holds it, only when they handed it to you |

### `check_claim`

Whether the description changed since your claim, with a line diff. Run it before opening or merging a PR.

| Argument | Required | |
|---|---|---|
| `issue` | yes | |

## Writing

### `set_state`

Patches named sections of the description (`Observed`, `Cause`, `Fix`, `Done when`), moves the reconciled marker, or both. A patch can also set `Impact`, the one plain-language line at the top of the description saying who notices the work; it takes mode `replace` and a single line, and replaces any `Impact:` line already there. `Observed` lines must read `YYYY-MM-DD · source · result`, optionally with a time after the date; `Done when` lines must be checklist items. `Open questions` changes only through `comment`.

| Argument | Required | |
|---|---|---|
| `issue` | yes | |
| `base` | yes | `description_sha` of the description the patch was written against, from `get_issue` or your last write's result |
| `patch` | | List of `{ section, mode: "append" \| "replace", body }` |
| `reconciled_through` | | Comment id the description now accounts for |
| `accounts_for` | | With `reconciled_through`: `{ comment, how, reason? }` for each comment the marker moves past |
| `descope_reason` | | Why an unticked `Done when` item no longer applies. Needed when the patch removes or rewords one |
| `descope_risk` | | With `descope_reason`: what stops being checked if the person approves, and what could get through because of it |
| `sign_off` | | The token from a refusal that asked the agent to put a sign-off question to its user; the retry passes it after they answer |

The form shows `descope_reason` and `descope_risk` on one line each, so each is refused past 100 characters.

At least one of `patch` or `reconciled_through` is needed.

Every write tool (`claim`, `set_state`, `comment`, `set_fields`, `set_status`) refuses a ticket carrying a hands-off label (`no-agents` unless `LINEAR_STRICT_HANDS_OFF_LABELS` says otherwise). Reading it still works.

The reconciled marker only moves past comments that are accounted for. A typed comment that already changed the description (correction, answer, closed_by, ask) counts on its own. Every other comment needs an `accounts_for` entry: `folded`, which needs a patch in the same call, or `no_state_change` with a reason. `{ comment: "*" }` covers every comment not named. A comment the previous marker covered that has been edited since needs accounting again, so `reconciled_through` may name the comment the marker already names. The marker records when this check ran (`checked`). It is stored in an attachment on the ticket; if that write fails after the description was written, the call says so and the patches stand. A description write that doesn't move the marker still updates its hash, and reports `marker_warning` if it couldn't. The result lists the comments marked as changing nothing, and flags those written by people for review.

Removing or rewording an unticked `Done when` item removes a check before it has passed, so it needs `descope_reason`, `descope_risk` and a yes from someone other than the agent.

With `LINEAR_STRICT_SIGN_OFF=judge`, a model decides instead of the person: it reads the description, the change, the reason and the risk, and approves only when the description backs the reason. The descope comment names the model and gives its reason; a decline comes back with what evidence would change it.

In Claude Code with the sign-off hooks installed (`linear-strict install`), the first `set_state` is refused with an `AskUserQuestion` call for the agent to make, whose `Accept` preview shows the ticket, each check and its replacement, the reason and the risk. The question ends with a token. A PreToolUse hook refuses the question unless it is exactly as issued; a PostToolUse hook records the option picked, the preview shown and any note. The agent then retries the same `set_state` with `sign_off: <token>`, and the server approves from the record: `Accept` approves, `Decline` or anything typed under Other declines with the text passed back. A token is single-use and only approves the change it was issued for.

Otherwise the server asks through MCP elicitation, a form the model cannot answer. Its one line says what is being asked. The rows under it carry the substance, each a short fixed label with the text beneath, and text longer than 90 characters continues on `↳` rows so the client's cut at about 100 never hides any of it: `Ticket` (its title), `Check today` (the item as it stands), `Becomes` (its replacement, noting if it is already ticked, or that nothing replaces it), `Why the agent wants it` (`descope_reason`), `If you accept` (`descope_risk`), and `Your note`. Accept approves the change as shown; there is nothing to tick. Every row is an optional text field, so the person can write what should differ and press Decline, or add a note to an approval. Ticking an item doesn't count as removing it. Once approved, the patch lands and a `descope` comment records the dropped items, the reason, the risk and any note. The server waits 30 minutes for an answer; Claude Code leaves the form up after that, and an answer then reaches nothing. A refusal tells the agent what the person wrote and what the client sent back (the action and the fields' types), so a request that didn't land can be told apart from a no. If the client can't show the form, the patch is refused and a person has to make the edit in Linear; their edit is the sign-off. A `comment` patch that drops an item is refused and pointed here.

A write whose `base` is not the current description is refused, and nothing is written. When this server returned the older text, the refusal shows what changed since. A write returns the new `description_sha`, so a second patch doesn't need another read. Every description write also reads the ticket again just before writing, and refuses with a diff if another writer changed it in between. Linear has no conditional update, so a change that lands between that re-read and the write can still be overwritten.

A write that ticks a `Done when` item without a citation still lands, and the result names it under `uncited_ticks` with a note that Done will refuse it until it cites its evidence. A `comment` with a patch reports the same.

### `comment`

A typed comment, headed `🤖 <author> · <date> · <kind>`. The server writes the header from `kind`, so `body` holds only the content. A header typed at the top of `body` is dropped, even one naming another kind, as is a `Description updated` line typed at the end when the call carries a patch. An `author_label` that is a whole header keeps only the name.

| Kind | Required with it | Effect on the description |
|---|---|---|
| `evidence` | | Optional `patch`, usually an `Observed` line |
| `correction` | `patch` | The patch that makes the description say the corrected thing |
| `ask` | | Adds an `OPEN` row under `Open questions`; `ask_to` names who should answer. When it names one member of the workspace, the comment mentions them by profile link, which notifies them; `ask_to_mentioned` says whether it did |
| `answer` | `answers` (e.g. `Q3`) | Flips that row to `ANSWERED` with a link to this comment |
| `closed_by` | `closed_by`, `relation` | Sets the Linear relation (`duplicate` or `fixed_there`) and records it under `Fix` |

Other arguments: `issue`, `kind` and `body` (required); `base`, required with `patch`, as for `set_state`; and `author_label`, the agent name shown when writing with a personal key.

### `set_status`

Moves the ticket to a workflow state by name. A completed state needs a `Done when` section with every item ticked and cited, your claim, and a description unchanged since the claim. If it changed, the refusal carries the diff; if items are open or uncited, it lists them. Tick an item with `set_state` once its check has run, citing what showed it after the item's text: `- [x] <item> · <evidence>`, where evidence is a commit SHA, a PR (`#123`), a `file:line`, a link, a CI run, `Observed 2` for a line already under Observed, or `` `command` → result ``. A cited PR that is linked to the ticket must be merged; one linked elsewhere can't be checked and passes. When linked PRs have merged and every one of them went into a branch other than the main one (`LINEAR_STRICT_MAIN_BRANCH`, default `main`), the move is refused: merged work waiting to ship belongs in a state that isn't completed, and work that reached main through a PR not linked here needs that PR linked with `set_fields` `link_prs`. A linked release, or a merged PR with no recorded target branch, skips this check. An item that no longer applies is dropped through `set_state` with `descope_reason`. The claim is cleared when the ticket completes. The call takes no evidence of its own, so write it into the description with `set_state` first; that is where this check, and any close-gate hook a project puts on this tool, can read it.

| Argument | Required | |
|---|---|---|
| `issue` | yes | |
| `state` | yes | State name, e.g. `Done` |
| `reason` | | Why the work stops. Required for a canceled state, which skips the Done checks; posted as a comment |

A cited PR whose merge status Linear's GitHub integration didn't record passes, and the result names it under `unchecked_prs`. If the linked PRs couldn't be read, the main-branch check is skipped and `unchecked_branch` says so.

### `set_fields`

Changes the fields that are not the ticket's content: title, priority (0 none to 4 low), assignee or delegate, labels, cycle, project, milestone, parent, due date, estimate, relations, and linked pull requests. The description goes through `set_state` and the workflow state through `set_status`; neither can be set here.

Names resolve to ids before anything is written: a user by name, display name, email or `"me"`; labels on the ticket's team or the workspace (not created here); a cycle by number, `"current"` or `"next"`; a project by name or id; a milestone in the ticket's project. Anything unknown or ambiguous refuses the whole call. `null` clears a field.

Changing a person's assignment needs `take_over: true`. A ticket assigned to another agent, or delegated to someone else, is refused. Relations are added after the field update: `related_to`, `blocks`, and `blocked_by` each take issue identifiers. `link_prs` takes GitHub pull request URLs and links each to the ticket, after the relations. Linear's GitHub integration records where each PR merged, and the result's `prs_linked` gives the target branch when Linear already knows it. A URL that isn't a pull request refuses the whole call before anything is written.

### `create_issue`

Creates a ticket whose description is built from validated sections.

A ticket needs a home: `parent` or `project_id`. A sub-ticket goes in its parent's project unless `project_id` says otherwise (the result's `project` names it), when that project is open and on the same team. Otherwise it is refused, so every ticket shows in a project's reports. Each refusal lists the team's open projects with their ids: up to three closest to the ticket's text first (Linear's semantic search, labelled a hint), then the rest, under way first. One for a parent with no usable project suggests the project the parent's own parent is in, or the one most of its open sub-tickets are in, saying so when only closed ones point there. On a team with no open projects the rule steps aside, and `home_note` says so. Without a parent, the server finds the team's open tickets the new one overlaps, and refuses while any of them is unaccounted for. With a judge key set (`linear-strict auth judge-key set`, or `ANTHROPIC_API_KEY`), a model reads every open ticket's title on the team, with the new ticket's title and description, and names them, up to eight, each with the work the two share (`why` on each candidate). The model is told a shared product, vendor or model name is not overlap on its own. Without a key, or when that call fails (`overlap_note` says so), Linear's searches find them: five by meaning (`semanticSearch`) and up to three more by keyword (`searchIssues` on the title). The refusal lists them and the three ways forward: file under one with `parent`, widen one instead and file nothing, or retry with `new_because` and every one of them in `distinct_from`. The reason is posted on the new ticket as a "filed new" comment, and the result's `filed_new` links it. If one search fails the other's tickets still count; if both fail, the ticket is filed and `overlap_unchecked` says why.

The result also has `your_unclaimed`: the tickets this identity filed on the team that are still in Triage, Todo or Backlog with no delegate. It gives `total` (counted to 200), `older_than_7_days`, and the ten oldest as rows of identifier, title, state and age in days.

| Argument | Required | |
|---|---|---|
| `team` | yes | Team key |
| `title` | yes | |
| `sections` | | Object keyed by section name |
| `parent` | one of these | The ticket this work is part of; skips the search |
| `project_id` | one of these | |
| `new_because` | | Why the work is none of the close tickets, at most 300 characters |
| `distinct_from` | with `new_because` | Each close ticket's identifier |

### `whoami`

The Linear user or app the token belongs to: `id`, `name`, `displayName`, and `app` (true for an agent identity). Claims, `assignee_is_me` and `delegate_is_me` all mean this identity. Takes no arguments.
