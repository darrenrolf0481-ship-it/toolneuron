import { useEffect, useState } from "react";
import {
  Code2,
  Cpu,
  Gauge,
  HardDrive,
  LayoutTemplate,
  Settings,
  Terminal,
  Zap,
} from "lucide-react";
import { listAiProviders } from "@/lib/crimson/ai.functions";
import { type Access, AccessControl } from "./access-control";
import { bootPersistence, useOs } from "@/lib/crimson/store";
import type { Tab } from "@/lib/crimson/types";
import { AnalysisView } from "./analysis-view";
import { EditorView } from "./editor-view";
import { Hub } from "./hub";
import { SettingsView } from "./settings-view";
import { StorageView } from "./storage-view";
import { TerminalView } from "./terminal-view";

const NAV: { id: Tab; label: string; icon: typeof Zap }[] = [
  { id: "toolneuron", label: "Hub", icon: Zap },
  { id: "terminal", label: "Term", icon: Terminal },
  { id: "editor", label: "Edit", icon: Code2 },
  { id: "analysis", label: "Review", icon: LayoutTemplate },
  { id: "storage", label: "Core", icon: HardDrive },
  { id: "settings", label: "Config", icon: Settings },
];

export function CrimsonOS() {
  const tab = useOs((state) => state.tab);
  const theme = useOs((state) => state.theme);
  const setTab = useOs((state) => state.setTab);
  // Set once the saved workspace and git history are loaded (the browser tests wait for it).
  const ready = useOs((state) => state.booted && state.gitStorage !== "loading");

  useEffect(() => {
    bootPersistence();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg" data-ready={ready ? "true" : undefined}>
      <nav className="hidden w-20 shrink-0 flex-col items-center gap-3 border-r border-border bg-surface py-5 md:flex">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-on-primary">
          <Cpu className="h-5 w-5" />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          {NAV.filter((item) => item.id !== "settings").map((item) => (
            <NavButton key={item.id} item={item} active={tab === item.id} onClick={() => setTab(item.id)} />
          ))}
        </div>
        <NavButton item={NAV.find((item) => item.id === "settings")!} active={tab === "settings"} onClick={() => setTab("settings")} />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
        <TopBar />
        <SaveBanner />
        <div className="os-grid relative min-h-0 flex-1 overflow-hidden">
          {tab === "toolneuron" && <Hub />}
          {tab === "terminal" && <TerminalView />}
          {tab === "editor" && <EditorView />}
          {tab === "analysis" && <AnalysisView />}
          {tab === "storage" && <StorageView />}
          {tab === "settings" && <SettingsView />}
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 flex gap-1 overflow-x-auto border-t border-border bg-surface px-2 py-1 md:hidden">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex min-h-11 min-w-14 shrink-0 flex-col items-center justify-center rounded-xl px-2 text-xs ${active ? "bg-primary text-on-primary" : "text-muted"}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: (typeof NAV)[number];
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      title={item.label}
      aria-label={item.label}
      onClick={onClick}
      className={`flex h-11 w-11 items-center justify-center rounded-2xl ${active ? "bg-primary text-on-primary" : "text-muted hover:text-fg"}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

function TopBar() {
  const tab = useOs((state) => state.tab);
  const personalities = useOs((state) => state.personalities);
  const activate = useOs((state) => state.activatePersonality);
  const fast = useOs((state) => state.fast);
  const setFast = useOs((state) => state.setFast);
  const provider = useOs((state) => state.provider);
  const setProvider = useOs((state) => state.setProvider);
  const [providers, setProviders] = useState<{ id: string; label: string; model: string; fastModel: string }[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null);
  const [access, setAccess] = useState<Access>("locked");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    listAiProviders()
      .then((result) => {
        setProviders(result.providers);
        setDefaultProvider(result.defaultId);
        setAccess(result.access);
      })
      .catch(() => setProviders([]));
  }, [refresh]);
  const current = providers.find((item) => item.id === provider) ?? providers.find((item) => item.id === defaultProvider);
  const active = personalities.find((item) => item.active) ?? personalities[0];

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 md:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <p className="hidden truncate text-xs font-semibold tracking-widest text-primary uppercase sm:block">{tab}</p>
        <label className="flex min-w-0 items-center gap-2 rounded-full border border-border bg-bg px-3 py-1 text-xs">
          <span className="hidden text-muted sm:inline">Persona</span>
          <select
            aria-label="Personality"
            className="max-w-24 bg-transparent text-fg outline-none sm:max-w-36"
            value={active?.id ?? ""}
            onChange={(event) => activate(Number(event.target.value))}
          >
            {personalities.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <AccessControl access={access} onChange={() => setRefresh((n) => n + 1)} />
        <label className="flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1 text-xs">
          <span className="hidden text-muted sm:inline">AI</span>
          <select
            aria-label="AI provider"
            className="max-w-24 bg-transparent text-fg outline-none sm:max-w-36"
            value={current?.id ?? ""}
            onChange={(event) => setProvider(event.target.value)}
            disabled={providers.length === 0}
            title={current ? `Model: ${fast ? current.fastModel : current.model}` : "No AI provider configured"}
          >
            {providers.length === 0 && <option value="">offline</option>}
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setFast(!fast)}
          className="rounded-full border border-border px-2.5 py-2 sm:px-3 text-xs font-semibold tracking-wide text-fg"
        >
          {fast ? "Flash" : "Precise"}
        </button>
        <span className="hidden items-center gap-2 text-xs text-muted sm:flex">
          <Gauge className="h-4 w-4 text-primary" />
          node
        </span>
      </div>
    </header>
  );
}

/** Storage problems (full storage, another tab took over, history missing) shown on every tab. */
function SaveBanner() {
  const saveError = useOs((state) => state.saveError);
  if (!saveError) return null;
  return (
    <div role="alert" aria-label="Save problem" className="shrink-0 border-b border-primary/60 bg-surface px-3 py-2 text-xs leading-5 text-fg md:px-5">
      {saveError}
    </div>
  );
}
