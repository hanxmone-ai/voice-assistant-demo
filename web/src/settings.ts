import type { Lang } from './speech/engines.ts';

export type Mode = 'auto' | 'demo' | 'server';

export interface Settings {
  /** Where answers, transcription and voice come from. */
  mode: Mode;
  serverUrl: string;
  lang: Lang;
  /** Read answers aloud; off gives a text-only assistant that still listens. */
  speak: boolean;
  /** With headphones the assistant's voice can't reach the microphone, so interrupting needs less effort. */
  headphones: boolean;
}

const KEY = 'voice-assistant-demo.settings';

export function defaultSettings(): Settings {
  const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh');
  return { mode: 'auto', serverUrl: '', lang: zh ? 'zh' : 'en', speak: true, headphones: false };
}

export function loadSettings(): Settings {
  const defaults = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      mode: saved.mode === 'demo' || saved.mode === 'server' ? saved.mode : 'auto',
      serverUrl: typeof saved.serverUrl === 'string' ? saved.serverUrl : '',
      lang: saved.lang === 'zh' || saved.lang === 'en' ? saved.lang : defaults.lang,
      speak: saved.speak ?? defaults.speak,
      headphones: saved.headphones ?? defaults.headphones,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage disabled: settings last for this visit.
  }
}
