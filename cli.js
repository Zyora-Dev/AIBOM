#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject } from './lib/scanner.js';
import { LIMITS, isSupportedPath } from './lib/path-policy.js';
import { stableId, compareReports } from './lib/risk-engine.js';
import { getDemo } from './lib/demo.js';
import { runBenchmark } from './lib/benchmark.js';

const baselineBytes = 16 * 1024 * 1024;
const help = `OpenAIBOM v0.2.0 — offline static analysis

Usage:
  node cli.js benchmark
  node cli.js scan <dir> [--baseline <report.json>] [--out <new-report.json>] [--fail-on-review]
  node cli.js scan --demo before|after [--baseline <report.json>] [--out <new-report.json>] [--fail-on-review]
  node cli.js --help

Reports are JSON on stdout, including when policy fails. --out also saves the
report before returning the policy exit code; its path MUST NOT already exist.
Existing reports and scanned inputs are never overwritten. Parent directories
for --out must already exist. Baselines must be compatible reports for the same
project (directory basename, or offline-risk-demo) and at most 16 MiB.

Local UTF-8 files only; no network, package installs, or source execution.
Hidden/generated/dependency paths, unsupported files, symlinks and special files
are skipped; report.input discloses counts and FILES_SKIPPED requires review.
Excluded directories are counted once, not traversed. A symlinked scan root or
ancestor is rejected.
Limits: ${LIMITS.files} files, ${LIMITS.fileBytes} bytes/file, ${LIMITS.totalBytes} bytes total.
Exceeding a limit aborts the scan, never silently truncates it.
Demo identifiers, revisions and the bundled advisory are FICTIONAL.
Benchmark precision/recall are fixture-only, NOT real-world accuracy.

Exit codes: 0 = pass or review (benchmark all passed); 1 = policy fail,
review with --fail-on-review, or benchmark failure; 2 = invalid input/I/O error.
`;

function parseArguments(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    if (args.length > 1) throw new Error('Unexpected arguments after --help.');
    return { command: 'help' };
  }
  const [command, ...rest] = args;
  if (!['scan', 'benchmark'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0])) return { command: 'help' };
  if (command === 'benchmark') {
    if (rest.length) throw new Error('benchmark accepts no arguments. Use --help.');
    return { command };
  }
  const options = { command, failOnReview: false };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i];
    if (argument.startsWith('--')) {
      if (!['--baseline', '--out', '--demo', '--fail-on-review'].includes(argument)) throw new Error(`Unknown option: ${argument}.`);
      if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}.`);
      seen.add(argument);
      if (argument === '--fail-on-review') { options.failOnReview = true; continue; }
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      options[argument.slice(2)] = value;
    } else {
      if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}.`);
      if (options.directory) throw new Error('Specify exactly one scan directory.');
      options.directory = argument;
    }
  }
  if (options.demo && !['before', 'after'].includes(options.demo)) throw new Error('--demo must be before or after.');
  if (Boolean(options.directory) === Boolean(options.demo)) throw new Error('Specify either a scan directory or --demo before|after.');
  return options;
}

async function readRegularFile(path, limit, label) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file, not a symlink or special file.`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} has a symlinked ancestor.`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file.`);
    if (stat.size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`);
    // Read one extra byte to detect files growing after stat without unbounded reads.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    return { content, bytes: length };
  } finally {
    await handle.close();
  }
}

async function collectFiles(directory) {
  const root = resolve(directory);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error('Scan root must be a local directory without symlinked ancestors.');
  const files = [];
  const skipped = { unsupportedFiles: 0, excludedDirectories: 0, symlinks: 0, specialFiles: 0 };
  let bytesRead = 0;
  async function visit(relativeDirectory) {
    const absoluteDirectory = join(root, relativeDirectory);
    if (await realpath(absoluteDirectory) !== absoluteDirectory) throw new Error('A directory changed into a symlink during collection.');
    const entries = (await readdir(absoluteDirectory)).sort();
    for (const name of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = join(root, relativePath);
      const entry = await lstat(absolutePath);
      if (entry.isSymbolicLink()) { skipped.symlinks++; continue; }
      if (entry.isDirectory()) {
        if (!isSupportedPath(`${relativePath}/a.py`)) { skipped.excludedDirectories++; continue; }
        await visit(relativePath);
      } else if (!entry.isFile()) {
        skipped.specialFiles++;
      } else if (!isSupportedPath(relativePath)) {
        skipped.unsupportedFiles++;
      } else {
        if (files.length >= LIMITS.files) throw new Error(`Project exceeds the ${LIMITS.files}-file limit; no partial report was produced.`);
        const file = await readRegularFile(absolutePath, LIMITS.fileBytes, `Input ${relativePath}`);
        bytesRead += file.bytes;
        if (bytesRead > LIMITS.totalBytes) throw new Error(`Project exceeds the ${LIMITS.totalBytes}-byte total limit; no partial report was produced.`);
        files.push({ path: relativePath, content: file.content });
      }
    }
  }
  await visit('');
  const skippedEntries = Object.values(skipped).reduce((sum, count) => sum + count, 0);
  if (!files.length) throw new Error(`No supported files found (${skippedEntries} skipped entries).`);
  return {
    projectName: basename(root) || 'local-project', files,
    input: {
      source: 'local', filesRead: files.length, bytesRead, skippedEntries, skipped,
      note: 'Skipped counts describe encountered entries only. Excluded directories count once; their descendants are not traversed or counted. Symlinks are never followed. Coverage is limited to the included supported files.'
    }
  };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    if (options.command === 'help') { process.stdout.write(help); return 0; }
    if (options.command === 'benchmark') {
      const report = runBenchmark();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.summary.passed === report.summary.total ? 0 : 1;
    }
    const project = options.demo ? getDemo()[options.demo] : await collectFiles(options.directory);
    const baseline = options.baseline ? JSON.parse((await readRegularFile(resolve(options.baseline), baselineBytes, 'Baseline')).content) : undefined;
    const report = scanProject({ projectName: project.projectName, files: project.files, baseline });
    if (!['pass', 'review', 'fail'].includes(report.analysis?.policy?.status)) throw new Error('Scanner returned an invalid policy status.');
    report.input = project.input || {
      source: `demo-${options.demo}`, filesRead: project.files.length,
      bytesRead: project.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
      skippedEntries: 0, skipped: { unsupportedFiles: 0, excludedDirectories: 0, symlinks: 0, specialFiles: 0 },
      note: 'FICTIONAL offline demo; identifiers and revisions are not verified, and the advisory is synthetic.'
    };
    report.analysis.coverage.inputSkipped = { ...report.input.skipped };
    if (report.input.skippedEntries > 0) {
      report.findings.push({
        id: stableId('FILES_SKIPPED', project.projectName),
        code: 'FILES_SKIPPED', severity: 'info', category: 'coverage', confidence: 'high', blocking: false,
        message: `${report.input.skippedEntries} input entries were skipped. ${report.input.note}`,
        remediation: 'Review report.input.skipped and verify that excluded files are outside the intended scan scope.'
      });
      if (report.analysis.policy.status === 'pass') report.analysis.policy.status = 'review';
    }
    // Include CLI collection evidence before comparing a reusable CLI baseline.
    report.diff = compareReports(report, baseline);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) await writeFile(resolve(options.out), json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json);
    const status = report.analysis.policy.status;
    return status === 'fail' || (status === 'review' && options.failOnReview) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`OpenAIBOM: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
