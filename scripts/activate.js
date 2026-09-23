// Activate the plugin in a local DSH profile from a git checkout:
//  1) symlink this package into the profile's node_modules
//  2) append this repo's cordis.patch.yml rows to the profile's cordis.patch.yml
//  3) print restart instructions
//
// This is the git-checkout path. The shipped `dsh.bundle` manifest + the same
// cordis.patch.yml are what the official `dsh plugin add` uses, so both routes
// install identically — this script only exists because the package is not on
// npm yet.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_NAME = process.env.DSH_PROFILE || 'web';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles');
const NODE_MODULES = path.join(PROFILE_DIR, 'node_modules');
const PATCH_FILE = path.join(PROFILE_DIR, PROFILE_NAME, 'cordis.patch.yml');
const OWN_PATCH = path.join(PLUGIN_DIR, 'cordis.patch.yml');

const PKG_NAME = 'dsh-course-subtitles';

function linkPackage() {
  const target = path.join(NODE_MODULES, PKG_NAME);
  if (fs.existsSync(target)) {
    console.log(`[1/2] already linked: ${target}`);
    return;
  }
  fs.mkdirSync(NODE_MODULES, { recursive: true });
  try {
    // a junction works without admin rights on Windows
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
    console.error('Is the profile set up? Try: dsh --profile web');
    process.exitCode = 1;
    return;
  }
  const content = fs.readFileSync(PATCH_FILE, 'utf8');
  if (content.includes(`id: ${PKG_NAME}`)) {
    console.log('[2/2] patch row already present');
    return;
  }
  // Reuse the shipped row verbatim so this script and `dsh plugin add` can
  // never drift apart. An inserted entry must be written as an `insert:` list
  // (a bare `- id:` row only overrides an existing entry and is silently
  // ignored); the file is written without a BOM so the yaml loader in
  // dsh-app-boot parses it cleanly.
  const row = fs.readFileSync(OWN_PATCH, 'utf8').trimEnd();
  fs.appendFileSync(PATCH_FILE, `\n# --- ${PKG_NAME} (added by scripts/activate.js) ---\n${row}\n`);
  console.log(`[2/2] appended row to ${PATCH_FILE}`);
}

linkPackage();
patchRow();

console.log(`
Done. To load the plugin:

  1) Stop the running DSH ${PROFILE_NAME} process (Ctrl+C in its terminal, or close it).
  2) Start it again:
       dsh --profile ${PROFILE_NAME}
  3) In the conversation, ask the agent to run the course subtitle pipeline —
     the plugin registers the tools course_subtitles_run / course_outline_run /
     course_subtitles_status / course_proxy_status / course_llm_status.
     If the tools do not show up, check the loader entry for
     "${PKG_NAME}" (a failed entry reports the reason loudly).

CLI is available right now, without a restart:
  node bin/cs.js run --course <url> --dry-run --lessons 1
`);
