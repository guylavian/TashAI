import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Classification } from "../api";
import { RoutingBadge } from "./RoutingBadge";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  classification?: Classification;
  streaming?: boolean;
  error?: boolean;
}

export function MessageBubble({ msg }: { msg: UiMessage }) {
  if (msg.role === "user") {
    return (
      <div className="row user">
        <div className="bubble user-bubble">{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="row assistant">
      <div className="assistant-col">
        {msg.classification ? (
          <RoutingBadge c={msg.classification} />
        ) : msg.streaming ? (
          <div className="routing routing-pending">
            <span className="spinner" /> routing…
          </div>
        ) : null}

        <div className={`bubble assistant-bubble${msg.error ? " error" : ""}`}>
          {msg.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          ) : msg.streaming ? (
            <span className="cursor">▋</span>
          ) : null}
          {msg.streaming && msg.content ? <span className="cursor">▋</span> : null}
        </div>
      </div>
    </div>
  );
}
