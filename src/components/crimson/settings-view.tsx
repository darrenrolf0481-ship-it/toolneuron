import { useRef, useState } from "react";
import { exportNode, importNode, useOs } from "@/lib/crimson/store";
import { PersonaForge } from "./persona-forge";
import { SkillsCredits } from "./skills-credits";

export function SettingsView() {
  const theme = useOs((state) => state.theme);
  const setTheme = useOs((state) => state.setTheme);
  const reset = useOs((state) => state.resetNode);
  const swarmHot = useOs((state) => state.swarmHot);
  const busy = useOs((state) => state.busy);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="os-scroll h-full overflow-y-auto p-4 md:p-6">
      <h2 className="text-2xl font-semibold">System config</h2>
      <p className="mt-1 max-w-xl text-sm text-muted">Theme, personalities, and the browser memory. The AI link (OpenRouter, OmniRoute or xAI) uses server-side keys. They are never typed or stored here.</p>

      <section className="mt-6 rounded-3xl border border-border bg-surface p-4">
        <p className="text-sm font-semibold">Theme</p>
        <div className="mt-3 flex gap-2">
          {(["night", "dayglass"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTheme(item)}
              className={`min-h-11 rounded-2xl px-4 text-sm ${theme === item ? "bg-primary text-on-primary" : "border border-border"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      <PersonaForge />

      <SkillsCredits />

      <section className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-2xl border border-border px-4 text-sm"
          onClick={() => {
            const blob = new Blob([exportNode()], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `toolneuron-node-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setNotice({ ok: true, text: "Exported files, personas, chat, packs, git and swarm memory." });
          }}
        >
          Export node
        </button>
        <button
          type="button"
          className="min-h-11 rounded-2xl border border-border px-4 text-sm disabled:opacity-40"
          disabled={busy || swarmHot}
          title={busy || swarmHot ? "Wait for the chat or swarm to finish" : "Restore from an exported node file"}
          onClick={() => fileInput.current?.click()}
        >
          Import node
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={async (event) => {
            const picked = event.target.files?.[0];
            event.target.value = "";
            if (!picked) return;
            const text = await picked.text().catch(() => "");
            if (!window.confirm(`Replace everything in this browser with "${picked.name}"? Export first if you want a backup.`)) return;
            const result = importNode(text);
            setNotice(result.ok ? { ok: true, text: result.summary } : { ok: false, text: result.error });
          }}
        />
        <button
          type="button"
          className="min-h-11 rounded-2xl border border-border px-4 text-sm text-primary"
          onClick={() => {
            if (window.confirm("Wipe this browser's project, chat and settings and restore the seed? (The encrypted vault is kept; delete it from the Vault itself.)")) reset();
          }}
        >
          Reset node
        </button>
      </section>
      {notice && (
        <p role="status" className={`mt-3 text-sm ${notice.ok ? "text-fg" : "text-primary"}`}>
          {notice.ok ? "" : "⚠ "}
          {notice.text}
        </p>
      )}
    </div>
  );
}
