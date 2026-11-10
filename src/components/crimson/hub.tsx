import { useEffect, useRef, useState } from "react";
import {
  Bug,
  Database,
  HelpCircle,
  Image as ImageIcon,
  MessageSquare,
  Network,
  Pin,
  Send,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { analyzeSource } from "@/lib/crimson/analyze";
import { findHandoff, handoffFrom } from "@/lib/crimson/handoff";
import { useOs } from "@/lib/crimson/store";
import type { Module } from "@/lib/crimson/types";
import { Rich } from "./rich";
import { SwarmPane } from "./swarm-pane";
import { VaultPane } from "./vault-pane";

const MODULES: { id: Module; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "vision", label: "Vision", icon: ImageIcon },
  { id: "knowledge", label: "Database", icon: Database },
  { id: "vault", label: "Vault", icon: ShieldCheck },
  { id: "swarm", label: "Swarm", icon: Network },
  { id: "debug", label: "Debug", icon: Bug },
  { id: "help", label: "Guide", icon: HelpCircle },
];

export function Hub() {
  const module = useOs((state) => state.module);
  const setModule = useOs((state) => state.setModule);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 lg:flex-row lg:p-5">
      <aside className="shrink-0 rounded-3xl border border-border bg-surface p-4 lg:w-60">
        <p className="text-lg font-semibold">ToolNeuron</p>
        <p className="text-xs tracking-widest text-muted uppercase">Neural IDE</p>
        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-1">
          {MODULES.map((item) => {
            const Icon = item.icon;
            const active = module === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setModule(item.id)}
                className={`flex min-h-11 items-center gap-2 rounded-2xl px-3 text-left text-xs font-semibold tracking-wide uppercase ${active ? "bg-primary text-on-primary" : "bg-bg text-muted"}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border bg-surface">
        {module === "chat" && <ChatPane />}
        {module === "vision" && <VisionPane />}
        {module === "knowledge" && <KnowledgePane />}
        {module === "vault" && <VaultPane />}
        {module === "swarm" && <SwarmPane />}
        {module === "debug" && <DebugPane />}
        {module === "help" && <HelpPane />}
      </section>
    </div>
  );
}

function ChatPane() {
  const chat = useOs((state) => state.chat);
  const busy = useOs((state) => state.busy);
  const consult = useOs((state) => state.consult);
  const stopChat = useOs((state) => state.stopChat);
  const personalities = useOs((state) => state.personalities);
  const handOff = useOs((state) => state.handOff);
  const fast = useOs((state) => state.fast);
  const clearHandoff = useOs((state) => state.clearHandoff);
  const note = useOs((state) => findHandoff(state.files));
  const noteText = useOs((state) => (note && state.activeFileId === note.id ? state.draft : note?.content) ?? "");
  const [text, setText] = useState("");
  const [handedAt, setHandedAt] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const active = personalities.find((item) => item.active) ?? personalities[0];
  const noteFrom = handoffFrom(noteText);
  const pinned = Boolean(note && noteText.trim());

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat, busy]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-xs font-semibold tracking-widest text-primary uppercase">Neural chat · {active?.name}</p>
        <p className="text-xs text-muted">{busy ? "linking" : "idle"}</p>
      </header>
      <div className="os-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-label="Chat">
        {chat.map((message, index) => (
          <div key={`${message.timestamp}-${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              role={message.error ? "status" : undefined}
              className={`max-w-[92%] rounded-3xl px-4 py-3 ${message.role === "user" ? "bg-primary text-on-primary" : message.error ? "border border-dashed border-primary/60 text-muted" : "border border-border bg-surface-2 text-fg"}`}
            >
              {message.error ? (
                <p className="text-xs leading-5 tracking-wide">⚠ {message.text}</p>
              ) : message.role === "ai" ? (
                <>
                  {message.text ? <Rich text={message.text} /> : <p className="text-sm text-muted">…</p>}
                  {message.pending && message.text && <span className="os-caret" aria-hidden />}
                  {message.stopped && <p className="mt-1 text-[11px] tracking-wide text-muted uppercase">Stopped</p>}
                  {message.cut && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] tracking-wide text-muted">
                      <span>Cut off at the length limit{fast ? " (Flash is on: shorter replies)" : ""}.</span>
                      {index === chat.length - 1 && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void consult("Continue exactly where your last reply stopped. Do not repeat what you already wrote.")}
                          className="min-h-8 rounded-full border border-primary px-3 text-primary disabled:opacity-40"
                        >
                          Continue
                        </button>
                      )}
                    </div>
                  )}
                  {message.skills && message.skills.length > 0 && !message.pending && (
                    <p className="mt-2 text-[11px] tracking-wide text-muted" title="Skills applied to this reply">
                      Skills: {message.skills.join(" · ")}
                    </p>
                  )}
                  {!message.pending && !message.intro && message.text.trim() && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] tracking-wide text-muted">
                      <span>{message.mode ? `From ${message.mode}` : ""}</span>
                      <button
                        type="button"
                        onClick={() => {
                          handOff(message.timestamp);
                          setHandedAt(message.timestamp);
                        }}
                        className="min-h-8 rounded-full border border-border px-3 text-fg hover:border-primary"
                        title="Save this reply as handoff.md; every later message in any mode gets it"
                      >
                        {handedAt === message.timestamp && pinned ? "Handed off ✓" : "Hand off"}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm leading-6 whitespace-pre-wrap">{message.text}</p>
              )}
            </div>
          </div>
        ))}
        {busy && !chat.some((message) => message.pending && message.text) && (
          <p className="text-xs tracking-widest text-muted uppercase" role="status">
            Holding the link…
          </p>
        )}
        <div ref={endRef} />
      </div>
      {pinned && note && (
        <div className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/50 px-3 py-2 text-xs" role="status" aria-label="Pinned handoff">
          <Pin className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 text-fg">
            Handoff{noteFrom ? ` from ${noteFrom}` : ""} pinned — {active?.name} reads it with every message.
          </span>
          <button
            type="button"
            className="min-h-8 rounded-full border border-border px-3 text-fg"
            onClick={() => {
              useOs.getState().openFile(note.id);
              useOs.getState().setTab("editor");
            }}
          >
            Edit
          </button>
          <button type="button" className="min-h-8 rounded-full border border-border px-3 text-fg" onClick={clearHandoff}>
            Clear
          </button>
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto px-4 pb-2">
        {active?.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="shrink-0 rounded-full border border-border px-3 py-2 text-xs text-muted"
            onClick={() => void consult(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !text.trim()) return;
          const next = text;
          setText("");
          void consult(next);
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Directive, or: create a file named notes.md"
          className="min-h-11 flex-1 rounded-2xl border border-border bg-bg px-4 text-sm text-fg outline-none"
        />
        {busy ? (
          <button
            type="button"
            onClick={stopChat}
            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary text-primary"
            aria-label="Stop reply"
            title="Stop"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
          <button type="submit" disabled={!text.trim()} className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-on-primary disabled:opacity-40" aria-label="Send">
            <Send className="h-4 w-4" />
          </button>
        )}
      </form>
    </div>
  );
}

function VisionPane() {
  const consult = useOs((state) => state.consult);
  const busy = useOs((state) => state.busy);
  const [positive, setPositive] = useState("Crimson cockpit at night, one operator, practical lights, no poster gloss");
  const [negative, setNegative] = useState("blurry, extra limbs, watermark, plastic skin");

  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-5">
      <div>
        <h2 className="text-xl font-semibold">Prompt forge</h2>
        <p className="mt-1 text-sm text-muted">This deck sharpens a prompt. It does not render an image.</p>
      </div>
      <label className="block text-xs tracking-widest text-muted uppercase">
        Positive
        <textarea value={positive} onChange={(event) => setPositive(event.target.value)} className="mt-2 min-h-28 w-full rounded-2xl border border-border bg-bg p-3 text-sm text-fg outline-none" />
      </label>
      <label className="block text-xs tracking-widest text-muted uppercase">
        Negative
        <textarea value={negative} onChange={(event) => setNegative(event.target.value)} className="mt-2 min-h-20 w-full rounded-2xl border border-border bg-bg p-3 text-sm text-fg outline-none" />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => void consult(`Sharpen this image prompt. Return the revised positive prompt, a tighter negative prompt, and one sentence on lighting. Do not claim an image was generated.\n\nPositive: ${positive}\nNegative: ${negative}`)}
        className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
      >
        Sharpen with AI
      </button>
    </div>
  );
}

