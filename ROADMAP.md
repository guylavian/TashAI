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
- [ ] **Fix the pre-SaaS blocker**: namespace artifact store + classification cache + summary cache by tenant (trusted `x-tenant-id` header from the gateway)
- [ ] Deploy **LiteLLM Gateway** in front of the relay: per-user/team API keys, budgets & quotas, usage metering (billing), audit log to Postgres, per-tenant model allowlists. TashAI registers as an upstream model.
- [ ] Persist `routingDecisionLog` output per-tenant (it already carries category/model/confidence/reasoning — that IS the audit trail)

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
