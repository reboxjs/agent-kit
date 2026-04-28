# @cdmbase/ai-sdk-cdecli

A [Vercel AI SDK](https://sdk.vercel.ai) provider that wraps [`cdecli interact-agent serve`](https://github.com/CDEBase/cli-tool) as a `LanguageModelV2`. Drop it into any ai-sdk app — including [`@cdmbase/agent-kit`](../agent-kit) agents and networks — to use cdecli as the inference + agent runtime backend.

## Why

`cdecli interact-agent serve` exposes a hosted agent runtime with:

- Smart model routing (cheap vs strong models per turn)
- Per-session memory with optional S3 backup
- Pre-activated **skills** (`--skill`) — bundled instructions + connector permissions
- 969+ Yantra connectors as built-in tools
- Centralized credentials (LLM keys live in cdecli, not your Node process)
- Bearer-auth + per-user data isolation

This package lets you consume all of that through the standard `LanguageModel` interface. **No changes to ai-sdk or agent-kit.**

## Install

```bash
pnpm add @cdmbase/ai-sdk-cdecli ai
```

You also need a running cdecli serve instance:

```bash
cdecli interact-agent serve --port 8080 --auth-secret "$BEARER"
```

…or point at the hosted endpoint `https://cdecli-agent.cdebase.dev`.

## Usage with `@cdmbase/agent-kit`

```ts
import { createAgent, createNetwork } from "@cdmbase/agent-kit";
import { cdecli } from "@cdmbase/ai-sdk-cdecli";

const supportAgent = createAgent({
  name: "support",
  description: "Answers customer questions",
  system: "You are a helpful support agent.",
  model: cdecli("claude-sonnet-4.6", {
    endpoint: process.env.CDECLI_AGENT_ENDPOINT!,
    token: process.env.CDECLI_AGENT_AUTH_TOKEN,
    skill: "support",
    session: "user-123",
  }),
});

const network = createNetwork({ agents: [supportAgent] });
await network.run("My order #42 hasn't shipped — what's going on?");
```

## Usage with the AI SDK directly

```ts
import { generateText, streamText } from "ai";
import { cdecli } from "@cdmbase/ai-sdk-cdecli";

const model = cdecli("claude-haiku-4.5", {
  endpoint: process.env.CDECLI_AGENT_ENDPOINT!,
  token: process.env.CDECLI_AGENT_AUTH_TOKEN,
});

const { text } = await generateText({
  model,
  prompt: "Summarize the latest deploy logs.",
});
```

Streaming works the same way:

```ts
const { textStream } = streamText({ model, prompt: "..." });
for await (const chunk of textStream) process.stdout.write(chunk);
```

## Configuration

| Option       | Type     | Description |
|--------------|----------|-------------|
| `endpoint`   | `string` | Required. Base URL of `cdecli interact-agent serve`. |
| `token`      | `string` | Bearer token for `--auth-secret` or upstream JWT. |
| `skill`      | `string` | Pre-activate a cdecli skill (mirrors `--skill`). |
| `skillId`    | `string` | Numeric/UUID skill ID variant. |
| `session`    | `string` | Stable session ID for cross-call memory. Omit for ephemeral per-call sessions. |
| `headers`    | `object` | Extra HTTP headers attached to every request. |
| `fetch`      | `fn`     | Custom fetch (testing/proxies). |

## Operating mode

The provider currently runs in **`server` mode**: cdecli executes everything (system prompt, tools, connectors). Tool definitions sent by ai-sdk are ignored and surfaced as `LanguageModelV2CallWarning`s, because the underlying `POST /v1/agent/chat` endpoint does not yet emit structured `tool_call` SSE events that could round-trip back to client-side TS handlers.

If you need TS-side tool handlers (e.g. agent-kit `createTool()`), keep using a direct ai-sdk provider (`@ai-sdk/openai`, `@ai-sdk/anthropic`) for that agent and use this provider for agents whose tools live in cdecli.

A future `client` mode will become available once cdecli serve emits structured tool-call events and accepts tool-result follow-ups.

## What gets sent

For each call the provider POSTs to `/v1/agent/chat`:

```json
{
  "session_id": "...",
  "message": "<entire ai-sdk prompt serialized as text>",
  "stream": true | false,
  "model": "<modelId>",
  "skill": "...",
  "skill_id": "..."
}
```

Streaming consumes cdecli's SSE events (`session`, `delta`, `output`, `status`, `error`, `done`) and converts them into `LanguageModelV2StreamPart`s (`text-start` / `text-delta` / `text-end` / `finish`).

## License

Apache-2.0
