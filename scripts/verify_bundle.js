// Verify the host plugin imports cleanly.
//
// The client bundle was removed on purpose: the plugin has no GUI configuration
// page — it is invoked through the agent-facing tools (course_subtitles_run /
// course_outline_run / course_subtitles_status / course_proxy_status /
// course_llm_status) and the /api/course-subtitles/* routes, both driven by the
// stored configuration.
//
// The host half imports packages that only exist inside a DeepSeek Harness
// installation (@deepseek-ai/schemastery, @deepseek-ai/dsh-credentials,
// @deepseek-ai/dsh-tools). Run this from a checkout linked into a DSH profile
// (`node scripts/activate.js`); outside one it reports a skip instead of failing.
try {
  const host = await import('../src/host/index.js');
  console.log('host exports:', Object.keys(host), '| name:', host.name, '| inject:', JSON.stringify(host.inject));
  if (typeof host.apply !== 'function') throw new Error('host apply() is not a function');
  console.log('HOST OK');
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  console.log('SKIPPED: the DSH runtime packages are not resolvable from here.');
  console.log(`  ${String(e.message).split('\n')[0]}`);
  console.log('  This check only runs inside a DSH install — link the plugin first:');
  console.log('    node scripts/activate.js   # then re-run this script');
}
