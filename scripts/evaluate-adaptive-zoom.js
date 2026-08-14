#!/usr/bin/env node
'use strict';

// Isolated Phase 5.3 evaluator. It is not imported by product code.
const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('../engine-runtime');
const { loadVisualRiskConfig } = require('../services/visualRisk');
const { OllamaVisualProvider } = require('../services/visualRisk/provider');

const cases = ['bodycam-660', 'microphone', 'phone', 'seattle-clean', 'swimming', 'glock-clean', 'nasa-action', 'crowd'];
const frameDir = process.argv[2];
const output = process.argv[3];
const ffmpeg = path.join(__dirname, '..', 'resources', 'bin', 'fallback', 'ffmpeg.exe');

async function inspect(provider, image) {
  const started = Date.now();
  try {
    const result = await provider.inspectFrame(image, {});
    return {
      latencyMs: Date.now() - started,
      valid: true,
      weapon: result.findings.some(finding => finding.category === 'weapon' && finding.applies),
      findings: result.findings,
      detectedText: result.detectedText
    };
  } catch (error) {
    return { latencyMs: Date.now() - started, valid: false, weapon: false, error: error.code || error.message, rawOutput: error.rawOutput || null };
  }
}

async function main() {
  if (!frameDir || !output) throw new Error('Usage: evaluate-adaptive-zoom.js FRAME_DIR OUTPUT_JSON');
  const config = loadVisualRiskConfig();
  const provider = new OllamaVisualProvider(config);
  const health = await provider.healthCheck();
  if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
  const results = {};
  for (const name of cases) {
    const image = path.join(frameDir, `${name}-720.jpg`);
    const full = await inspect(provider, image);
    const tiles = [];
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const tile = path.join(frameDir, `${name}-tile-${row}-${column}.jpg`);
        const crop = `crop=iw/2:ih/2:${column}*iw/2:${row}*ih/2`;
        const extracted = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', image, '-vf', crop, '-frames:v', '1', '-q:v', '2', '-y', tile], { timeoutMs: 30000 });
        if (!extracted.ok) throw new Error(extracted.stderr || extracted.error || `Failed to crop ${name}`);
        tiles.push({ row, column, ...await inspect(provider, tile) });
      }
    }
    results[name] = { full, tiles, tiledWeapon: tiles.some(tile => tile.weapon) };
  }
  await provider.unload(config.model);
  const record = {
    model: config.model,
    grid: '2x2',
    generic: true,
    results,
    bodycamDetected: results['bodycam-660'].tiledWeapon,
    negativeFalsePositives: cases.slice(1).filter(name => results[name].tiledWeapon)
  };
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ model: record.model, bodycamDetected: record.bodycamDetected, negativeFalsePositives: record.negativeFalsePositives }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ code: error.code || 'ADAPTIVE_ZOOM_FAILED', message: error.message, rawOutput: error.rawOutput || null }));
  process.exitCode = 1;
});
