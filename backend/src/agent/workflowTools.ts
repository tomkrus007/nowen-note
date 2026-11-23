import { z } from "zod";
import type { ToolDefinition } from "./model.js";

export const workflowInput = z.object({
  aiContentLabels: z.literal("v1").optional(),
  templateId: z.string().uuid().optional(),
  templateRevision: z.string().uuid().optional(),
  notebookId: z.string().min(1).max(128), includeChildren: z.boolean().default(true),
  instruction: z.string().trim().min(1).max(4000),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  lang: z.enum(["zh-CN", "en"]).default("zh-CN"),
  linkNoteId: z.string().min(1).max(128).optional(),
}).strict();
export const workflowPlan = z.object({
  summary: z.string().trim().min(1).max(16000),
  sourceNoteIds: z.array(z.string().min(1).max(128)).max(10),
  note: z.object({ title: z.string().trim().min(1).max(200), content: z.string().min(1).max(48000) }).strict().optional(),
  taskRequest: z.string().trim().min(1).max(4000).optional(),
  extensionCalls: z.array(z.object({ toolId: z.string().max(256), input: z.record(z.unknown()) }).strict()).max(3).optional(),
}).strict();
const navigationToolProperties = {
  // Bounded file-style navigation over the fixed server-authorized scope.
  // Metadata first; bodies are only returned in bounded slices by read_note.
  list_notes: { type: "object", properties: {
    cursor: { type: "string", maxLength: 128, description: "Pagination cursor from a previous list_notes result; omit for the first page" },
    limit: { type: "number", minimum: 1, maximum: 100 },
  }, additionalProperties: false },
  read_note: { type: "object", properties: {
    noteId: { type: "string", maxLength: 128 },
    offset: { type: "number", minimum: 0, maximum: 1000000, description: "Character offset from a previous read_note result; default 0" },
    limit: { type: "number", minimum: 1, maximum: 8000 },
  }, required: ["noteId"], additionalProperties: false },
  grep_notes: { type: "object", properties: {
    pattern: { type: "string", minLength: 1, maxLength: 200, description: "Literal substring to find in note plain text" },
    limit: { type: "number", minimum: 1, maximum: 30 },
  }, required: ["pattern"], additionalProperties: false },
} as const;
export const workflowTools: ToolDefinition[] = [
  { type: "function", function: { name: "search_notebook", description: "Semantic/keyword search of the user-selected notebook scope. Returns bounded untrusted note context and source IDs. For large scopes, prefer list_notes/grep_notes/read_note to navigate incrementally instead of issuing broad searches.", parameters: { type: "object", properties: { query: { type: "string", maxLength: 1000 } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "list_notes", description: "List note metadata (id, title, notebook, size, updatedAt) inside the fixed notebook scope. Bodies are never returned. Use this first to enumerate a directory before reading selected notes.", parameters: navigationToolProperties.list_notes } },
  { type: "function", function: { name: "read_note", description: "Read one bounded slice of a note's plain text (default 4000 chars). Use offset/nextOffset to continue reading long documents. Protected notes are rejected.", parameters: navigationToolProperties.read_note } },
  { type: "function", function: { name: "grep_notes", description: "Find notes in the scope whose plain text contains a literal substring. Returns matching line snippets with note IDs; no full bodies.", parameters: navigationToolProperties.grep_notes } },
  { type: "function", function: { name: "propose_workflow", description: "Finish with a cited summary and optional new Markdown note and/or task request. No writes occur. taskRequest is passed to the existing task composer. Human approval is required for all writes.", parameters: {
    type: "object", properties: {
      summary: { type: "string", maxLength: 16000 }, sourceNoteIds: { type: "array", items: { type: "string" }, maxItems: 10 },
      note: { type: "object", properties: { title: { type: "string", maxLength: 200 }, content: { type: "string", maxLength: 48000 } }, required: ["title", "content"], additionalProperties: false },
      taskRequest: { type: "string", maxLength: 4000 },
      extensionCalls: { type: "array", maxItems: 3, items: { type: "object", properties: { toolId: { type: "string" }, input: { type: "object" } }, required: ["toolId", "input"], additionalProperties: false } },
    }, required: ["summary", "sourceNoteIds"], additionalProperties: false,
  } } },
];
