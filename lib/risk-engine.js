import { createHash } from 'node:crypto';

export const ENGINE_VERSION = '0.2.0';
export const stableId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
export const POLICY_RULES = ['MODEL_UNPINNED', 'REMOTE_CODE_ENABLED', 'UNSAFE_DESERIALIZATION', 'FIXTURE_ADVISORY_MATCH'];
export const FIXTURE_ADVISORY = Object.freeze({
  id: 'FIXTURE-2026-001', ecosystem: 'npm', name: '@openaibom-fixtures/unsafe-loader', affectedVersions: ['1.0.0'], fixedVersion: '1.0.1',
  source: 'Bundled synthetic benchmark v1; NOT a real security advisory', synthetic: true
});

export function validateBaseline(baseline, projectName) {
  if (baseline == null) return null;
  if (baseline.format !== 'openaibom-inventory' || baseline.specVersion !== ENGINE_VERSION || baseline.project?.name !== projectName || !Array.isArray(baseline.components) || !Array.isArray(baseline.findings) || baseline.components.length > 10000 || baseline.findings.length > 20000) throw new Error('Baseline must be a version 0.2.0 OpenAIBOM report for the same project name.');
  if (!baseline.components.every(c => c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.type === 'string') || !baseline.findings.every(f => f && typeof f.id === 'string' && typeof f.code === 'string' && typeof f.message === 'string')) throw new Error('Baseline components or findings are malformed.');
  if (baseline.evidenceManifest !== undefined && (!Array.isArray(baseline.evidenceManifest) || baseline.evidenceManifest.length > 300 || !baseline.evidenceManifest.every(file => file && typeof file.path === 'string' && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)))) throw new Error('Baseline evidence manifest is malformed.');
  return baseline;
}

export function compareReports(report, baseline) {
  if (!baseline) return null;
  const changes = (after, before) => {
    const previousIds = new Set(before.map(x => x.id));
    return after.filter(item => !previousIds.has(item.id));
  };
  return {
    added: changes(report.components, baseline.components), removed: changes(baseline.components, report.components),
    introduced: changes(report.findings, baseline.findings), resolved: changes(baseline.findings, report.findings),
    changedFiles: (report.evidenceManifest || []).filter(file => !baseline.evidenceManifest?.some(previous => previous.path === file.path && previous.sha256 === file.sha256)).map(file => file.path),
    removedFiles: (baseline.evidenceManifest || []).filter(file => !report.evidenceManifest?.some(current => current.path === file.path)).map(file => file.path),
    note: 'Disappeared findings are not proof of remediation if files were removed, skipped, or became unparseable. Compare coverage. Baseline is user-supplied and unsigned.',
    coverageChanged: JSON.stringify([report.project.filesScanned, report.analysis.coverage]) !== JSON.stringify([baseline.project.filesScanned, baseline.analysis?.coverage])
  };
}

