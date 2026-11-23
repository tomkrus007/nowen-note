import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AgentWorkflowBatchRuntime } from "../src/agent/workflowBatch.js";

let BatchRuntime: typeof import("../src/agent/workflowBatch.js").AgentWorkflowBatchRuntime;
let db: ReturnType<typeof import("../src/db/schema.js").getDb>;
let closeDb: () => void;
let runtime: AgentWorkflowBatchRuntime;
let app: Hono;
let originalFetch: typeof fetch;
const userId = "batch-a";
const headers = { "Content-Type": "application/json", "X-User-Id": userId };
const other = "batch-b";
const input = (patch = {}) => ({ notebookId: "batch-book", includeChildren: true, instruction: "Summarize this notebook", timezone: "Asia/Shanghai", lang: "en" as const, ...patch });

/** Fetch mock: any chat request returns a deterministic JSON text reply. */
let chatReply: (messages: any[]) => string;

async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = runtime.get(userId, id);
    if (!["running", "summarizing"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Batch job did not settle");
}

test.before(async () => {
  const schema = await import("../src/db/schema.js"); db = schema.getDb(); closeDb = schema.closeDb;
  BatchRuntime = (await import("../src/agent/workflowBatch.js")).AgentWorkflowBatchRuntime;
  for (const id of [userId, other]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,?)").run(id, id, "hash");
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('batch-book',?,'Batch'),('batch-other',?,'Private')").run(userId, other);
  db.prepare("INSERT INTO notebooks(id,userId,name,parentId) VALUES ('batch-child',?,'Child','batch-book')").run(userId);
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content,contentText,contentFormat) VALUES ('batch-n1',?,'batch-book','One','One evidence alpha','One evidence alpha','markdown'),('batch-n2',?,'batch-book','Two','Two evidence beta','Two evidence beta','markdown'),('batch-n3',?,'batch-child','Three','Three evidence gamma','Three evidence gamma','markdown'),('batch-secret',?,'batch-other','Private','PRIVATE_BATCH_SENTINEL','PRIVATE_BATCH_SENTINEL','markdown')").run(userId, userId, userId, other);
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISettings(userId, [{ key: "ai_api_url", value: "https://batch.example/v1" }, { key: "ai_api_key", value: "test-key" }, { key: "ai_model", value: "batch-model" }]);
  app = new Hono().route("/api/agent", (await import("../src/routes/agent.js")).default);
  originalFetch = globalThis.fetch;
});

test.beforeEach(() => {
  db.exec("DELETE FROM agent_workflow_batches;");
  runtime = new BatchRuntime();
  chatReply = (messages: any[]) => {
    const text = messages.map((m: any) => m.content).join("\n");
    if (text.includes("synthesis agent")) return JSON.stringify({ summary: "Overall summary", note: { title: "Notebook digest", content: "# Notebook digest\n\nOne, two and three." } });
    return "Batch summary text";
  };
  globalThis.fetch = (async (_url: unknown, init: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content: chatReply(JSON.parse(String(init.body)).messages) } }] }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
});

test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => closeDb());

test("batch job enumerates readable scope, summarizes per batch and persists a proposal draft without writes", async () => {
  const notes = count("notes");
  const { id } = runtime.start(userId, null, input());
  const job = await settled(id);
  assert.equal(job.status, "completed");
  assert.equal(job.noteIds.length, 3);
  assert.ok(!job.noteIds.includes("batch-secret"));
  assert.ok(job.batchSummaries.length >= 1);
  assert.equal(job.proposal!.note.title, "Notebook digest");
  assert.equal(count("notes"), notes); // no business writes without approval
  // Protected notes are excluded from enumeration.
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='batch-n1'").run();
  const second = runtime.start(userId, null, input());
  const job2 = await settled(second.id);
  assert.ok(!job2.noteIds.includes("batch-n1"));
  db.prepare("UPDATE notes SET isLocked=0 WHERE id='batch-n1'").run();
});

test("batch scope and ownership are enforced; foreign users cannot read or resume", async () => {
  assert.throws(() => runtime.start(userId, null, input({ notebookId: "batch-other" })), /NOTE_ACCESS_DENIED/);
  const { id } = runtime.start(userId, null, input());
  await settled(id);
  assert.throws(() => runtime.get(id, other), /RUN_NOT_FOUND/);
  assert.throws(() => runtime.resume(userId, id), /RETRY_UNAVAILABLE/);
  assert.throws(() => runtime.get("missing", userId), /RUN_NOT_FOUND/);
});

test("empty scope is rejected and one active job per user", async () => {
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('batch-empty',?,'Empty')").run(userId);
  assert.throws(() => runtime.start(userId, null, input({ notebookId: "batch-empty" })), /INVALID_INPUT/);
  db.exec("DELETE FROM agent_workflow_batches;");
  const slow = { id: "" };
  const original = chatReply;
  chatReply = () => new Promise(() => {}) as unknown as string; // hang the model call
  slow.id = runtime.start(userId, null, input()).id;
  assert.throws(() => runtime.start(userId, null, input()), /RUN_ALREADY_ACTIVE/);
  runtime.cancel(userId, slow.id);
  const cancelled = runtime.get(userId, slow.id);
  assert.equal(cancelled.status, "cancelled");
  chatReply = original;
});

