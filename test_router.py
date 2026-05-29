#!/usr/bin/env python3
"""POC: test the infra router across all 5 categories."""
import httpx

RELAY = "http://localhost:3100"

tests = [
    ("network",    "Cisco core switch — all interfaces in err-disabled state, what caused it?"),
    ("network",    "Checkpoint firewall is dropping traffic on port 443 from the DMZ to the backend VLAN"),
    ("openshift",  "Pods in the payments project are stuck in CrashLoopBackOff on OCP — how to debug?"),
    ("openshift",  "Create an OpenShift Route with TLS passthrough for the internal API service"),
    ("windows",    "AD replication is broken between the two DCs — users cannot authenticate to Exchange"),
    ("windows",    "Deploy a GPO to disable USB storage on all Windows Server machines via SCCM"),
    ("security",   "QRadar is showing 500 failed SSH logins from the same source IP in under 3 minutes"),
    ("security",   "Trellix flagged malware on 3 endpoints in the finance VLAN — assess blast radius"),
    ("monitoring", "Splunk query to find all Checkpoint deny events in the last 6 hours by source IP"),
    ("monitoring", "Prometheus alert rule for when Redis memory usage exceeds 85% for 5 minutes"),
    ("automation", "Ansible playbook to patch all RHEL servers and reboot only if the kernel changed"),
    ("automation", "Terraform module to provision a new PostgreSQL instance on OpenShift with PVC"),
]

print(f"\n{'Query':<60} {'Expected':<12} {'Got':<12} {'Conf':>6}  {'Model'}")
print("─" * 115)

for expected_cat, query in tests:
    resp = httpx.post(
        f"{RELAY}/compute/auto",
        json={"messages": [{"role": "user", "content": query}], "max_tokens": 10},
        timeout=60,
    )
    data = resp.json()
    clf = data.get("classification", {})
    got_cat = clf.get("category", "?")
    conf = clf.get("confidence", 0)
    model = data.get("model", "?").split("/")[-1]  # short name
    match = "✓" if got_cat == expected_cat else "✗"
    short_q = query[:57] + "..." if len(query) > 57 else query
    print(f"{match} {short_q:<59} {expected_cat:<12} {got_cat:<12} {conf:>6.2f}  {model}")

print()
