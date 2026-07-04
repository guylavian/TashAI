# LLM Relay

On-premise AI relay server for enterprise infrastructure teams. Sits between your tools and [LM Studio](https://lmstudio.ai/), routing each query to the most appropriate local model based on domain and complexity — no GPU rental, no cloud, no data leaving the network.

## Architecture

```
CLI chat · Web console · OpenAI SDK · Open WebUI
              │
              ▼
     LLM Relay (Fastify/TS)  :3100
              │
   Generic classifier engine bound to an infra taxonomy
   Tier 0 provenance  →  Tier 1 keyword  →  Tier 2 LLM (qwen-7b, single pass)
              │
   network  openshift  windows  security  monitoring  automation  general
      │         │         │         │          │           │          │
    phi      qwen-7b    phi      qwen-7b      phi        qwen-7b    gemma-4     (LM Studio :1234)
```

### How routing decides

The classifier is a generic engine (`src/services/routing/engine.ts`) driven entirely by a project taxonomy (`infra-taxonomy.ts`) — categories, keywords, aliases, provenance map and routing targets all come from that one source of truth. Three tiers, cheapest first:

- **Tier 0 — provenance** (zero cost): an uploaded artifact's type routes directly. A `.pcap` → `network`, a `.evtx` / Windows event log → `windows`. Confidence 1.0, no model call.
- **Tier 1 — keyword fast-path** (zero LLM cost): an org-specific term match (e.g. `deploymentconfig`, `get-winevent`, `qradar`) routes immediately.
- **Tier 2 — LLM classifier**: when no keyword matches, a strong model (qwen) classifies in a single pass. Being strong, it connects implicit phrasing on the first try ("computer object" → `windows`, "container OOMKilled" → `openshift`) where smaller models confidently misfile to `general`. Aliases taught to the model (e.g. `kubernetes` → `openshift`) are normalized back to canonical categories. Below the confidence threshold it falls back to `ROUTE_DEFAULT`.

> The engine also supports an optional **second-stage selector** (`CLASSIFIER_FALLBACK_MODEL`): a stronger model re-checks an unsure/`general` pick. That's only worthwhile with a *weak* primary classifier — with qwen as primary it's left disabled (there's no stronger model to escalate to).

Results are cached (60 s TTL, bounded) so repeated queries skip classification entirely.

### Routing table

| Category | Signals | Model |
|---|---|---|
| `network` | Cisco, Checkpoint, PaloAlto, Juniper, Alteon, F5, VLANs, BGP, HSRP, Nexus, FortiGate | phi-3.5-mini |
| `openshift` | OpenShift/OCP, **Kubernetes/k8s**, pods, DeploymentConfig, oc/kubectl, Helm, Routes | qwen2.5-coder-7b |
| `windows` | Active Directory, GPO, SCCM, Exchange, DFSR, SCOM, DC, Kerberos, LDAP, ADFS | phi-3.5-mini |
| `security` | QRadar, Trellix, malware, brute-force, CVEs, EDR/SIEM, threat hunting | qwen2.5-coder-7b |
| `monitoring` | Prometheus, Splunk, Omnibus, Grafana, PromQL, Thanos, alert rules, SLOs | phi-3.5-mini |
| `automation` | Ansible, Terraform, CI/CD, Satellite, Jenkins, AWX, GitOps, scripts | qwen2.5-coder-7b |
| `general` | VMware, NetApp, Kafka, Redis, MongoDB, RHBK, RHEL, anything else | gemma-4 (default) |

Complexity overrides: `complex` → qwen2.5-coder-7b (any domain); `simple` → lfm2.5-1.2b, but **only for trivial `general` questions** — a domain task is never downgraded to the tiny model.

## Prerequisites

- [LM Studio](https://lmstudio.ai/) running locally on port 1234
- Node.js 20+
- Python 3.11+ (for the CLI client and the `/parse` + `/remote` parsers)
- Docker + Docker Compose (for Prometheus + Grafana)

### Models to load in LM Studio

| Model | Size | Role |
|---|---|---|
| `liquid/lfm2.5-1.2b` | ~0.8 GB | Fast path for trivial general queries |
| `phi-3.5-mini-instruct` (Q4_K_M) | ~2.2 GB | network / windows / monitoring |
| `qwen2.5-coder-7b-instruct` (Q4_K_M) | ~4.4 GB | **Classifier** + openshift / security / automation / complex |
| `google/gemma-4-e4b` | ~8 GB | Default fallback (`general`) |

Tip: keep the classifier (qwen) **loaded** in LM Studio. The relay also warms hot-path models sequentially on boot, but keeping qwen resident avoids cold-load latency on the first keyword-miss query.

## Setup

### Relay server

```bash
npm install
cp .env.example .env   # edit if your LM Studio is on a different IP/port
npm run dev            # starts on port 3100
```

Or containerized (Node relay + Python parsers in one image; works with the Grafana stack unchanged):

```bash
docker compose up -d --build   # relay on :3100, LM Studio reached via host.docker.internal
```

### Web console

```bash
cd web
npm install
npm run dev            # Vite dev server; talks to the relay on :3100
```

Streaming chat with a routing badge (which category/model/confidence answered), file attachments (wired to `/parse`), and a remote-log fetch panel (wired to `/remote`).

### Python client

```bash
cd client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # includes scapy, python-evtx, paramiko, pywinrm
cp .env.example .env
```

### Monitoring (Prometheus + Grafana)

```bash
cd grafana
docker compose up -d
```

- Prometheus → http://localhost:9090
- Grafana → http://localhost:3000 (admin / admin)

The dashboard loads automatically. No manual import needed.

## Usage

### Live interactive chat (CLI)

```bash
cd client
.venv/bin/python main.py chat
```

- Queries auto-routed to the best model
- Streaming output with Markdown rendering
- Conversation history across sessions (↑/↓ arrow keys)
- Attach local files inline with `@`:

```
>> analyze @/var/log/auth.log for brute force indicators
>> what issues do you see in @~/switch-backup.txt
>> diff @/etc/nginx/nginx.conf and @/tmp/nginx.new.conf
```

Supported file types: text/log files (inline), `.pcap`/`.pcapng` (parsed via Scapy), `.evtx` (parsed Windows event logs).

Chat commands: `/clear`, `/history`, `/models`, `/help`, `/exit`

> The CLI only executes a suggested shell command from an explicitly shell-tagged code fence, after a y/N prompt — model prose and markdown are never run.

### Analyze infrastructure artifacts

```bash
# Linux/Windows logs
.venv/bin/python main.py logs path/to/auth.log
.venv/bin/python main.py logs path/to/Security.evtx --os windows

# Packet captures
.venv/bin/python main.py pcap path/to/capture.pcap

# Switch/router configuration
.venv/bin/python main.py switch --host 10.0.0.1 --user admin --password secret
.venv/bin/python main.py switch --file path/to/running-config.txt
```

Each command shows which model answered and token usage.

## API

### Auto-routed completion (recommended)

```
POST /compute/auto
```

```json
{
  "messages": [{ "role": "user", "content": "Why are pods in the payments project in CrashLoopBackOff?" }],
  "max_tokens": 2048
}
```

Response includes `classification` — domain, complexity, confidence, the model that answered, and `reasoning` (the tier/stage that decided: `provenance`, `keyword fast-path`, `llm`, `llm (second-stage)`, …):

```json
{
  "id": "...",
  "model": "qwen2.5-coder-7b-instruct",
  "content": "...",
  "classification": {
    "category": "openshift",
    "complexity": "medium",
    "confidence": 0.92,
    "recommended_model": "qwen2.5-coder-7b-instruct",
    "reasoning": "keyword fast-path"
  },
  "latency_ms": 1840,
  "usage": { "prompt_tokens": 38, "completion_tokens": 312, "total_tokens": 350 }
}
```

### File ingestion & remote log fetch

```
POST /parse           # upload a raw artifact → LLM-ready text + provenance source
POST /remote          # fetch logs from a remote host (SSH or WinRM)
```

`/parse` accepts a raw `application/octet-stream` body with `?name=<filename>`; it shells out to the Python parsers (Scapy for pcap, python-evtx for evtx, switch-config parser) and returns parsed text plus a `source` that drives Tier-0 routing. `/remote` fetches logs over SSH (paramiko) or Windows Event Logs over WinRM (pywinrm); credentials are piped to the fetcher over stdin and never written to argv, logs or disk.

Set `RELAY_API_KEY` to require `Authorization: Bearer <key>` on every route except `GET /health` and `GET /metrics` (the gateway presents this key). Empty (default) leaves the relay open for standalone dev.

#### Artifact offload

Parsed text over ~4000 chars is not pasted whole into context. `/parse` stores the full text in an in-memory, TTL'd store (keyed by SHA-1) and returns a compact digest (first ~60 lines) plus `artifact_hash`. When a later message references `hash=<40-hex>`, the chat routes (`/compute*`, `/v1/chat/completions`) inject a `retrieve_artifact({hash, query})` tool and run a short tool loop so the model pulls only the slices it needs — instead of re-sending the whole artifact every turn. Estimated tokens saved are exported as `relay_tokens_saved_total{reason="artifact_digest"|"artifact_slice"}`.

#### History compaction

Clients resend the whole conversation every turn, which bloats context and slows small local models. Before classification/chat, every chat route runs `compactMessages`: under `HISTORY_BUDGET_TOKENS` (chars/4, default 3000, `0` disables) it's a zero-overhead passthrough; over budget it keeps the leading system message(s) + last 4 turns verbatim and replaces the middle with one `Summary of earlier conversation: …` system message produced by the tiny `ROUTE_SIMPLE` model (temperature 0, 10s timeout). If that model is unset or the summarize call fails it falls back to plain truncation (`[earlier N messages omitted]`) — compaction never fails the request. Artifact `hash=<40-hex>` markers in dropped messages are re-attached so `retrieve_artifact` still works. Summaries are cached (SHA-1 of the collapsed prefix). Savings export as `relay_tokens_saved_total{reason="history_compaction"}`.

### Other endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/compute/auto` | Auto-route via classifier |
| POST | `/compute/:modelId` | Pin to a specific model |
| POST | `/compute` | Direct (model required in body) |
| POST | `/v1/chat/completions` | OpenAI-compatible (pass `"model": "auto"` to route; tool-calling passed through) |
| POST | `/parse` | Parse an uploaded pcap/evtx/log/config artifact |
| POST | `/remote` | Fetch remote logs via SSH / WinRM |
| GET | `/health` | Server + LM Studio status |
| GET | `/models` | List models loaded in LM Studio (short-TTL cached) |
| GET | `/metrics` | Prometheus scrape endpoint |

## Gateway (SaaS mode)

For multi-user deployments the relay sits behind a **LiteLLM Gateway**, which owns per-user API keys, budgets/quotas, rate limits and usage logging (Postgres). The relay stays the trusted routing/compression upstream and only needs to know which end-user each request belongs to.

```
user (sk-user-key) → LiteLLM Gateway (:4000) → TashAI relay (:3100) → models
```

```bash
# 1. Set RELAY_API_KEY in the relay's .env (the gateway presents it as the bearer);
#    when set it guards every route except GET /health and GET /metrics.
# 2. Start the gateway (LiteLLM + Postgres). Relay reached via host.docker.internal.
cd gateway
LITELLM_MASTER_KEY=sk-master RELAY_API_KEY=<same-as-relay> docker compose up -d

# 3. Mint a per-user virtual key (budget/quota enforced by the gateway)
curl http://localhost:4000/key/generate \
  -H "Authorization: Bearer sk-master" -H "Content-Type: application/json" \
  -d '{"models":["tashai-auto"],"max_budget":10,"user_id":"alice"}'

# 4. End-user call — the `user` field identifies the tenant to the relay, which
#    namespaces the artifact store and classifier/summary caches by it.
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"tashai-auto","user":"alice","messages":[{"role":"user","content":"why is my pod in CrashLoopBackOff?"}]}'
```

The tenant id also resolves from an `x-user-id` header (which takes priority over the body `user` field).

## Observability

The relay exposes Prometheus metrics at `GET /metrics`:

| Metric | Type | Description |
|---|---|---|
| `relay_requests_total` | counter | Requests by `model`, `category`, `status` |
| `relay_tokens_total` | counter | Tokens by `model`, `token_type` (prompt/completion) — accurate for streamed responses |
| `relay_request_duration_ms` | histogram | Latency by `model`, `category` |
| `relay_classifier_confidence` | histogram | Classifier confidence by `category` |
| `relay_classifier_stage_total` | counter | Decisions by `stage` — `keyword` (0 LLM) · `llm` (1) · `llm_second_stage` (2, the double call) · `provenance` · `fallback` |
| `relay_active_requests` | gauge | In-flight requests |

`relay_classifier_stage_total` lets you watch the share of traffic paying the double-call (gemma + qwen) before deciding whether to optimize it:

```promql
sum(rate(relay_classifier_stage_total{stage="llm_second_stage"}[5m]))
/ sum(rate(relay_classifier_stage_total[5m]))
```

Grafana dashboard panels: requests/min by model, token consumption rate, category distribution donut, P50/P95 latency, classifier confidence heatmap, cumulative tokens per model.

## Test the router

The TypeScript eval harness runs the taxonomy against a labelled set and checks routing behavior:

```bash
# A = classifier enabled, B = keyword-only (deterministic); then the report
CLASSIFIER_ENABLED=true  npx tsx tests/eval.ts tests/results_A.json
CLASSIFIER_ENABLED=false npx tsx tests/eval.ts tests/results_B.json
npx tsx tests/report.ts        # prints accuracy + behavior checks

# Alias normalization (kubernetes → openshift, etc.), no LM Studio needed
ROUTE_DEFAULT=gemma ROUTE_OPENSHIFT=phi ROUTE_WINDOWS=phi ROUTE_NETWORK=phi \
ROUTE_MONITORING=phi ROUTE_SECURITY=qwen ROUTE_AUTOMATION=qwen \
npx tsx alias-normalization.test.ts
```

## Configuration

All settings via `.env`:

```ini
PORT=3100
LM_STUDIO_URL=http://localhost:1234/v1
# Per-model endpoint overrides (e.g. OpenShift AI — each model has its own route + token).
# Models not listed fall back to LM_STUDIO_URL.
MODEL_ENDPOINTS={"qwen2.5-coder-7b-instruct":{"url":"https://qwen.apps.cluster/v1","api_key":"sha256~..."}}

# Classifier — single strong pass (qwen)
CLASSIFIER_MODEL=qwen2.5-coder-7b-instruct       # classifies keyword-miss queries
CLASSIFIER_FALLBACK_MODEL=                        # optional second-stage; only useful with a weak primary
CLASSIFIER_CONFIDENCE_THRESHOLD=0.75             # below this → ROUTE_DEFAULT
CLASSIFIER_TIMEOUT_MS=12000                      # per-attempt timeout (request is aborted on expiry)
CLASSIFIER_MAX_TOKENS=200
CLASSIFIER_ENABLED=true
WARM_MODELS=true                                 # warm hot-path models on boot (set false to skip)

# Routing targets
ROUTE_NETWORK=phi-3.5-mini-instruct
ROUTE_OPENSHIFT=qwen2.5-coder-7b-instruct
ROUTE_WINDOWS=phi-3.5-mini-instruct
ROUTE_SECURITY=qwen2.5-coder-7b-instruct
ROUTE_MONITORING=phi-3.5-mini-instruct
ROUTE_AUTOMATION=qwen2.5-coder-7b-instruct
ROUTE_SIMPLE=liquid/lfm2.5-1.2b
ROUTE_COMPLEX=qwen2.5-coder-7b-instruct
ROUTE_DEFAULT=google/gemma-4-e4b
```

Model IDs must match exactly what LM Studio shows in its model list (`GET /models`).
