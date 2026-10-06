import test from 'node:test';
import assert from 'node:assert/strict';
import { getDemo } from '../lib/demo.js';
import { runBenchmark } from '../lib/benchmark.js';
import { scanProject } from '../lib/scanner.js';

const emptyReport = findings => ({ components: [], findings, analysis: { policy: { status: 'pass' }, coverage: {} } });

test('hand-labelled benchmark matches all fixture rules, paths and lines', () => {
  const report = runBenchmark();
  const failures = report.cases.filter(item => !item.passed);
  assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  assert.equal(report.suiteVersion, '0.2.0');
  assert.equal(report.summary.passed, report.summary.total);
  assert.equal(report.summary.precision, 1);
  assert.equal(report.summary.recall, 1);
  assert.equal(report.summary.falsePositives, 0);
  assert.equal(report.summary.falseNegatives, 0);
  assert.equal(report.summary.scanFailures, 0);
  assert.match(report.scope, /fixture-only/i);
  assert.match(report.scope, /NOT real-world accuracy/);
  assert.match(report.scope, /synthetic/i);
});

test('ground truth is fixed even when the scanner finds nothing', () => {
  const report = runBenchmark({ scan: () => emptyReport([]) });
  assert.ok(report.cases.some(item => item.expected.length === 0));
  assert.ok(report.cases.some(item => item.expected.length > 0));
  assert.ok(report.cases.length >= 30);
  assert.equal(new Set(report.cases.map(item => item.name)).size, report.cases.length);
  assert.equal(report.summary.truePositives, 0);
  assert.equal(report.summary.falsePositives, 0);
  assert.equal(report.summary.falseNegatives, report.cases.reduce((sum, item) => sum + item.expected.length, 0));
  assert.ok(report.summary.falseNegatives > 0);
  assert.equal(report.summary.precision, null);
  assert.equal(report.summary.recall, 0);
  assert.ok(report.summary.passed < report.summary.total);
  for (const item of report.cases) {
    assert.equal(item.passed, item.expected.length === 0);
    for (const label of item.expected) {
      assert.equal(typeof label.code, 'string');
      assert.equal(typeof label.path, 'string');
      assert.ok(Number.isInteger(label.line) && label.line > 0);
    }
  }
});

test('matching is a multiset, not a set of codes or locations', () => {
  const report = runBenchmark({ scan: ({ files }) => emptyReport(files[0].path === 'loader.py' ? [
    { code: 'UNSAFE_DESERIALIZATION', path: 'loader.py', line: 2 }
  ] : []) });
  const repeated = report.cases.find(item => item.name === 'Python repeated findings retain multiplicity');
  assert.equal(repeated.expected.length, 2);
  assert.equal(repeated.actual.length, 1);
  assert.equal(repeated.passed, false);
});

test('incorrect evidence and duplicate detections count as false positives', () => {
  const reference = runBenchmark({ scan: () => emptyReport([]) });
  let index = 0;
  const report = runBenchmark({ scan: () => {
    const labels = reference.cases[index++].expected.map(label => ({ ...label }));
    return emptyReport(labels.length ? [...labels, { ...labels[0] }] : []);
  } });
  assert.equal(report.summary.truePositives, reference.summary.falseNegatives);
  assert.equal(report.summary.falseNegatives, 0);
  assert.equal(report.summary.falsePositives, reference.cases.filter(item => item.expected.length).length);
  index = 0;
  const wrongLocations = runBenchmark({ scan: () => emptyReport(reference.cases[index++].expected.map(label => ({ ...label, path: `wrong/${label.path}`, line: label.line + 1 }))) });
  assert.equal(wrongLocations.summary.truePositives, 0);
  assert.equal(wrongLocations.summary.falseNegatives, reference.summary.falseNegatives);
  assert.equal(wrongLocations.summary.falsePositives, reference.summary.falseNegatives);
});

test('inventory findings do not inflate fixture precision or recall', () => {
  const plain = runBenchmark({ scan: () => emptyReport([]) });
  const inventory = runBenchmark({ scan: () => emptyReport([
    { code: 'LICENSE_UNKNOWN', path: 'package.json', line: 1 },
    { code: 'NO_MODEL_REFERENCE' }
  ]) });
  assert.deepEqual(inventory, plain);
});

test('scan exceptions and invalid scanner responses fail even negative fixtures', () => {
  for (const scan of [() => { throw new Error('fixture scan failed'); }, () => ({ findings: [] })]) {
    const report = runBenchmark({ scan });
    assert.equal(report.summary.passed, 0);
    assert.equal(report.summary.scanFailures, report.summary.total);
    assert.ok(report.summary.falseNegatives > 0);
    assert.ok(report.cases.every(item => !item.passed && typeof item.error === 'string'));
  }
  const thrownUndefined = runBenchmark({ scan: () => { throw undefined; } });
  assert.equal(thrownUndefined.summary.passed, 0);
  assert.equal(thrownUndefined.summary.scanFailures, thrownUndefined.summary.total);
});

test('results do not expose mutable ground truth for subsequent runs', () => {
  const first = runBenchmark({ scan: () => emptyReport([]) });
  first.cases[0].expected[0].line = 999;
  const second = runBenchmark({ scan: () => emptyReport([]) });
  assert.equal(second.cases[0].expected[0].line, 2);
});

test('demo uses the same project and file paths with prominent fictional notices', () => {
  const { before, after } = getDemo();
  assert.equal(before.projectName, 'offline-risk-demo');
  assert.equal(after.projectName, before.projectName);
  assert.deepEqual(before.files.map(file => file.path), after.files.map(file => file.path));
  assert.ok(before.files.some(file => /FICTIONAL/.test(file.content)));
  assert.ok(after.files.some(file => /FICTIONAL/.test(file.content)));
  assert.match(after.files.find(file => file.path === 'app.py').content, /weights_only=True/);
  assert.match(after.files.find(file => file.path === 'app.py').content, /trust_remote_code=False/);
  assert.match(after.files.find(file => file.path === 'app.js').content, /trust_remote_code: false/);
  assert.equal(JSON.parse(after.files.find(file => file.path === 'package-lock.json').content).packages['node_modules/@openaibom-fixtures/unsafe-loader'].version, '1.0.1');
  before.files[0].content = 'mutated';
  assert.notEqual(getDemo().before.files[0].content, 'mutated');
});

test('demo remediation removes blocking findings without claiming complete safety', () => {
  const demo = getDemo();
  const before = scanProject(demo.before);
  const after = scanProject({ ...demo.after, baseline: before });
  assert.equal(before.analysis.policy.status, 'fail');
  assert.equal(after.analysis.policy.status, 'review');
  assert.deepEqual(before.findings.filter(f => f.blocking).map(f => f.code).sort(), [
    'FIXTURE_ADVISORY_MATCH', 'MODEL_UNPINNED', 'MODEL_UNPINNED',
    'REMOTE_CODE_ENABLED', 'REMOTE_CODE_ENABLED', 'UNSAFE_DESERIALIZATION'
  ]);
  assert.equal(after.findings.filter(f => f.blocking).length, 0);
  assert.ok(after.findings.some(f => f.code === 'LICENSE_UNKNOWN'));
  assert.deepEqual(after.analysis.coverage, before.analysis.coverage);
});
