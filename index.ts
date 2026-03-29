/**
 * Gemini Search — ACP-only pi extension
 *
 * Provides a `gemini_search` tool that spawns `gemini --acp` as a persistent
 * subprocess, communicates via JSON-RPC 2.0 over stdin/stdout, and leverages
 * Gemini's built-in `google_web_search` grounding tool.
 *
 * Prerequisites:
 *   npm install -g @google/gemini-cli
 *   gemini          # run once to complete OAuth
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ── Configuration ────────────────────────────────────────────────────────────

const SEARCH_MODEL = "gemini-2.5-flash";
const BOOT_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 60_000;
const MAX_QUERIES_BEFORE_RESTART = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  onNotification?: (notification: any) => void;
  timeout: NodeJS.Timeout;
}

export interface ResolvedUrl {
  title: string;
  url: string;
  resolved: boolean;
}

// ── Link extraction ──────────────────────────────────────────────────────────

/**
 * Extracts links from Gemini CLI text output.
 * Handles multiple formats:
 *   1. Standard markdown: [text](url)
 *   2. Reference style: [N] title (url)
 *   3. Bare URLs
 * Deduplicates by URL.
 */
export function extractLinks(text: string): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();

  // Markdown links: [text](url)
  for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      links.push({ title: m[1], url: m[2] });
    }
  }

  // Reference-style: [N] title (url)
  for (const m of text.matchAll(/\[\d+\]\s*([^\n(]+?)[\s\n]*\((https?:\/\/[^)]+)\)/g)) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      links.push({ title: m[1].trim(), url: m[2] });
    }
  }

  // Bare URLs
  for (const m of text.matchAll(/(?:^|\s)(https?:\/\/[^\s)]+)/gm)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      try {
        links.push({ title: new URL(m[1]).hostname.replace(/^www\./, ""), url: m[1] });
      } catch {
        links.push({ title: m[1], url: m[1] });
      }
    }
  }

  return links;
}

// ── Link stripping ───────────────────────────────────────────────────────────

/**
 * Strips markdown link syntax, bare URLs, and source sections from text.
 * Used to clean Gemini's answer before rendering sources separately.
 */
export function stripLinks(text: string): string {
  let cleaned = text.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1");
  cleaned = cleaned.replace(/\(https?:\/\/[^)]+\)/g, "");
  cleaned = cleaned.replace(/^\s*https?:\/\/[^\s]+\s*$/gm, "");
  cleaned = cleaned.replace(/\n*(?:Sources|References):\s*[\s\S]*$/i, "");
  return cleaned.trimEnd();
}

// ── Grounding URL resolution ─────────────────────────────────────────────────

/**
 * Resolves grounding redirect URLs to their real destinations via HEAD requests.
 * Direct URLs are passed through as-is.
 *
 * @param links - Array of { title, url } from extractLinks()
 * @param fetchFn - Optional fetch implementation (for testing)
 */
export async function resolveGroundingUrls(
  links: Array<{ title: string; url: string }>,
  fetchFn: typeof fetch = fetch
): Promise<ResolvedUrl[]> {
  return Promise.all(
    links.map(async ({ title, url }): Promise<ResolvedUrl> => {
      if (!url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect/")) {
        return { title, url, resolved: true };
      }
      try {
        const res = await fetchFn(url, { method: "HEAD", redirect: "manual" });
        const location = res.headers.get("Location");
        if (location && [301, 302, 307, 308].includes(res.status)) {
          return { title, url: location, resolved: true };
        }
      } catch {}
      return { title, url, resolved: false };
    })
  );
}

// ── JSON-RPC message handling ────────────────────────────────────────────────

/**
 * Routes an incoming JSON-RPC message to the appropriate pending request.
 * Notifications (no id) are broadcast to all listeners.
 * Responses resolve/reject their matching pending request.
 *
 * @returns "notification" | "response" | "ignored" for testing assertions
 */
