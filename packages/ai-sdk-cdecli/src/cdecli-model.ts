import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Message,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";

/**
 * Configuration for the cdecli LanguageModelV2 provider.
 *
 * Wraps `cdecli interact-agent serve` (POST /v1/agent/chat) so it can be used
 * anywhere the Vercel AI SDK accepts a `LanguageModel` — including
 * `@cdmbase/agent-kit` agents.
 */
export interface CdecliModelConfig {
  /** Base URL of a `cdecli interact-agent serve` instance. */
  endpoint: string;
  /** Bearer token for `--auth-secret` (or upstream JWT). */
  token?: string;
  /**
   * Pre-activate a cdecli skill for the session (mirrors `--skill`).
   * Skill IDs map to bundled or user-defined skill bundles in cdecli.
   */
  skill?: string;
  /** Numeric/UUID skill ID variant. */
  skillId?: string;
  /**
   * Stable cdecli session ID. When set, conversation memory persists
   * server-side across calls. When unset, a fresh ephemeral session is
   * created per call (the entire prompt is forwarded as a single message).
   */
  session?: string;
  /** Custom `fetch` (for testing / proxies). */
  fetch?: typeof fetch;
  /** Optional extra headers attached to every request. */
  headers?: Record<string, string>;
}

/**
 * Operating mode for the provider.
 *
 * - `"server"`: cdecli runs everything (system prompt, tools,
 *   connectors). Tool definitions sent by ai-sdk are ignored — the provider
 *   emits a `unsupported-setting` warning when tools are present.
 *
 * Mode `"client"` (forward tool calls back to the caller) is reserved for
 * a future cdecli `/v1/agent/chat` extension that emits structured
 * `tool_call` SSE events and accepts `tool_result` follow-ups.
 * - "local" (default): tool_call events are mapped into AI SDK tool-call
 *   content so agent-kit can execute locally registered tools.
 */
type ToolMode = "server" | "local";

interface MappedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface InternalConfig extends CdecliModelConfig {
  modelId: string;
  toolMode: ToolMode;
}

const SSE_DONE = "__cdecli_done__";

interface CdecliEvent {
  event: string;
  data: unknown;
}

/** Convert ai-sdk V2 prompt to a single textual message for cdecli's chat API. */
export function promptToCdecliMessage(prompt: LanguageModelV2Message[]): string {
  const lines: string[] = [];
  for (const msg of prompt) {
    switch (msg.role) {
      case "system":
        lines.push(`[system]\n${msg.content}`);
        break;
      case "user":
      case "assistant": {
        const role = msg.role === "user" ? "user" : "assistant";
        const text = msg.content
          .map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "reasoning") return "";
            if (part.type === "tool-call") {
              return `[tool-call ${part.toolName}(${JSON.stringify(part.input)})]`;
            }
            if (part.type === "tool-result") {
              return `[tool-result ${part.toolName} → ${JSON.stringify(part.output)}]`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) lines.push(`[${role}]\n${text}`);
        break;
      }
      case "tool": {
        const text = msg.content
          .map((part) => `[tool-result ${part.toolName} → ${JSON.stringify(part.output)}]`)
          .join("\n");
        if (text) lines.push(text);
        break;
      }
    }
  }
  return lines.join("\n\n");
}

/** Parse a single SSE event string `event: foo\ndata: {...}`. */
function parseSseEvent(block: string): CdecliEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* leave as string */
  }
  return { event, data };
}

/** Async iterator over SSE event blocks from a streaming Response body. */
async function* iterateSse(response: Response): AsyncGenerator<CdecliEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt = parseSseEvent(block);
      if (evt) yield evt;
    }
  }
  if (buffer.trim()) {
    const evt = parseSseEvent(buffer);
    if (evt) yield evt;
  }
}

function getString(data: unknown, key: string): string | undefined {
  if (data && typeof data === "object" && key in data) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function buildBody(
  options: LanguageModelV2CallOptions,
  cfg: InternalConfig,
  stream: boolean,
): Record<string, unknown> {
  return {
    session_id: cfg.session ?? generateSessionId(),
    message: promptToCdecliMessage(options.prompt),
    stream,
    model: cfg.modelId,
    skill: cfg.skill,
    skill_id: cfg.skillId,
  };
}

function buildHeaders(cfg: InternalConfig, accept: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept,
    ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    ...cfg.headers,
  };
}

