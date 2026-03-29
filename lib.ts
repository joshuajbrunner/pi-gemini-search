/**
 * Pure utility functions for Gemini search extension.
 * Extracted for testability — no subprocess or pi dependencies.
 */

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

export interface ResolvedUrl {
  title: string;
  url: string;
  resolved: boolean;
}

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

export interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  onNotification?: (notification: any) => void;
  timeout: NodeJS.Timeout;
}

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