export function handleMessage(
  msg: any,
  pendingRequests: Map<number, PendingRequest>
): "notification" | "response" | "ignored" {
  if (msg?.jsonrpc !== "2.0") return "ignored";

  // Notification (no id) — broadcast to listeners
  if (msg.method === "session/update" && !msg.id) {
    if (msg.params?.update?.sessionUpdate === "available_commands_update") return "ignored";
    for (const p of pendingRequests.values()) p.onNotification?.(msg);
    return "notification";
  }

  // Response
  const p = pendingRequests.get(msg.id);
  if (!p) return "ignored";
  clearTimeout(p.timeout);
  pendingRequests.delete(msg.id);
  msg.error ? p.reject(new Error(`ACP error: ${msg.error.message}`)) : p.resolve(msg.result);
  return "response";
}

/**
 * Builds a JSON-RPC 2.0 request line (NDJSON format).
 */
export function buildRequest(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, id, params }) + "\n";
}

/**
 * Builds the search prompt text for a query.
 */
export function buildSearchPrompt(query: string): string {
  return `Use the google_web_search tool to search the web for: ${query}. Include source URLs.`;
}

/**
 * Formats a search result into the final output text.
 */
export function formatResult(result: {
  answer: string;
  sources: Array<{ title: string; url: string }>;
  warning?: string;
}): string {
  const lines: string[] = [result.answer];

  if (result.warning) {
    lines.push("", `⚠️ ${result.warning}`);
  }

  if (result.sources.length > 0) {
    lines.push("", "**Sources:**");
    result.sources.forEach((s, i) => lines.push(`${i + 1}. [${s.title}](${s.url})`));
  }

  return lines.join("\n");
}

// ── ACP subprocess state ─────────────────────────────────────────────────────

let acpProcess: ChildProcess | null = null;
let sessionId: string | null = null;
let requestId = 0;
let queryCount = 0;
let processStartTime: number | null = null;

const pending = new Map<number, PendingRequest>();

// ── JSON-RPC transport ───────────────────────────────────────────────────────

function sendRequest(
  method: string,
  params: Record<string, unknown>,
  onNotification?: (n: any) => void,
  timeoutMs = PROMPT_TIMEOUT_MS
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!acpProcess?.stdin?.writable) {
      return reject(new Error("ACP process not available"));
    }

    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, onNotification, timeout });

    const line = buildRequest(id, method, params);
    acpProcess.stdin.write(line, (err) => {
      if (err) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(new Error(`Failed to write to ACP stdin: ${err.message}`));
      }
    });
  });
}

// ── Process lifecycle ────────────────────────────────────────────────────────

function killProcess(): void {
  if (acpProcess) {
    acpProcess.kill();
    acpProcess = null;
  }
  sessionId = null;
  queryCount = 0;
  processStartTime = null;
  for (const [, p] of pending) {
    clearTimeout(p.timeout);
    p.reject(new Error("ACP process killed"));
  }
  pending.clear();
}