function warningsFor(options: LanguageModelV2CallOptions, toolMode: ToolMode): LanguageModelV2CallWarning[] {
  const warnings: LanguageModelV2CallWarning[] = [];
  if (toolMode === "server" && options.tools && options.tools.length > 0) {
    warnings.push({
      type: "other",
      message:
        "cdecli provider runs tools server-side; client-supplied tool definitions are ignored. " +
        "Use a cdecli skill to expose connectors as tools.",
    });
  }
  if (options.toolChoice && options.toolChoice.type !== "auto") {
    warnings.push({
      type: "unsupported-setting",
      setting: "toolChoice",
      details: "cdecli always uses auto tool choice (server-side)",
    });
  }
  return warnings;
}

function generateSessionId(): string {
  return `aksdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeDetail(detail: string): string {
  // Strip leading emoji/symbol prefixes emitted by cdecli status logs.
  return detail.replace(/^[^a-zA-Z0-9_./-]+\s*/u, "").trim();
}

function mapToolCall(eventData: unknown, index: number): MappedToolCall | null {
  const name = getString(eventData, "name");
  if (!name) return null;
  const detail = getString(eventData, "detail") ?? "";
  const cleanedDetail = sanitizeDetail(detail);

  if (name === "bash_exec") {
    return {
      toolCallId: `cdecli-terminal-${index}`,
      toolName: "terminal",
      input: { command: cleanedDetail || detail },
    };
  }

  return {
    toolCallId: `cdecli-${name}-${index}`,
    toolName: name,
    input: detail ? { detail: cleanedDetail || detail } : {},
  };
}

/**
 * `LanguageModelV2` implementation that proxies inference to a
 * `cdecli interact-agent serve` instance.
 */
export class CdecliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "cdecli";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  readonly #config: InternalConfig;

  constructor(modelId: string, config: CdecliModelConfig & { toolMode?: ToolMode }) {
    if (!config.endpoint) {
      throw new Error("CdecliLanguageModel: `endpoint` is required");
    }
    this.modelId = modelId;
    this.#config = {
      ...config,
      modelId,
      toolMode: config.toolMode ?? "local",
    };
  }

  doGenerate(
    options: LanguageModelV2CallOptions,
  ): ReturnType<LanguageModelV2["doGenerate"]> {
    return this._doGenerate(options);
  }

  async _doGenerate(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    if (this.#config.toolMode === "local") {
      return this._doGenerateFromStream(options);
    }

    const fetchImpl = this.#config.fetch ?? fetch;
    const body = buildBody(options, this.#config, false);
    const url = `${this.#config.endpoint.replace(/\/$/, "")}/v1/agent/chat`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(this.#config, "application/json"),
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`cdecli /v1/agent/chat failed: ${res.status} ${errText}`);
    }
    const json = (await res.json()) as { response?: string; session_id?: string; done?: boolean };
    const text = json.response ?? "";
    const content: LanguageModelV2Content[] = text
      ? [{ type: "text" as const, text }]
      : [];
    const finishReason: LanguageModelV2FinishReason = "stop";
    return {
      content,
      finishReason,
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      warnings: warningsFor(options, this.#config.toolMode),
      providerMetadata: json.session_id
        ? { cdecli: { sessionId: json.session_id } }
        : undefined,
      request: { body },
      response: { headers: headersToRecord(res.headers) },
    };
  }

  async _doGenerateFromStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const fetchImpl = this.#config.fetch ?? fetch;
    const body = buildBody(options, this.#config, true);
    const url = `${this.#config.endpoint.replace(/\/$/, "")}/v1/agent/chat`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(this.#config, "text/event-stream"),
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`cdecli /v1/agent/chat failed: ${res.status} ${errText}`);
    }

    let text = "";
    let sessionId: string | undefined;
    const toolCalls: MappedToolCall[] = [];
    let toolIndex = 0;

    for await (const evt of iterateSse(res)) {
      switch (evt.event) {
        case "session": {
          const sid = getString(evt.data, "session_id");
          if (sid) sessionId = sid;
          break;
        }
        case "delta":
        case "output": {
          const chunk = getString(evt.data, "text");
          if (chunk) text += chunk;
          break;
        }
        case "tool_call": {
          const mapped = mapToolCall(evt.data, ++toolIndex);
          if (mapped) toolCalls.push(mapped);
          break;
        }
        case "error": {
          const message = getString(evt.data, "error") ?? "cdecli stream error";
          throw new Error(message);
        }
      }
    }

    const content: LanguageModelV2Content[] = [];
    if (text) {
      content.push({ type: "text", text });
    }
    for (const tc of toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: JSON.stringify(tc.input),
      });
    }

    return {
      content,
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      warnings: warningsFor(options, this.#config.toolMode),
      providerMetadata: sessionId ? { cdecli: { sessionId } } : undefined,
      request: { body },
      response: { headers: headersToRecord(res.headers) },
    };
  }

  doStream(
    options: LanguageModelV2CallOptions,
  ): ReturnType<LanguageModelV2["doStream"]> {
    return this._doStream(options);
  }

  async _doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const fetchImpl = this.#config.fetch ?? fetch;
    const body = buildBody(options, this.#config, true);
    const url = `${this.#config.endpoint.replace(/\/$/, "")}/v1/agent/chat`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(this.#config, "text/event-stream"),
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`cdecli /v1/agent/chat failed: ${res.status} ${errText}`);
    }

    const warnings = warningsFor(options, this.#config.toolMode);
    const textId = "txt-0";
    let textStarted = false;
    let aggregated = "";
    let sessionId: string | undefined;

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        try {
          for await (const evt of iterateSse(res)) {
            if (evt.event === SSE_DONE) break;
            switch (evt.event) {
              case "session": {
                const sid = getString(evt.data, "session_id");
                if (sid) sessionId = sid;
                break;
              }
              case "delta":
              case "output": {
                const chunk = getString(evt.data, "text");
                if (!chunk) break;
                if (!textStarted) {
                  controller.enqueue({ type: "text-start", id: textId });
                  textStarted = true;
                }
                aggregated += chunk;
                controller.enqueue({ type: "text-delta", id: textId, delta: chunk });
                break;
              }
              case "status":
                // forward as raw (UI may surface it); do not affect text stream.
                controller.enqueue({ type: "raw", rawValue: evt });
                break;
              case "error": {
                const message = getString(evt.data, "error") ?? "cdecli stream error";
                controller.enqueue({ type: "error", error: new Error(message) });
                break;
              }
              case "done":
                // handled below after the loop
                break;
              default:
                controller.enqueue({ type: "raw", rawValue: evt });
            }
          }
        } catch (err) {
          controller.enqueue({ type: "error", error: err });
        } finally {
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textId });
          } else if (aggregated === "") {
            // Emit a minimal empty text turn so callers can still finalize.
            controller.enqueue({ type: "text-start", id: textId });
            controller.enqueue({ type: "text-end", id: textId });
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: undefined,
              outputTokens: undefined,
              totalTokens: undefined,
            },
            providerMetadata: sessionId
              ? { cdecli: { sessionId } }
              : undefined,
          });
          controller.close();
        }
      },
    });

    return {
      stream,
      request: { body },
      response: { headers: headersToRecord(res.headers) },
    };
  }
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Factory matching the ai-sdk provider convention:
 *
 * ```ts
 * import { cdecli } from "@cdmbase/ai-sdk-cdecli";
 * const model = cdecli("claude-sonnet-4.6", {
 *   endpoint: process.env.CDECLI_AGENT_ENDPOINT!,
 *   token: process.env.CDECLI_AGENT_AUTH_TOKEN,
 *   skill: "support",
 * });
 * ```
 */
export function cdecli(
  modelId: string,
  config: CdecliModelConfig & { toolMode?: ToolMode },
): LanguageModelV2 {
  return new CdecliLanguageModel(modelId, config);
}
