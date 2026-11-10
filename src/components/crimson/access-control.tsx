import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { lockAccess, unlockAccess } from "@/lib/crimson/ai.functions";

export type Access = "unlocked" | "locked" | "unconfigured";

/** Header control: unlock with the server's access key, or lock again. */
export function AccessControl({ access, onChange }: { access: Access; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  if (access === "unconfigured") {
    return (
      <span
        className="rounded-full border border-border px-3 py-2 text-xs text-muted"
        title="Set APP_ACCESS_KEY (8+ characters) in the server .env to enable AI."
      >
        AI off
      </span>
    );
  }

  if (access === "unlocked") {
    return (
      <button
        type="button"
        aria-label="Lock AI"
        title="Lock AI on this device"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted hover:text-fg"
        onClick={async () => {
          await lockAccess().catch(() => undefined);
          onChange();
        }}
      >
        <LockOpen className="h-4 w-4" />
      </button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!key || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await unlockAccess({ data: { key } });
      if (result.ok) {
        setKey("");
        setOpen(false);
        onChange();
      } else {
        setError(result.error);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Unlock AI"
        className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-white"
      >
        <Lock className="h-3.5 w-3.5" />
        <span className="sm:hidden">Unlock</span>
        <span className="hidden sm:inline">Unlock AI</span>
      </button>
      {open && (
        <form
          onSubmit={submit}
          onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
          className="absolute right-0 top-11 z-50 w-[min(18rem,calc(100vw-1.5rem))] rounded-2xl border border-border bg-surface p-4 shadow-xl"
        >
          <label htmlFor="tn-access-key" className="text-xs font-semibold tracking-wide text-fg">
            Access key
          </label>
          <input
            id="tn-access-key"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary"
          />
          {error && <p className="mt-2 text-xs text-primary">{error}</p>}
          <button
            type="submit"
            disabled={pending || !key}
            className="mt-3 w-full rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Checking…" : "Unlock"}
          </button>
          <p className="mt-2 text-[11px] leading-4 text-muted">Remembered on this device for 30 days.</p>
        </form>
      )}
    </div>
  );
}
