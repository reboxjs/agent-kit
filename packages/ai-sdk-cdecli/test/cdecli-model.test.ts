import { describe, expect, it } from "vitest";
import { cdecli, CdecliLanguageModel, promptToCdecliMessage } from "../src/index";
import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";

function makeOptions(
  overrides: Partial<LanguageModelV2CallOptions> = {},
): LanguageModelV2CallOptions {
  return {
    prompt: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
    ...overrides,
  };
}

describe("promptToCdecliMessage", () => {
  it("serializes a system + user prompt", () => {
    const out = promptToCdecliMessage([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out).toContain("[system]");
    expect(out).toContain("be brief");
    expect(out).toContain("[user]");
    expect(out).toContain("hi");
  });

  it("serializes assistant tool-call and tool-result parts", () => {
    const out = promptToCdecliMessage([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: "search",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "search",
            output: { type: "json", value: { hits: 0 } },
          },
        ],
      },
    ]);
    expect(out).toContain("[tool-call search");
    expect(out).toContain("[tool-result search");
  });
});

describe("CdecliLanguageModel", () => {
  it("requires endpoint", () => {
    expect(() =>
      new CdecliLanguageModel("m", { endpoint: "" } as never),
    ).toThrow(/endpoint/);
  });

  it("doGenerate POSTs /v1/agent/chat and maps response to text content", async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return new Response(
        JSON.stringify({ session_id: "s1", response: "hello back", done: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const model = cdecli("claude-sonnet-4.6", {
      endpoint: "http://localhost:8080",
      token: "abc",
      skill: "support",
      session: "fixed-session",
      fetch: fakeFetch,
    });

    const result = await model.doGenerate(makeOptions());
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://localhost:8080/v1/agent/chat");
    const body = captured!.body as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4.6");
    expect(body.skill).toBe("support");
    expect(body.session_id).toBe("fixed-session");
    expect(body.stream).toBe(false);
    expect(captured!.headers["authorization"]).toBe("Bearer abc");

    expect(result.content).toEqual([{ type: "text", text: "hello back" }]);
    expect(result.finishReason).toBe("stop");
    expect(result.providerMetadata?.cdecli?.sessionId).toBe("s1");
  });

  it("doGenerate emits a warning when client passes tools", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ response: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const model = cdecli("m", { endpoint: "http://x", fetch: fakeFetch });
    const result = await model.doGenerate(
      makeOptions({
        tools: [
          {
            type: "function",
            name: "t",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(result.warnings.some((w) => w.type === "other")).toBe(true);
  });

  it("doStream parses delta + done SSE events into text-delta parts", async () => {
    const sse = [
      "event: session\ndata: {\"session_id\":\"s2\"}",
      "event: delta\ndata: {\"text\":\"Hel\"}",
      "event: delta\ndata: {\"text\":\"lo\"}",
      "event: done\ndata: {}",
    ].join("\n\n") + "\n\n";

    const fakeFetch: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const model = cdecli("m", { endpoint: "http://x", fetch: fakeFetch });
    const { stream } = await model.doStream(makeOptions());

    const parts: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const types = (parts as { type: string }[]).map((p) => p.type);
    expect(types[0]).toBe("stream-start");
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types[types.length - 1]).toBe("finish");

    const deltas = (parts as { type: string; delta?: string }[])
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta);
    expect(deltas.join("")).toBe("Hello");
  });

  it("doStream surfaces error events", async () => {
    const sse =
      "event: error\ndata: {\"error\":\"boom\"}\n\nevent: done\ndata: {}\n\n";
    const fakeFetch: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const model = cdecli("m", { endpoint: "http://x", fetch: fakeFetch });
    const { stream } = await model.doStream(makeOptions());
    const parts: { type: string; error?: unknown }[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value as { type: string; error?: unknown });
    }
    const err = parts.find((p) => p.type === "error");
    expect(err).toBeTruthy();
    expect(String((err as { error: Error }).error)).toContain("boom");
  });

  it("throws on non-2xx response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("nope", { status: 500 });
    const model = cdecli("m", { endpoint: "http://x", fetch: fakeFetch });
    await expect(model.doGenerate(makeOptions())).rejects.toThrow(/500/);
  });
});