async function ensureProcess(): Promise<void> {
  // Restart if query limit reached
  if (acpProcess && queryCount >= MAX_QUERIES_BEFORE_RESTART) {
    killProcess();
  }

  // Already running
  if (acpProcess && sessionId) return;

  processStartTime = Date.now();

  return new Promise<void>((resolve, reject) => {
    acpProcess = spawn("gemini", ["--acp", "-m", SEARCH_MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: acpProcess.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      try {
        handleMessage(JSON.parse(line), pending);
      } catch {}
    });

    acpProcess.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (chunk.includes("FatalAuthenticationError") || chunk.includes("OAuth token expired")) {
        reject(new Error("Gemini CLI auth failed — run `gemini` to re-authenticate."));
      }
    });

    acpProcess.on("error", (err) => {
      acpProcess = null;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Gemini CLI not found. Install with: npm install -g @google/gemini-cli"));
      } else {
        reject(err);
      }
    });

    acpProcess.on("exit", (code) => {
      acpProcess = null;
      sessionId = null;
      if (code !== 0 && code !== null) {
        for (const [, p] of pending) {
          clearTimeout(p.timeout);
          p.reject(new Error(`ACP process exited with code ${code}`));
        }
        pending.clear();
      }
    });

    const bootTimeout = setTimeout(() => {
      killProcess();
      reject(new Error(`ACP boot timed out after ${BOOT_TIMEOUT_MS}ms`));
    }, BOOT_TIMEOUT_MS);

    (async () => {
      try {
        await sendRequest(
          "initialize",
          { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pi-gemini-search", version: "1.0" } },
          undefined,
          BOOT_TIMEOUT_MS
        );

        await sendRequest("authenticate", { methodId: "oauth-personal" }, undefined, BOOT_TIMEOUT_MS);

        const res = await sendRequest(
          "session/new",
          { cwd: process.cwd(), mcpServers: [] },
          undefined,
          BOOT_TIMEOUT_MS
        );

        sessionId = res.sessionId;
        clearTimeout(bootTimeout);
        resolve();
      } catch (err) {
        clearTimeout(bootTimeout);
        killProcess();
        reject(err);
      }
    })();
  });
}

// ── Search execution ─────────────────────────────────────────────────────────

async function search(
  query: string,
  signal?: AbortSignal,
  onUpdate?: (partial: any) => void
): Promise<{ answer: string; sources: Array<{ title: string; url: string }>; warning?: string }> {
  queryCount++;
  await ensureProcess();

  const chunks: string[] = [];

  // Set up abort handler
  let cancelled = false;
  const onAbort = async () => {
    cancelled = true;
    try {
      await sendRequest("session/cancel", { sessionId: sessionId! }, undefined, 2000);
    } catch {}
    setTimeout(() => {
      if (acpProcess) killProcess();
    }, 2000);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await sendRequest(
      "session/prompt",
      {
        sessionId: sessionId!,
        prompt: [{ type: "text", text: buildSearchPrompt(query) }],
      },
      (notification: any) => {
        const update = notification.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk") {
          const text = update.content?.text;
          if (text) {
            chunks.push(text);
            onUpdate?.({ content: [{ type: "text", text: `Receiving response... (${chunks.length} chunks)` }] });
          }
        }
      }
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (cancelled) throw new Error("Search cancelled");

  const fullText = chunks.join("");
  if (!fullText.trim()) throw new Error("Gemini returned empty response");

  const links = extractLinks(fullText);

  onUpdate?.({ content: [{ type: "text", text: `Resolving ${links.length} source URLs...` }] });

  const resolved = await resolveGroundingUrls(links);
  const answer = stripLinks(fullText);
  const sources = resolved.map((r) => ({ title: r.title, url: r.url }));

  return {
    answer,
    sources,
    ...(links.length === 0
      ? { warning: "Gemini may have answered from memory — information may not be current." }
      : {}),
  };
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: any) {
  // Lazy-import pi runtime dependencies (not available during tests)
  const { Type } = require("@sinclair/typebox");

  pi.registerTool({
    name: "gemini_search",
    label: "Gemini Search",
    description:
      "Search the web for current information using Gemini CLI's grounded search. " +
      "Returns an AI-synthesized answer with source URLs. Use for recent events, " +
      "live data, current docs, or anything that may have changed after training.",
    promptSnippet: "Search the web for current information via Gemini's grounded search",
    promptGuidelines: [
      "Use gemini_search when the user asks about recent events, current versions, live data, or anything potentially outdated in training data.",
      "Do NOT use for well-established historical facts or stable knowledge.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),

    async execute(_toolCallId: string, params: any, signal: any, onUpdate: any, _ctx: any) {
      onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }] });

      const result = await search(params.query, signal, onUpdate);

      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: {
          query: params.query,
          sources: result.sources,
          warning: result.warning,
        },
      };
    },
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    killProcess();
  });
}
