import { describe, expect, it } from 'vitest';

import { clean, SentenceChunker } from '../web/src/speech/chunker.ts';

function feed(text: string, step = 3, chunker = new SentenceChunker()): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...chunker.push(text.slice(i, i + step)));
  return [...out, ...chunker.flush()];
}

describe('SentenceChunker', () => {
  it('emits each sentence as soon as it ends, whatever the token size', () => {
    const text = 'Three things keep me quick. Your browser notices when you stop! Does it work? Yes.';
    for (const step of [1, 2, 5, 40]) {
      expect(feed(text, step)).toEqual([
        'Three things keep me quick.',
        'Your browser notices when you stop!',
        'Does it work?',
        'Yes.',
      ]);
    }
  });

  it('does not wait for the end of the answer', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello there, this is the first sentence. And th')).toEqual(['Hello there, this is the first sentence.']);
    expect(c.push('e second')).toEqual([]);
    expect(c.flush()).toEqual(['And the second']);
  });

  it('keeps decimals, abbreviations and a dot that may still be a decimal', () => {
    const c = new SentenceChunker();
    expect(c.push('It costs 3.')).toEqual([]);
    expect(c.push('50 dollars, e.g. for Mr. Smith today. Next')).toEqual(['It costs 3.50 dollars, e.g. for Mr. Smith today.']);
  });

  it('splits Chinese on full-width punctuation', () => {
    expect(feed('我能这么快，靠三件事。回答是一句一句说出来的！你可以打断我吗？可以。')).toEqual([
      '我能这么快，靠三件事。',
      '回答是一句一句说出来的！',
      '你可以打断我吗？',
      '可以。',
    ]);
  });

  it('joins very short sentences to the next one', () => {
    expect(feed('Yes. I can do that for you right now.', 4)).toEqual(['Yes. I can do that for you right now.']);
  });

  it('breaks very long sentences at a comma', () => {
    const c = new SentenceChunker({ maxChars: 60 });
    const out = feed(
      'This sentence goes on and on, with clause after clause, because some models love long sentences, and we still want to start talking',
      10,
      c,
    );
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(60);
    expect(out.join(' ').replace(/\s+/g, ' ')).toContain('we still want to start talking');
  });

  it('treats line breaks as boundaries', () => {
    expect(feed('The first list item\nThe second list item\n')).toEqual(['The first list item', 'The second list item']);
  });
});

describe('clean', () => {
  it('strips what should not be read aloud', () => {
    expect(clean('**Bold** and `code` and [a link](https://x.y) and https://example.com/z')).toBe('Bold and code and a link and');
    expect(clean('- one\n- two')).toBe('one two');
    expect(clean('```js\nconsole.log(1)\n``` done')).toBe('done');
  });
});
