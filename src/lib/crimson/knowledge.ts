/**
 * Knowledge packs (the Hub's Database): uploaded text, split into sections,
 * and a keyword search (TF-IDF) that picks the sections matching a message.
 * No embeddings and no server: it runs in the browser on every message.
 */

/** Most text kept per pack; larger uploads keep their start. */
export const MAX_PACK_CHARS = 120_000;
/** Section size the text is split into. */
export const SECTION_CHARS = 700;
/** Most characters of matching sections added to one prompt. */
export const RETRIEVAL_BUDGET = 1800;

export type PackLike = { id: string; name: string; excerpt: string; text?: string; armed?: boolean };

export type Section = { pack: string; index: number; text: string };

const STOP = new Set(
  "the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when your into than then them these some could also just like been were more such only other very where while each does make most over said should those after because being here".split(
    " ",
  ),
);

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((word) => !STOP.has(word));
}

/** Splits on blank lines, then lines, packing pieces up to SECTION_CHARS. */
export function sections(text: string, size = SECTION_CHARS): string[] {
  const pieces = text
    .split(/\n\s*\n/)
    .flatMap((block) => (block.length > size ? block.split("\n") : [block]))
    .flatMap((line) => {
      if (line.length <= size) return [line];
      const out: string[] = [];
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
      return out;
    })
    .map((piece) => piece.trim())
    .filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      out.push(current);
      current = piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) out.push(current);
  return out;
}

export function packText(pack: PackLike): string {
  return pack.text ?? pack.excerpt;
}

/**
 * The sections of the armed packs that best match `message`, within
 * `budget` characters. With no match, the start of each armed pack (so a
 * pack of rules still applies to every message).
 */
export function retrieve(packs: PackLike[], message: string, budget = RETRIEVAL_BUDGET): { sections: Section[]; matched: boolean } {
  const armed = packs.filter((pack) => pack.armed);
  if (armed.length === 0) return { sections: [], matched: false };
  const all: (Section & { words: Map<string, number> })[] = [];
  for (const pack of armed) {
    sections(packText(pack)).forEach((text, index) => {
      const words = new Map<string, number>();
      for (const word of terms(text)) words.set(word, (words.get(word) ?? 0) + 1);
      all.push({ pack: pack.name, index, text, words });
    });
  }
  const query = [...new Set(terms(message))];
  const df = new Map(query.map((word) => [word, all.filter((section) => section.words.has(word)).length]));
  const scored = all
    .map((section) => {
      let score = 0;
      for (const word of query) {
        const tf = section.words.get(word) ?? 0;
        if (tf) score += (1 + Math.log(tf)) * Math.log(1 + all.length / (df.get(word) ?? 1));
      }
      return { section, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const pick = (list: Section[]) => {
    const out: Section[] = [];
    let used = 0;
    for (const section of list) {
      const cost = section.text.length + section.pack.length + 8;
      if (used + cost > budget) {
        if (out.length === 0) out.push({ ...section, text: section.text.slice(0, Math.max(0, budget - section.pack.length - 8)) });
        break;
      }
      out.push(section);
      used += cost;
    }
    return out;
  };
  if (scored.length > 0) return { sections: pick(scored.map(({ section }) => ({ pack: section.pack, index: section.index, text: section.text }))), matched: true };
  const starts = armed.map((pack) => ({ pack: pack.name, index: 0, text: (sections(packText(pack))[0] ?? "").slice(0, Math.floor(budget / armed.length) - pack.name.length - 8) }));
  return { sections: pick(starts.filter((section) => section.text)), matched: false };
}

/** The prompt block for retrieved sections, or "". */
export function knowledgeBlock(found: { sections: Section[]; matched: boolean }): string {
  if (found.sections.length === 0) return "";
  const head = found.matched ? "Knowledge (sections of the user's packs that match this message):" : "Knowledge (start of the user's armed packs):";
  return [head, ...found.sections.map((section) => `[${section.pack} §${section.index + 1}]\n${section.text}`)].join("\n");
}
