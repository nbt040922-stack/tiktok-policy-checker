const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { runProcess } = require('../engine-runtime');
const {
  VisualFindingCache, VisualRiskService, VisualSamplingService, cheapScan, loadVisualRiskConfig
} = require('../services/visualRisk');
const { OllamaVisualProvider } = require('../services/visualRisk/provider');

const root = path.join(__dirname, '..');
const ffmpeg = path.join(root, 'resources', 'bin', 'fallback', 'ffmpeg.exe');
const sheet = path.join(root, 'test', 'fixtures', 'visual', 'synthetic-contact-sheet.png');
const calibrationSheet = path.join(root, 'test', 'fixtures', 'visual', 'synthetic-calibration-sheet.png');
const minorBlood = path.join(root, 'test', 'fixtures', 'visual', 'synthetic-minor-blood.png');
const config = loadVisualRiskConfig();
const cases = [
  { id: 'clean-talking-head', panel: 0, allowed: [], forbidden: ['weapon', 'blood', 'nudity', 'graphic_injury'] },
  { id: 'weapon-visible-prop', panel: 1, allowed: ['weapon'], forbidden: ['blood', 'nudity'] },
  { id: 'news-weapon', panel: 2, allowed: ['weapon'], forbidden: ['blood', 'nudity'] },
  { id: 'minor-injury', panel: 3, allowed: [], forbidden: ['weapon', 'nudity', 'graphic_injury'] },
  { id: 'benign-red-object', panel: 4, allowed: [], forbidden: ['blood', 'graphic_injury', 'weapon', 'nudity'] },
  { id: 'clothed-beach', panel: 5, allowed: [], forbidden: ['nudity', 'sexual_content', 'weapon', 'blood'] },
  { id: 'risk-text-overlay', panel: 6, allowed: ['on_screen_text_risk'], forbidden: ['weapon', 'blood', 'nudity'], text: /weapon\s+for\s+sale/i },
  { id: 'prevention-no-act', panel: 7, allowed: [], forbidden: ['self_harm_visual', 'blood', 'weapon', 'nudity'] },
  { id: 'theatrical-blood-context', source: calibrationSheet, columns: 2, rows: 1, panel: 0, allowed: [], forbidden: ['weapon', 'nudity', 'graphic_injury'] },
  { id: 'partial-nudity-risk', source: calibrationSheet, columns: 2, rows: 1, panel: 1, allowed: ['nudity', 'sexual_content'], forbidden: ['weapon', 'blood', 'graphic_injury'] },
  { id: 'minor-visible-blood', source: minorBlood, columns: 1, rows: 1, panel: 0, allowed: ['blood'], forbidden: ['weapon', 'nudity', 'graphic_injury'] }
];

async function checked(args, timeoutMs = 30000) {
  const result = await runProcess(ffmpeg, args, { timeoutMs });
  if (!result.ok) throw new Error(result.error || result.stderr);
}

function gpuProbe() {
  return new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], (error, stdout) => resolve(error ? null : Number.parseInt(stdout, 10))));
}

async function main() {
  if (!fs.existsSync(sheet)) throw new Error(`Missing fixture: ${sheet}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-benchmark-'));
  const provider = new OllamaVisualProvider(config);
  let peakVramMiB = await gpuProbe();
  const monitor = setInterval(async () => {
    const used = await gpuProbe();
    if (Number.isFinite(used)) peakVramMiB = Math.max(peakVramMiB || 0, used);
  }, 500);
  try {
    const health = await provider.healthCheck();
    if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
    await provider.unload('qwen3:14b');
    const benchmarkStarted = Date.now();
    const results = [];
    for (const item of cases) {
      const columns = item.columns || 4; const rows = item.rows || 2;
      const column = item.panel % columns; const row = Math.floor(item.panel / columns);
      const jpg = path.join(dir, `${item.id}.jpg`); const raw = path.join(dir, `${item.id}.rgb`);
      const crop = `crop=iw/${columns}:ih/${rows}:${column}*iw/${columns}:${row}*ih/${rows},scale=${config.frameWidth}:${config.frameHeight}`;
      await checked(['-hide_banner', '-loglevel', 'error', '-i', item.source || sheet, '-vf', crop, '-frames:v', '1', '-q:v', '3', '-y', jpg]);
      await checked(['-hide_banner', '-loglevel', 'error', '-i', item.source || sheet, '-vf', crop, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', raw]);
      const signals = cheapScan(fs.readFileSync(raw), config.frameWidth, config.frameHeight, config);
      const started = Date.now();
      const inspected = await provider.inspectFrame(jpg, signals);
      const applied = inspected.findings.filter(finding => finding.applies).map(finding => finding.category);
      const foundAllowed = Boolean(!item.allowed.length || item.allowed.some(category => applied.includes(category)) || (item.text && item.text.test(inspected.detectedText)));
      const falsePositive = item.forbidden.some(category => applied.includes(category));
      results.push({ id: item.id, pass: foundAllowed && !falsePositive, falsePositive, applied, detectedText: inspected.detectedText, cheapEscalate: signals.escalate, redRatio: Number(signals.redRatio.toFixed(4)), skinRatio: Number(signals.skinRatio.toFixed(4)), edgeDensity: Number(signals.edgeDensity.toFixed(4)), latencyMs: Date.now() - started });
    }

    const cleanPanel = path.join(dir, 'clean.jpg');
    await checked(['-hide_banner', '-loglevel', 'error', '-i', sheet, '-vf', `crop=iw/4:ih/2:0:0,scale=-2:${config.proxyHeight}`, '-frames:v', '1', '-q:v', '3', '-y', cleanPanel]);
    const longVideo = path.join(dir, 'clean-20min.mp4');
    await checked(['-hide_banner', '-loglevel', 'error', '-loop', '1', '-framerate', '1', '-i', cleanPanel, '-t', '1200', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', longVideo], 180000);
    const segments = Array.from({ length: 60 }, (_, index) => ({ startSeconds: index * 20, endSeconds: (index + 1) * 20, text: 'Neutral educational speech.' }));
    const judgments = segments.map((_, index) => ({ id: `segment-${index + 1}`, decision: 'KEEP', categories: [], requiresVisualReview: false }));
    const service = new VisualRiskService({
      config, provider, textModel: 'qwen3:14b', cache: new VisualFindingCache(),
      sampler: new VisualSamplingService({ ffmpegPath: ffmpeg, runProcess, config })
    });
    const e2eStarted = Date.now();
    const longRun = await service.analyze(longVideo, dir, { metadata: { videoId: 'synthetic-clean-20m' }, transcriptSegments: segments }, judgments);
    const e2eMs = Date.now() - e2eStarted;
    await provider.unload(config.model);
    clearInterval(monitor);
    const latencies = results.map(item => item.latencyMs).sort((a, b) => a - b);
    console.log(JSON.stringify({
      model: config.model, benchmarkCases: results.length, passed: results.filter(item => item.pass).length,
      falsePositives: results.filter(item => item.falsePositive).map(item => item.id),
      escalationRate: results.filter(item => item.cheapEscalate).length / results.length,
      meanVlmLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      peakVramMiB, results,
      longVideo: { durationSeconds: 1200, runtimeMs: e2eMs, ...longRun.metrics }
    }, null, 2));
  } finally {
    clearInterval(monitor);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(JSON.stringify({ code: error.code || 'VISUAL_BENCHMARK_FAILED', message: error.message, rawOutput: error.rawOutput || null })); process.exitCode = 1; });
