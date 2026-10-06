import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject, isSupportedPath, LIMITS } from '../lib/scanner.js';

const scan = files => scanProject({ projectName: 'test-project', files });
test('inventories direct npm dependencies and preserves constraints and declared app license', () => {
  const report = scan([{ path: 'package.json', content: JSON.stringify({ name: 'test', license: 'MIT', dependencies: { openai: '^4.0' }, devDependencies: { typescript: '~5.0' } }) }]);
  assert.equal(report.components.length, 3);
  assert.equal(report.components[0].licenseStatus, 'declared-unverified');
  assert.equal(report.components[1].version, '^4.0');
  assert.equal(report.components[1].license, null);
  assert.equal(report.findings.filter(f => f.code === 'LICENSE_UNKNOWN').length, 2);
});
test('parses supported requirements and discloses unsupported lines', () => {
  const report = scan([{ path: 'requirements-dev.txt', content: '# deps\nTransformers==4.48.0\nmy_package[extra]>=1.0, <2.0 ; python_version >= "3.10"\nnumpy\n-r base.txt\nhttps://example.com/pkg.whl' }]);
  assert.deepEqual(report.components.map(c => c.name), ['transformers', 'my-package', 'numpy']);
  assert.equal(report.components[0].evidence[0].line, 2);
  assert.equal(report.components[1].version, '>=1.0, <2.0');
  assert.equal(report.findings.filter(f => f.code === 'UNSUPPORTED_REQUIREMENT').length, 2);
});
test('finds literal candidates, aggregates evidence, and does not export source', () => {
  const report = scan([{ path: 'src/app.py', content: 'private_value = "not-for-report"\nmodel = "demo-model"\nmodel="demo-model"\nx.from_pretrained(\n "org/encoder")\nload_dataset("org/data")' }]);
  assert.equal(report.components.length, 3);
  assert.equal(report.components[0].type, 'model');
  const model = report.components.find(c => c.name === 'demo-model');
  assert.deepEqual(model.evidence.map(e => e.line), [2, 3]);
  assert.equal(report.components.find(c => c.type === 'dataset').name, 'org/data');
  assert.ok(!JSON.stringify(report).includes('not-for-report'));
  assert.ok(report.components.every(c => !c.reviewed));
});
test('reports unsupported manifests and malformed JSON without aborting scan', () => {
  const report = scan([{ path: 'package.json', content: '{bad' }, { path: 'pyproject.toml', content: '[project]' }]);
  assert.ok(report.findings.some(f => f.code === 'INVALID_MANIFEST'));
  assert.ok(report.findings.some(f => f.code === 'UNSUPPORTED_MANIFEST'));
});
test('excludes hidden, generated, dependency, traversal, and unsupported paths', () => {
  for (const path of ['.env', '.secret.py', 'x/.git/app.js', 'node_modules/x/a.js', '.venv/x.py', 'venv/x.py', 'dist/a.js', '../a.py', '/a.py', 'x\\a.py', 'image.png']) assert.equal(isSupportedPath(path), false, path);
  for (const path of ['src/app.ts', 'requirements.txt', 'nested/package.json']) assert.equal(isSupportedPath(path), true, path);
});
test('validates payload, duplicate paths, and limits', () => {
  assert.throws(() => scanProject({ projectName: '', files: [] }));
  assert.throws(() => scan([]));
  assert.throws(() => scan([null]));
  assert.throws(() => scan([{ path: '.env', content: 'secret' }]));
  assert.throws(() => scan([{ path: 'a.py', content: 'x'.repeat(LIMITS.fileBytes + 1) }]));
  assert.throws(() => scan(Array.from({ length: 301 }, (_, i) => ({ path: `${i}.py`, content: '' }))));
  assert.throws(() => scan(Array.from({ length: 9 }, (_, i) => ({ path: `${i}.py`, content: 'x'.repeat(LIMITS.fileBytes) }))));
  assert.throws(() => scan([{ path: 'a.py', content: '' }, { path: 'a.py', content: '' }]));
});
