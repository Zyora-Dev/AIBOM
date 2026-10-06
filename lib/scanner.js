import { createHash } from 'node:crypto';
import { LIMITS, isSupportedPath } from './path-policy.js';
import { analyzeSource } from './source-analysis.js';
import { assess, stableId, validateBaseline, compareReports, ENGINE_VERSION } from './risk-engine.js';
export { LIMITS, isSupportedPath } from './path-policy.js';

export function scanProject({ projectName, files, baseline = null }) {
  if (typeof projectName !== 'string' || !projectName.trim() || projectName.length > 120) throw new Error('Provide a project name between 1 and 120 characters.');
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.files) throw new Error(`Choose between 1 and ${LIMITS.files} supported files.`);
  let bytes = 0;
  const paths = new Set();
  for (const file of files) {
    if (!file || !isSupportedPath(file.path) || typeof file.content !== 'string') throw new Error('Unsupported file path or content.');
    const size = Buffer.byteLength(file.content);
    bytes += size;
    if (size > LIMITS.fileBytes || bytes > LIMITS.totalBytes) throw new Error('Project exceeds the scan size limit (128 KB/file, 1 MB total).');
    if (paths.has(file.path)) throw new Error('Duplicate file paths are not allowed.');
    paths.add(file.path);
  }

  validateBaseline(baseline, projectName.trim());
  const components = new Map();
  const findings = [];
  const events = [], parseIssues = [], sourceFiles = [];
  const add = (type, name, version, ecosystem, path, line, license = null, extra = {}) => {
    const id = stableId(type, name, version || null, ecosystem, extra.revision || null, Boolean(extra.resolved));
    let item = components.get(id);
    if (!item) {
      item = { id, type, name, version: version || null, ecosystem, license, licenseStatus: license ? 'declared-unverified' : 'unknown', evidence: [], reviewed: false, ...extra };
      components.set(id, item);
    }
    if (!item.evidence.some(e => e.path === path && e.line === line)) item.evidence.push({ path, line });
    return item;
  };

  for (const { path, content } of files) {
    if (path.endsWith('package-lock.json')) {
      try {
        const lock = JSON.parse(content);
        if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
          findings.push({ severity: 'warning', code: 'UNSUPPORTED_LOCKFILE', category: 'coverage', message: 'Only npm package-lock versions 2 and 3 with packages entries are supported.', path });
          continue;
        }
        for (const [location, entry] of Object.entries(lock.packages)) {
          if (!location || !entry || typeof entry !== 'object') continue;
          const inferredName = location.split('node_modules/').at(-1);
          const name = typeof entry.name === 'string' ? entry.name : inferredName;
          if (!location.includes('node_modules/') || entry.link || typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.version)) {
            findings.push({ severity: 'info', code: 'LOCK_ENTRY_UNRESOLVED', category: 'coverage', message: 'A workspace, linked, or non-exact lockfile entry needs manual review.', path });
            continue;
          }
          const line = content.slice(0, content.indexOf(JSON.stringify(location))).split('\n').length;
          add('dependency', name, entry.version, 'npm', path, line, typeof entry.license === 'string' ? entry.license : null, { resolved: true, resolution: 'npm-lockfile', installPath: location });
        }
      } catch {
        findings.push({ severity: 'warning', code: 'INVALID_LOCKFILE', category: 'coverage', message: 'Could not parse npm lockfile.', path });
      }
      continue;
    }
    if (path.endsWith('package.json')) {
      try {
        const manifest = JSON.parse(content);
        if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error();
        if (typeof manifest.name === 'string') add('application', manifest.name, typeof manifest.version === 'string' ? manifest.version : null, 'npm', path, 1, typeof manifest.license === 'string' ? manifest.license : null);
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const entries = manifest[section];
          if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
          for (const [name, version] of Object.entries(entries)) {
            if (typeof version !== 'string') continue;
            const line = content.slice(0, content.indexOf(JSON.stringify(name))).split('\n').length;
            add('dependency', name, version, 'npm', path, line);
          }
        }
      } catch {
        findings.push({ severity: 'warning', code: 'INVALID_MANIFEST', message: 'Could not parse this package manifest.', path });
      }
      continue;
    }

    if (/(?:^|\/)requirements(?:[-.][\w-]+)?\.txt$/.test(path)) {
      content.split(/\r?\n/).forEach((text, index) => {
        const clean = text.replace(/\s+#.*$/, '').trim();
        if (!clean || clean.startsWith('#')) return;
        const match = clean.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[\w, .-]+\])?\s*((?:(?:===|==|~=|!=|<=|>=|<|>)[^;\s]+(?:\s*,\s*[^;\s]+)*)?)(?:\s*;.*)?$/);
        if (match) add('dependency', match[1].toLowerCase().replace(/[-_.]+/g, '-'), match[2] || null, 'pypi', path, index + 1);
        else findings.push({ severity: 'info', code: 'UNSUPPORTED_REQUIREMENT', message: 'Requirement syntax was not parsed. Review this line manually.', path, line: index + 1 });
      });
      continue;
    }

    if (path.endsWith('pyproject.toml')) {
      findings.push({ severity: 'info', code: 'UNSUPPORTED_MANIFEST', message: 'pyproject.toml dependency parsing is not supported yet. Provide requirements.txt for Python dependency inventory.', path });
      continue;
    }

    sourceFiles.push({ path });
    const result = analyzeSource(path, content);
    parseIssues.push(...result.issues);
    for (const event of result.events) {
      if (event.kind !== 'loader' && event.name) {
        const component = add(event.kind, event.name, null, event.ecosystem, path, event.line, null, { revision: event.revision.state === 'literal' ? event.revision.value : null, confidence: event.confidence });
        event.componentId = component.id;
      }
      events.push(event);
    }
  }

  for (const component of components.values()) {
    if (!component.license) findings.push({ severity: 'warning', code: 'LICENSE_UNKNOWN', componentId: component.id, message: `No license established for ${component.name}. Verify upstream terms manually.` });
  }
  if (![...components.values()].some(c => c.type === 'model')) findings.push({ severity: 'info', code: 'NO_MODEL_REFERENCE', message: 'No supported literal model references found. Models configured dynamically may be missed.' });

  const report = assess({
    format: 'openaibom-inventory', specVersion: ENGINE_VERSION, generatedAt: new Date().toISOString(),
    project: { name: projectName.trim(), filesScanned: files.length },
    scope: 'Offline, evidence-backed syntax analysis and explicit policy checks. Not an execution trace, legal verdict, or certified SPDX/CycloneDX document.',
    limitations: ['Declared npm/Python constraints are not resolved versions. npm lockfile v2/v3 entries are inventoried separately, including transitive entries; dependency-to-dependency edges are not resolved.', 'Comments and string examples are excluded using syntax parsers. Same-named APIs and binding reassignments can still produce false positives; dynamic configuration is unresolved.', 'Dataset references do not establish training data or provenance. Upstream licenses and model revisions are not fetched.', 'Real-world vulnerability coverage is not provided offline. Advisory matching uses a clearly labeled fictional fixture only.', 'Missing licenses or incomplete analysis require review; a passing policy is not a guarantee of safety.'],
    components: [...components.values()], findings
  }, events, parseIssues, sourceFiles);
  report.evidenceManifest = files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex'), parseStatus: parseIssues.some(issue => issue.path === file.path) ? 'failed' : sourceFiles.some(source => source.path === file.path) ? 'parsed' : 'manifest' })).sort((a, b) => a.path.localeCompare(b.path));
  report.inputDigest = createHash('sha256').update(JSON.stringify(report.evidenceManifest)).digest('hex');
  report.diff = compareReports(report, baseline);
  return report;
}
