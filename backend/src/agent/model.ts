import { createHash } from "node:crypto";
import { z } from "zod";
import { aiOutboundFetch } from "../services/ai-outbound-fetch.js";
import type { AISettings } from "../services/ai-client.js";
import { buildAIHeaders, hasAIAuth } from "../services/ai-provider-config.js";
import { resolveUserChatSettings } from "../services/user-chat-settings.js";
import { requestRemoteSharedChat } from "../services/remote-shared-ai.js";
import { redactSharedAIResponse } from "../services/shared-ai-response.js";

const evidence = new Map<string, { toolCalling: boolean; streaming: boolean; checkedAt: number }>();
const configurationKey = (settings: AISettings) => createHash("sha256").update(JSON.stringify(settings)).digest("hex");
export function agentModelCapabilities(settings: AISettings) {
  if (settings.ai_provider === "anthropic" && !settings.ai_remote_shared) return { chat: true, toolCalling: false, streaming: true, structuredOutput: "unverified", embedding: false, vision: "unverified", reasoning: "unverified", contextWindow: null };
  const observed = evidence.get(configurationKey(settings));
  return { chat: true, toolCalling: observed && Date.now() - observed.checkedAt < 3600000 ? observed.toolCalling : "unverified", streaming: observed?.streaming ?? "unverified", structuredOutput: "unverified", embedding: "unverified", vision: "unverified", reasoning: "unverified", contextWindow: null };
}
const callSchema = z.object({ id: z.string().min(1).max(200), type: z.literal("function"), function: z.object({ name: z.string().max(100), arguments: z.string().max(100_000) }) });
export type ToolCall = z.infer<typeof callSchema>;
export interface ToolDefinition { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }

/** Match the existing AI routes: local providers may run without an API key. */
export function agentModelConfigured(settings: AISettings): boolean {
  return Boolean(settings.ai_api_url.trim() && settings.ai_model.trim()
    && hasAIAuth(settings));
}

