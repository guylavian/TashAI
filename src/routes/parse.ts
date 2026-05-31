/**
 * POST /parse — accept a raw uploaded artifact (pcap/evtx/log/switch config) and
 * return parsed, LLM-ready text plus the provenance `source` for Tier-0 routing.
 *
 * The relay shells out to the Python parsers in client/ (the same code the CLI
 * uses) so we reuse Scapy/python-evtx rather than reimplementing binary parsing
 * in Node. Upload as `application/octet-stream` with `?name=<filename>`.
 */
import type { FastifyInstance } from "fastify";
import { spawn } from "child_process";
import { writeFile, unlink, mkdtemp, rmdir } from "fs/promises";
import os from "os";
import path from "path";

const CLIENT_DIR = path.join(process.cwd(), "client");
const PYTHON = process.env.PARSER_PYTHON || path.join(CLIENT_DIR, ".venv", "bin", "python");
const PARSE_SCRIPT = path.join(CLIENT_DIR, "parse_file.py");
const MAX_TEXT = 60_000; // cap parsed text so a huge capture can't blow the model context
const MAX_UPLOAD = 64 * 1024 * 1024;

interface ParserOutput {
  source?: string | null;
  text?: string;
  error?: string;
}

function runParser(filePath: string): Promise<ParserOutput> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [PARSE_SCRIPT, filePath], { cwd: CLIENT_DIR });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => resolve({ error: `parser process failed: ${e.message}` }));
    proc.on("close", (code) => {
      const lastLine = out.trim().split("\n").pop() ?? "";
      try {
        const parsed = JSON.parse(lastLine) as ParserOutput;
        resolve(parsed);
      } catch {
        resolve({ error: err.trim() || `parser exited with code ${code}` });
      }
    });
  });
}

export async function parseRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Querystring: { name?: string } }>(
    "/parse",
    { bodyLimit: MAX_UPLOAD },
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({
          error:
            "Empty body. POST the raw file with Content-Type: application/octet-stream and ?name=<filename>.",
        });
      }

      const name = (req.query.name || "upload.bin").replace(/[^\w.\- ]/g, "_");
      const ext = path.extname(name) || ".bin";
      const dir = await mkdtemp(path.join(os.tmpdir(), "relay-parse-"));
      const filePath = path.join(dir, `f${ext}`);

      try {
        await writeFile(filePath, body);
        const result = await runParser(filePath);

        if (result.error) {
          return reply.status(422).send({ error: `Failed to parse ${name}: ${result.error}` });
        }

        let text = result.text ?? "";
        const truncated = text.length > MAX_TEXT;
        if (truncated) text = text.slice(0, MAX_TEXT);

        return reply.send({
          filename: name,
          source: result.source ?? null,
          bytes: body.length,
          truncated,
          text,
        });
      } finally {
        await unlink(filePath).catch(() => {});
        await rmdir(dir).catch(() => {});
      }
    }
  );
}
