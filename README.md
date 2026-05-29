# LLM Relay

On-premise AI relay server for enterprise infrastructure teams. Sits between your tools and [LM Studio](https://lmstudio.ai/), routing each query to the most appropriate local model based on domain and complexity — no GPU, no cloud, no data leaving the network.

## Architecture

```
CLI chat / Python client / OpenAI SDK
              │
              ▼
     LLM Relay (Fastify/TS)  :3100
              │
    ┌─────────┴──────────────────────────────────────────┐
    │         SLLM Classifier (phi-3.5-mini)             │
    │  Classifies domain + complexity · keyword fallback │
    └──┬────────┬─────────┬────────┬────────┬────────────┘
       │        │         │        │        │
    network  openshift  windows  security  auto/general
       │        │         │        │        │
   phi-3.5  phi-3.5   phi-3.5   qwen-7b  gemma-4    (LM Studio :1234)
```

### Routing table

| Category | Signals | Model |
|---|---|---|
| `network` | Cisco, Checkpoint, PaloAlto, Juniper, Alteon, F5, VLANs, BGP | phi-3.5-mini |
| `openshift` | OpenShift/OCP, pods, DeploymentConfig, oc CLI, Helm, Routes | phi-3.5-mini |
| `windows` | Active Directory, GPO, SCCM, Exchange, DFSR, SCOM, DC | phi-3.5-mini |
| `security` | QRadar, Trellix, malware, brute-force, CVEs, threat hunting | qwen2.5-coder-7b |
| `monitoring` | Prometheus, Splunk, Omnibus, Grafana, alert rules, SLOs | phi-3.5-mini |
| `automation` | Ansible, Terraform, CI/CD, Red Hat Satellite, scripts | qwen2.5-coder-7b |
| `general` | VMware, NetApp, Kafka, Redis, MongoDB, RHBK, RHEL | gemma-4 (default) |

Complexity overrides: `simple` → lfm2.5-1.2b (fast path), `complex` → qwen2.5-coder-7b.

Keyword fallback activates when classifier confidence is below threshold.

## Prerequisites

- [LM Studio](https://lmstudio.ai/) running locally on port 1234
- Node.js 20+
- Python 3.11+ (for the CLI client)
- Docker + Docker Compose (for Prometheus + Grafana)

### Models to load in LM Studio

| Model | Size | Role |
|---|---|---|
| `liquid/lfm2.5-1.2b` | ~0.8 GB | Fast path for simple queries |
| `phi-3.5-mini-instruct` (Q4_K_M) | ~2.2 GB | Classifier + network/openshift/windows/monitoring |
| `qwen2.5-coder-7b-instruct` (Q4_K_M) | ~4.4 GB | Security + automation + complex queries |
| `google/gemma-4-e4b` | ~8 GB | Default fallback |

## Setup

### Relay server

```bash
npm install
cp .env.example .env   # edit if your LM Studio is on a different IP/port
npm run dev            # starts on port 3100
```

### Python client

```bash
cd client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
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

### Live interactive chat

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

### List available models

```bash
.venv/bin/python main.py models
```

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

Response includes `classification` — domain, complexity, confidence, and which model answered:

```json
{
  "id": "...",
  "model": "phi-3.5-mini-instruct",
  "content": "...",
  "classification": {
    "category": "openshift",
    "complexity": "medium",
    "confidence": 0.92,
    "reasoning": "Pod lifecycle issue in OCP namespace"
  },
  "latency_ms": 1840,
  "usage": { "prompt_tokens": 38, "completion_tokens": 312, "total_tokens": 350 }
}
```

### Other endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/compute/auto` | Auto-route via classifier |
| POST | `/compute/:modelId` | Pin to a specific model |
| POST | `/v1/chat/completions` | OpenAI-compatible (pass `"model": "auto"` to route) |
| POST | `/compute/async` | Fire-and-forget with webhook callback |
| GET | `/health` | Server + LM Studio status |
| GET | `/models` | List models loaded in LM Studio |
| GET | `/metrics` | Prometheus scrape endpoint |
| GET/POST/DELETE | `/webhooks` | Manage webhook subscriptions |

## Observability

The relay exposes Prometheus metrics at `GET /metrics`:

| Metric | Type | Description |
|---|---|---|
| `relay_requests_total` | counter | Requests by `model`, `category`, `status` |
| `relay_tokens_total` | counter | Tokens by `model`, `token_type` (prompt/completion) |
| `relay_request_duration_ms` | histogram | Latency by `model`, `category` |
| `relay_classifier_confidence` | histogram | Classifier confidence by `category` |
| `relay_active_requests` | gauge | In-flight requests |

Grafana dashboard panels: requests/min by model, token consumption rate, category distribution donut, P50/P95 latency, classifier confidence heatmap, cumulative tokens per model.

## Test the router

```bash
cd client && .venv/bin/python ../test_router.py
```

Runs 12 queries across all 6 infra categories and prints a routing accuracy table.

## Configuration

All settings via `.env`:

```ini
PORT=3100
LM_STUDIO_URL=http://localhost:1234/v1

CLASSIFIER_MODEL=phi-3.5-mini-instruct
CLASSIFIER_CONFIDENCE_THRESHOLD=0.75   # below this → keyword fallback

ROUTE_NETWORK=phi-3.5-mini-instruct
ROUTE_OPENSHIFT=phi-3.5-mini-instruct
ROUTE_WINDOWS=phi-3.5-mini-instruct
ROUTE_SECURITY=qwen2.5-coder-7b-instruct
ROUTE_MONITORING=phi-3.5-mini-instruct
ROUTE_AUTOMATION=qwen2.5-coder-7b-instruct
ROUTE_SIMPLE=liquid/lfm2.5-1.2b
ROUTE_COMPLEX=qwen2.5-coder-7b-instruct
ROUTE_DEFAULT=google/gemma-4-e4b
```

Model IDs must match exactly what LM Studio shows in its model list (`GET /models`).
