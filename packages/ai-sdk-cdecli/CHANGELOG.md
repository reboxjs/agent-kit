# Changelog

## 0.1.0

- Initial release. `LanguageModelV2` provider wrapping `cdecli interact-agent serve` (`POST /v1/agent/chat`).
- `doGenerate` (non-streaming) and `doStream` (SSE → `text-delta`).
- Server-side tool execution; client tool definitions emit a warning.
