/**
 * Cuts streaming text into pieces worth speaking.
 *
 * Text-to-speech sounds natural on whole sentences, but waiting for the
 * full answer wastes seconds. So tokens are collected until a sentence ends
 * (. ! ? and their Chinese forms, or a line break) and each sentence is sent
 * to TTS while the model keeps writing. Very short sentences are held back
 * and joined to the next one; very long ones are split at a comma or space.
 */
export class SentenceChunker {
  private buffer = '';
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor({ minChars = 12, maxChars = 220 }: { minChars?: number; maxChars?: number } = {}) {
    this.minChars = minChars;
    this.maxChars = maxChars;
  }

  /** Adds streamed text; returns the sentences that are complete. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const end = this.sentenceEnd();
      if (end < 0) break;
      const piece = clean(this.buffer.slice(0, end));
      if (piece.length < this.minChars && this.buffer.slice(end).trim() !== '' && !this.isCjk(piece)) {
        // Too short to sound good alone; wait for more unless the stream ends.
        const next = this.sentenceEnd(end);
        if (next < 0) break;
        const joined = clean(this.buffer.slice(0, next));
        this.buffer = this.buffer.slice(next);
        if (joined) out.push(joined);
        continue;
      }
      this.buffer = this.buffer.slice(end);
      if (piece) out.push(piece);
    }
    if (this.buffer.length > this.maxChars) out.push(...this.splitLong());
    return out;
  }

  /** Ends the stream; returns whatever is left. */
  flush(): string[] {
    const rest = clean(this.buffer);
    this.buffer = '';
    return rest ? [rest] : [];
  }

  /** Index just after the next sentence end at or after [from], or -1. */
  private sentenceEnd(from = 0): number {
    const re = /([.!?…]+["'”’)]?)(\s+|$)|([。！？；]+["'”’）]?)|\n+/g;
    re.lastIndex = from;
    for (let m = re.exec(this.buffer); m; m = re.exec(this.buffer)) {
      const end = m.index + m[0].length;
      // A Latin "." at the very end may be a decimal or an abbreviation still being typed.
      if (m[1] && m[2] === '' && end === this.buffer.length) return -1;
      // "3.5", "e.g." and "Mr." are not sentence ends.
      if (m[1] === '.' && /(\b[A-Z][a-z]?|\b(e\.g|i\.e|etc|vs|Dr|Mr|Ms|Mrs|No))$/.test(this.buffer.slice(0, m.index))) continue;
      if (end > from) return end;
    }
    return -1;
  }

  private splitLong(): string[] {
    const out: string[] = [];
    while (this.buffer.length > this.maxChars) {
      const window = this.buffer.slice(0, this.maxChars);
      let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('，'), window.lastIndexOf('、'));
      if (cut < this.maxChars / 3) cut = window.lastIndexOf(' ');
      if (cut < this.maxChars / 3) cut = this.maxChars - 1;
      out.push(clean(this.buffer.slice(0, cut + 1)));
      this.buffer = this.buffer.slice(cut + 1);
    }
    return out.filter(Boolean);
  }

  private isCjk(s: string): boolean {
    return /[一-鿿]/.test(s) && s.length >= 4;
  }
}

/** Removes what shouldn't be read aloud: Markdown marks, code fences, URLs, extra spaces. */
export function clean(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
