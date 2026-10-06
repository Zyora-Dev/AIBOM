import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../lib/path-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliPath = join(root, 'cli.js');
const cli = (...args) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
};
const json = result => {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};
async function workspace(t, files = { 'app.py': 'value = 1\n' }) {
  const directory = join(root, `.cli-fixtures-${randomUUID()}`);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(directory, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return directory;
}
const assertError = (result, message) => {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
};

test('CLI help documents offline operation, limits, outputs and exit codes', () => {
  for (const args of [[], ['--help'], ['scan', '--help'], ['benchmark', '--help']]) {
    const result = cli(...args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /--baseline/);
    assert.match(result.stdout, /--fail-on-review/);
    assert.match(result.stdout, /MUST NOT already exist/);
    assert.match(result.stdout, /fixture-only/);
    assert.match(result.stdout, /Exit codes/);
  }
});

test('CLI rejects invalid commands and arguments on stderr', () => {
  for (const args of [
    ['unknown'], ['scan'], ['scan', '--demo', 'other'], ['scan', '--demo'],
    ['scan', '.', '--wat'], ['scan', '.', 'other'], ['scan', '.', '--out'],
    ['scan', '.', '--baseline', '--out'], ['scan', '.', '--demo', 'before'],
    ['scan', '.', '--fail-on-review', '--fail-on-review'], ['benchmark', '--out', 'report.json'],
    ['--help', 'extra']
  ]) assertError(cli(...args), /OpenAIBOM:/);
});

test('CLI scans local files and emits a JSON pass report', async t => {
  const directory = await workspace(t);
  const result = cli('scan', directory);
  assert.equal(result.status, 0, result.stderr);
  const report = json(result);
  assert.equal(report.analysis.policy.status, 'pass');
  assert.equal(report.project.filesScanned, 1);
  assert.equal(report.input.source, 'local');
  assert.equal(report.input.filesRead, 1);
  assert.equal(report.input.skippedEntries, 0);
  assert.equal(report.input.bytesRead, Buffer.byteLength('value = 1\n'));
});

test('CLI fails policy for an unpinned model while still emitting a report', async t => {
  const directory = await workspace(t, { 'app.py': "AutoModel.from_pretrained('fictional/model')\n" });
  const result = cli('scan', directory);
  assert.equal(result.status, 1, result.stderr);
  const report = json(result);
  assert.equal(report.analysis.policy.status, 'fail');
  assert.ok(report.findings.some(f => f.code === 'MODEL_UNPINNED'));
});

test('CLI defaults review to exit zero and supports --fail-on-review', async t => {
  const directory = await workspace(t, { 'requirements.txt': 'fictional-package==1.0.0\n' });
  const normal = cli('scan', directory);
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(json(normal).analysis.policy.status, 'review');
  const strict = cli('scan', directory, '--fail-on-review');
  assert.equal(strict.status, 1, strict.stderr);
  assert.equal(json(strict).analysis.policy.status, 'review');
});

test('CLI parser errors require review, not an apparently clean pass', async t => {
  const directory = await workspace(t, { 'broken.js': 'const = ;\n' });
  const result = cli('scan', directory, '--fail-on-review');
  assert.equal(result.status, 1, result.stderr);
  const report = json(result);
  assert.equal(report.analysis.policy.status, 'review');
  assert.ok(report.findings.some(f => f.code === 'PARSE_ERROR' && f.path === 'broken.js' && f.line === 1));
});

test('CLI saves failure reports before returning the policy exit code', async t => {
  const directory = await workspace(t, { 'app.py': "AutoModel.from_pretrained('fictional/model')\n" });
  const output = join(directory, 'report.json');
  const result = cli('scan', directory, '--out', output);
  assert.equal(result.status, 1, result.stderr);
  const report = json(result);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
  assert.equal(report.analysis.policy.status, 'fail');
});

test('CLI exclusive output never overwrites reports or scanned inputs', async t => {
  const original = 'value = 1\n';
  const directory = await workspace(t, { 'app.py': original, 'existing.json': 'keep this report' });
  for (const [name, content] of [['app.py', original], ['existing.json', 'keep this report']]) {
    assertError(cli('scan', directory, '--out', join(directory, name)), /EEXIST|exist/i);
    assert.equal(await readFile(join(directory, name), 'utf8'), content);
  }
});

test('CLI output symlink does not overwrite its target', async t => {
  const directory = await workspace(t);
  const target = join(directory, 'app.py');
  await symlink(target, join(directory, 'report.json'));
  assertError(cli('scan', directory, '--out', join(directory, 'report.json')), /EEXIST|exist/i);
  assert.equal(await readFile(target, 'utf8'), 'value = 1\n');
});

test('CLI reports output errors instead of claiming a saved report', async t => {
  const directory = await workspace(t);
  assertError(cli('scan', directory, '--out', join(directory, 'missing', 'report.json')), /ENOENT|no such/i);
});

test('CLI accepts a saved compatible baseline and does not modify it', async t => {
  const directory = await workspace(t, { 'app.py': "AutoModel.from_pretrained('fictional/model')\n" });
  const baseline = join(directory, 'baseline.json');
  const before = cli('scan', directory, '--out', baseline);
  assert.equal(before.status, 1, before.stderr);
  const baselineContent = await readFile(baseline, 'utf8');
  await writeFile(join(directory, 'app.py'), 'value = 1\n');
  const after = cli('scan', directory, '--baseline', baseline);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(json(after).analysis.policy.status, 'review');
  assert.equal(await readFile(baseline, 'utf8'), baselineContent);
});

test('CLI rejects malformed, incompatible, missing and symlinked baselines', async t => {
  const directory = await workspace(t, { 'app.py': 'value = 1\n', 'bad.json': '{broken', 'invalid.json': '{}' });
  assertError(cli('scan', directory, '--baseline', join(directory, 'bad.json')), /JSON|property|position/i);
  assertError(cli('scan', directory, '--baseline', join(directory, 'invalid.json')), /Baseline/i);
  assertError(cli('scan', directory, '--baseline', join(directory, 'missing.json')), /ENOENT|no such/i);
  await symlink(join(directory, 'invalid.json'), join(directory, 'link.json'));
  assertError(cli('scan', directory, '--baseline', join(directory, 'link.json')), /regular file|symlink/i);
});

test('CLI skips excluded paths and links with explicit entry counts', async t => {
  const directory = await workspace(t, {
    'src/app.py': 'value = 1\n',
    'node_modules/pkg/risk.py': "AutoModel.from_pretrained('fictional/model')\n",
    '.git/risk.py': 'bad code', 'dist/risk.py': 'bad code',
    '.hidden.py': 'bad code', 'notes.txt': 'unsupported text',
    'linked-target/risk.py': 'value = 2\n'
  });
  await symlink(join(directory, 'src', 'app.py'), join(directory, 'linked.py'));
  await symlink(join(directory, 'linked-target'), join(directory, 'linked-directory'));
  const result = cli('scan', directory);
  assert.equal(result.status, 0, result.stderr);
  const report = json(result);
  assert.equal(report.project.filesScanned, 2);
  assert.deepEqual(report.input.skipped, { unsupportedFiles: 2, excludedDirectories: 3, symlinks: 2, specialFiles: 0 });
  assert.equal(report.input.skippedEntries, 7);
  assert.match(report.input.note, /descendants are not traversed or counted/);
  assert.equal(report.findings.some(f => f.code === 'MODEL_UNPINNED'), false);
});

test('CLI skipped-entry findings have stable IDs and remain reusable in baselines', async t => {
  const directory = await workspace(t, { 'project/app.py': 'value = 1\n', 'project/notes.txt': 'outside supported scope' });
  const project = join(directory, 'project');
  const baseline = join(directory, 'baseline.json');
  const before = cli('scan', project, '--out', baseline);
  assert.equal(before.status, 0, before.stderr);
  const first = json(before);
  const finding = first.findings.find(item => item.code === 'FILES_SKIPPED');
  assert.equal(typeof finding.id, 'string');
  assert.ok(finding.id.length > 0);
  assert.equal(first.analysis.policy.status, 'review');
  assert.equal(first.analysis.coverage.inputSkipped.unsupportedFiles, 1);
  const after = cli('scan', project, '--baseline', baseline, '--fail-on-review');
  assert.equal(after.status, 1, after.stderr);
  const second = json(after);
  assert.equal(second.findings.find(item => item.code === 'FILES_SKIPPED').id, finding.id);
  assert.deepEqual(second.diff.introduced, []);
  assert.deepEqual(second.diff.resolved, []);
  assert.deepEqual(second.diff.changedFiles, []);
  assert.deepEqual(second.diff.removedFiles, []);
  assert.equal(second.diff.coverageChanged, false);
  await rm(join(project, 'notes.txt'));
  const clean = cli('scan', project, '--baseline', baseline, '--fail-on-review');
  assert.equal(clean.status, 0, clean.stderr);
  const third = json(clean);
  assert.equal(third.analysis.policy.status, 'pass');
  assert.equal(third.diff.coverageChanged, true);
  assert.ok(third.diff.resolved.some(item => item.id === finding.id));
});

test('CLI rejects symlink roots and symlinked ancestors', async t => {
  const directory = await workspace(t, { 'project/app.py': 'value = 1\n' });
  await symlink(join(directory, 'project'), join(directory, 'project-link'));
  assertError(cli('scan', join(directory, 'project-link')), /directory|symlink/i);
  await mkdir(join(directory, 'project', 'nested'));
  await writeFile(join(directory, 'project', 'nested', 'app.py'), 'value = 1\n');
  assertError(cli('scan', join(directory, 'project-link', 'nested')), /directory|symlink/i);
});

test('CLI rejects nonexistent, nondirectory and empty scan inputs', async t => {
  const directory = await workspace(t, { 'notes.txt': 'not supported' });
  assertError(cli('scan', join(directory, 'missing')), /ENOENT|no such/i);
  assertError(cli('scan', join(directory, 'notes.txt')), /directory/i);
  assertError(cli('scan', directory), /No supported files found \(1 skipped entries\)/);
});

test('CLI enforces per-file byte limits without truncating and accepts the boundary', async t => {
  const directory = await workspace(t, { 'app.py': `#${' '.repeat(LIMITS.fileBytes - 1)}` });
  const boundary = cli('scan', directory);
  assert.equal(boundary.status, 0, boundary.stderr);
  assert.equal(json(boundary).input.bytesRead, LIMITS.fileBytes);
  await writeFile(join(directory, 'app.py'), `#${' '.repeat(LIMITS.fileBytes)}`);
  assertError(cli('scan', directory), /byte limit/);
});

test('CLI enforces aggregate byte limits without partial reports', async t => {
  const directory = await workspace(t, {});
  const count = Math.floor(LIMITS.totalBytes / LIMITS.fileBytes) + 1;
  for (let index = 0; index < count; index++) await writeFile(join(directory, `${index}.py`), `#${' '.repeat(LIMITS.fileBytes - 1)}`);
  assertError(cli('scan', directory), /total limit.*no partial report/);
});

test('CLI enforces supported-file count without partial reports', async t => {
  const directory = await workspace(t, {});
  await Promise.all(Array.from({ length: LIMITS.files + 1 }, (_, index) => writeFile(join(directory, `${index}.py`), '# fixture\n')));
  assertError(cli('scan', directory), /file limit.*no partial report/);
});

test('CLI rejects invalid UTF-8 instead of silently replacing input', async t => {
  const directory = await workspace(t, { 'app.py': Buffer.from([0xff, 0xfe, 0xff]) });
  assertError(cli('scan', directory), /encoded data|encoding|UTF-8/i);
});

test('CLI demo before and after support a meaningful same-project baseline', async t => {
  const directory = await workspace(t, {});
  const baseline = resolve(directory, 'before.json');
  const before = cli('scan', '--demo', 'before', '--out', baseline);
  assert.equal(before.status, 1, before.stderr);
  assert.equal(json(before).project.name, 'offline-risk-demo');
  const after = cli('scan', '--demo', 'after', '--baseline', baseline);
  assert.equal(after.status, 0, after.stderr);
  const report = json(after);
  assert.equal(report.project.name, 'offline-risk-demo');
  assert.equal(report.analysis.policy.status, 'review');
  assert.equal(report.findings.filter(f => f.blocking).length, 0);
  assert.match(report.input.note, /FICTIONAL/);
  const strict = cli('scan', '--demo', 'after', '--fail-on-review');
  assert.equal(strict.status, 1, strict.stderr);
});

test('CLI benchmark emits fixture metrics and returns the matching exit code', () => {
  const result = cli('benchmark');
  const report = json(result);
  assert.equal(result.status, report.summary.passed === report.summary.total ? 0 : 1);
  assert.equal(report.suiteVersion, '0.2.0');
  assert.match(report.scope, /NOT real-world accuracy/);
  assert.equal(report.summary.total, report.cases.length);
});