export function assess(report, events, parseIssues, sourceFiles) {
  const add = data => {
    const finding = { confidence: 'medium', category: 'configuration', blocking: POLICY_RULES.includes(data.code), ...data };
    finding.id = stableId(finding.code, finding.path || '', finding.componentId || '', finding.call || '', finding.line || 0);
    report.findings.push(finding);
    return finding;
  };
  const unresolvedCalls = new Set();
  for (const event of events) {
    const evidence = { path: event.path, line: event.line, confidence: event.confidence, call: event.call, componentId: event.componentId };
    if (event.kind === 'loader') {
      const definitelyUnsafe = event.name !== 'torch.load' || (event.weightsOnly.state === 'literal' && event.weightsOnly.value === false);
      if (definitelyUnsafe) add({ ...evidence, code: 'UNSAFE_DESERIALIZATION', severity: 'high', message: `${event.name} permits general object deserialization in this configuration. Exploitability depends on artifact trust and runtime behavior.`, remediation: 'Use a data-only format or restricted loader and verify artifact provenance. For torch.load, explicitly set weights_only=True where supported.' });
      else if (event.weightsOnly.state !== 'literal' || event.weightsOnly.value !== true) {
        unresolvedCalls.add(event);
        add({ ...evidence, code: 'LOADER_SAFETY_UNRESOLVED', severity: 'medium', category: 'coverage', message: 'torch.load safety depends on an omitted or dynamic weights_only setting and installed runtime version.', remediation: 'Set weights_only=True explicitly and validate compatibility; review the input artifact.' });
      }
      continue;
    }
    if (!event.name) {
      unresolvedCalls.add(event);
      add({ ...evidence, code: 'DYNAMIC_REFERENCE', severity: 'info', category: 'coverage', message: 'Model or dataset identifier is dynamic, omitted, or not a supported literal. No component identity was inferred.', remediation: 'Provide a reviewable literal reference or document the resolved identifier separately.' });
    }
    if (event.ecosystem !== 'huggingface') continue;
    if (event.kind === 'model' && event.name) {
      const revision = event.revision;
      if (/^(?:\.{1,2}[\\/]|\/|[A-Za-z]:\\)/.test(event.name)) {
        add({ ...evidence, code: 'LOCAL_MODEL_PROVENANCE_UNKNOWN', severity: 'info', category: 'coverage', message: 'Local model path detected. Artifact hashes and origin were not provided; remote revision policy does not apply.', remediation: 'Record hashes and trusted origin metadata for the local model artifacts.' });
      } else if (revision.state === 'dynamic') {
        unresolvedCalls.add(event);
        add({ ...evidence, code: 'REVISION_UNRESOLVED', severity: 'medium', category: 'coverage', message: 'Model revision is dynamic and could not be established.', remediation: 'Resolve and record the immutable model commit identifier.' });
      } else if (typeof revision.value !== 'string' || !/^[a-f\d]{40}$/i.test(revision.value)) {
        add({ ...evidence, code: 'MODEL_UNPINNED', severity: 'medium', category: 'reproducibility', message: 'Model reference is not pinned to a literal 40-character commit identifier. This is a reproducibility policy violation, not a confirmed vulnerability.', remediation: 'Use a verified immutable model commit in revision= (Python) or the revision option (JavaScript).' });
      }
    }
    if (event.remoteCode.state === 'literal' && event.remoteCode.value === true) add({ ...evidence, code: 'REMOTE_CODE_ENABLED', severity: 'high', message: 'Remote model or dataset code is explicitly enabled. Static evidence identifies permission to execute code, not malicious content.', remediation: 'Disable trust_remote_code or separately audit and pin the code before approving an explicit exception.' });
    else if (event.remoteCode.state === 'dynamic' || (event.remoteCode.state === 'literal' && typeof event.remoteCode.value !== 'boolean')) {
      unresolvedCalls.add(event);
      add({ ...evidence, code: 'REMOTE_CODE_UNRESOLVED', severity: 'medium', category: 'coverage', message: 'Remote-code permission is dynamic or supplied through expanded options.', remediation: 'Make trust_remote_code=False explicit and review expanded options.' });
    }
  }
  for (const issue of parseIssues) add({ ...issue, severity: 'warning', category: 'coverage', confidence: 'high', remediation: 'Correct syntax or provide a supported source file; no clean bill of health is issued for this file.' });
  for (const component of report.components) {
    if (component.ecosystem === FIXTURE_ADVISORY.ecosystem && component.name === FIXTURE_ADVISORY.name && component.resolved && FIXTURE_ADVISORY.affectedVersions.includes(component.version)) {
      add({ code: 'FIXTURE_ADVISORY_MATCH', severity: 'high', category: 'synthetic-advisory', confidence: 'high', synthetic: true, componentId: component.id, ...component.evidence[0], message: `SYNTHETIC DEMO ONLY: ${FIXTURE_ADVISORY.id} matches fictional fixture package ${component.name}@${component.version}. Not a real vulnerability.`, remediation: `For this benchmark, change the fixture lockfile version to ${FIXTURE_ADVISORY.fixedVersion}.`, advisory: FIXTURE_ADVISORY });
    }
  }
  report.findings = report.findings.map(f => ({ category: 'inventory', confidence: 'high', blocking: false, ...f, id: f.id || stableId(f.code, f.componentId || '', f.path || '', f.line || 0) }));
  const nodes = [{ id: 'project-root', label: report.project.name, type: 'project' }];
  const edges = [];
  for (const file of sourceFiles) {
    const id = stableId('file', file.path);
    nodes.push({ id, label: file.path, type: 'source' });
    edges.push({ source: 'project-root', target: id, relation: 'contains', evidence: { path: file.path, line: 1 } });
  }
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const component of report.components) {
    nodes.push({ id: component.id, label: `${component.name}${component.version ? ` @ ${component.version}` : ''}`, type: component.type });
    for (const evidence of component.evidence) {
      const sourceId = stableId('file', evidence.path);
      edges.push({ source: nodeIds.has(sourceId) ? sourceId : 'project-root', target: component.id, relation: component.resolved ? 'locks' : ['model', 'dataset'].includes(component.type) ? 'references' : 'declares', evidence });
    }
  }
  for (const finding of report.findings) {
    const target = finding.componentId || stableId('file', finding.path || '');
    finding.affected = nodes.some(n => n.id === target) ? [target, 'project-root'] : ['project-root'];
  }
  const blockers = report.findings.filter(f => f.blocking).map(f => f.id);
  const review = report.findings.some(f => ['coverage', 'inventory'].includes(f.category) && f.code !== 'NO_MODEL_REFERENCE');
  report.analysis = {
    engineVersion: ENGINE_VERSION,
    method: 'Babel JavaScript/TypeScript AST + Lezer Python syntax tree; literal arguments only, no project code execution.',
    policy: { name: 'offline-ai-supply-chain-v1', status: blockers.length ? 'fail' : review ? 'review' : 'pass', blockingFindings: blockers, rules: POLICY_RULES, explanation: 'Explicit remote code, unpinned model commits, unsafe deserialization settings, and synthetic fixture matches block. Missing evidence requires review. No numerical risk score.' },
    coverage: { filesAnalyzed: sourceFiles.length - parseIssues.length, sourceFilesSelected: sourceFiles.length, unresolvedCalls: unresolvedCalls.size, parseErrors: parseIssues.length, limitations: ['No interprocedural or scope-sensitive binding/data-flow analysis; aliases and same-named APIs may be misidentified.', 'Python f-strings, escaped identifiers, computed properties, dynamic arguments, and expanded options are unresolved.', 'Revision format is checked but its existence and immutability are not verified upstream.', 'Offline advisory coverage is SYNTHETIC FIXTURE ONLY. Real dependencies are not vulnerability-assessed.', 'Graph edges show project membership and observed references, not execution reachability, training lineage, or exploitability.'] },
    advisorySource: FIXTURE_ADVISORY.source, graph: { nodes, edges }
  };
  return report;
}
