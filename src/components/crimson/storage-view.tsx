import { useState } from "react";
import { useOs } from "@/lib/crimson/store";

export function StorageView() {
  const storage = useOs((state) => state.storage);
  const add = useOs((state) => state.addStorage);
  const remove = useOs((state) => state.removeStorage);
  const [note, setNote] = useState("");

  return (
    <div className="os-scroll h-full overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Data core</h2>
          <p className="mt-1 max-w-xl text-sm text-muted">Names, sizes, and short notes. File bytes are not kept, so a reload still knows what you filed.</p>
        </div>
        <label className="min-h-11 cursor-pointer rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary">
          Ingest
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const items = Array.from(event.target.files ?? []).map((file) => ({
                id: `stor_${file.name}_${Date.now()}`,
                name: file.name,
                size: file.size > 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`,
                type: file.name.split(".").pop() || "file",
                date: new Date().toISOString().slice(0, 10),
              }));
              if (items.length) add(items);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = note.trim();
          if (!text) return;
          add([
            {
              id: `note_${Date.now()}`,
              name: text.slice(0, 48),
              size: `${text.length} chars`,
              type: "note",
              date: new Date().toISOString().slice(0, 10),
              note: text,
            },
          ]);
          setNote("");
        }}
      >
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Pin a note into the core"
          className="min-h-11 flex-1 rounded-2xl border border-border bg-surface px-3 text-sm outline-none"
        />
        <button type="submit" className="min-h-11 rounded-2xl border border-border px-4 text-sm">
          Pin
        </button>
      </form>

      <ul className="mt-4 space-y-2">
        {storage.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 rounded-3xl border border-border bg-surface px-4 py-3">
            <div>
              <p className="text-sm font-semibold">{item.name}</p>
              <p className="text-xs text-muted">
                {item.type} · {item.size} · {item.date}
              </p>
              {item.note && <p className="mt-2 text-sm">{item.note}</p>}
            </div>
            <button type="button" onClick={() => remove(item.id)} className="min-h-11 text-xs text-muted">
              Drop
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
