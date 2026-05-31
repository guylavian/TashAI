/**
 * POST /remote — fetch a log/command output from a remote host over SSH or WinRM,
 * returning LLM-ready text plus a provenance `source` for routing.
 *
 * Credentials are forwarded to the Python fetcher over STDIN (never argv), used
 * only for the connection, and never stored or logged. Intended for a trusted
 * LAN; put the relay behind TLS if exposed beyond it.
 */
import type { FastifyInstance } from "fastify";
import { spawn } from "child_process";
import path from "path";

const CLIENT_DIR = path.join(process.cwd(), "client");
const PYTHON = process.env.PARSER_PYTHON || path.join(CLIENT_DIR, ".venv", "bin", "python");
const SCRIPT = path.join(CLIENT_DIR, "remote_fetch.py");
const MAX_TEXT = 60_000;

interface RemoteBody {
  protocol?: "ssh" | "winrm";
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  keyPath?: string;
  keyText?: string;
  command?: string;
}

function run(cfg: unknown): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [SCRIPT], { cwd: CLIENT_DIR });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => resolve({ error: `remote process failed: ${e.message}` }));
    proc.on("close", (code) => {
      const last = out.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(last) as { text?: string; error?: string });
      } catch {
        resolve({ error: err.trim() || `fetcher exited with code ${code}` });
      }
    });
    // Credentials over stdin — keeps them out of the process list / logs.
    proc.stdin.write(JSON.stringify(cfg));
    proc.stdin.end();
  });
}

export async function remoteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/remote", async (req, reply) => {
    const b = (req.body ?? {}) as RemoteBody;
    if (!b.host || !b.username || !b.command) {
      return reply.status(400).send({ error: "host, username, and command are required" });
    }

    const protocol = b.protocol === "winrm" ? "winrm" : "ssh";
    const cfg = {
      protocol,
      host: b.host,
      port: b.port,
      username: b.username,
      password: b.password,
      key_path: b.keyPath,
      key_text: b.keyText,
      command: b.command,
    };

    const result = await run(cfg);
    if (result.error) {
      return reply.status(502).send({ error: result.error });
    }

    let text = result.text ?? "";
    const truncated = text.length > MAX_TEXT;
    if (truncated) text = text.slice(0, MAX_TEXT);

    // Windows event logs are unambiguously "windows"; leave Linux/network to the
    // classifier (a syslog could be security, monitoring, network, …).
    const source = protocol === "winrm" ? "logs_windows" : null;

    return reply.send({ host: b.host, command: b.command, source, truncated, text });
  });
}
