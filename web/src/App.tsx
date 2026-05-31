import { useEffect, useRef, useState, useCallback } from "react";
import { streamChat, getHealth, getModels, parseFile, RELAY_URL, type ChatMessage, type Health, type ParsedFile, type RemoteResult } from "./api";
import { MessageBubble, type UiMessage } from "./components/MessageBubble";
import { RemotePanel } from "./components/RemotePanel";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

const ACCEPT = ".pcap,.pcapng,.evtx,.log,.csv,.txt,.conf,.cfg,.out";

interface Attachment {
  id: string;
  name: string;
  status: "parsing" | "ready" | "error";
  parsed?: ParsedFile;
  error?: string;
}

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [modelCount, setModelCount] = useState<number>(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showRemote, setShowRemote] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea with content, capped; reset when cleared.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  // Poll health + models.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [h, m] = await Promise.all([getHealth(), getModels()]);
      if (!alive) return;
      setHealth(h);
      setModelCount(m.length);
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Autoscroll to bottom as content streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = nextId();
      setAttachments((prev) => [...prev, { id, name: file.name, status: "parsing" }]);
      try {
        const parsed = await parseFile(file);
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "ready", parsed } : a)));
      } catch (err) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "error", error: (err as Error).message } : a))
        );
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // A remote SSH/WinRM fetch becomes an attachment, same as an uploaded file.
  const onRemoteFetched = useCallback((r: RemoteResult) => {
    const name = `${r.host}: ${r.command.length > 40 ? r.command.slice(0, 40) + "…" : r.command}`;
    setAttachments((prev) => [
      ...prev,
      {
        id: nextId(),
        name,
        status: "ready",
        parsed: { filename: name, source: r.source, bytes: r.text.length, truncated: r.truncated, text: r.text },
      },
    ]);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    const ready = attachments.filter((a) => a.status === "ready" && a.parsed);
    if ((!text && ready.length === 0) || streaming) return;

    // Fold parsed files into the message content; pick a Tier-0 source if a
    // single typed artifact (pcap/evtx/switch) was attached.
    const fileBlocks = ready
      .map((a) => `\n\n--- File: ${a.parsed!.filename} (${a.parsed!.source ?? "text"}) ---\n${a.parsed!.text}\n--- End of file ---`)
      .join("");
    const sources = [...new Set(ready.map((a) => a.parsed!.source).filter(Boolean))] as string[];
    const source = sources.length === 1 ? sources[0] : undefined;

    const displayText = text || `(analyze ${ready.map((a) => a.parsed!.filename).join(", ")})`;
    const wireContent = `${text}${fileBlocks}`.trim();

    const userMsg: UiMessage = {
      id: nextId(),
      role: "user",
      content: displayText + (ready.length ? `\n📎 ${ready.map((a) => a.parsed!.filename).join(", ")}` : ""),
    };
    const asstId = nextId();
    const asstMsg: UiMessage = { id: asstId, role: "assistant", content: "", streaming: true };

    // Build the wire history from prior turns + this one (with file content).
    const history: ChatMessage[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: wireContent },
    ];

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setInput("");
    setAttachments([]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const patch = (fn: (m: UiMessage) => UiMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === asstId ? fn(m) : m)));

    try {
      for await (const ev of streamChat(history, { signal: ac.signal, source })) {
        if (ev.type === "classification") {
          patch((m) => ({ ...m, classification: ev.classification }));
        } else if (ev.type === "chunk") {
          patch((m) => ({ ...m, content: m.content + ev.content }));
        } else if (ev.type === "error") {
          patch((m) => ({ ...m, content: `⚠ ${ev.message}`, error: true, streaming: false }));
        } else if (ev.type === "done") {
          break;
        }
      }
      patch((m) => ({ ...m, streaming: false }));
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        patch((m) => ({ ...m, streaming: false }));
      } else {
        patch((m) => ({
          ...m,
          content: m.content || `⚠ ${(err as Error).message}`,
          error: !m.content,
          streaming: false,
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, messages, attachments]);

  const stop = () => abortRef.current?.abort();
  const clear = () => !streaming && setMessages([]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const healthy = health?.status === "ok";

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
        <div className="brand">
          <span className="logo">◆</span>
          <div>
            <div className="title">Infrastructure AI Gateway</div>
            <div className="subtitle">auto-routed · streaming · {RELAY_URL}</div>
          </div>
        </div>
        <div className="status">
          <span className={`dot ${health ? (healthy ? "ok" : "degraded") : "down"}`} />
          <span className="status-text">
            {health ? (healthy ? "connected" : "degraded") : "offline"}
          </span>
          {health && <span className="status-meta">{modelCount} models · classifier {health.classifier}</span>}
          <button className="btn ghost" onClick={clear} disabled={streaming || messages.length === 0}>
            Clear
          </button>
        </div>
        </div>
      </header>

      <div className="messages" ref={scrollRef}>
        <div className="thread">
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-title">Ask the gateway anything infra.</div>
            <div className="empty-hint">
              Each reply shows the <b>category</b>, the <b>model</b> it routed to, the <b>tier</b> that
              decided, and the <b>confidence</b>.
            </div>
            <div className="examples">
              {[
                "Why are pods in the payments project in CrashLoopBackOff?",
                "AD replication is broken between two DCs — users can't authenticate",
                "Ansible playbook to patch all RHEL servers and reboot if kernel changed",
                "Splunk query for Checkpoint deny events in the last 6 hours",
              ].map((ex) => (
                <button key={ex} className="example" onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
        </div>
      </div>

      <div className="composer-bar">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.id} className={`attach-chip ${a.status}`} title={a.error ?? a.parsed?.source ?? ""}>
              {a.status === "parsing" && <span className="spinner" />}
              {a.status === "ready" && <span className="attach-tick">✓</span>}
              {a.status === "error" && <span className="attach-x">✕</span>}
              <span className="attach-name">{a.name}</span>
              {a.status === "ready" && a.parsed?.source && (
                <span className="attach-source">{a.parsed.source}</span>
              )}
              {a.status === "ready" && a.parsed?.truncated && <span className="attach-trunc">truncated</span>}
              <button className="attach-remove" onClick={() => removeAttachment(a.id)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          style={{ display: "none" }}
          onChange={(e) => onFiles(e.target.files)}
        />
        <button
          className="btn attach"
          onClick={() => fileRef.current?.click()}
          disabled={streaming}
          title="Attach pcap, evtx, log, or switch config"
        >
          📎
        </button>
        <button
          className="btn attach"
          onClick={() => setShowRemote(true)}
          disabled={streaming}
          title="Fetch a log over SSH or WinRM"
        >
          🖥
        </button>
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the gateway anything infra…"
          rows={1}
        />
        {streaming ? (
          <button className="btn stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            className="btn send"
            onClick={send}
            disabled={!input.trim() && !attachments.some((a) => a.status === "ready")}
          >
            Send
          </button>
        )}
      </div>
      <div className="composer-hint">
        <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <span className="clip">📎</span> attach file ·{" "}
        <span className="clip">🖥</span> fetch remote log (SSH / WinRM)
      </div>
      </div>
      {showRemote && <RemotePanel onClose={() => setShowRemote(false)} onFetched={onRemoteFetched} />}
    </div>
  );
}
