# Notebook Agent API (P1)

Base path: `/api/agent`. Use the existing authenticated login session. PATs are denied. Supply `?workspaceId=personal` (or omit it) for personal scope; supply the actual workspace ID for a workspace. The query scope must match the owned run on every operation. No API token or approval token belongs in a URL.

| Method/path | Contract |
| --- | --- |
| `GET /capabilities` | Existing Agent switch and observed model capability evidence; `unverified` is not a promise of support |
| `GET /workflows` | Up to 30 newest accessible workflows belonging to the current user/query workspace; metadata only |
| `POST /workflows` | Strict input below; `202 {id}` starts asynchronous search/proposal execution |
| `GET /workflows/:id` | Current status, ordered steps, action results, readable sources and optional live preview |
| `POST /workflows/:id/approve` | Strict `{token}` with the 64-character live preview token; revalidates and consumes approval, then commits actions |
| `POST /workflows/:id/tasks` | Strict `{token,tasks}` revises existing task drafts only, validates selected tasks and returns a fresh approval token; no business writes |
| `POST /workflows/:id/retry` | Requires failed/partial run with live draft and unfinished action; returns a fresh preview/token, performs no business write |
| `POST /workflows/:id/cancel` | Stops future work; already committed actions remain and are reported |
| `POST /workflows/:id/reject` | Same cancellation semantics for a rejected proposal |

Create input:

```json
{
  "notebookId": "selected-notebook-id",
  "includeChildren": true,
  "instruction": "Summarize these notes, create a summary note and draft the next actions.",
  "timezone": "Asia/Shanghai",
  "lang": "en"
}
```

`lang` is `en` or `zh-CN` (default). `includeChildren` defaults to true. `timezone` must be a valid IANA timezone. Optional `linkNoteId` must be a readable, unprotected note inside the selected scope. If the plan also creates a note, tasks link to that new note instead. Unknown fields, including execute/permission overrides, are rejected. Workflow POST bodies are bounded at 64 KB.

## Batch orchestration (map-reduce)

`POST /api/agent/batches` starts a durable read-only batch job over a notebook scope: readable notes are enumerated server-side (protected notes excluded), summarized in batches of at most 10 notes (each note capped at 6,000 plain-text characters), then reduced into a proposal draft `{summary, note:{title,content}}` persisted in `agent_workflow_batches.proposalJson`. Progress (`completedThrough`) persists per batch, so `POST /api/agent/batches/:id/resume` continues a failed job from its breakpoint without re-running completed batches. One active job per user. Limits: 40 batches (400 notes), 2,000-character batch summaries, 30,000-character reduce context, 90-second per-call timeout. PATs are denied; the same session, ACL and protected-content checks as workflows apply.

Approval closes the loop with the same policy as workflow approvals: completing a job issues a one-use 64-character token (returned as `approvalToken` by `GET /api/agent/batches/:id` while valid, 30-minute expiry, only the digest is stored). `POST /api/agent/batches/:id/approve` with `{token}` rechecks the payload binding, notebook write permission and protected scope, then creates the summary note through the shared workflow write path (blocks, links, Yjs, Outbox and the durable `noteId` result commit in one transaction, DCC-002; status becomes `applied`). An expired approval rotates explicitly through `POST /api/agent/batches/:id/reissue`, which never changes the proposal. Forged, replayed or cross-user tokens fail closed without writes. `aiContentLabels: "v1"` marks the created note with AI provenance.

Run details contain `id`, `notebookId`, `workspaceId`, `status`, timestamps and `errorCode`; `steps: [{sequence,toolName,status}]`; `actions: [{kind,status,resourceIds,errorCode}]`; and `sources: [{id,title,version}]`. `kind` is `note` or `tasks`. `resourceIds` are only recorded as successful inside the same transaction as the business write.

The optional ten-minute in-memory `preview` contains `summary`, `sources`, `contextTruncated`, `linkNoteId`, optional `note: {title,content}` and the existing task composer preview (`previewId`, `timezone`, drafts, warnings). Only `waiting_approval` exposes a token. Source hashes, stored approval hashes, raw provider responses and credentials are never returned. There is no P1 SSE endpoint; clients poll GET without re-executing tools.

Task review requires `waiting_approval`, an unexpired current token and an unfinished task action. Submit every original `clientId` exactly once, together with `selected`, `title`, `description`, `priority`, `startDate`, `dueDate`, `dueAt`, `repeatRule`, `repeatInterval`, `repeatEndDate` and `repeatEndCount`. Dates retain the task composer's local wall-time convention. New/foreign IDs, missing/duplicate IDs, unknown fields, project/scope overrides and `allowDuplicate` are rejected. Source, session, scope, template and tool permissions are rechecked. Selected tasks reuse composer title/date/recurrence/project/duplicate validation; invalid selected fields return `INVALID_TASK_INPUT` or the existing composer error. An excluded task may have an empty title and never reaches batch creation. All drafts can be excluded; approval then records an empty task result without creating a composer batch, while other displayed actions retain their normal approval rules.

A successful review replaces only the ephemeral task draft and approval binding. It does not call the model, reset the original ten-minute session lifetime, change the note/extension proposal or create resources. The old token cannot review or approve again. A failed validation preserves the previous preview/token. Clients disable approval during local edits and explicitly review the returned preview before approval. If a review response is lost, reconcile by GET rather than replaying the mutation. Completed task actions cannot be revised; failed task actions may be reviewed after the existing explicit retry issues a new token.

Errors use `{code,error}`. HTTP errors include `INVALID_INPUT`, `AGENT_SESSION_REQUIRED`, `NOTE_ACCESS_DENIED`, `PROTECTED_DOCUMENT`, `AGENT_DISABLED`, `AI_NOT_CONFIGURED`, `RUN_NOT_FOUND`, `RUN_ALREADY_ACTIVE`, `VERSION_CONFLICT`, `APPROVAL_INVALID`, `APPROVAL_EXPIRED` and `RETRY_UNAVAILABLE`. Asynchronous failures appear in `errorCode`, such as `MODEL_TIMEOUT`, `TOOL_CALLING_UNSUPPORTED`, `INVALID_TOOL_ARGUMENTS`, `TOOL_NOT_ALLOWED`, `REPEATED_TOOL_CALL`, `SCOPE_TOO_LARGE`, `CONTEXT_BUDGET_EXHAUSTED`, task-composer validation errors or `WRITE_FAILED`. Failed actions do not imply prior successful actions rolled back. A run never hard-fails merely because the context budget is full: the tool result is clipped and the model is told to propose from the evidence already retrieved.

Never automatically replay a mutation after an uncertain response. Read the run and inspect `actions` first. A fresh retry token does not authorize repeating completed actions. After backend restart, a draft/token cannot be resumed; only metadata and committed result IDs remain. `completed` confirms current-server commits, not another device's persistence. See [architecture](../architecture/agent-p1-notebook-workflows.md) for limits, storage and DCC boundaries.
