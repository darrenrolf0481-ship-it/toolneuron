import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, Fingerprint, KeyRound, Lock, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { MIN_PASSPHRASE, passphraseProblem, type VaultEntry } from "@/lib/crimson/vault/crypto";
import { onIpAddress, passkeySupport } from "@/lib/crimson/vault/passkey";
import { useVault } from "@/lib/crimson/vault/vault-store";

const field = "min-h-11 w-full rounded-2xl border border-border bg-bg px-4 text-sm text-fg outline-none focus:border-primary";
const primaryBtn = "flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-40";
const ghostBtn = "flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-border px-4 text-sm disabled:opacity-40";

export function VaultPane() {
  const status = useVault((state) => state.status);
  const init = useVault((state) => state.init);
  const touch = useVault((state) => state.touch);

  useEffect(() => init(), [init]);

  return (
    <div className="os-scroll flex-1 overflow-y-auto p-4 md:p-5" onPointerDown={touch} onKeyDown={touch}>
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h2 className="text-xl font-semibold">Memory vault</h2>
            <p className="text-xs text-muted">AES-256 encrypted in this browser. Never sent to the AI or the server.</p>
          </div>
        </div>
        <Messages />
        {status === "loading" && <p className="text-sm text-muted">Opening…</p>}
        {status === "none" && <CreateVault />}
        {status === "locked" && <UnlockVault />}
        {status === "unlocked" && <OpenVault />}
      </div>
    </div>
  );
}

function Messages() {
  const error = useVault((state) => state.error);
  const notice = useVault((state) => state.notice);
  const working = useVault((state) => state.working);
  return (
    <>
      {working && (
        <p role="status" className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm">
          {working}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-2xl border border-dashed border-primary/60 px-4 py-3 text-sm">
          ⚠ {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm">
          {notice}
        </p>
      )}
    </>
  );
}

function CreateVault() {
  const create = useVault((state) => state.create);
  const working = useVault((state) => state.working);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const problem = pass ? passphraseProblem(pass) : null;
  const mismatch = again.length > 0 && again !== pass;
  const ready = pass.length > 0 && !problem && again === pass;

  return (
    <form
      className="space-y-3 rounded-3xl border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !working) void create(pass);
      }}
    >
      <p className="text-sm font-semibold">Create your vault</p>
      <p className="text-sm text-muted">
        Choose a passphrase of at least {MIN_PASSPHRASE} characters. A few unrelated words work well. It is never stored:{" "}
        <span className="text-fg">if you forget it, the vault cannot be recovered.</span>
      </p>
      <label className="block text-xs font-semibold tracking-wide text-muted" htmlFor="vault-new">
        Passphrase
      </label>
      <input id="vault-new" type="password" autoComplete="new-password" value={pass} onChange={(event) => setPass(event.target.value)} className={field} />
      {problem && <p className="text-xs text-primary">{problem}</p>}
      <label className="block text-xs font-semibold tracking-wide text-muted" htmlFor="vault-again">
        Repeat passphrase
      </label>
      <input id="vault-again" type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} className={field} />
      {mismatch && <p className="text-xs text-primary">The two passphrases differ.</p>}
      <button type="submit" disabled={!ready || !!working} className={primaryBtn}>
        <Lock className="h-4 w-4" />
        Create encrypted vault
      </button>
    </form>
  );
}

function useCountdown(until: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function UnlockVault() {
  const unlock = useVault((state) => state.unlock);
  const unlockPasskey = useVault((state) => state.unlockPasskey);
  const hasPasskey = useVault((state) => state.hasPasskey);
  const working = useVault((state) => state.working);
  const retryAt = useVault((state) => state.retryAt);
  const wait = useCountdown(retryAt);
  const [pass, setPass] = useState("");

  return (
    <div className="space-y-3 rounded-3xl border border-border bg-surface p-4">
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!pass || working || wait) return;
          if (await unlock(pass)) setPass("");
        }}
      >
        <label className="block text-sm font-semibold" htmlFor="vault-pass">
          Passphrase
        </label>
        <input
          id="vault-pass"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={pass}
          onChange={(event) => setPass(event.target.value)}
          className={field}
        />
        <button type="submit" disabled={!pass || !!working || wait > 0} className={`${primaryBtn} w-full`}>
          <KeyRound className="h-4 w-4" />
          {wait > 0 ? `Try again in ${wait}s` : "Unlock"}
        </button>
      </form>
      {hasPasskey && (
        <button type="button" disabled={!!working} onClick={() => void unlockPasskey()} className={`${ghostBtn} w-full`}>
          <Fingerprint className="h-4 w-4" />
          Unlock with passkey
        </button>
      )}
    </div>
  );
}

