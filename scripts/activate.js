// Activate the plugin in the DSH web profile:
//  1) symlink the package into the profile's node_modules
//  2) append a cordis.patch.yml row (id + package name)
//  3) print restart instructions
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles');
const NODE_MODULES = path.join(PROFILE_DIR, 'node_modules');
const PATCH_FILE = path.join(PROFILE_DIR, 'web', 'cordis.patch.yml');

const PKG_NAME = 'dsh-course-subtitles';

function linkPackage() {
  const target = path.join(NODE_MODULES, PKG_NAME);
  if (fs.existsSync(target)) {
    console.log(`[1/2] already linked: ${target}`);
    return;
  }
  fs.mkdirSync(NODE_MODULES, { recursive: true });
  try {
    // junction works without admin rights on Windows
    fs.symlinkSync(PLUGIN_DIR, target, 'junction');
    console.log(`[1/2] linked: ${target} -> ${PLUGIN_DIR}`);
  } catch (e) {
    console.error('symlink failed:', e.message);
    console.error(`fallback: copy the folder to ${target} manually`);
    process.exitCode = 1;
  }
}

function patchRow() {
  if (!fs.existsSync(PATCH_FILE)) {
    console.error(`cordis.patch.yml not found at ${PATCH_FILE}`);
    process.exitCode = 1;
    return;
  }
  const content = fs.readFileSync(PATCH_FILE, 'utf8');
  if (content.includes(`id: ${PKG_NAME}`)) {
    console.log('[2/2] patch row already present');
    return;
  }
  // An inserted entry must be written as an `insert:` list (a bare `- id:` row
  // only overrides an existing entry and is silently ignored). Node writes
  // UTF-8 without BOM so the js-yaml loader in dsh-app-boot parses it cleanly.
  const row = `\n# dsh-course-subtitles: course subtitles -> bilingual Feishu docs\n- insert:\n    - id: ${PKG_NAME}\n      name: '${PKG_NAME}'\n`;
  fs.appendFileSync(PATCH_FILE, row);
  console.log(`[2/2] appended row to ${PATCH_FILE}`);
}

linkPackage();
patchRow();

console.log(`
Done. To load the plugin:

  1) Stop the running DSH web process (Ctrl+C in its terminal, or close it).
  2) Start it again:
       dsh --profile web
     (or however you normally launch DSH web)
  3) Open the GUI, go to 设置 → 插件 → the "插件配置" list: the "课程字幕" card
     appears there alongside the other configurable plugins. If the card does
     not appear, check the loader status entry for
     "${PKG_NAME}" (a failed entry shows a loud per-entry report).

CLI is available right now without restart:
  cd ${PLUGIN_DIR}
  node bin/cs.js run --course <url> --dry-run
`);
