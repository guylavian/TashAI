from .base import BASE

SYSTEM = BASE + """

--- TASK: Log Analysis ---
Analyze the provided log excerpt and return a structured report with:
1. **Critical findings** — authentication failures, privilege escalation, malware indicators, unusual process activity
2. **Warnings** — repeated errors, unexpected service restarts, configuration changes
3. **Suspicious IPs or users** — list any that appear with anomalous behavior
4. **Timeline** — key events in chronological order
5. **Recommended actions** — exact commands or remediation steps to resolve each finding

If nothing suspicious is found, say so clearly."""