function OpenVault() {
  const entries = useVault((state) => state.entries);
  const lock = useVault((state) => state.lock);
  const [editing, setEditing] = useState<VaultEntry | "new" | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setEditing("new")} className={primaryBtn}>
          <Plus className="h-4 w-4" />
          Add entry
        </button>
        <button type="button" onClick={() => lock()} className={ghostBtn}>
          <Lock className="h-4 w-4" />
          Lock now
        </button>
      </div>
      <p className="text-xs text-muted">Locks itself after 5 idle minutes, and when the page closes.</p>
      {editing && <EntryForm entry={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}
      {entries.length === 0 && !editing && <p className="rounded-2xl border border-border bg-bg px-4 py-3 text-sm text-muted">Empty. Add an API key, password or private note.</p>}
      <ul className="space-y-2">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} onEdit={() => setEditing(entry)} />
        ))}
      </ul>
      <VaultSettings />
    </div>
  );
}

function EntryRow({ entry, onEdit }: { entry: VaultEntry; onEdit: () => void }) {
  const remove = useVault((state) => state.remove);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <li className="rounded-2xl border border-border bg-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.title}</p>
        <div className="flex gap-1">
          <IconBtn label={shown ? "Hide secret" : "Show secret"} onClick={() => setShown(!shown)}>
            {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </IconBtn>
          <IconBtn
            label={copied ? "Copied" : "Copy secret"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(entry.secret);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setShown(true);
              }
            }}
          >
            <Copy className="h-4 w-4" />
          </IconBtn>
          <IconBtn label="Edit entry" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </IconBtn>
          <IconBtn
            label="Delete entry"
            onClick={() => {
              if (window.confirm(`Delete "${entry.title}" from the vault?`)) void remove(entry.id);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>
      <p className="mt-2 font-mono text-xs break-all text-fg">{shown ? entry.secret || "(empty)" : "•".repeat(Math.min(24, Math.max(8, entry.secret.length)))}</p>
      {copied && <p className="mt-1 text-xs text-muted">Copied to the clipboard.</p>}
      {entry.note && <p className="mt-2 text-sm whitespace-pre-wrap text-muted">{entry.note}</p>}
    </li>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-11 w-11 items-center justify-center rounded-xl border border-border text-muted hover:text-fg">
      {children}
    </button>
  );
}

