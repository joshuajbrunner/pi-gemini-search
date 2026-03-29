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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  extractLinks,
  stripLinks,
  resolveGroundingUrls,
  handleMessage as routeMessage,
  buildRequest,
  buildSearchPrompt,
  formatResult,
  type PendingRequest,
} from "./lib.js";

// ── Configuration ────────────────────────────────────────────────────────────

const SEARCH_MODEL = "gemini-2.5-flash";
const BOOT_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 60_000;
const MAX_QUERIES_BEFORE_RESTART = 20;

// ── ACP subprocess state ─────────────────────────────────────────────────────

let acpProcess: ChildProcess | null = null;
let sessionId: string | null = null;
let requestId = 0;
let queryCount = 0;
let processStartTime: number | null = null;

const pending = new Map<number, PendingRequest>();

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

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
        routeMessage(JSON.parse(line), pending);
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

export default function (pi: ExtensionAPI) {
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

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
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
