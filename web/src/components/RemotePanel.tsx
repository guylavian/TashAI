import { useState } from "react";
import { remoteFetch, type RemoteResult } from "../api";

type ConnKind = "linux" | "network" | "windows";

interface Preset {
  label: string;
  command: string;
}

const PRESETS: Record<ConnKind, Preset[]> = {
  linux: [
    { label: "auth.log — logins / sudo", command: "tail -n 500 /var/log/auth.log 2>/dev/null || tail -n 500 /var/log/secure" },
    { label: "syslog / messages", command: "tail -n 500 /var/log/syslog 2>/dev/null || tail -n 500 /var/log/messages" },
    { label: "journalctl — errors", command: "journalctl -p err -n 500 --no-pager" },
    { label: "dmesg — kernel ring", command: "dmesg --ctime | tail -n 300" },
    { label: "nginx — error log", command: "tail -n 300 /var/log/nginx/error.log" },
  ],
  network: [
    { label: "show logging (Cisco IOS/NX-OS)", command: "show logging" },
    { label: "show log messages (Junos)", command: "show log messages | last 300" },
    { label: "show interface status (Cisco)", command: "show interface status" },
  ],
  windows: [
    { label: "Security — failed logons (4625)", command: "Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625} -MaxEvents 200 | Format-List TimeCreated,Id,Message" },
    { label: "System — errors", command: "Get-WinEvent -FilterHashtable @{LogName='System';Level=2} -MaxEvents 200 | Format-List TimeCreated,Id,ProviderName,Message" },
    { label: "Application — errors", command: "Get-WinEvent -FilterHashtable @{LogName='Application';Level=2} -MaxEvents 200 | Format-List TimeCreated,Id,ProviderName,Message" },
  ],
};

const DEFAULT_PORT: Record<ConnKind, number> = { linux: 22, network: 22, windows: 5985 };

export function RemotePanel({
  onClose,
  onFetched,
}: {
  onClose: () => void;
  onFetched: (r: RemoteResult) => void;
}) {
  const [kind, setKind] = useState<ConnKind>("linux");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [keyPath, setKeyPath] = useState("");
  const [command, setCommand] = useState(PRESETS.linux[0].command);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onKindChange = (k: ConnKind) => {
    setKind(k);
    setPort(DEFAULT_PORT[k]);
    setCommand(PRESETS[k][0].command);
    if (k === "windows") setUseKey(false);
  };

  const fetchNow = async () => {
    setError(null);
    if (!host.trim() || !username.trim() || !command.trim()) {
      setError("Host, username, and command are required.");
      return;
    }
    setBusy(true);
    try {
      const result = await remoteFetch({
        protocol: kind === "windows" ? "winrm" : "ssh",
        host: host.trim(),
        port,
        username: username.trim(),
        password: password || undefined,
        keyPath: useKey && keyPath ? keyPath.trim() : undefined,
        command: command.trim(),
      });
      onFetched(result);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Fetch remote log</span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="seg">
            {(["linux", "network", "windows"] as ConnKind[]).map((k) => (
              <button key={k} className={`seg-btn ${kind === k ? "active" : ""}`} onClick={() => onKindChange(k)}>
                {k === "linux" ? "Linux (SSH)" : k === "network" ? "Network (SSH)" : "Windows (WinRM)"}
              </button>
            ))}
          </div>

          <div className="field-row">
            <label className="field grow">
              <span>Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5 or host.corp" autoFocus />
            </label>
            <label className="field port">
              <span>Port</span>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </label>
          </div>

          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={kind === "windows" ? "DOMAIN\\user or user" : "ops"} />
          </label>

          {kind !== "windows" && (
            <label className="checkbox">
              <input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} />
              <span>Use SSH private key (path on the relay host)</span>
            </label>
          )}

          {useKey && kind !== "windows" ? (
            <label className="field">
              <span>Private key path</span>
              <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
              <span className="hint-sm">Password below is used as the key passphrase if set.</span>
            </label>
          ) : null}

          <label className="field">
            <span>{useKey ? "Passphrase (optional)" : "Password"}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </label>

          <label className="field">
            <span>Log target</span>
            <select
              value={PRESETS[kind].find((p) => p.command === command)?.command ?? ""}
              onChange={(e) => e.target.value && setCommand(e.target.value)}
            >
              {PRESETS[kind].map((p) => (
                <option key={p.label} value={p.command}>{p.label}</option>
              ))}
              <option value="">— custom —</option>
            </select>
          </label>

          <label className="field">
            <span>Command</span>
            <textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={2} spellCheck={false} />
          </label>

          {error && <div className="modal-error">⚠ {error}</div>}
          <div className="modal-note">
            Credentials are sent to the relay for this connection only — never stored or logged.
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn send" onClick={fetchNow} disabled={busy}>
            {busy ? "Fetching…" : "Fetch & attach"}
          </button>
        </div>
      </div>
    </div>
  );
}
