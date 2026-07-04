/**
 * Generic query-classification ENGINE.
 *
 * Knows nothing about any specific category set. Everything project-specific —
 * the categories, their keywords, the system prompt, the provenance map, and the
 * routing targets — is supplied as a `Taxonomy` (see ./infra-taxonomy.ts for the
 * default). `createClassifier(taxonomy, deps)` derives all five from that single
 * source of truth and returns a bound `{ classify, resolveModel }`.
 *
 * Behavior is identical to the previous hand-wired classifier: Tier 0 provenance
 * → cache → Tier 1 keyword (span-claiming, longest-phrase-first, same-category
 * reinforces / other-category suppresses) → Tier 2 LLM (5s timeout, fence-strip +
 * per-field .catch parsing, agree/override combination).
 */
import crypto from "crypto";
import { z } from "zod";
import type { Message } from "../../types";

// ─── Taxonomy data model ──────────────────────────────────────────────────────
export interface CategoryDef<C extends string = string> {
  id: C;
  description: string;        // goes into the system prompt
  disambiguation?: string;    // e.g. "OpenShift Route = openshift, NOT network"
  aliases?: string[];         // synonyms taught to the LLM ("kubernetes" → openshift)
  keywords: { weight: number; terms: string[] }[];
  sources?: string[];         // provenance aliases (pcap, evtx, …) → this category
  model?: string | null;      // routing target
}

export interface Taxonomy<C extends string = string> {
  categories: CategoryDef<C>[];
  fallbackCategory: C;
  fastPathWeight?: number;    // default 4
  minWeight?: number;         // default 3
  complexity?: { simple?: string | null; complex?: string | null };
}

/**
 * Identity helper that infers the concrete category union `C` from the literal
 * `id` fields, so a project taxonomy keeps a strong union while the engine stays
 * string-generic.
 */
export function defineTaxonomy<C extends string>(t: Taxonomy<C>): Taxonomy<C> {
  return t;
}

// ─── Injected dependencies ────────────────────────────────────────────────────
export type ChatFn = (
  model: string,
  messages: Message[],
  opts: { temperature?: number; max_tokens?: number; signal?: AbortSignal }
) => Promise<{ choices: Array<{ message?: { content?: string | null } | null }> }>;

export interface ClassifierConfig {
  enabled: boolean;
  model: string;
  maxTokens: number;
  confidenceThreshold: number;
  timeoutMs?: number;
  // Optional stronger model used as a second-stage selector when the primary
  // model returns a low-confidence / "general" pick and no keyword matched.
  fallbackModel?: string;
}

export interface EngineDeps {
  chat: ChatFn;
  classifier: ClassifierConfig;
}

// ─── Result shape (generic over the category union) ───────────────────────────
export type Complexity = "simple" | "medium" | "complex";

export interface Classification<C extends string = string> {
  category: C;
  complexity: Complexity;
  recommended_model: string | null;
  confidence: number;
  reasoning?: string;
}

