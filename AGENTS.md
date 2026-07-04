# LLM Relay — agent guide

On-prem relay between clients (CLI / web / OpenAI SDK / Open WebUI) and LM Studio (`:1234`).
Routes each query to the best local model via a 3-tier classifier. No cloud, no data leaves the network.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Fastify bootstrap (`:3100`), CORS, rate limit, auth hook, model warm-up |
| `src/services/routing/engine.ts` | Generic classifier engine — tiers, cache, keyword matcher. Category-agnostic |
| `src/services/routing/infra-taxonomy.ts` | THE source of truth: categories, keywords, aliases, provenance, routing targets |
| `src/services/classifier.ts` | Binds engine + taxonomy + config; `resolveRoutedModel` |
| `src/services/lmStudio.ts` | OpenAI SDK client for LM Studio; `chat` / `chatStream` / `listModels` |
| `src/routes/` | `compute` (direct/auto/pinned/async), `openai` (`/v1/chat/completions`), `parse`, `remote`, `models`, `metrics`, `webhooks` |
| `client/` | Python CLI (`main.py chat`), parsers (pcap/evtx/switch), remote fetcher |
| `web/` | Vite/React console |
| `grafana/` | Prometheus + Grafana docker-compose, auto-provisioned dashboard |

## Commands

```bash
npm run dev                                   # relay on :3100 (needs LM Studio on :1234)
npx tsc --noEmit                              # typecheck — must pass before any commit
ROUTE_DEFAULT=gemma ROUTE_OPENSHIFT=phi ROUTE_WINDOWS=phi ROUTE_NETWORK=phi \
ROUTE_MONITORING=phi ROUTE_SECURITY=qwen ROUTE_AUTOMATION=qwen \
npx tsx alias-normalization.test.ts           # engine test, no LM Studio needed
CLASSIFIER_ENABLED=true npx tsx tests/eval.ts tests/results_A.json   # router eval (needs LM Studio)
```

Tests are plain `assert` scripts run with `npx tsx` — no test framework. Keep it that way.

## How routing decides (don't re-invent this)

Tier 0 provenance (uploaded artifact type → category, confidence 1.0) → cache (60s TTL, 1000-entry FIFO)
→ Tier 1 keyword fast-path (span-claiming, longest-phrase-first) → Tier 2 LLM (single strong pass,
alias-normalized before zod, AbortController-cancelled on timeout).

Rules encoded in comments — respect them:
- Routes must **trust `recommended_model`** — never re-gate on the raw confidence scalar
  (kwConfidence's 0.6 base is not comparable to the threshold; see `resolveRoutedModel`).
- Second-stage selector (`CLASSIFIER_FALLBACK_MODEL`) is **off by default** — only useful with a weak primary.
- `simple` complexity never downgrades a domain query to the tiny model — only trivial `general`.
- New category/keyword/alias? Edit **only** `infra-taxonomy.ts`; prompt, alias map, provenance map derive from it.

## Conventions

- Ponytail/minimal style: no new dependencies, no speculative abstraction, shortest working diff.
  Non-obvious decisions live in code comments (read them before "fixing" something).
- Model IDs must match LM Studio's `GET /models` output exactly.
- Streaming writes to `reply.raw` bypass Fastify's send path — CORS header must be set manually,
  and errors must be caught in-route (headers already flushed → Fastify handler would crash).
- Token metrics: prefer the real `usage` chunk (`stream_options: { include_usage: true }`); the
  per-delta count is a fallback only.
- Credentials (`/remote`) go to the Python fetcher over **stdin only** — never argv, logs, or disk.
- Warm models **sequentially** — two concurrent cold loads race and LM Studio cancels one.

## Gotchas

- `.env` drives everything (`src/config/index.ts`); empty route values are valid (feature off).
- Classifier cache key is the **last user message only** — by design.
- `/parse` shells out to `client/.venv/bin/python` (override with `PARSER_PYTHON`).
- Grafana dashboard is auto-provisioned; edit `grafana/dashboard.json`, never hand-import.
- History compaction (`historyCompactor.ts`) runs on every chat route before classify/chat: over `HISTORY_BUDGET_TOKENS` (default 3000, `0` off) it summarizes the middle with the tiny `ROUTE_SIMPLE` model, keeping system + last 4 turns; artifact `hash=` markers are preserved and it falls back to plain truncation — never fails the request.
- **PRE-SAAS BLOCKER**: artifact store, classification cache, and summary cache are global in-memory — any client can `retrieve_artifact` any hash. Single-tenant by design. Before multi-user: namespace all three by tenant/API key (see ROADMAP.md).

## Scope rule

Do NOT build SaaS plumbing here (auth systems, billing, job queues, multi-provider, guardrails).
That layer is adopted, not written — LiteLLM Gateway in front, TashAI stays the routing/compression core.
See ROADMAP.md for the phased plan.
