import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../server.js';
import { analyzeInWorker, serverConfig } from '../lib/hosted-analysis.js';

const origin = 'https://openaibom-demo.onrender.com';
const payload = { projectName: 'visitor-project', files: [{ path: 'app.py', content: 'model = "example-model"' }] };

async function setup(t, options = {}) {
  const server = createAppServer({ config: serverConfig({ HOSTING_MODE: 'public', RENDER_EXTERNAL_URL: origin }), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { Host: new URL(origin).host, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const scan = (data = payload, headers = {}) => request('/api/scan', { method: 'POST', body: JSON.stringify(data), headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
  return { server, request, scan };
}

test('hosting config stays loopback by default and fails closed for invalid public origins', () => {
  assert.deepEqual(serverConfig({}), { mode: 'local', origin: undefined, host: '127.0.0.1' });
  assert.equal(serverConfig({ HOSTING_MODE: 'public', RENDER_EXTERNAL_URL: origin }).host, '0.0.0.0');
  assert.equal(serverConfig({ HOSTING_MODE: 'public', APP_ORIGIN: 'https://custom.example/', RENDER_EXTERNAL_URL: origin }).origin, 'https://custom.example');
  for (const value of [undefined, 'http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'https://example.com/#x']) {
    assert.throws(() => serverConfig({ HOSTING_MODE: 'public', APP_ORIGIN: value }), /HTTPS origin/);
  }
  assert.throws(() => serverConfig({ HOSTING_MODE: 'typo' }), /HOSTING_MODE/);
});

test('public config, host allowlist and strict origin checks support Render without trusting forwarded headers', async t => {
  const { request, scan } = await setup(t);
  const configuration = await request('/api/config');
  assert.equal(configuration.status, 200);
  assert.equal(JSON.parse(configuration.text).hostingMode, 'public');
  assert.equal(JSON.parse(configuration.text).uploadsEnabled, true);
  assert.equal(configuration.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(configuration.headers['referrer-policy'], 'no-referrer');
  assert.equal((await request('/', { headers: { Host: 'untrusted.example', 'X-Forwarded-Host': new URL(origin).host } })).status, 403);
  assert.equal((await request('/api/health', { headers: { Host: 'localhost' } })).status, 200);
  assert.equal((await request('/api/config', { headers: { Host: 'localhost' } })).status, 403);
  assert.equal((await scan(payload, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await scan(payload, { Origin: 'null' })).status, 403);
  assert.equal((await request('/api/scan', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })).status, 403);
  const valid = await scan();
  assert.equal(valid.status, 200);
  assert.equal(JSON.parse(valid.text).components[0].name, 'example-model');
  assert.equal(valid.headers['access-control-allow-origin'], undefined);
});

test('hosted bundled demo and same-project baseline comparison remain available', async t => {
  const { request, scan } = await setup(t);
  const demo = JSON.parse((await request('/api/demo')).text);
  const before = JSON.parse((await scan(demo.before)).text);
  const after = JSON.parse((await scan({ ...demo.after, baseline: before })).text);
  assert.equal(before.analysis.policy.status, 'fail');
  assert.equal(after.analysis.policy.status, 'review');
  assert.equal(after.diff.resolved.filter(f => f.blocking).length, 6);
  const benchmark = JSON.parse((await request('/api/benchmark')).text);
  assert.equal(benchmark.summary.passed, benchmark.summary.total);
});

test('public scan budget returns retryable 429 independently of spoofed client IP headers', async t => {
  const { request, scan } = await setup(t, { scansPerMinute: 1 });
  assert.equal((await scan()).status, 200);
  const limited = await scan(payload, { 'X-Forwarded-For': '203.0.113.5' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/demo')).status, 200);
});

test('concurrent upload limit keeps the health endpoint responsive and releases aborted requests', async t => {
  const { server, request, scan } = await setup(t, { maxConcurrent: 1 });
  const partial = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/scan', headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json' } });
  partial.on('error', () => {});
  const admitted = new Promise(resolve => server.once('request', resolve));
  partial.write('{');
  const incoming = await admitted;
  assert.equal((await request('/api/health')).status, 200);
  const busy = await scan();
  assert.equal(busy.status, 503);
  assert.equal(busy.headers['retry-after'], '10');
  const closed = new Promise(resolve => incoming.once('close', resolve));
  partial.destroy();
  await closed;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await scan()).status, 200);
});

test('chunked uploads enforce the byte limit without relying on Content-Length', async t => {
  const { request, scan } = await setup(t);
  const oversized = await request('/api/scan', { method: 'POST', body: 'x'.repeat(12 * 1024 * 1024 + 1), headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
  assert.equal(oversized.status, 413);
  assert.equal((await scan()).status, 200);
});

test('worker parsing validates inputs, times out and honors cancellation without executing source', async () => {
  const report = await analyzeInWorker(JSON.stringify(payload));
  assert.equal(report.project.name, payload.projectName);
  await assert.rejects(analyzeInWorker('invalid'), /Invalid JSON/);
  await assert.rejects(analyzeInWorker('null'), /request|object|payload/i);
  await assert.rejects(analyzeInWorker(JSON.stringify(payload), { timeoutMs: 1 }), /timed out/);
  const controller = new AbortController();
  const running = analyzeInWorker(JSON.stringify(payload), { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, /cancelled/);
  await assert.rejects(analyzeInWorker('{}', { signal: controller.signal }), /cancelled/);
});