const CACHE_TTL_MS = 60_000;
// Cap entries so the cache can't grow unbounded — every unique query content is a
// new SHA-1 key, and the TTL alone never evicts (it's only checked on read).
const CACHE_MAX_ENTRIES = 1000;
const CLASSIFIER_TIMEOUT_MS = 5_000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Engine factory ───────────────────────────────────────────────────────────
export function createClassifier<C extends string>(taxonomy: Taxonomy<C>, deps: EngineDeps) {
  const ids = taxonomy.categories.map((c) => c.id);
  const fallback = taxonomy.fallbackCategory;
  const fastPathWeight = taxonomy.fastPathWeight ?? 4;
  const minWeight = taxonomy.minWeight ?? 3;

  // SYSTEM_PROMPT — derived from the taxonomy (enum line + per-category bullets).
  const systemPrompt =
    `You are an ultra-fast query classifier for an enterprise infrastructure team.\n` +
    `Classify the last user message. Respond ONLY with compact JSON, no prose, no markdown fences:\n` +
    `{"category":"${ids.join("|")}","complexity":"simple|medium|complex","confidence":<0.0-1.0>}\n\n` +
    `Categories:\n` +
    taxonomy.categories
      .map((c) => {
        const aliases = c.aliases?.length ? ` (also covers: ${c.aliases.join(", ")})` : "";
        return `- ${c.id}: ${c.description}${c.disambiguation ? " " + c.disambiguation : ""}${aliases}`;
      })
      .join("\n") +
    `\n\nUse EXACTLY one of the ${ids.length} category values above — never invent a new one. ` +
    `If the query does not fit, use "${fallback}".\n\n` +
    `Complexity: simple (single resource, direct, trivial) | medium (multi-step/cross-domain) | complex (fleet-wide, incident, correlation).`;

  // Zod schema — runtime enum from ids, each field individually fault-tolerant.
  const schema = z.object({
    category: z.enum(ids as [C, ...C[]]).catch(fallback),
    complexity: z.enum(["simple", "medium", "complex"]).catch("medium"),
    confidence: z.number().min(0).max(1).catch(0.5),
  });

  // ALIAS_TO_ID — recover near-miss LLM category values BEFORE zod validation.
  // The prompt teaches aliases ("openshift … also covers: kubernetes, k8s"), and
  // small models echo the alias as the category, or vary case/punctuation
  // ("Openshift", "open_shift"). Without this, z.enum(...).catch(fallback) would
  // silently coerce a correct-in-spirit pick to the fallback — keeping the
  // model's (often high) confidence, so the misroute hides in the metrics too.
  // Derived from the taxonomy, so adding a category/alias updates it for free.
  const compactKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliasToId = new Map<string, C>();
  for (const c of taxonomy.categories) {
    aliasToId.set(compactKey(c.id), c.id);
    for (const a of c.aliases ?? []) {
      const k = compactKey(a);
      if (k && !aliasToId.has(k)) aliasToId.set(k, c.id); // never override a real id
    }
  }
  const normalizeCategory = (value: unknown): unknown =>
    typeof value === "string" ? aliasToId.get(compactKey(value)) ?? value : value;

  // FLAT_TERMS — longest phrase first, per-term global regex with word boundary.
  const flatTerms = taxonomy.categories
    .flatMap((c) =>
      c.keywords.flatMap((k) =>
        k.terms.map((term) => ({
          category: c.id,
          weight: k.weight,
          term,
          re: new RegExp(`(?<![a-z0-9])${escapeRe(term)}`, "gi"),
        }))
      )
    )
    .sort((a, b) => b.term.length - a.term.length);

  // SOURCE_TO_CATEGORY — reduced over categories[].sources.
  const sourceMap: Record<string, C> = {};
  for (const c of taxonomy.categories) for (const s of c.sources ?? []) sourceMap[s] = c.id;

  // Category → model map; fallback model = the fallback category's model.
  const modelMap: Record<string, string | null | undefined> = {};
  for (const c of taxonomy.categories) modelMap[c.id] = c.model;
  const fallbackModel = modelMap[fallback] ?? null;

  const cache = new Map<string, { result: Classification<C>; ts: number }>();

  // Tenant is folded into the key so one tenant's cached classification is never
  // served to another (the cache is a shared in-memory Map across all requests).
  function cacheKey(content: string, tenant: string): string {
    return crypto.createHash("sha1").update(`${tenant}:${content.length}:${content}`).digest("hex");
  }

  function cacheGet(key: string): Classification<C> | null {
    const hit = cache.get(key);
    if (!hit) return null;
    // Evict on read once stale, so expired entries don't linger until overwritten.
    if (Date.now() - hit.ts >= CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return hit.result;
  }

  function cacheSet(key: string, result: Classification<C>): void {
    cache.set(key, { result, ts: Date.now() });
    // Map preserves insertion order, so the first key is the oldest — evict it
    // when over the cap (simple FIFO bound; the TTL handles staleness).
    if (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  type KwHit = { category: C; score: number; margin: number };

  function keywordPreClassify(text: string): KwHit | null {
    const lower = text.toLowerCase();
    const scores = new Map<C, number>();
    const claimed: { start: number; end: number; category: C }[] = [];

    for (const t of flatTerms) {
      t.re.lastIndex = 0;
      let matched = false;
      let m: RegExpExecArray | null;
      while ((m = t.re.exec(lower)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        // Suppress a substring term only when it sits inside a span already claimed
        // by a DIFFERENT category (cross-category), e.g. "sccm" within "sccm task
        // sequence". Same-category overlaps still reinforce.
        const coveredByOther = claimed.some(
          (s) => s.category !== t.category && start >= s.start && end <= s.end
        );
        if (coveredByOther) continue;
        matched = true;
        claimed.push({ start, end, category: t.category });
      }
      if (matched) scores.set(t.category, (scores.get(t.category) ?? 0) + t.weight);
    }
    if (scores.size === 0) return null;

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [bestCat, bestScore] = ranked[0];
    const second = ranked[1]?.[1] ?? 0;
    if (bestScore < minWeight) return null;
    return { category: bestCat, score: bestScore, margin: bestScore - second };
  }

  function kwConfidence(hit: KwHit): number {
    return Math.min(1, 0.6 + hit.margin / 10);
  }

  function resolveModel(category: C, complexity: Complexity): string | null {
    // Complex tasks always go to the strongest model, regardless of domain.
    if (complexity === "complex" && taxonomy.complexity?.complex) return taxonomy.complexity.complex;
    // The fast "simple" model is reserved for trivial *general* questions
    // ("what port is SSH?"). A domain task (openshift/network/windows/…) must
    // never be downgraded to it just because the classifier tagged it simple —
    // it gets its category model. Category precedence over `simple`.
    if (complexity === "simple" && category === fallback && taxonomy.complexity?.simple) {
      return taxonomy.complexity.simple;
    }
    return modelMap[category] || fallbackModel || null;
  }

  function parseClassifierJson(raw: string): z.infer<typeof schema> | null {
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]) as unknown;
      // Map alias / case / punctuation variants back to a canonical id before
      // zod, so a "correct in spirit" pick isn't silently coerced to fallback.
      if (obj && typeof obj === "object") {
        const rec = obj as Record<string, unknown>;
        rec.category = normalizeCategory(rec.category);
      }
      const parsed = schema.safeParse(obj);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function kwResult(kw: KwHit, reasoning: string): Classification<C> {
    return {
      category: kw.category,
      complexity: "medium",
      confidence: kwConfidence(kw),
      recommended_model: resolveModel(kw.category, "medium"),
      reasoning,
    };
  }

  function fallbackClassification(): Classification<C> {
    return {
      category: fallback,
      complexity: "medium",
      confidence: 0,
      recommended_model: fallbackModel,
      reasoning: "classifier unavailable — using defaults",
    };
  }

  function extractLastUserContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return messages[messages.length - 1].content;
  }

  // One LLM classification attempt with the given model. Returns parsed JSON or
  // null (timeout / error / unparseable). Used for both the fast primary model
  // and the optional second-stage selector.
  async function tryClassify(model: string, content: string): Promise<z.infer<typeof schema> | null> {
    // Drive an AbortController off the timeout so the underlying LM Studio request
    // is actually cancelled — a bare Promise.race left the call running in the
    // background, leaking in-flight requests during slow cold model loads.
    const controller = new AbortController();
    const ms = deps.classifier.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const completion = await deps.chat(
        model,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
        { temperature: 0.1, max_tokens: Math.min(deps.classifier.maxTokens, 60), signal: controller.signal }
      );
      return parseClassifierJson(completion.choices[0]?.message?.content ?? "");
    } catch {
      return null; // timeout/abort/parse error all collapse to "no result"
    } finally {
      clearTimeout(timer);
    }
  }

  async function classify(messages: Message[], source?: string, tenant = "default"): Promise<Classification<C>> {
    // Tier 0 — provenance.
    if (source && sourceMap[source]) {
      const category = sourceMap[source];
      return {
        category,
        complexity: "medium",
        confidence: 1,
        recommended_model: resolveModel(category, "medium"),
        reasoning: "provenance",
      };
    }

    const lastContent = extractLastUserContent(messages);
    const key = cacheKey(lastContent, tenant);
    const cached = cacheGet(key);
    if (cached) return cached;

    const kw = keywordPreClassify(lastContent);

    // Tier 1 — keyword fast-path.
    if (kw && kw.score >= fastPathWeight) {
      const result: Classification<C> = {
        category: kw.category,
        complexity: "medium",
        confidence: kwConfidence(kw),
        recommended_model: resolveModel(kw.category, "medium"),
        reasoning: "keyword fast-path",
      };
      cacheSet(key, result);
      return result;
    }

    // Tier 2 — LLM (only if enabled).
    if (!deps.classifier.enabled || !deps.classifier.model) {
      return kw ? kwResult(kw, "keyword (classifier disabled)") : fallbackClassification();
    }

    // Stage 1 — fast primary classifier.
    let parsed = await tryClassify(deps.classifier.model, lastContent);
    let stage = "llm";

    // Stage 2 — second-stage selector (option B): when stage 1 *answered* but is
    // unsure (low confidence or "general") and no keyword matched, ask a stronger
    // model to re-pick. Deliberately NOT triggered on a stage-1 failure (null) —
    // if the fast model is down the stronger one likely is too, and we don't want
    // to stack a second timeout onto an outage.
    // Escalate to the stronger model when the fast model is low-confidence OR
    // lands on "general" — small models confidently dump implicit domain queries
    // ("container OOMKilled" → openshift) into the catch-all. The stronger model
    // is a far better classifier; if it names a *specific* category, take it.
    // Truly-general queries cost one extra call but stay general (no adoption).
    const fbModel = deps.classifier.fallbackModel;
    const unsure =
      !!parsed && (parsed.confidence < deps.classifier.confidenceThreshold || parsed.category === fallback);
    if (unsure && !kw && fbModel && fbModel !== deps.classifier.model) {
      const parsed2 = await tryClassify(fbModel, lastContent);
      if (parsed2 && parsed2.category !== fallback) {
        parsed = parsed2;
        stage = "llm (second-stage)";
      }
    }

    if (!parsed) {
      return kw ? kwResult(kw, "keyword (LLM unavailable)") : fallbackClassification();
    }

    let category = parsed.category as C;
    let confidence = parsed.confidence;
    let reasoning = stage;

    if (kw) {
      if (kw.category === category) {
        confidence = Math.min(1, Math.max(confidence, kwConfidence(kw)) + 0.1);
        reasoning = stage === "llm" ? "llm+keyword agree" : `${stage}+keyword agree`;
      } else if (kw.score >= 3 && (confidence < deps.classifier.confidenceThreshold || category === fallback)) {
        category = kw.category;
        confidence = kwConfidence(kw);
        reasoning = "keyword override (llm uncertain)";
      }
    }

    const result: Classification<C> = {
      category,
      complexity: parsed.complexity,
      confidence,
      recommended_model: resolveModel(category, parsed.complexity),
      reasoning,
    };
    cacheSet(key, result);
    return result;
  }

  return { classify, resolveModel };
}
