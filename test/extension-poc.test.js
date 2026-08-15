const assert = require('node:assert/strict');
const test = require('node:test');

const { networkRecord, redactText } = require('../scripts/extension-poc/main');

test('extension POC redacts network secrets and records no cookies', () => {
  const record = networkRecord({
    url: 'https://www.youtube.com/api/timedtext?v=abc&signature=secret',
    method: 'GET', initiator: 'chrome-extension://example/background.html?token=secret'
  }, 429);
  assert.deepEqual(record, {
    event: 'transcript-network', hostname: 'www.youtube.com', path: '/api/timedtext', method: 'GET', status: 429,
    initiator: 'chrome-extension://example/background.html', session: 'persist:youtube-transcript-poc', cookies: 'NOT_INSPECTED'
  });
  assert.equal(redactText('Authorization: Bearer super.secret.token'), 'Authorization: Bearer [REDACTED]');
  assert.equal(networkRecord({ url: 'https://yt-summary.glasp.co/yt_lg/wxEpPin8MWw/unknown/unknown/init', method: 'GET' }, 200).path,
    '/yt_lg/:videoId/unknown/unknown/init');
});
