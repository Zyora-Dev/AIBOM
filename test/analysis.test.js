import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/scanner.js';

const scan = (content, path = 'app.py', baseline) => scanProject({ projectName: 'analysis-test', files: [{ path, content }], baseline });
const pinned = 'a'.repeat(40);

test('AST ignores commented and quoted examples in both languages', () => {
  for (const [path, content] of [
    ['app.py', '# model = "fake"\ntext = \'AutoModel.from_pretrained("fake", trust_remote_code=True)\'\n'],
    ['app.ts', '// model = "fake"\nconst text = \'AutoModel.from_pretrained("fake", {trust_remote_code: true})\';']
  ]) {
    const report = scan(content, path);
    assert.equal(report.components.length, 0);
    assert.equal(report.findings.filter(f => f.blocking).length, 0);
  }
});
test('explicit remote code and missing revision are independently actionable', () => {
  const report = scan('from transformers import AutoModel as AM\nx = AM.from_pretrained("org/model", trust_remote_code=True)');
  assert.equal(report.analysis.policy.status, 'fail');
  const findings = report.findings.filter(f => f.blocking);
  assert.deepEqual(findings.map(f => f.code).sort(), ['MODEL_UNPINNED', 'REMOTE_CODE_ENABLED']);
  assert.ok(findings.every(f => f.path === 'app.py' && f.line === 2 && f.remediation));
  assert.ok(findings.every(f => f.affected.includes('project-root')));
});
test('expanded or dynamic JS options never establish safety', () => {
  for (const options of [`{ revision: '${pinned}', trust_remote_code: false, ...options }`, 'options']) {
    const report = scan(`const m = AutoModel.from_pretrained('org/model', ${options});`, 'app.ts');
    assert.ok(report.findings.some(f => f.code === 'REMOTE_CODE_UNRESOLVED'));
    assert.ok(report.findings.some(f => f.code === 'REVISION_UNRESOLVED'));
    assert.equal(report.analysis.coverage.unresolvedCalls, 1);
  }
});
test('syntax errors surface as incomplete coverage', () => {
  for (const path of ['broken.py', 'broken.ts']) {
    const report = scan('def (', path);
    assert.equal(report.analysis.policy.status, 'review');
    assert.equal(report.analysis.coverage.parseErrors, 1);
    assert.equal(report.analysis.coverage.filesAnalyzed, 0);
    assert.ok(report.findings.some(f => f.code === 'PARSE_ERROR'));
  }
});
test('baseline comparison preserves stable identities and exposes resolved policy findings', () => {
  const before = scan('x = AutoModel.from_pretrained("org/model", trust_remote_code=True)');
  const after = scan(`x = AutoModel.from_pretrained("org/model", revision="${pinned}", trust_remote_code=False)`, 'app.py', before);
  assert.equal(after.analysis.policy.status, 'review');
  assert.ok(after.diff.resolved.some(f => f.code === 'REMOTE_CODE_ENABLED'));
  assert.ok(after.diff.resolved.some(f => f.code === 'MODEL_UNPINNED'));
  assert.equal(after.diff.added.length, 1);
  assert.equal(after.diff.removed.length, 1);
  const again = scan(`x = AutoModel.from_pretrained("org/model", revision="${pinned}", trust_remote_code=False)`, 'app.py', after);
  assert.equal(again.diff.added.length + again.diff.removed.length + again.diff.introduced.length + again.diff.resolved.length, 0);
  assert.equal(again.components[0].id, after.components[0].id);
  assert.equal(again.inputDigest, after.inputDigest);
  assert.deepEqual(again.diff.changedFiles, []);
  assert.deepEqual(after.diff.changedFiles, ['app.py']);
  assert.match(after.evidenceManifest[0].sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => scan('', 'app.py', { ...before, project: { name: 'other-project' } }), /Baseline/);
  assert.throws(() => scan('', 'app.py', { ...before, specVersion: '0.1' }), /Baseline/);
  for (const evidenceManifest of ['invalid', [null], [{ path: 'app.py', sha256: 'invalid' }]]) {
    assert.throws(() => scan('', 'app.py', { ...before, evidenceManifest }), /Baseline evidence manifest/);
  }
});
test('reference graph never fabricates a model-to-dataset lineage edge', () => {
  const report = scan(`x = AutoModel.from_pretrained("org/model", revision="${pinned}")\ndata = load_dataset("org/data")`);
  const graph = report.analysis.graph;
  const ids = new Set(graph.nodes.map(n => n.id));
  assert.ok(graph.edges.every(e => ids.has(e.source) && ids.has(e.target) && e.evidence.path));
  const model = report.components.find(c => c.type === 'model');
  const dataset = report.components.find(c => c.type === 'dataset');
  assert.ok(!graph.edges.some(e => e.source === model.id && e.target === dataset.id));
});
test('lockfile extraction distinguishes exact fixture match from ordinary dependencies', () => {
  const lock = { lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/@openaibom-fixtures/unsafe-loader': { version: '1.0.0', license: 'MIT' }, 'node_modules/real-package': { version: '1.0.0' } } };
  const report = scan(JSON.stringify(lock, null, 2), 'package-lock.json');
  assert.equal(report.components.length, 2);
  assert.ok(report.components.every(c => c.resolved));
  const matches = report.findings.filter(f => f.code === 'FIXTURE_ADVISORY_MATCH');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].synthetic, true);
  assert.match(matches[0].message, /Not a real vulnerability/);
  assert.match(report.analysis.advisorySource, /NOT a real/);
});
