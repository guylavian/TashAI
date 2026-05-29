import { config } from "../config";
import { chat } from "./lmStudio";
import type { ClassificationResult, Message } from "../types";

const SYSTEM_PROMPT = `You are an ultra-fast query classifier for an enterprise infrastructure team.
Analyze the last user message and classify it.

Respond ONLY with valid JSON in this exact shape:
{
  "category": "network" | "openshift" | "windows" | "security" | "monitoring" | "automation" | "general",
  "complexity": "simple" | "medium" | "complex",
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one short sentence>"
}

Categories:
- network: Cisco switches/routers, Alteon LB, F5 BigIP/WAF, BGP, OSPF, VLANs, interfaces, ACLs, NAT, err-disabled, spanning-tree. ALSO: Checkpoint/PaloAlto/Juniper when the question is about traffic flow, blocking, routing, or connectivity (not threat analysis).
- openshift: OpenShift OCP pods, deployments, DeploymentConfig, services, RBAC, Helm, oc CLI, projects, namespaces, operators, imagestreams, PVCs. IMPORTANT: "OpenShift Route" = openshift (NOT network routing).
- windows: Active Directory, DC, DNS, DHCP, DFSR, GPO, Windows Server, SCCM, SharePoint, SCOM, Exchange, AD replication, trust, Kerberos. IMPORTANT: AD/DC questions are windows even if they involve authentication failures.
- security: QRadar SIEM alerts/queries, Trellix EDR/AV detections, CVE analysis, brute-force detection, threat hunting, malware incidents, compliance audits. Only use security when the focus is threat/attack/compliance — NOT routine firewall troubleshooting or AD administration.
- monitoring: Writing or tuning Prometheus rules, Splunk queries/dashboards, IBM Omnibus policies, Grafana panels, SCOM alert rules, capacity planning, SLOs, resource trending. Writing a Splunk query = monitoring, even if the events are security-related.
- automation: Ansible playbooks, Terraform, PowerShell scripts, bash scripts, CI/CD, cron jobs, Red Hat Satellite, SCCM task sequences. "generate/write/create a script or playbook" = automation.
- general: VMware vSphere/ESXi, NetApp storage, Kafka/Zookeeper, Redis, MongoDB/PostgreSQL/MSSQL, RHBK/Keycloak, RHEL, anything not clearly one of the above.

Complexity:
- simple: single device/resource, direct question, short answer expected
- medium: multi-step, cross-domain, moderate analysis
- complex: fleet-wide, incident diagnosis, deep analysis, multiple systems, correlation across sources

Be fast. No extra text outside the JSON.`;

// ─── Keyword pre-classifier ───────────────────────────────────────────────────
// Terms are org-specific signals that unambiguously identify a category.
// Weight 4 = unique to exactly one domain in this org (always override LLM).
// Weight 3 = strong signal (override LLM unless a weight-4 term fires first).
// Weight 2 = moderate signal (only used as tiebreaker).
// Highest cumulative score wins. Minimum score of 3 required to fire at all.

type KwRule = { category: ClassificationResult["category"]; weight: number; terms: string[] };

const KEYWORD_RULES: KwRule[] = [
  // IaC verbs with specific nouns — weight 4 so they beat conflicting platform signals
  // e.g. "Terraform module on OpenShift" → automation wins over openshift
  { category: "automation", weight: 4, terms: [
    "ansible playbook", "terraform module", "terraform plan", "terraform apply",
    "red hat satellite", "sccm task sequence",
  ]},
  // OCP-unique objects — "OpenShift Route" is OCP, not IP routing
  { category: "openshift", weight: 4, terms: [
    "deploymentconfig", "imagestream", "operatorhub", "crashloopbackoff",
    "oc get", "oc apply", "oc login", "oc rollout",
  ]},
  // Windows-unique objects — can't appear in any other domain
  { category: "windows", weight: 4, terms: [
    "active directory", "domain controller", "ad replication", "dfsr",
    " gpo ", "gpo to", "sccm", "exchange server", "sharepoint", "windows server",
  ]},
  // Security tools unique to this org
  { category: "security", weight: 4, terms: [
    "qradar", "trellix", "blast radius",
  ]},
  // Monitoring tool actions (writing/querying) — always monitoring even for security events
  { category: "monitoring", weight: 4, terms: [
    "splunk query", "splunk search", "splunk spl", "prometheus alert rule",
    "prometheus rule", "grafana dashboard", "omnibus policy", "netcool",
  ]},
  // General OCP terms — weight 3, can be beaten by weight-4 IaC terms
  { category: "openshift", weight: 3, terms: [
    "openshift", " ocp ", "ocp —", "on ocp", "helm chart",
  ]},
  // Network infrastructure
  { category: "network", weight: 3, terms: [
    "cisco", "alteon", "checkpoint", "palo alto", "juniper", "f5 big", "bigip",
    "err-disabled", "spanning-tree",
  ]},
  // Security signals
  { category: "security", weight: 3, terms: [
    "brute-force", "brute force", "malware", "ransomware", " cve-", "threat hunting",
  ]},
  // Monitoring signals
  { category: "monitoring", weight: 3, terms: [
    "prometheus", "splunk", "grafana", "alert rule",
  ]},
  // Automation signals
  { category: "automation", weight: 3, terms: [
    "ansible", "terraform", "ci/cd pipeline",
  ]},
  // Weak network signals
  { category: "network", weight: 2, terms: [
    "vlan ", "bgp ", "ospf ", "firewall rule", "acl entry",
  ]},
];

