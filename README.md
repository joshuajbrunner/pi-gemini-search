# pi-gemini-search

A [pi](https://github.com/badlogic/pi-mono) extension that provides web search via Google's Gemini CLI, using the **Agent Client Protocol (ACP)** over a persistent subprocess.

Leverages Gemini's built-in `google_web_search` grounding tool — no separate API key needed, just your Google AI Pro subscription OAuth.

## How It Works

1. Spawns `gemini --acp` as a persistent subprocess on first search
2. Communicates via JSON-RPC 2.0 over stdin/stdout
3. Handshakes once: `initialize` → `authenticate` (OAuth) → `session/new`
4. Reuses the session across queries (avoids ~12s boot per search)
5. Sends `session/prompt` with `google_web_search` instruction, streams `agent_message_chunk` responses
6. Resolves grounding redirect URLs to real source URLs
7. Auto-restarts after 20 queries to reset the context window

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) coding agent
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed globally:
  ```bash
  npm install -g @google/gemini-cli
  ```
- Google OAuth authenticated (run `gemini` once to complete browser auth flow)

## Installation

### Option 1: Symlink (recommended for development)

```bash
git clone https://github.com/joshuajbrunner/pi-gemini-search.git ~/Projects/pi-gemini-search
mkdir -p ~/.pi/agent/extensions/gemini-search
ln -sf ~/Projects/pi-gemini-search/index.ts ~/.pi/agent/extensions/gemini-search/index.ts
```

### Option 2: Direct clone

```bash
git clone https://github.com/joshuajbrunner/pi-gemini-search.git ~/.pi/agent/extensions/gemini-search
```

Then restart pi or run `/reload`.

## Usage

The extension registers a `gemini_search` tool that the LLM can call automatically. You can also be explicit:

```
What's the latest version of Node.js?
Use gemini_search to find the current Bitcoin price
Search for recent changes to the TypeScript compiler
```

## Configuration

Constants at the top of `index.ts`:

| Constant | Default | Description |
|----------|---------|-------------|
| `SEARCH_MODEL` | `gemini-2.5-flash` | Gemini model for search queries |
| `BOOT_TIMEOUT_MS` | 30s | Max time for initial ACP handshake |
| `PROMPT_TIMEOUT_MS` | 60s | Max time per search query |
| `MAX_QUERIES_BEFORE_RESTART` | 20 | Queries before subprocess restart |

## ACP Protocol

The extension uses the **Agent Client Protocol** — a JSON-RPC 2.0 protocol built into `gemini --acp` that communicates over stdin/stdout using newline-delimited JSON (NDJSON).

### Handshake

```
→ { method: "initialize", params: { protocolVersion: 1, clientInfo: {...} } }
← { result: { protocolVersion: 1, agentInfo: {...} } }

→ { method: "authenticate", params: { methodId: "oauth-personal" } }
← { result: {} }

→ { method: "session/new", params: { cwd: "...", mcpServers: [] } }
← { result: { sessionId: "uuid" } }
```

### Per-query

```
→ { method: "session/prompt", params: { sessionId, prompt: [{type: "text", text: "..."}] } }
← { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "..." } } } }  (streaming)
← { id: N, result: { stopReason: "end_turn" } }  (final)
```

## Disclaimer

> **⚠️** Google's [ToS](https://geminicli.com/docs/resources/tos-privacy/) states that "directly accessing the services powering Gemini CLI using third-party software" is a violation. This extension communicates through Gemini's official ACP protocol via the official CLI binary. Whether this constitutes "third-party access" is [under discussion](https://github.com/google-gemini/gemini-cli/discussions/22970). **Use at your own risk.**

## License

MIT
