// Tiny JSON file cache for idempotent, token-efficient re-runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function makeCache(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function fileFor(key) {
    const safe = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(dir, safe + '.json');
  }

  return {
    dir,
    get(key) {
      try {
        const f = fileFor(key);
        if (!fs.existsSync(f)) return undefined;
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        return raw.data;
      } catch {
        return undefined;
      }
    },
    set(key, data) {
      const f = fileFor(key);
      fs.writeFileSync(f, JSON.stringify({ key, data }), 'utf8');
    },
    del(key) {
      try {
        fs.unlinkSync(fileFor(key));
      } catch {}
    },
  };
}
