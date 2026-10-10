import type { ChatMessage, StreamEvent } from './types.ts';

/**
 * A pretend model for demo mode: short, spoken-style answers (no Markdown),
 * streamed with a realistic rhythm, in English or Chinese to match the
 * question.
 */

const ZH = /[一-鿿]/;

const ANSWERS: { match: RegExp; en?: string; zh?: string }[] = [
  {
    match: /(how|work|pipeline|latency|fast|怎么|原理|延迟|速度)/i,
    en: 'Three things keep me quick. Your browser notices the moment you stop talking, so nothing waits for a button. My answer is spoken one sentence at a time, while the rest is still being written. And if you talk over me, I stop and listen straight away.',
    zh: '我能这么快，靠三件事。浏览器一听到你说完就马上处理，不用等你按按钮。回答是一句一句说出来的，后面的还在生成。你随时插话，我会立刻停下来听你说。',
  },
  {
    match: /(interrupt|barge|stop|打断|停)/i,
    en: 'Go ahead and try it. Ask me something long, then start talking while I am answering. I will stop mid-sentence and listen to you.',
    zh: '你可以试试看。问我一个长一点的问题，在我回答的时候直接开口说话，我会马上停下来听你说。',
  },
  {
    match: /(who|what are you|what can you|你是谁|你能做|介绍)/i,
    en: 'I am a demo voice assistant. In this mode a small built-in model answers, so it works without any keys. Connect a real model on the server and the same pipeline talks to it.',
    zh: '我是一个语音助手演示。现在是演示模式，回答来自内置的小模型，不需要任何密钥。在服务器上接入真实模型后，同样的流程就能和它对话。',
  },
  {
    match: /^\s*(hi|hello|hey|你好|嗨)/i,
    en: 'Hello! I am listening. Ask me how this works, or try interrupting me while I talk.',
    zh: '你好！我在听。可以问我这是怎么做到的，或者在我说话时打断我试试。',
  },
];

const FALLBACK = {
  en: 'Good question. In demo mode I only know a few answers, but every part you just used was real: voice detection, streaming, and speech. Ask me how it works.',
  zh: '好问题。演示模式下我只会回答几个问题，但你刚才用到的每个环节都是真的：语音检测、流式输出和语音合成。可以问我这是怎么做到的。',
};

export function mockReply(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lang = ZH.test(last) ? 'zh' : 'en';
  const hit = ANSWERS.find((a) => a.match.test(last) && a[lang]);
  return hit?.[lang] ?? FALLBACK[lang];
}

/** Word-sized pieces (single characters for Chinese) that join back to the text. */
export function pieces(text: string): string[] {
  return text.match(/[一-鿿　-〿＀-￯]|\s+|[^\s一-鿿　-〿＀-￯]{1,6}/gu) ?? [];
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface MockOptions {
  firstTokenMs?: number;
  pieceMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export async function* mockStream(
  messages: ChatMessage[],
  { firstTokenMs = 350, pieceMs = 30, random = Math.random, sleep = abortableSleep, signal }: MockOptions = {},
): AsyncGenerator<StreamEvent> {
  const reply = mockReply(messages);
  yield { type: 'start', provider: 'mock', model: 'demo-mock' };
  try {
    await sleep(firstTokenMs, signal);
    const parts = pieces(reply);
    for (let i = 0; i < parts.length; ) {
      const n = 1 + Math.floor(random() * 3);
      yield { type: 'delta', text: parts.slice(i, i + n).join('') };
      i += n;
      await sleep(pieceMs * (0.5 + random()), signal);
    }
  } catch (e) {
    if (signal?.aborted) return;
    throw e;
  }
  yield { type: 'done', finishReason: 'stop' };
}

/** A canned transcript for demo mode when the browser can't recognise speech. */
export const MOCK_TRANSCRIPTS = {
  en: ['How does this work so fast?', 'Can I interrupt you?', 'What can you do?'],
  zh: ['你是怎么做到这么快的？', '我可以打断你吗？', '你能做什么？'],
};