test("failed batches resume from the persisted breakpoint instead of restarting", async () => {
  const { id } = runtime.start(userId, null, input());
  let job = await settled(id);
  assert.equal(job.status, "completed");
  // Simulate a partial-failure restart: rewind progress, mark failed, resume.
  db.prepare("UPDATE agent_workflow_batches SET completedThrough=0,status='failed',errorCode='AGENT_INTERNAL_ERROR',proposalJson=NULL WHERE id=?").run(id);
  const resumed = runtime.resume(userId, id);
  assert.equal(resumed.resumed, true);
  job = await settled(id);
  assert.equal(job.status, "completed");
  assert.ok(job.proposal);
});

test("API routes enforce sessions, strict input and PAT denial", async () => {
  const send = (path: string, body: unknown, patch = {}) => app.request(`/api/agent${path}`, { method: "POST", headers: { ...headers, ...patch }, body: JSON.stringify(body) });
  assert.equal((await send("/batches", input(), { "X-Auth-Mode": "api-token" })).status, 403);
  assert.equal((await send("/batches", { ...input(), execute: true })).status, 400);
  const start = await send("/batches", input());
  assert.equal(start.status, 202);
  const { id } = await start.json();
  const job = await settled(id);
  const read = await app.request(`/api/agent/batches/${id}`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).proposal.note.title, "Notebook digest");
  const listed = await app.request(`/api/agent/batches`, { headers });
  assert.equal((await listed.json()).some((item: any) => item.id === id), true);
  assert.equal((await app.request(`/api/agent/batches/${id}`, { headers: { ...headers, "X-User-Id": other } })).status, 404);
  void job;
});

test("approval creates the summary note exactly once through the shared write path", async () => {
  const notes = count("notes");
  const { id } = runtime.start(userId, null, input({ aiContentLabels: "v1" }));
  const job = await settled(id);
  assert.equal(job.status, "completed");
  const token = job.approvalToken!;
  assert.ok(token && token.length === 64);
  // Forged tokens never write.
  await assert.rejects(runtime.approve(userId, id, "0".repeat(64)), /APPROVAL_INVALID|APPROVAL_EXPIRED/);
  assert.equal(count("notes"), notes);
  const applied = await runtime.approve(userId, id, token);
  assert.equal(applied.status, "applied");
  assert.ok(applied.noteId);
  const note = db.prepare("SELECT title,content,notebookId FROM notes WHERE id=?").get(applied.noteId!) as { title: string; content: string; notebookId: string };
  assert.equal(note.notebookId, "batch-book");
  assert.equal(note.title, "Notebook digest");
  assert.ok(note.content.includes("AI 生成内容")); // aiContentLabels=v1 provenance
  // Token is one-use; second approval fails closed.
  await assert.rejects(runtime.approve(userId, id, token), /APPROVAL_EXPIRED|APPROVAL_NOT_PENDING/);
  assert.equal(count("notes"), notes + 1);
});

test("expired approvals rotate through explicit reissue without changing the proposal", async () => {
  const { id } = runtime.start(userId, null, input());
  const job = await settled(id);
  db.prepare("UPDATE agent_workflow_batches SET expiresAt=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), id);
  await assert.rejects(runtime.approve(userId, id, job.approvalToken!), /APPROVAL_EXPIRED/);
  const reissued = runtime.reissue(userId, id);
  assert.ok(reissued.approvalToken && reissued.approvalToken !== job.approvalToken);
  const applied = await runtime.approve(userId, id, reissued.approvalToken!);
  assert.equal(applied.status, "applied");
  // reissue is meaningless after the note exists.
  assert.throws(() => runtime.reissue(userId, id), /APPROVAL_NOT_PENDING/);
});

test("write permission is rechecked at approval time; workspace viewers cannot create", async () => {
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('batch-w','Team',?)").run(userId);
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('batch-w',?,'owner'),('batch-w',?,'viewer')").run(userId, other);
  db.prepare("INSERT INTO notebooks(id,userId,workspaceId,name) VALUES ('batch-team-book',?,'batch-w','Team book')").run(userId);
  db.prepare("INSERT INTO notes(id,userId,workspaceId,notebookId,title,content,contentText,contentFormat) VALUES ('batch-team-n1',?,'batch-w','batch-team-book','Team','Team evidence','Team evidence','markdown')").run(userId);
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISettings(other, [{ key: "ai_api_url", value: "https://batch.example/v1" }, { key: "ai_api_key", value: "test-key" }, { key: "ai_model", value: "batch-model" }]);
  const { id } = runtime.start(userId, "batch-w", input({ notebookId: "batch-team-book" }));
  const job = await settled(id);
  // A viewer cannot approve the owner's job without write permission.
  await assert.rejects(runtime.approve(other, id, job.approvalToken!), /RUN_NOT_FOUND|NOTE_ACCESS_DENIED|APPROVAL_EXPIRED/);
  const applied = await runtime.approve(userId, id, job.approvalToken!);
  assert.equal(applied.status, "applied");
});

function count(table: string) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