const KW_MIN = 3; // minimum score for keyword fallback to activate

function keywordPreClassify(text: string): { category: ClassificationResult["category"]; score: number } | null {
  const lower = ` ${text.toLowerCase()} `;
  const scores = new Map<ClassificationResult["category"], number>();

  for (const rule of KEYWORD_RULES) {
    for (const term of rule.terms) {
      if (lower.includes(term)) {
        scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
      }
    }
  }

  if (scores.size === 0) return null;

  let best: ClassificationResult["category"] | null = null;
  let bestScore = 0;
  for (const [cat, score] of scores) {
    if (score > bestScore) { bestScore = score; best = cat; }
  }

  if (best === null || bestScore < KW_MIN) return null;
  return { category: best, score: bestScore };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const classificationCache = new Map<string, { result: ClassificationResult; ts: number }>();
const CACHE_TTL_MS = 60_000;

function cacheKey(messages: Message[]): string {
  const last = messages[messages.length - 1];
  return `${last.role}:${last.content.slice(0, 200)}`;
}

// ─── Main classify ────────────────────────────────────────────────────────────

export async function classify(messages: Message[]): Promise<ClassificationResult> {
  if (!config.classifier.enabled || !config.classifier.model) {
    return fallbackClassification();
  }

  const key = cacheKey(messages);
  const cached = classificationCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const lastContent = extractLastUserContent(messages);
  const kw = keywordPreClassify(lastContent);

  // Only send the last user message for speed — the classifier doesn't need full history
  const classifierMessages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lastContent },
  ];

  try {
    const completion = await chat(config.classifier.model, classifierMessages, {
      temperature: 0.1,
      max_tokens: config.classifier.maxTokens,
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw) as ClassificationResult;

    const llmCategory = parsed.category ?? "general";
    const llmConf = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

    // Model leads. Keywords activate only when the model is uncertain or falls back to "general".
    const llmUncertain = llmConf < config.classifier.confidenceThreshold || llmCategory === "general";
    const finalCategory = (kw !== null && llmUncertain) ? kw.category : llmCategory;

    const result: ClassificationResult = {
      category: finalCategory,
      complexity: parsed.complexity ?? "medium",
      confidence: kw !== null && finalCategory === kw.category && llmConf < 0.5
        ? 0.9
        : llmConf,
      recommended_model: resolveModel(finalCategory, parsed.complexity ?? "medium"),
      reasoning: parsed.reasoning,
    };

    classificationCache.set(key, { result, ts: Date.now() });
    return result;
  } catch {
    if (kw) {
      return {
        category: kw.category,
        complexity: "medium",
        confidence: 0.85,
        recommended_model: resolveModel(kw.category, "medium"),
        reasoning: "keyword match (LLM unavailable)",
      };
    }
    return fallbackClassification();
  }
}

function extractLastUserContent(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages[messages.length - 1].content;
}

export function resolveModel(
  category: ClassificationResult["category"],
  complexity: ClassificationResult["complexity"]
): string | null {
  const r = config.routing;

  // Complex queries always go to the strongest available model
  if (complexity === "complex" && r.complex) return r.complex;
  // Simple queries go to the fast model
  if (complexity === "simple" && r.simple) return r.simple;

  // Category-specific routing for medium complexity
  const categoryMap: Record<string, string> = {
    network:    r.network,
    openshift:  r.openshift,
    windows:    r.windows,
    security:   r.security,
    monitoring: r.monitoring,
    automation: r.automation,
    general:    r.default,
  };

  const mapped = categoryMap[category];
  if (mapped) return mapped;

  return r.default || null;
}

function fallbackClassification(): ClassificationResult {
  return {
    category: "general",
    complexity: "medium",
    confidence: 0,
    recommended_model: config.routing.default || null,
    reasoning: "classifier unavailable — using defaults",
  };
}