function EntryForm({ entry, onDone }: { entry: VaultEntry | null; onDone: () => void }) {
  const upsert = useVault((state) => state.upsert);
  const [title, setTitle] = useState(entry?.title ?? "");
  const [secret, setSecret] = useState(entry?.secret ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [show, setShow] = useState(!entry);
  return (
    <form
      className="space-y-3 rounded-3xl border border-primary/60 bg-surface p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!title.trim()) return;
        const ok = await upsert({ id: entry?.id ?? `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, title: title.trim().slice(0, 120), secret: secret.slice(0, 10_000), note: note.slice(0, 10_000) });
        if (ok) onDone();
      }}
    >
      <p className="text-sm font-semibold">{entry ? "Edit entry" : "New entry"}</p>
      <label className="block text-xs font-semibold tracking-wide text-muted" htmlFor="ve-title">
        Name
      </label>
      <input id="ve-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="OpenRouter key" className={field} autoFocus />
      <label className="block text-xs font-semibold tracking-wide text-muted" htmlFor="ve-secret">
        Secret
      </label>
      <div className="flex gap-2">
        <input
          id="ve-secret"
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          className={`${field} font-mono`}
        />
        <IconBtn label={show ? "Hide secret" : "Show secret"} onClick={() => setShow(!show)}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </IconBtn>
      </div>
      <label className="block text-xs font-semibold tracking-wide text-muted" htmlFor="ve-note">
        Note (optional, also encrypted)
      </label>
      <textarea id="ve-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} className={`${field} py-3`} />
      <div className="flex gap-2">
        <button type="submit" disabled={!title.trim()} className={primaryBtn}>
          Save
        </button>
        <button type="button" onClick={onDone} className={ghostBtn}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function VaultSettings() {
  const hasPasskey = useVault((state) => state.hasPasskey);
  const setupPasskey = useVault((state) => state.setupPasskey);
  const forgetPasskey = useVault((state) => state.forgetPasskey);
  const changePassphrase = useVault((state) => state.changePassphrase);
  const destroy = useVault((state) => state.destroy);
  const working = useVault((state) => state.working);
  const [support, setSupport] = useState<"yes" | "no" | "maybe">("maybe");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const problem = next ? passphraseProblem(next) : null;

  useEffect(() => {
    void passkeySupport().then(setSupport);
  }, []);

  return (
    <details className="rounded-3xl border border-border bg-surface p-4">
      <summary className="cursor-pointer text-sm font-semibold">Vault settings</summary>
      <div className="mt-4 space-y-5">
        <section className="space-y-2">
          <p className="text-sm font-semibold">Passkey unlock</p>
          <p className="text-sm text-muted">
            Unlock with your fingerprint, face or device PIN. Uses the WebAuthn PRF extension (Chrome on Android, recent desktop browsers). Your passphrase keeps working.
          </p>
          {support === "no" && !hasPasskey ? (
            <p className="text-xs text-primary">
              {onIpAddress()
                ? "Passkeys do not work when the app is opened by IP address. Open it via localhost or a domain name."
                : "This browser cannot do passkey unlock (it needs a secure page and PRF support)."}
            </p>
          ) : hasPasskey ? (
            <button type="button" disabled={!!working} onClick={() => void forgetPasskey()} className={ghostBtn}>
              <Fingerprint className="h-4 w-4" />
              Remove passkey unlock
            </button>
          ) : (
            <button type="button" disabled={!!working} onClick={() => void setupPasskey()} className={ghostBtn}>
              <Fingerprint className="h-4 w-4" />
              Set up passkey unlock
            </button>
          )}
        </section>

        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!current || !next || problem || working) return;
            if (await changePassphrase(current, next)) {
              setCurrent("");
              setNext("");
            }
          }}
        >
          <p className="text-sm font-semibold">Change passphrase</p>
          <label className="sr-only" htmlFor="vc-current">
            Current passphrase
          </label>
          <input id="vc-current" type="password" autoComplete="current-password" placeholder="Current passphrase" value={current} onChange={(event) => setCurrent(event.target.value)} className={field} />
          <label className="sr-only" htmlFor="vc-next">
            New passphrase
          </label>
          <input id="vc-next" type="password" autoComplete="new-password" placeholder="New passphrase" value={next} onChange={(event) => setNext(event.target.value)} className={field} />
          {problem && <p className="text-xs text-primary">{problem}</p>}
          <button type="submit" disabled={!current || !next || !!problem || !!working} className={ghostBtn}>
            Change passphrase
          </button>
        </form>

        <section className="space-y-2">
          <p className="text-sm font-semibold">Delete vault</p>
          <p className="text-sm text-muted">Erases the encrypted vault from this browser. Export a node backup first if you want to keep it.</p>
          <button
            type="button"
            onClick={() => {
              if (window.prompt('Type DELETE to erase the vault and everything in it.') === "DELETE") destroy();
            }}
            className={`${ghostBtn} text-primary`}
          >
            <Trash2 className="h-4 w-4" />
            Delete vault
          </button>
        </section>
      </div>
    </details>
  );
}
