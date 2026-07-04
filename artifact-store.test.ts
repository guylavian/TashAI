/**
 * Self-check for the artifact store + hash-detection helper (headroom pattern).
 * Plain asserts, run with `npx tsx artifact-store.test.ts`.
 */
import assert from "assert";
import { put, get, slice } from "./src/services/artifactStore";
import { hasArtifactRef } from "./src/services/artifactTools";

function roundtrip() {
  const h = put("hello\nworld", "note.txt");
  assert.strictEqual(h.length, 40, "sha1 hash is 40 hex chars");
  const a = get(h)!;
  assert.strictEqual(a.text, "hello\nworld");
  assert.strictEqual(a.name, "note.txt");
  assert.strictEqual(get("deadbeef"), undefined, "unknown hash → undefined");
}

function sliceWithQuery() {
  const lines = ["a0", "a1", "a2", "MATCH-here", "a4", "a5", "a6"];
  const h = put(lines.join("\n"), "log");
  const s = slice(h, "match")!; // case-insensitive
  // ±2 context around line index 3 → lines 1..5
  assert.ok(s.includes("MATCH-here"), "returns the matching line");
  assert.ok(s.includes("a1") && s.includes("a5"), "includes ±2 context lines");
  assert.ok(!s.includes("a0") && !s.includes("a6"), "excludes lines beyond context");
  assert.ok(slice(h, "nope")!.startsWith("no lines match"), "no match → notice");
  assert.strictEqual(slice("0".repeat(40), "x"), undefined, "missing artifact → undefined");
  // no query → head, capped
  const big = put("x".repeat(20000), "big");
  assert.strictEqual(slice(big, undefined, 8000)!.length, 8000, "no query → head capped at maxChars");
}

function evictionBound() {
  const hashes: string[] = [];
  for (let i = 0; i < 60; i++) hashes.push(put(`entry-${i}`, `f${i}`)); // 60 > cap 50
  assert.strictEqual(get(hashes[0]), undefined, "oldest evicted past the 50-entry bound");
  assert.ok(get(hashes[59]), "newest still present");
}

function ttlExpiry() {
  const h = put("perishable", "t");
  assert.ok(get(h), "present before TTL");
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 60 * 1000; // jump >1h
  try {
    assert.strictEqual(get(h), undefined, "expired after TTL");
  } finally {
    Date.now = realNow;
  }
}

function hashDetection() {
  const HEX = "a".repeat(40);
  assert.ok(hasArtifactRef([{ role: "user", content: `see hash=${HEX} please` }]), "detects hash=<40hex>");
  assert.ok(!hasArtifactRef([{ role: "user", content: "hash=tooshort" }]), "ignores short hash");
  assert.ok(!hasArtifactRef([{ role: "user", content: "no hash here" }]), "no ref → false");
}

roundtrip();
sliceWithQuery();
evictionBound();
ttlExpiry();
hashDetection();
console.log("artifact-store.test.ts: all assertions passed");
