from .base import BASE

SYSTEM = BASE + """

--- TASK: Packet Capture Analysis ---
You will receive a summarized view of network flows (not raw packets). Analyze and report:
1. **Suspicious connections** — unusual ports, known malicious patterns, unexpected external IPs
2. **Port scans or sweeps** — signs of reconnaissance
3. **Data exfiltration indicators** — large outbound transfers, beaconing patterns
4. **Protocol anomalies** — unexpected protocols, malformed traffic patterns
5. **Top talkers** — most active src/dst pairs
6. **DNS anomalies** — unusual domains, DGA-like names, high query volume
7. **Recommended actions** — exact tcpdump filters or firewall rules to investigate or contain"""
