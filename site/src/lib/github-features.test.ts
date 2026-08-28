import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStatus, excerptFromBody, normalizeFeature, normalizeFeatures, readFeatureCache, resolveBoardState, sortNew, sortShipped, sortTop, writeFeatureCache, type Feature } from "./github-features.ts";

const issue = (extra: Record<string, unknown> = {}) => ({ number: 1, title: "A feature", body: "## Problem\n\n**Make it better**", html_url: "https://github.com/trydrift/drift/issues/1", state: "open", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: null, comments: 2, labels: [{ name: "feature-request" }], reactions: { "+1": 7, heart: 99 }, ...extra });
test("excludes pull requests and unlabeled issues", () => { assert.equal(normalizeFeature(issue({ pull_request: {} })), null); assert.equal(normalizeFeature(issue({ labels: [] })), null); });
test("uses only +1 reactions and handles missing summaries", () => { assert.equal(normalizeFeature(issue())?.votes, 7); assert.equal(normalizeFeature(issue({ reactions: null }))?.votes, 0); });
test("status precedence and view sorting work", () => { assert.equal(deriveStatus("open", ["status: planned", "status: shipped"]), "Shipped"); const make = (n: number, votes: number, created: string, status: Feature["status"] = "Requested"): Feature => ({ number: n, title: String(n), excerpt: "", htmlUrl: "", state: status === "Closed" ? "closed" : "open", status, votes, comments: 0, createdAt: created, updatedAt: created, closedAt: null }); const xs = [make(1, 2, "2026-01-01T00:00:00Z"), make(2, 2, "2026-01-02T00:00:00Z"), make(3, 9, "2025-01-01T00:00:00Z"), make(4, 1, "2026-01-03T00:00:00Z", "Closed"), make(5, 1, "2026-01-03T00:00:00Z", "Shipped")]; assert.deepEqual(sortTop(xs).map((f) => f.number), [3, 2, 1]); assert.deepEqual(sortNew(xs).map((f) => f.number), [2, 1, 3]); assert.deepEqual(sortShipped(xs).map((f) => f.number), [5]); });
test("normalizes issue-form markdown to safe text and handles null", () => { assert.equal(excerptFromBody("## Problem\n\n[Read](https://evil.test) **text**\n\n- more\n\n<script>alert(1)</script>"), "Problem Read text more"); assert.equal(excerptFromBody(null), ""); });
test("ignores malformed entries and distinguishes cache states", () => { assert.deepEqual(normalizeFeatures([null, {}, issue({ number: "bad" })]), []); const feature = normalizeFeature(issue())!; const raw = writeFeatureCache([feature], 1000); assert.deepEqual(readFeatureCache(raw, 1000 + 100)?.kind, "fresh"); assert.deepEqual(readFeatureCache(raw, 1000 + 6 * 60 * 1000)?.kind, "stale"); assert.equal(readFeatureCache(JSON.stringify({ schema: 99, cachedAt: 1000, features: [] }), 1000).kind, "invalid"); assert.equal(readFeatureCache(JSON.stringify({ schema: 1, cachedAt: 1000, features: [{}] }), 1000).kind, "invalid"); });
test("a successful empty response is valid cache data", () => { const raw = writeFeatureCache([], 1000); const cache = readFeatureCache(raw, 1000); assert.equal(cache.kind, "fresh"); assert.deepEqual(cache.features, []); });

test("cache freshness is independent of how many features it holds", () => {
  const feature = normalizeFeature(issue())!;
  const now = 1000;
  // fresh, with and without features
  assert.equal(readFeatureCache(writeFeatureCache([feature], now), now + 100).kind, "fresh");
  assert.equal(readFeatureCache(writeFeatureCache([], now), now + 100).kind, "fresh");
  // stale, with and without features
  const later = now + 6 * 60 * 1000;
  assert.equal(readFeatureCache(writeFeatureCache([feature], now), later).kind, "stale");
  assert.equal(readFeatureCache(writeFeatureCache([], now), later).kind, "stale");
});

test("malformed and incompatible caches read as invalid", () => {
  assert.equal(readFeatureCache("not json at all", 1000).kind, "invalid");
  assert.equal(readFeatureCache(null, 1000).kind, "invalid");
  assert.equal(readFeatureCache(JSON.stringify({ schema: 99, cachedAt: 1000, features: [] }), 1000).kind, "invalid");
  assert.equal(readFeatureCache(JSON.stringify({ schema: 1, cachedAt: "soon", features: [] }), 1000).kind, "invalid");
  assert.equal(readFeatureCache(JSON.stringify({ schema: 1, cachedAt: 1000, features: [{ number: 1 }] }), 1000).kind, "invalid");
});

test("a successful GitHub response with zero issues normalizes to an empty list", () => {
  assert.deepEqual(normalizeFeatures([]), []);
  assert.deepEqual(normalizeFeatures([issue({ pull_request: {} }), issue({ labels: [] })]), []);
});

test("board state separates a missing snapshot from an empty one", () => {
  // no usable snapshot yet
  assert.equal(resolveBoardState(false, false), "ok");   // still loading / just fetched clean
  assert.equal(resolveBoardState(false, true), "error"); // never loaded + fetch failed => hard error
  // a snapshot exists (empty or not) — a failed refresh is only ever "stale"
  assert.equal(resolveBoardState(true, false), "ok");
  assert.equal(resolveBoardState(true, true), "stale");  // includes the stale-empty-cache + failed-refresh bug
});
