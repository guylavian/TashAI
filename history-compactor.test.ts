/**
 * Self-check for history compaction. Plain asserts, run with
 * `npx tsx history-compactor.test.ts`. No LM Studio needed — the summarizer chat
 * dependency is injected as a stub (or left empty to exercise the truncation path).
 */
import assert from "assert";
import { compactMessages, type CompactChatFn } from "./src/services/historyCompactor";
import { hasArtifactRef } from "./src/services/artifactTools";
import type { Message } from "./src/types";

const big = (tag: string) => ({ role: "user" as const, content: `${tag} ` + "x".repeat(200) });

function underBudgetPassthrough() {
  const msgs: Message[] = [{ role: "user", content: "short question" }];
  return compactMessages(msgs, { budget: 3000 }).then((out) => {
    assert.strictEqual(out, msgs, "under budget → same array reference, zero overhead");
  });
}

async function truncationFallback() {
  // model:"" → no summarizer → plain truncation of the middle.
  const msgs: Message[] = [
    { role: "system", content: "you are a helper" },
    ...Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? big(`u${i}`) : { role: "assistant" as const, content: `a${i} ` + "y".repeat(200) }
    ),
  ];
  const out = await compactMessages(msgs, { budget: 5, model: "" });
  assert.strictEqual(out[0].role, "system", "leading system kept");
  assert.strictEqual(out[0].content, "you are a helper", "system kept verbatim");
  assert.strictEqual(out[1].role, "system", "summary/truncation note is a system message");
  assert.ok(out[1].content.startsWith("[earlier "), "truncation note when no summarizer");
  // last 4 turns (8 msgs) kept verbatim at the tail
  assert.deepStrictEqual(out.slice(-8), msgs.slice(-8), "last 8 messages kept verbatim");
  assert.ok(out.length < msgs.length, "middle collapsed");
}

async function artifactMarkerPreserved() {
  const HEX = "a".repeat(40);
  const msgs: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: `parse digest hash=${HEX} keep me ` + "z".repeat(300) },
    ...Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? big(`u${i}`) : { role: "assistant" as const, content: `a${i} ` + "y".repeat(200) }
    ),
  ];
  const out = await compactMessages(msgs, { budget: 5, model: "" });
  // The hash message is in the collapsed middle, but its marker must survive.
  assert.ok(hasArtifactRef([out[1]]), "artifact marker re-attached to the note");
  assert.ok(out[1].content.includes(`hash=${HEX}`), "exact marker preserved");
}

async function toolPairExtension() {
  // messages.length - KEEP_TAIL(8) lands the window start on a tool message;
  // it must be pulled back to include the preceding assistant.
  const msgs: Message[] = [
    { role: "system", content: "sys" }, // 0
    big("u0"), // 1
    { role: "assistant", content: "a1 " + "y".repeat(200) }, // 2  ← the tool_calls assistant
    { role: "tool", content: "t2 tool result " + "w".repeat(200) }, // 3  ← would be tail[0] without the guard
    big("u4"), // 4
    { role: "assistant", content: "a5" }, // 5
    big("u6"), // 6
    { role: "assistant", content: "a7" }, // 7
    big("u8"), // 8
    { role: "assistant", content: "a9" }, // 9
    big("u10"), // 10
  ]; // len 11 → naive start = 11-8 = 3 (the tool message)
  const out = await compactMessages(msgs, { budget: 5, model: "" });
  const tailStart = out.findIndex((m) => m.content.startsWith("a1 "));
  assert.ok(tailStart !== -1, "assistant that owns the tool result is kept, not summarized away");
  assert.strictEqual(out[tailStart + 1].role, "tool", "its tool result stays attached right after it");
  assert.notStrictEqual(out[1].role === "tool" && out[1].content.startsWith("t2"), true, "tail never opens on a dangling tool");
}

async function cacheHitSummarizesOnce() {
  let calls = 0;
  const countingChat: CompactChatFn = async () => {
    calls++;
    return { choices: [{ message: { content: "brief summary of the middle" } }] };
  };
  const msgs: Message[] = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? big(`u${i}`) : { role: "assistant" as const, content: `a${i} ` + "y".repeat(200) }
    ),
  ];
  const first = await compactMessages(msgs, { budget: 5, model: "tiny", chat: countingChat });
  const second = await compactMessages(msgs, { budget: 5, model: "tiny", chat: countingChat });
  assert.ok(first[1].content.startsWith("Summary of earlier conversation:"), "summary note shape");
  assert.strictEqual(calls, 1, "identical middle → summarizer invoked once (cache hit on second call)");
  assert.strictEqual(second[1].content, first[1].content, "cached summary reused");
}

async function main() {
  await underBudgetPassthrough();
  await truncationFallback();
  await artifactMarkerPreserved();
  await toolPairExtension();
  await cacheHitSummarizesOnce();
  console.log("history-compactor.test.ts: all assertions passed");
}

void main();