function KnowledgePane() {
  const packs = useOs((state) => state.packs);
  const addPack = useOs((state) => state.addPack);
  const togglePack = useOs((state) => state.togglePack);
  const removePack = useOs((state) => state.removePack);

  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Knowledge packs</h2>
          <p className="mt-1 text-sm text-muted">Armed packs are pasted into the next chat, capped. Text files only.</p>
        </div>
        <label className="min-h-11 cursor-pointer rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary">
          Inject text
          <input
            type="file"
            accept=".txt,.md,.json,.csv,.py,.js,.ts,.html"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const excerpt = (await file.text()).slice(0, 4000);
              addPack({
                id: `pack_${Date.now()}`,
                name: file.name,
                size: `${Math.max(1, Math.round(file.size / 1024))} KB`,
                excerpt,
                status: "indexed",
                armed: true,
              });
            }}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {packs.map((pack) => (
          <article key={pack.id} className="rounded-3xl border border-border bg-bg p-4">
            <p className="font-semibold">{pack.name}</p>
            <p className="mt-1 text-xs text-muted">
              {pack.size} · {pack.status} · {pack.armed ? "armed" : "sheathed"}
            </p>
            <p className="mt-3 line-clamp-3 text-sm text-muted">{pack.excerpt}</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => togglePack(pack.id)} className="min-h-11 flex-1 rounded-2xl border border-border text-sm">
                {pack.armed ? "Sheath" : "Arm"}
              </button>
              {pack.id !== "doctrine" && (
                <button type="button" aria-label={`Remove ${pack.name}`} onClick={() => removePack(pack.id)} className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border text-muted">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function DebugPane() {
  const files = useOs((state) => state.files);
  const activeFileId = useOs((state) => state.activeFileId);
  const draft = useOs((state) => state.draft);
  const consult = useOs((state) => state.consult);
  const busy = useOs((state) => state.busy);
  const file = files.find((item) => item.id === activeFileId);
  const findings = analyzeSource(file?.type === "file" ? draft : "", file?.language ?? "");

  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Local doctrine</h2>
          <p className="mt-1 text-sm text-muted">{file?.name ?? "No file"} · {findings.length} hit{findings.length === 1 ? "" : "s"}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void consult(
              `Give three short refactor notes for ${file?.name ?? "the open file"}. Local doctrine hits:\n${
                findings.map((hit) => `${hit.rule} line ${hit.line}: ${hit.message}`).join("\n") || "none"
              }`,
            )
          }
          className="min-h-11 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40"
        >
          Ask for a refactor
        </button>
      </div>
      {findings.length === 0 ? (
        <p className="rounded-3xl border border-border bg-bg p-4 text-sm text-muted">
          Clean under the local rules. Open audit_target.py or xss_sink.js in the editor to see them fire.
        </p>
      ) : (
        <ul className="space-y-2">
          {findings.map((hit) => (
            <li key={`${hit.rule}-${hit.line}`} className="rounded-3xl border border-border bg-bg p-4">
              <p className="text-xs font-semibold tracking-widest text-primary uppercase">
                {hit.severity} · {hit.rule} · line {hit.line}
              </p>
              <p className="mt-2 text-sm">{hit.message}</p>
              <p className="mt-2 text-sm text-muted">{hit.fix}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HelpPane() {
  return (
    <div className="os-scroll flex-1 space-y-4 overflow-y-auto p-5 text-sm leading-6">
      <h2 className="text-xl font-semibold">Operator guide</h2>
      <p>Crimson OS keeps the project in this browser. Chat, review, and the terminal's <span className="font-mono">ai</span> command call the AI only when you send them.</p>
      <div className="rounded-3xl border border-border bg-bg p-4">
        <p className="font-semibold">Vault</p>
        <p className="text-muted">Encrypted with your passphrase (AES-256) and kept in this browser only. Optional passkey unlock. There is no recovery if you forget the passphrase.</p>
      </div>
      <div className="rounded-3xl border border-border bg-bg p-4">
        <p className="font-semibold">What to try</p>
        <p className="text-muted">Open the editor and run neural_brain.py. Switch to Review on audit_target.py. In chat, ask it to create a file named patch.py.</p>
      </div>
      <div className="rounded-3xl border border-border bg-bg p-4">
        <p className="font-semibold">Keep it on a phone</p>
        <p className="text-muted">iPhone: Safari, Share, Add to Home Screen. Android: Chrome menu, Install app or Add to Home screen. The node remembers the project after you close it.</p>
      </div>
    </div>
  );
}
