import type { Classification } from "../api";

export const CATEGORY_COLORS: Record<string, string> = {
  network: "#3b82f6",
  openshift: "#ef4444",
  windows: "#f59e0b",
  security: "#a855f7",
  monitoring: "#22c55e",
  automation: "#06b6d4",
  general: "#94a3b8",
};

export function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? "#94a3b8";
}

/** Map the relay's `reasoning` string to a short, friendly tier label. */
export function tierLabel(reasoning?: string): string {
  if (!reasoning) return "—";
  if (reasoning === "provenance") return "Provenance";
  if (reasoning === "keyword fast-path") return "Keyword";
  if (reasoning === "llm+keyword agree") return "LLM + keyword";
  if (reasoning.startsWith("keyword override")) return "Keyword override";
  if (reasoning === "llm") return "LLM";
  if (reasoning.startsWith("keyword (")) return "Keyword (fallback)";
  if (reasoning.startsWith("classifier unavailable")) return "Fallback";
  return reasoning;
}

function confidenceColor(conf: number): string {
  if (conf >= 0.75) return "#22c55e";
  if (conf >= 0.5) return "#f59e0b";
  return "#ef4444";
}

function shortModel(model?: string | null): string {
  if (!model) return "—";
  return model.split("/").pop() ?? model;
}

export function RoutingBadge({ c }: { c: Classification }) {
  const color = categoryColor(c.category);
  const conf = Math.round((c.confidence ?? 0) * 100);
  return (
    <div className="routing">
      <span className="chip" style={{ background: color }}>
        {c.category}
      </span>
      <span className="routing-model" title="model the gateway routed to">
        {shortModel(c.recommended_model)}
      </span>
      {c.complexity && <span className="routing-complexity">{c.complexity}</span>}
      <span className="routing-tier" title={c.reasoning ?? ""}>
        {tierLabel(c.reasoning)}
      </span>
      <span className="conf">
        <span className="conf-bar">
          <span
            className="conf-fill"
            style={{ width: `${conf}%`, background: confidenceColor(c.confidence ?? 0) }}
          />
        </span>
        <span className="conf-num">{conf}%</span>
      </span>
    </div>
  );
}