/** Incremental SSE parsing keeps separate indices and concatenates only protocol argument deltas. */
export async function readAgentResponse(response: Response, signal?: AbortSignal): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MODEL_REQUEST_FAILED");
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, payloadChars = 0, done = false, usage: unknown, finishReason: string | null = null;
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim();
    if (!value) return;
    if (value === "[DONE]") { done = true; return; }
    const event = JSON.parse(value);
    if (event.usage) usage = event.usage;
    const reason = event.choices?.[0]?.finish_reason;
    if (typeof reason === "string" && reason) finishReason = reason;
    for (const delta of event.choices?.[0]?.delta?.tool_calls || []) {
      if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= 12) throw new Error("INVALID_TOOL_CALL");
      const call = calls.get(delta.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (delta.id) call.id += delta.id;
      if (delta.type && delta.type !== "function") throw new Error("INVALID_TOOL_CALL");
      if (delta.function?.name) call.function.name += delta.function.name;
      if (delta.function?.arguments) { call.function.arguments += delta.function.arguments; payloadChars += delta.function.arguments.length; }
      calls.set(delta.index, call);
    }
    // Reasoning text is never returned to the model, but it still costs budget;
    // count it so runaway thinking cannot stream forever.
    const reasoning = event.choices?.[0]?.delta?.reasoning_content;
    if (typeof reasoning === "string") payloadChars += reasoning.length;
  };
  try {
    signal?.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      // Gateways inflate every SSE frame with metadata (observed ~1 KB per frame),
      // so transport bytes are a poor proxy for model output. Cap the payload and
      // keep only a generous byte ceiling as a memory guard.
      bytes += chunk.value.byteLength;
      if (bytes > 16_000_000) throw new Error("MODEL_OUTPUT_LIMIT");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (streaming) {
        let end: number;
        while (!done && (end = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, end).replace(/\r$/, "")); buffer = buffer.slice(end + 1); }
        if (done) { buffer = ""; break; }
      }
      if (payloadChars > 120_000) throw new Error("MODEL_OUTPUT_LIMIT");
    }
    buffer += decoder.decode();
    if (!streaming) {
      const payload = JSON.parse(buffer);
      if (payload?.choices?.[0]?.finish_reason === "length") throw new Error("MODEL_OUTPUT_LIMIT");
      return payload;
    }
    if (buffer.trim()) consume(buffer);
    // finish_reason is authoritative: some OpenAI-compatible gateways close the
    // stream without a trailing [DONE]. Only treat EOF as truncation when the
    // provider never reported a terminal reason.
    if (finishReason === "length") throw new Error("MODEL_OUTPUT_LIMIT");
    if (!done && !finishReason) throw new Error("STREAM_INTERRUPTED");
    return { choices: [{ message: { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) } }], usage };
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error("MODEL_TIMEOUT"), { code: "MODEL_TIMEOUT", name: "TimeoutError" });
    throw error;
  } finally { signal?.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Separate from legacy text extraction: tool arguments are never interpreted as Markdown. */
export async function callAgentModel(settings: AISettings, messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal) {
  if (settings.shared_ai_user_id) settings = resolveUserChatSettings(settings.shared_ai_user_id);
  if (!agentModelConfigured(settings)) throw Object.assign(new Error("AI_NOT_CONFIGURED"), { code: "AI_NOT_CONFIGURED", status: 400 });
  if (settings.ai_provider === "anthropic" && !settings.ai_remote_shared) throw new Error("TOOL_CALLING_UNSUPPORTED");
  // DeepSeek rejects required tool_choice in thinking mode. Match the model name
  // too: gateways commonly proxy DeepSeek under a custom OpenAI-compatible URL.
  const host = new URL(settings.ai_api_url).hostname;
  const deepseek = settings.ai_provider === "deepseek" || host === "api.deepseek.com" || /deepseek/i.test(settings.ai_model);
  const bailian = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(host) || host.endsWith(".maas.aliyuncs.com");
  const deadline = new AbortController();
  const abort = () => deadline.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => deadline.abort(new DOMException("Model deadline exceeded", "TimeoutError")), 45_000);
  const requestSignal = deadline.signal;
  try {
    const providerExtras: Record<string, unknown> = bailian ? { enable_thinking: false } : deepseek ? { thinking: { type: "disabled" } } : {};
    const requestOnce = (extras: Record<string, unknown>) => settings.ai_remote_shared
      ? requestRemoteSharedChat(settings, { messages, tools, tool_choice: "required", stream: true, max_tokens: 4096 }, requestSignal)
      : aiOutboundFetch(`${settings.ai_api_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: buildAIHeaders(settings.ai_provider, settings.ai_api_key, settings.ai_custom_headers),
      body: JSON.stringify({ model: settings.ai_model, messages, tools, tool_choice: "required", stream: true, max_tokens: 4096, ...extras }),
      signal: requestSignal,
      redirect: "error",
    });
    let rawResponse = await requestOnce(providerExtras);
    // A gateway that rejects the provider-specific thinking switch must not turn
    // into TOOL_CALLING_UNSUPPORTED; retry once with the plain OpenAI body.
    if (!rawResponse.ok && !settings.ai_remote_shared && Object.keys(providerExtras).length
      && (rawResponse.status === 400 || rawResponse.status === 422)) {
      void rawResponse.body?.cancel().catch(() => undefined);
      rawResponse = await requestOnce({});
    }
    if (!rawResponse.ok) { void rawResponse.body?.cancel().catch(() => undefined); throw new Error(rawResponse.status === 400 || rawResponse.status === 422 ? "TOOL_CALLING_UNSUPPORTED" : "MODEL_REQUEST_FAILED"); }
    const response = settings.shared_ai_user_id && !settings.ai_remote_shared ? await redactSharedAIResponse(rawResponse, settings) : rawResponse;
    const data = await readAgentResponse(response, requestSignal);
    const calls = z.array(callSchema).min(1).max(12).safeParse(data?.choices?.[0]?.message?.tool_calls);
    if (evidence.size >= 256) evidence.delete(evidence.keys().next().value!);
    evidence.set(configurationKey(settings), { toolCalling: calls.success, streaming: response.headers.get("content-type")?.includes("text/event-stream") || false, checkedAt: Date.now() });
    if (!calls.success) throw new Error("TOOL_CALLING_UNSUPPORTED");
    if (new Set(calls.data.map(c => c.id)).size !== calls.data.length) throw new Error("INVALID_TOOL_CALL");
    return { calls: calls.data, usage: Number.isSafeInteger(data.usage?.total_tokens) && data.usage.total_tokens >= 0 ? data.usage.total_tokens : null };
  } catch (error) {
    if (requestSignal.aborted) throw Object.assign(new Error("MODEL_TIMEOUT"), { code: "MODEL_TIMEOUT", name: "TimeoutError" });
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
