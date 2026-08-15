const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadPolicyJudgeConfig } = require('../services/policyJudge');
const { loadPolicySet } = require('../services/policyKnowledge');
const { loadVisualRiskConfig } = require('../services/visualRisk');
const { inspectExtension, resolveExtensionPath } = require('../services/youtube/extensionTranscript/extensionManager');

const root = path.join(__dirname, '..');
const userData = process.env.DOCTOR_USER_DATA || path.join(process.env.APPDATA || os.homedir(), 'tiktok-policy-checker');
const rows = [];
const add = (name, status, detail) => rows.push({ name, status, detail });
const run = (file, args, timeout = 30000) => spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, PATH: '' } });

async function main() {
  add('System', 'PASS', `${os.type()} ${os.release()} ${os.arch()} · ${Math.round(os.totalmem() / 2 ** 30)} GiB RAM`);
  const gpu = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  add('GPU / VRAM', gpu.status === 0 ? 'PASS' : 'WARN', gpu.status === 0 ? gpu.stdout.trim() : 'NVIDIA telemetry unavailable');
  for (const [name, file, args] of [
    ['yt-dlp', path.join(root, 'resources/bin/fallback/yt-dlp.exe'), ['--version']],
    ['FFmpeg', path.join(root, 'resources/bin/fallback/ffmpeg.exe'), ['-version']],
    ['Deno', path.join(root, 'resources/bin/fallback/deno.exe'), ['--version']],
    ['OCR runtime', path.join(root, 'resources/ocr/rapidocr-worker.exe'), ['--health']]
  ]) {
    const result = fs.existsSync(file) ? run(file, args) : { status: 1 };
    add(name, result.status === 0 ? 'PASS' : 'FAIL', result.status === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/)[0] : `Missing or unusable: ${file}`);
  }
  let models = [];
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    models = (await response.json()).models?.map(item => item.name) || []; add('Ollama', 'PASS', 'Local API reachable');
  } catch (error) { add('Ollama', 'WARN', error.message); }
  const judge = loadPolicyJudgeConfig(); const visual = loadVisualRiskConfig();
  add('Qwen model', models.includes(judge.model) ? 'PASS' : 'WARN', models.includes(judge.model) ? judge.model : `${judge.model} not installed`);
  add('Gemma model', models.includes(visual.model) ? 'PASS' : 'WARN', models.includes(visual.model) ? visual.model : `${visual.model} not installed`);
  try { const policies = loadPolicySet(); add('Policy version', 'PASS', `${policies.version} · ${policies.records.length} records`); }
  catch (error) { add('Policy version', 'FAIL', error.message); }
  const database = path.join(userData, 'analysis-jobs.json');
  try {
    const state = fs.existsSync(database) ? JSON.parse(fs.readFileSync(database, 'utf8')) : { formatVersion: 1, jobs: [] };
    add('Job database', state.formatVersion === 1 && Array.isArray(state.jobs) ? 'PASS' : 'FAIL', `${database} · ${state.jobs?.length || 0} jobs`);
  } catch (error) { add('Job database', 'FAIL', `${database} · ${error.message}`); }
  add('Cache paths', 'PASS', path.join(userData, '*-cache.json'));
  add('Report path', 'PASS', path.join(userData, 'reports'));
  const extension = inspectExtension(resolveExtensionPath(userData));
  add('Transcript extension', extension.status === 'EXTENSION_READY' ? 'PASS' : extension.status === 'EXTENSION_NOT_FOUND' ? 'WARN' : 'FAIL',
    `${extension.status} · ${extension.extensionPath}`);
  console.table(rows);
  if (rows.some(row => row.status === 'FAIL')) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
