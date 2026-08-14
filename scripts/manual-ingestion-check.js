const path = require('node:path');
const { buildYtDlpBaseArgs, runProcess } = require('../engine-runtime');
const { YouTubeIngestionService } = require('../services/youtube');

const root = path.join(__dirname, '..');
const fallbackDir = path.join(root, 'resources', 'bin', 'fallback');
const paths = {
  ytdlpPath: path.join(fallbackDir, 'yt-dlp.exe'),
  denoPath: path.join(fallbackDir, 'deno.exe')
};

async function getRawMetadata(url) {
  const args = [
    ...buildYtDlpBaseArgs({ paths, cookies: false }),
    '--no-playlist', '--skip-download', '--dump-single-json', url
  ];
  const result = await runProcess(paths.ytdlpPath, args, { timeoutMs: 120000 });
  if (!result.ok) throw new Error(result.stderr || result.error);
  return JSON.parse(result.stdout);
}

async function main() {
  const urls = process.argv.slice(2);
  if (!urls.length) throw new Error('Pass one or more YouTube video URLs.');
  const service = new YouTubeIngestionService({ getRawMetadata });
  for (const url of urls) {
    try {
      const result = await service.ingest(url);
      console.log(JSON.stringify({
        url,
        status: 'PASS',
        videoId: result.metadata.videoId,
        title: result.metadata.title,
        durationSeconds: result.metadata.durationSeconds,
        transcriptSource: result.transcriptSource,
        transcriptLanguage: result.transcriptLanguage,
        cueCount: result.transcriptCues.length,
        segmentCount: result.transcriptSegments.length,
        firstTimestamp: result.transcriptCues[0]?.startSeconds
      }));
    } catch (error) {
      console.log(JSON.stringify({ url, status: 'ERROR', code: error.code || 'INGESTION_ERROR', message: error.message }));
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
