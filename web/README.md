# Infrastructure AI Gateway — Web Console

A streaming chat UI for the LLM relay gateway. Every reply shows the **routing
decision**: which category the query was classified as, which model it was routed
to, the tier that decided (provenance / keyword / LLM / fallback), and the
confidence.

## Run

The relay must be running (default `http://localhost:3100`, CORS is open).

```bash
cd web
npm install
npm run dev        # → http://localhost:5173
```

Point at a different relay:

```bash
VITE_RELAY_URL=http://10.0.0.5:3100 npm run dev
```

## Build

```bash
npm run build      # static bundle in dist/
npm run preview    # serve the built bundle
```

## What it talks to

| Call | Endpoint | Purpose |
|---|---|---|
| chat | `POST /compute/auto` (`stream:true`) | streamed reply + `classification` event |
| health | `GET /health` | connection dot + classifier status |
| models | `GET /models` | loaded-model count |

The streaming protocol is the relay's SSE: a `classification` frame first, then
`chunk` frames, then `done` (or `error`).
