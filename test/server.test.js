import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../server.js';

test('local server serves dashboard, scans, and validates requests', async t => {
  const server = createAppServer({ config: { mode: 'local', host: '127.0.0.1' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /OpenAIBOM/);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/app.js', '/style.css', '/scanner.js', '/api/health']) assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/unknown')).status, 404);
  const payload = { projectName: 'demo', files: [{ path: 'app.py', content: 'model="example-model"' }] };
  const request = (body, headers = {}) => fetch(base + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const response = await request(JSON.stringify(payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).components[0].name, 'example-model');
  assert.equal((await request('bad-json')).status, 400);
  assert.equal((await request('null')).status, 400);
  assert.equal((await request(JSON.stringify(payload), { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request(JSON.stringify(payload), { 'Content-Type': 'text/plain' })).status, 415);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const oversizedStatus = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 12 * 1024 * 1024 + 1 } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(oversizedStatus, 413);
  const demo = await (await fetch(base + '/api/demo')).json();
  const before = await (await request(JSON.stringify(demo.before))).json();
  assert.equal(before.analysis.policy.status, 'fail');
  const fixedResponse = await request(JSON.stringify({ ...demo.after, baseline: before }));
  assert.equal(fixedResponse.status, 200);
  const fixed = await fixedResponse.json();
  assert.equal(fixed.analysis.policy.status, 'review');
  assert.ok(fixed.diff.resolved.some(f => f.code === 'REMOTE_CODE_ENABLED'));
  assert.ok(fixed.inputDigest);
  const benchmark = await (await fetch(base + '/api/benchmark')).json();
  assert.equal(benchmark.summary.passed, benchmark.summary.total);
  assert.match(benchmark.scope, /NOT real-world accuracy/);
  const clientModule = await (await fetch(base + '/scanner.js')).text();
  assert.ok(!clientModule.includes("from 'node:"));
  assert.ok(clientModule.includes('isSupportedPath'));
});
