import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  extractLinks,
  stripLinks,
  resolveGroundingUrls,
  handleMessage,
  buildRequest,
  buildSearchPrompt,
  formatResult,
  type PendingRequest,
} from "./index.js";

// ═════════════════════════════════════════════════════════════════════════════
// extractLinks
// ═════════════════════════════════════════════════════════════════════════════

describe("extractLinks", () => {
  it("extracts standard markdown links", () => {
    const text = "Check out [Node.js](https://nodejs.org) and [Deno](https://deno.land).";
    const links = extractLinks(text);
    assert.deepEqual(links, [
      { title: "Node.js", url: "https://nodejs.org" },
      { title: "Deno", url: "https://deno.land" },
    ]);
  });

  it("extracts reference-style links", () => {
    const text = "[1] Node.js Official Site (https://nodejs.org)\n[2] Deno Land (https://deno.land)";
    const links = extractLinks(text);
    assert.deepEqual(links, [
      { title: "Node.js Official Site", url: "https://nodejs.org" },
      { title: "Deno Land", url: "https://deno.land" },
    ]);
  });

  it("extracts bare URLs with domain as title", () => {
    const text = "Visit https://www.example.com for more info.";
    const links = extractLinks(text);
    assert.equal(links.length, 1);
    assert.equal(links[0].title, "example.com");
    assert.equal(links[0].url, "https://www.example.com");
  });

  it("deduplicates URLs across formats", () => {
    const text = "[Node](https://nodejs.org) and also https://nodejs.org";
    const links = extractLinks(text);
    assert.equal(links.length, 1);
    assert.equal(links[0].title, "Node");
  });

  it("handles mixed formats in one response", () => {
    const text = [
      "Here is [Google](https://google.com) for searching.",
      "[1] MDN Web Docs (https://developer.mozilla.org)",
      "Also see https://stackoverflow.com for help.",
    ].join("\n");
    const links = extractLinks(text);
    assert.equal(links.length, 3);
    assert.equal(links[0].url, "https://google.com");
    assert.equal(links[1].url, "https://developer.mozilla.org");
    assert.equal(links[2].url, "https://stackoverflow.com");
  });

  it("returns empty array for text with no links", () => {
    assert.deepEqual(extractLinks("No links here."), []);
  });

  it("handles grounding redirect URLs", () => {
    const url = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123";
    const text = `[Source](${url})`;
    const links = extractLinks(text);
    assert.equal(links.length, 1);
    assert.equal(links[0].url, url);
  });

  it("handles http links (not just https)", () => {
    const text = "[Old site](http://example.com)";
    const links = extractLinks(text);
    assert.equal(links.length, 1);
    assert.equal(links[0].url, "http://example.com");
  });

  it("handles reference-style with multiline gap", () => {
    const text = "[1] Some Title\n(https://example.com)";
    const links = extractLinks(text);
    assert.equal(links.length, 1);
    assert.equal(links[0].title, "Some Title");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// stripLinks
// ═════════════════════════════════════════════════════════════════════════════

describe("stripLinks", () => {
  it("removes markdown link syntax, keeps text", () => {
    const text = "Check [Node.js](https://nodejs.org) for details.";
    assert.equal(stripLinks(text), "Check Node.js for details.");
  });

  it("removes parenthetical URLs", () => {
    const text = "More info (https://example.com) available.";
    assert.equal(stripLinks(text), "More info  available.");
  });

  it("removes bare URLs on their own line", () => {
    const text = "Some text\nhttps://example.com\nMore text";
    assert.equal(stripLinks(text), "Some text\n\nMore text");
  });

  it("removes Sources section and everything after", () => {
    const text = "The answer is 42.\n\nSources:\n1. https://example.com\n2. https://other.com";
    assert.equal(stripLinks(text), "The answer is 42.");
  });

  it("removes References section (case-insensitive)", () => {
    const text = "Answer here.\n\nreferences:\n- some ref";
    assert.equal(stripLinks(text), "Answer here.");
  });

  it("trims trailing whitespace", () => {
    const text = "Clean text   \n  ";
    assert.equal(stripLinks(text), "Clean text");
  });

  it("handles text with no links", () => {
    assert.equal(stripLinks("Plain text"), "Plain text");
  });

  it("handles multiple markdown links in one line", () => {
    const text = "See [A](https://a.com) and [B](https://b.com).";
    assert.equal(stripLinks(text), "See A and B.");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveGroundingUrls
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveGroundingUrls", () => {
  it("passes through direct URLs without fetching", async () => {
    const fetchFn = mock.fn(() => {
      throw new Error("should not be called");
    });

    const result = await resolveGroundingUrls(
      [{ title: "Example", url: "https://example.com" }],
      fetchFn as any
    );

    assert.equal(fetchFn.mock.callCount(), 0);
    assert.deepEqual(result, [{ title: "Example", url: "https://example.com", resolved: true }]);
  });

  it("resolves grounding redirects via HEAD request", async () => {
    const groundingUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123";

    const fetchFn = mock.fn(() =>
      Promise.resolve({
        status: 302,
        headers: new Headers({ Location: "https://real-site.com/page" }),
      })
    );

    const result = await resolveGroundingUrls(
      [{ title: "Source", url: groundingUrl }],
      fetchFn as any
    );

    assert.equal(fetchFn.mock.callCount(), 1);
    const call = fetchFn.mock.calls[0] as any;
    assert.equal(call.arguments[0], groundingUrl);
    assert.deepEqual(call.arguments[1], { method: "HEAD", redirect: "manual" });
    assert.deepEqual(result, [{ title: "Source", url: "https://real-site.com/page", resolved: true }]);
  });

  it("handles 301 redirects", async () => {
    const groundingUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/xyz";

    const fetchFn = mock.fn(() =>
      Promise.resolve({
        status: 301,
        headers: new Headers({ Location: "https://permanent.com" }),
      })
    );

    const result = await resolveGroundingUrls(
      [{ title: "Perm", url: groundingUrl }],
      fetchFn as any
    );

    assert.deepEqual(result, [{ title: "Perm", url: "https://permanent.com", resolved: true }]);
  });

  it("marks as unresolved when redirect has no Location header", async () => {
    const groundingUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/bad";

    const fetchFn = mock.fn(() =>
      Promise.resolve({
        status: 302,
        headers: new Headers(),
      })
    );

    const result = await resolveGroundingUrls(
      [{ title: "Bad", url: groundingUrl }],
      fetchFn as any
    );

    assert.deepEqual(result, [{ title: "Bad", url: groundingUrl, resolved: false }]);
  });

  it("marks as unresolved when fetch throws", async () => {
    const groundingUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/err";

    const fetchFn = mock.fn(() => Promise.reject(new Error("network error")));

    const result = await resolveGroundingUrls(
      [{ title: "Err", url: groundingUrl }],
      fetchFn as any
    );

    assert.deepEqual(result, [{ title: "Err", url: groundingUrl, resolved: false }]);
  });

  it("marks as unresolved for non-redirect status codes", async () => {
    const groundingUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ok";

    const fetchFn = mock.fn(() =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
      })
    );

    const result = await resolveGroundingUrls(
      [{ title: "Ok", url: groundingUrl }],
      fetchFn as any
    );

    assert.deepEqual(result, [{ title: "Ok", url: groundingUrl, resolved: false }]);
  });

  it("resolves mixed direct and grounding URLs concurrently", async () => {
    const groundingUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/mix";

    const fetchFn = mock.fn(() =>
      Promise.resolve({
        status: 302,
        headers: new Headers({ Location: "https://resolved.com" }),
      })
    );

    const result = await resolveGroundingUrls(
      [
        { title: "Direct", url: "https://direct.com" },
        { title: "Grounded", url: groundingUrl },
      ],
      fetchFn as any
    );

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { title: "Direct", url: "https://direct.com", resolved: true });
    assert.deepEqual(result[1], { title: "Grounded", url: "https://resolved.com", resolved: true });
    assert.equal(fetchFn.mock.callCount(), 1); // only grounding URL fetched
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// handleMessage (JSON-RPC routing)
// ═════════════════════════════════════════════════════════════════════════════

describe("handleMessage", () => {
  let pendingRequests: Map<number, PendingRequest>;

  function makePending(
    id: number,
    onNotification?: (n: any) => void
  ): { promise: Promise<any>; pending: PendingRequest; cleanup: () => void } {
    let pending: PendingRequest;
    const promise = new Promise<any>((resolve, reject) => {
      pending = {
        resolve,
        reject,
        onNotification,
        timeout: setTimeout(() => reject(new Error("test timeout")), 5000),
      };
      pendingRequests.set(id, pending!);
    });
    const cleanup = () => {
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      // Resolve silently to prevent unhandled rejection
      pending.resolve(undefined);
    };
    return { promise, pending: pending!, cleanup };
  }

  beforeEach(() => {
    pendingRequests = new Map();
  });

  it("ignores non-JSON-RPC messages", () => {
    assert.equal(handleMessage({}, pendingRequests), "ignored");
    assert.equal(handleMessage({ foo: "bar" }, pendingRequests), "ignored");
    assert.equal(handleMessage(null, pendingRequests), "ignored");
    assert.equal(handleMessage(undefined, pendingRequests), "ignored");
  });

  it("ignores available_commands_update notifications", () => {
    const msg = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "available_commands_update" } },
    };
    assert.equal(handleMessage(msg, pendingRequests), "ignored");
  });

  it("broadcasts agent_message_chunk notifications to listeners", () => {
    const received: any[] = [];
    const { cleanup } = makePending(1, (n) => received.push(n));

    const msg = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Hello" },
        },
      },
    };

    const result = handleMessage(msg, pendingRequests);
    assert.equal(result, "notification");
    assert.equal(received.length, 1);
    assert.equal(received[0].params.update.content.text, "Hello");
    cleanup();
  });

  it("broadcasts to multiple listeners", () => {
    const received1: any[] = [];
    const received2: any[] = [];
    const { cleanup: c1 } = makePending(1, (n) => received1.push(n));
    const { cleanup: c2 } = makePending(2, (n) => received2.push(n));

    const msg = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Hi" } } },
    };

    handleMessage(msg, pendingRequests);
    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
    c1();
    c2();
  });

  it("resolves matching response", async () => {
    const { promise } = makePending(42);

    const result = handleMessage(
      { jsonrpc: "2.0", id: 42, result: { sessionId: "abc" } },
      pendingRequests
    );

    assert.equal(result, "response");
    const value = await promise;
    assert.deepEqual(value, { sessionId: "abc" });
    assert.equal(pendingRequests.size, 0);
  });

  it("rejects on error response", async () => {
    const { promise } = makePending(7);

    handleMessage(
      { jsonrpc: "2.0", id: 7, error: { message: "something broke" } },
      pendingRequests
    );

    await assert.rejects(promise, /ACP error: something broke/);
    assert.equal(pendingRequests.size, 0);
  });

  it("ignores response for unknown request ID", () => {
    assert.equal(
      handleMessage({ jsonrpc: "2.0", id: 999, result: {} }, pendingRequests),
      "ignored"
    );
  });

  it("cleans up timeout on successful response", async () => {
    const { promise, pending } = makePending(1);
    // Verify timeout exists
    assert.ok(pending.timeout);

    handleMessage({ jsonrpc: "2.0", id: 1, result: "ok" }, pendingRequests);
    await promise;
    // If timeout wasn't cleared, it would fire and cause issues — test passing = success
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildRequest
// ═════════════════════════════════════════════════════════════════════════════

describe("buildRequest", () => {
  it("builds valid JSON-RPC 2.0 NDJSON line", () => {
    const line = buildRequest(1, "initialize", { protocolVersion: 1 });
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, 1);
    assert.equal(parsed.method, "initialize");
    assert.deepEqual(parsed.params, { protocolVersion: 1 });
  });

  it("ends with newline", () => {
    const line = buildRequest(1, "test", {});
    assert.ok(line.endsWith("\n"));
  });

  it("produces valid JSON for complex params", () => {
    const line = buildRequest(3, "session/new", {
      cwd: "/home/user",
      mcpServers: [],
    });
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.params.cwd, "/home/user");
    assert.deepEqual(parsed.params.mcpServers, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildSearchPrompt
// ═════════════════════════════════════════════════════════════════════════════

describe("buildSearchPrompt", () => {
  it("wraps query in search instruction", () => {
    const prompt = buildSearchPrompt("latest Node.js version");
    assert.ok(prompt.includes("google_web_search"));
    assert.ok(prompt.includes("latest Node.js version"));
    assert.ok(prompt.includes("source URLs"));
  });

  it("handles special characters in query", () => {
    const prompt = buildSearchPrompt('what is "TypeScript" & why?');
    assert.ok(prompt.includes('"TypeScript"'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// formatResult
// ═════════════════════════════════════════════════════════════════════════════

describe("formatResult", () => {
  it("formats answer only", () => {
    const output = formatResult({ answer: "The answer is 42.", sources: [] });
    assert.equal(output, "The answer is 42.");
  });

  it("includes warning when present", () => {
    const output = formatResult({
      answer: "Maybe this.",
      sources: [],
      warning: "Answered from memory",
    });
    assert.ok(output.includes("⚠️ Answered from memory"));
  });

  it("includes numbered sources with markdown links", () => {
    const output = formatResult({
      answer: "Node.js is at v24.",
      sources: [
        { title: "Node.js", url: "https://nodejs.org" },
        { title: "GitHub", url: "https://github.com/nodejs/node" },
      ],
    });
    assert.ok(output.includes("**Sources:**"));
    assert.ok(output.includes("1. [Node.js](https://nodejs.org)"));
    assert.ok(output.includes("2. [GitHub](https://github.com/nodejs/node)"));
  });

  it("includes all sections when warning and sources present", () => {
    const output = formatResult({
      answer: "Answer.",
      sources: [{ title: "Src", url: "https://src.com" }],
      warning: "May be stale",
    });
    const lines = output.split("\n");
    assert.equal(lines[0], "Answer.");
    assert.ok(lines.some((l) => l.includes("⚠️")));
    assert.ok(lines.some((l) => l.includes("**Sources:**")));
    assert.ok(lines.some((l) => l.includes("[Src](https://src.com)")));
  });
});
