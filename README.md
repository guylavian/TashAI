# LLM Relay

On-premise AI relay server for enterprise infrastructure teams. Sits between your tools and [LM Studio](https://lmstudio.ai/), routing each query to the most appropriate local model based on domain and complexity — no GPU, no cloud, no data leaving the network.

## Architecture

```
Your tools / Python client
         │
         ▼
   LLM Relay (Fastify/TS)  :3100
         │
    ┌────┴────────────────────────────────────────┐
    │          SLLM Router (phi-3.5-mini)         │
    │  Classifies domain + complexity in ~300ms   │
    └────┬──────┬──────┬──────┬──────┬────────────┘
         │      │      │      │      │
      network  ocp  windows secur  auto   → model
         │      │      │      │      │
    phi-3.5  phi-3.5 phi-3.5 qwen  qwen   (LM Studio)
```

### Routing logic

| Category | Keywords | Model |
|---|---|---|
| `network` | Cisco, Checkpoint, PaloAlto, Juniper, Alteon, F5, VLANs, BGP | phi-3.5-mini |
| `openshift` | OpenShift/OCP, pods, DeploymentConfig, oc CLI, Helm | phi-3.5-mini |
| `windows` | Active Directory, GPO, SCCM, Exchange, DFSR, SCOM | phi-3.5-mini |
| `security` | QRadar, Trellix, malware, brute-force, CVEs, threat hunting | qwen2.5-coder-7b |
| `monitoring` | Prometheus, Splunk, Omnibus, Grafana, alert rules | phi-3.5-mini |
| `automation` | Ansible, Terraform, CI/CD, Red Hat Satellite, scripts | qwen2.5-coder-7b |
| `general` | VMware, NetApp, Kafka, Redis, MongoDB, RHBK, RHEL | gemma-4 (default) |

Complexity overrides: `simple` → lfm2.5-1.2b (fast path), `complex` → qwen2.5-coder-7b.

Keyword fallback activates when model confidence is below threshold.

## Prerequisites

- [LM Studio](https://lmstudio.ai/) running locally on port 1234
- Node.js 20+
- Python 3.11+ (for the CLI client)

### Models to load in LM Studio

| Model | Size | Role |
|---|---|---|
| `liquid/lfm2.5-1.2b` | ~0.8 GB | Fast path for simple queries |
| `phi-3.5-mini-instruct` (Q4_K_M) | ~2.2 GB | Classifier + network/ocp/windows/monitoring |
| `qwen2.5-coder-7b-instruct` (Q4_K_M) | ~4.4 GB | Security + automation + complex queries |
| `google/gemma-4-e4b` | ~8 GB | Default fallback |

## Setup

### Server

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

Response includes `classification` — which domain/complexity was detected and which model answered:

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

### Route to a specific model

```
POST /compute/:modelId
```

```
POST /compute/qwen2.5-coder-7b-instruct
```

### OpenAI-compatible endpoint

```
POST /v1/chat/completions
```

Pass `"model": "auto"` to trigger routing. Compatible with any OpenAI SDK client — point `base_url` at `http://localhost:3100/v1`.

### Other endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Server + LM Studio status |
| GET | `/models` | List models loaded in LM Studio |
| POST | `/compute/async` | Fire-and-forget with webhook callback |
| GET/POST/DELETE | `/webhooks` | Manage webhook subscriptions |

## Python CLI client

Analyzes infrastructure artifacts and routes them through the relay.

```bash
cd client

# Analyze Linux/Windows logs
.venv/bin/python main.py logs path/to/auth.log

# Parse a PCAP file
.venv/bin/python main.py pcap path/to/capture.pcap

# Check switch configuration
.venv/bin/python main.py switch --host 10.0.0.1 --user admin
```

Each command shows which model answered and token usage.

## Test the router

```bash
cd client && .venv/bin/python ../test_router.py
```

Runs 12 queries covering all 6 infra categories and prints a routing accuracy table.

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
