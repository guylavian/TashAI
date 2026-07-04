# Roadmap — TashAI as a SaaS (target: ~1000 users) with AI governance

Principle: TashAI's moat is taxonomy routing + artifact intelligence. Everything else
(auth, billing, guardrails, serving) is **adopted, not written**.

## Phase 0 — token efficiency core ✅ (this PR)
- Second-stage classifier off by default (no double LLM call)
- `RELAY_API_KEY` bearer auth on `/remote` + `/parse`
- Artifact offload: `/parse` stores full text by hash, models pull slices via `retrieve_artifact` tool
- History compaction: over-budget conversations summarized by the tiny model
- `relay_tokens_saved_total` metric (Grafana)

## Phase 1 — multi-tenant readiness
- [x] **Fix the pre-SaaS blocker**: artifact store + classification cache + summary cache are namespaced by tenant (`tenantOf`: `x-user-id` header → body `user` → `default`); `RELAY_API_KEY` now guards every route but `/health` + `/metrics`
- [x] **LiteLLM Gateway** relay-side config shipped (`gateway/docker-compose.yml` + `gateway/litellm-config.yaml`): TashAI registered as the `tashai-auto` upstream; per-user keys/budgets/quotas/usage-logging owned by the gateway. (Deploying + wiring real Postgres/keys is ops.)
- [x] `routingDecisionLog` now carries the tenant (`user` field) alongside category/model/confidence/reasoning — that IS the per-tenant audit trail; persisting it to a store is left to the gateway/ops layer

## Phase 2 — AI governance (gateway hook slots, not custom code)
- [ ] **PII detection/redaction**: Microsoft Presidio on inbound prompts, per-tenant toggle (air-gap friendly)
- [ ] **Prompt-injection / jailbreak screening**: LLM Guard (or vLLM Semantic Router's classifier if adopted)
- [ ] **Policy engine per tenant**: allowed models, allowed taxonomy categories (e.g. "tenant X may not use `security` routing"), max tokens, retention period
- [ ] **Transparency/compliance**: per-request "which model answered and why" report from the audit trail (EU-AI-Act-style disclosure)
- [ ] Kill switch + model version pinning (gateway-level)

## Phase 3 — serving at scale: OpenShift AI
Serving is **OpenShift AI** (KServe/vLLM) — each model gets its own inference route + token.
- [x] Relay supports per-model endpoints: `MODEL_ENDPOINTS` JSON (`{"model-id":{"url":"…/v1","api_key":"…"}}`); models not in the map fall back to `LM_STUDIO_URL` (dev)
- [ ] Fill `MODEL_ENDPOINTS` with the real OpenShift AI routes/tokens per routed model (network/openshift/windows/… targets)
- [ ] `GET /models` + warm-up currently only cover the default endpoint — extend if needed once real endpoints are in
- [ ] Evaluate vLLM Semantic Router's **semantic cache** once `relay_requests_total` shows near-duplicate queries across tenants
- [ ] Optional: LLMLingua-2-style token pruning as one extra pass inside `compactMessages()` behind an env flag — only if Grafana shows prompts still fat after compaction

## Decision log
- 2026-07: keep this repo over LiteLLM-auto-routing / vLLM-SR / RouteLLM — none cover
  provenance-tier routing, the infra taxonomy, or artifact parse/offload; plumbing stays frozen here.
- 2026-07: headroom MCP server dropped from the loop — its compress/store/retrieve pattern
  was ported natively into the relay (artifactStore + historyCompactor), where it runs on 100% of prompts.
