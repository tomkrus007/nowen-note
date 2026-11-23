import type { Migration } from "./migrations.impl.js";

export const agentWorkflowBatchMigration: Migration = {
  version: 146,
  name: "agent-workflow-batches",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_batches (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        notebookId TEXT NOT NULL,
        workspaceId TEXT,
        status TEXT NOT NULL,
        instruction TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'zh-CN',
        noteIds TEXT NOT NULL DEFAULT '[]',
        batchSize INTEGER NOT NULL,
        aiContentLabels TEXT,
        completedThrough INTEGER NOT NULL DEFAULT 0,
        batchErrors TEXT NOT NULL DEFAULT '[]',
        batchSummariesJson TEXT NOT NULL DEFAULT '[]',
        proposalJson TEXT,
        tokenDigest TEXT,
        payloadDigest TEXT,
        expiresAt TEXT,
        consumedAt TEXT,
        noteId TEXT,
        errorCode TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_workflow_batches_user ON agent_workflow_batches(userId, createdAt);
    `);
  },
};
