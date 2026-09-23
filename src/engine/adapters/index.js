// Adapter registry: pick an adapter by URL and expose a unified lesson/caption interface.
import * as deeplearning from './deeplearning.js';
import * as youtube from './youtube.js';
import * as bilibili from './bilibili.js';
import * as coursera from './coursera.js';

const ADAPTERS = [deeplearning, youtube, bilibili, coursera];

export const adapters = ADAPTERS.map((a) => ({
  id: a.id,
  name: a.name,
  hasOutline: typeof a.discoverOutline === 'function',
}));

export function pickAdapter(url) {
  const a = ADAPTERS.find((x) => x.match(url || ''));
  if (!a) {
    throw new Error(
      `no adapter for "${url}". Supported: deeplearning (learn.deeplearning.ai), youtube, bilibili, coursera (needs login cookie).`
    );
  }
  return a;
}
