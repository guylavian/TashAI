/**
 * The default enterprise-infrastructure taxonomy — the single source of truth for
 * categories, keywords, prompt descriptions, provenance, and routing targets.
 *
 * Routing `model` values are read from `config.routing` (env-driven, via .env)
 * so behavior is identical to the previous hardcoded classifier; the taxonomy
 * just expresses that wiring as data instead of five parallel structures.
 */
import { config } from "../../config";
import { defineTaxonomy, type Taxonomy } from "./engine";

export const infraTaxonomy = defineTaxonomy({
  fallbackCategory: "general",
  fastPathWeight: 4,
  minWeight: 3,
  complexity: { simple: config.routing.simple, complex: config.routing.complex },
  categories: [
    {
      id: "network",
      description:
        "Cisco/Alteon/F5/Checkpoint/PaloAlto/Juniper, BGP, OSPF, VLANs, ACLs, NAT, spanning-tree, err-disabled (traffic/connectivity, not threat).",
      aliases: ["routing", "switching", "load balancing", "WAF", "firewall connectivity", "subnets", "DNS resolution paths"],
      model: config.routing.network,
      sources: ["pcap", "switch"],
      keywords: [
        { weight: 3, terms: [
          "cisco", "alteon", "checkpoint", "palo alto", "juniper", "f5 big", "bigip",
          "err-disabled", "spanning-tree", "nexus", "fortigate", "port-channel",
          "etherchannel", "hsrp", "vrrp",
        ]},
        { weight: 2, terms: ["vlan", "bgp", "ospf", "eigrp", "mpls", "firewall rule", "acl entry"] },
      ],
    },
    {
      id: "openshift",
      description:
        "OpenShift/OCP and Kubernetes: pods, DeploymentConfig, oc/kubectl CLI, routes, operators, imagestreams, PVCs, deployments, namespaces, nodes.",
      disambiguation: '"OpenShift Route" = openshift, NOT network. Any Kubernetes/k8s question is openshift.',
      aliases: ["kubernetes", "k8s", "containers", "container orchestration", "pods and deployments", "helm", "cluster workloads", "ingress/routes"],
      model: config.routing.openshift,
      keywords: [
        { weight: 4, terms: [
          "deploymentconfig", "imagestream", "operatorhub", "crashloopbackoff",
          "oc get", "oc apply", "oc login", "oc rollout", "oc adm", "buildconfig",
          "securitycontextconstraints", "argocd", "tekton", "quay",
          "kubernetes", "k8s", "kubectl", "kubelet", "kubeadm", "kubeconfig",
          "daemonset", "statefulset", "configmap", "replicaset",
        ]},
        { weight: 3, terms: ["openshift", "ocp", "helm chart"] },
      ],
    },
    {
      id: "windows",
      description: "AD, DC, DNS, DHCP, DFSR, GPO, SCCM, Exchange, SharePoint, SCOM, Event logs (.evtx), Get-WinEvent.",
      disambiguation: "AD/event-log analysis is windows even when it involves auth failures.",
      aliases: ["Active Directory", "domain join", "Windows endpoints", "PowerShell on Windows", "Kerberos/LDAP auth", "WSUS patching"],
      model: config.routing.windows,
      sources: ["evtx", "logs_windows"],
      keywords: [
        { weight: 4, terms: [
          "active directory", "domain controller", "ad replication", "dfsr",
          "gpo", "sccm", "exchange server", "sharepoint", "windows server",
          "event viewer", "event log", "evtx", "winevt", "windows event",
          "security.evtx", "system.evtx", "application.evtx",
          "get-eventlog", "get-winevent",
          "kerberos", "ldap", "ntlm", "wsus", "dcdiag", "repadmin",
          "ntds", "lsass", "krbtgt",
        ]},
      ],
    },
    {
      id: "security",
      description: "QRadar, Trellix, CVEs, brute-force, threat hunting, malware, compliance.",
      disambiguation: "Only when the focus is threat/attack/compliance.",
      aliases: ["SOC", "incident response", "EDR/SIEM alerts", "vulnerabilities", "IOCs", "intrusion", "compliance audit"],
      model: config.routing.security,
      sources: ["logs_linux"],
      keywords: [
        { weight: 4, terms: ["qradar", "trellix", "blast radius"] },
        { weight: 3, terms: [
          "brute-force", "brute force", "malware", "ransomware", "cve-", "threat hunting",
          "edr", "siem", "phishing", "nessus", "mitre",
        ]},
      ],
    },
    {
      id: "monitoring",
      description: "writing/tuning Prometheus rules, Splunk queries, Grafana, Omnibus, SLOs.",
      disambiguation: "A Splunk query is monitoring even for security events.",
      aliases: ["observability", "dashboards", "alerting rules", "metrics/log queries", "capacity planning", "SLOs"],
      model: config.routing.monitoring,
      keywords: [
        { weight: 4, terms: [
          "splunk query", "splunk search", "splunk spl", "prometheus alert rule",
          "prometheus rule", "grafana dashboard", "omnibus policy", "netcool",
          "alertmanager", "promql", "thanos", "logql",
        ]},
        { weight: 3, terms: ["prometheus", "splunk", "grafana", "alert rule", "loki", "kibana"] },
      ],
    },
    {
      id: "automation",
      description: "Ansible, Terraform, PowerShell/bash scripts, CI/CD, Satellite.",
      disambiguation: '"write a script/playbook" = automation.',
      aliases: ["IaC", "infrastructure as code", "config management", "CI/CD pipelines", "GitOps", "scripting/orchestration"],
      model: config.routing.automation,
      keywords: [
        { weight: 4, terms: [
          "ansible playbook", "terraform module", "terraform plan", "terraform apply",
          "red hat satellite", "sccm task sequence", "ansible tower", "awx",
          "gitlab ci", "jenkins pipeline", "argo workflow",
        ]},
        { weight: 3, terms: ["ansible", "terraform", "ci/cd pipeline", "jenkins", "gitlab", "puppet", "saltstack"] },
      ],
    },
    {
      id: "general",
      description: "VMware, NetApp, Kafka, Redis, DBs, RHBK, RHEL, trivial/non-infra questions, anything else.",
      model: config.routing.default,
      keywords: [],
    },
  ],
});

// Strong category union derived from the taxonomy's literal ids.
export type InfraCategory = typeof infraTaxonomy extends Taxonomy<infer C> ? C : never;
