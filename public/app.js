import { isSupportedPath } from '/scanner.js';

const $ = id => document.getElementById(id);
const list = value => Array.isArray(value) ? value : [];
const snapshot = value => JSON.parse(JSON.stringify(value));
const describe = value => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? 'Not provided');
const projectName = report => report?.project?.name || 'Project';
let currentReport = null;
let baseline = null;
let baselineSource = '';
let comparisonName = '';
let demo = null;
let demoBaseline = null;
let busy = false;
let benchmarkBusy = false;
let config = null;
const isPublic = () => config?.hostingMode === 'public';
const serverName = () => isPublic() ? 'hosted server' : 'local server';
const uploadsAllowed = () => Boolean(config?.uploadsEnabled && (!isPublic() || $('upload-consent').checked));

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function status(text, error = false) {
  const pending = !error && /^(Scanning|Loading)/.test(text);
  $('status-message').textContent = text;
  $('status-title').textContent = error ? 'Action could not be completed' : pending ? 'Analysis in progress' : 'Workspace ready';
  $('status-icon').textContent = error ? '!' : pending ? '↻' : '✓';
  $('status').classList.toggle('error', error);
  $('status').classList.toggle('pending', pending);
  if (error) $('status').scrollIntoView({ block: 'center' });
}
function selectView(name, focus = false) {
  for (const tab of document.querySelectorAll('[data-view]')) {
    const selected = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}
const reportTabs = [...document.querySelectorAll('[data-view]')];
for (const [index, tab] of reportTabs.entries()) {
  tab.addEventListener('click', () => selectView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % reportTabs.length;
    if (event.key === 'ArrowLeft') next = (index + reportTabs.length - 1) % reportTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = reportTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectView(reportTabs[next].dataset.view, true);
  });
}
function setBusy(value) {
  busy = value;
  const disabled = value || !config;
  for (const id of ['folder', 'baseline-file']) $(id).disabled = disabled || !uploadsAllowed();
  $('demo').disabled = disabled;
  $('demo-fixed').disabled = disabled || !demoBaseline;
  $('benchmark').disabled = disabled || benchmarkBusy;
  $('upload-consent').disabled = disabled || !config?.uploadsEnabled;
  $('export').disabled = disabled || !currentReport;
  $('copy-digest').disabled = disabled || !currentReport?.inputDigest;
  $('save-baseline').disabled = disabled || !currentReport;
  $('clear-baseline').disabled = disabled || !baseline;
  for (const id of ['folder', 'baseline-file']) {
    document.querySelector(`label[for="${id}"]`).setAttribute('aria-disabled', String($(id).disabled));
  }
  $('report').setAttribute('aria-busy', String(value));
}
function renderUploadStatus() {
  $('upload-status').textContent = !config ? 'Uploads are disabled: server configuration is unavailable.'
    : !config.uploadsEnabled ? 'Visitor uploads are disabled by this server. Bundled samples remain available.'
      : isPublic() && !uploadsAllowed() ? 'Consent is required before folder selection or baseline import. You can run the synthetic demo without consent.'
        : isPublic() ? 'Selecting a folder starts an upload and scan of its supported contents on the hosted server.'
          : 'Selecting a folder sends its supported contents to the local server and starts a scan.';
}
async function loadConfig() {
  $('upload-consent').checked = false;
  setBusy(false);
  try {
    const value = await requestJSON('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!['local', 'public'].includes(value?.hostingMode) || typeof value.uploadsEnabled !== 'boolean'
      || value.sourceHandling?.persisted !== false || value.sourceHandling?.executed !== false
      || !['files', 'fileBytes', 'totalBytes'].every(key => Number.isSafeInteger(value.limits?.[key]) && value.limits[key] > 0)
      || !Number.isFinite(value.maxScanSeconds) || value.maxScanSeconds <= 0) {
      throw new Error('The server returned an invalid privacy or limits configuration.');
    }
    config = value;
    $('hosting-badge').textContent = isPublic() ? 'Hosted demo' : 'Local workspace';
    $('privacy-notice').textContent = isPublic()
      ? 'Selected supported source contents are sent over HTTPS to the hosted server, processed in memory, and not executed or intentionally stored/logged by the application. The hosting provider may retain request metadata. Do not upload secrets, personal information, or confidential source. JSON exports contain evidence paths and project metadata; review before sharing.'
      : 'Supported source contents are sent to this local server for analysis, processed in memory, and not executed or intentionally stored/logged by the application. No source is sent to a cloud service by this application in local mode. Do not select secrets, personal information, or confidential source. JSON exports contain evidence paths and project metadata; review before sharing.';
    $('upload-consent-panel').hidden = !isPublic();
    $('baseline-transfer').textContent = isPublic()
      ? 'Import reads the report into browser memory. The selected baseline is sent over HTTPS to the hosted server with the next project scan; the source-handling notice also applies to baselines. Review evidence paths and metadata before importing.'
      : 'Import reads the report into browser memory. The selected baseline is sent to the local server with the next project scan.';
    $('scan-limits').textContent = `Maximum: ${config.limits.files} supported files, ${config.limits.fileBytes.toLocaleString()} bytes per file, ${config.limits.totalBytes.toLocaleString()} bytes total; scan time limit ${config.maxScanSeconds} seconds.`;
    $('benchmark-status').textContent = `Not run. Bundled synthetic fixtures run on the ${serverName()}; no visitor source files are used.`;
    status(isPublic() ? 'Hosted mode ready. Try the bundled samples, or read the privacy notice and consent before uploading.' : 'Local mode ready. Select a project folder or run the bundled synthetic samples.');
  } catch (error) {
    config = null;
    $('hosting-badge').textContent = 'Configuration unavailable';
    $('privacy-notice').textContent = 'Server privacy settings could not be confirmed. Uploads and scans are disabled. No source files have been sent. Reload the page to retry.';
    $('baseline-transfer').textContent = 'Server configuration is unavailable; imports are disabled.';
    $('benchmark-status').textContent = 'Disabled until server configuration loads. Reload the page to retry.';
    status(`Could not load server configuration. Uploads, scans, and benchmarks are disabled. Reload the page to retry. ${error.message}`, true);
  } finally {
    renderUploadStatus();
    setBusy(false);
  }
}
$('upload-consent').addEventListener('change', () => {
  $('folder').value = '';
  $('baseline-file').value = '';
  renderUploadStatus();
  setBusy(busy);
});
function renderBaseline() {
  $('baseline-status').textContent = baseline
    ? `${projectName(baseline)} · ${baseline.components.length} components · ${baselineSource}. Applies to the next scan; the displayed comparison is unchanged.`
    : 'None selected. Save a scan or import an exported report to compare the next scan.';
  setBusy(busy);
}
function captureBaseline(report, source) {
  baseline = snapshot(report);
  baselineSource = source;
  renderBaseline();
}
function sourceLocation(evidence) {
  return evidence?.path ? `${evidence.path}${evidence.line ? `:${evidence.line}` : ''}` : 'Location not provided';
}
function renderStats(target, entries) {
  $(target).replaceChildren(...entries.map(([value, label]) => {
    const card = element('div', undefined, 'stat');
    card.append(element('strong', String(value)), element('span', label));
    return card;
  }));
}
function renderReviewCount() {
  const reviewed = currentReport.components.filter(component => component.reviewed).length;
  $('review-count').textContent = `${reviewed} of ${currentReport.components.length} manually reviewed · review state is included in export`;
}
function renderComponents() {
  if (!currentReport) return;
  const type = $('filter').value;
  const query = $('search').value.trim().toLowerCase();
  const components = currentReport.components.filter(component =>
    (type === 'all' || component.type === type) &&
    [component.name, component.id, component.ecosystem, component.version, component.revision].some(value => String(value ?? '').toLowerCase().includes(query)));
  $('components').replaceChildren();
  $('empty').hidden = components.length > 0;
  for (const component of components) {
    const row = element('tr');
    const identity = element('td');
    identity.append(element('strong', component.name || component.id || 'Unnamed component'), element('small', `${component.type || 'Unknown type'} · ${component.ecosystem || 'Unknown ecosystem'}`));
    if (component.id) identity.append(element('small', `ID: ${component.id}`));
    const version = element('td', component.version || 'Version not established');
    version.append(element('small', `Revision: ${component.revision ? describe(component.revision) : 'Not established'}`));
    const license = element('td', component.license || 'Unknown', component.license ? '' : 'unknown');
    if (component.license) license.append(element('small', 'Declared, not verified'));
    const evidence = element('td');
    for (const item of list(component.evidence)) evidence.append(element('small', sourceLocation(item)));
    if (!evidence.childNodes.length) evidence.textContent = 'Evidence not provided';
    const review = element('td');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(component.reviewed);
    checkbox.setAttribute('aria-label', `Mark ${component.name || component.id} reviewed`);
    checkbox.addEventListener('change', () => { component.reviewed = checkbox.checked; renderReviewCount(); });
    review.append(checkbox);
    row.append(identity, version, license, evidence, review);
    $('components').append(row);
  }
  renderReviewCount();
}
function renderPolicy() {
  const policy = currentReport.analysis?.policy;
  const engineStatus = policy?.engineStatus ?? policy?.status;
  const engineDecision = ['pass', 'fail', 'review'].includes(engineStatus) ? engineStatus : 'review';
  const partial = currentReport.selection.skippedFiles > 0;
  const decision = partial && engineDecision !== 'fail' ? 'review' : engineDecision;
  currentReport.selection.policyStatus = decision;
  currentReport.selection.reviewRequired = partial;
  if (partial) {
    currentReport.analysis ??= {};
    currentReport.analysis.policy = {
      ...policy,
      status: decision,
      engineStatus: engineStatus || 'review',
      selectionAdjustment: 'Browser selection omitted files. Review is required unless engine checks already fail; the engine result applies only to submitted files.'
    };
  }
  $('policy-status').textContent = { pass: 'Configured checks passed', fail: 'Changes required', review: 'Manual review needed' }[decision];
  $('policy-status').closest('section').className = `policy-panel ${decision}`;
  const descriptions = { pass: 'No policy blockers reported by the configured checks.', fail: 'Configured checks found blocking issues. Inspect the evidence and remediation below.', review: 'Manual review is required before drawing conclusions.' };
  $('policy-description').textContent = partial
    ? `${descriptions[decision]} Selection is incomplete: ${currentReport.selection.unsupportedFiles} unsupported/excluded and ${currentReport.selection.oversizedFiles} oversized files were skipped. Engine result for the submitted subset: ${engineStatus || 'not provided'}. Exported analysis.policy.status includes this selection-level decision; engineStatus preserves the original engine result. No browser-generated findings are added.`
    : policy ? descriptions[decision] : 'This report has no explicit policy result. No verdict is inferred from finding counts.';
  const rules = list(policy?.rules);
  $('policy-rules').replaceChildren(...(rules.length ? rules : ['No policy rules provided by this engine.']).map(rule => element('li', describe(rule))));
  const blockers = list(policy?.blockingFindings);
  $('policy-blockers').textContent = blockers.length ? `${blockers.length} policy blocker(s): ${blockers.join(', ')}` : 'No blocking finding identifiers reported.';
  $('policy-next-title').textContent = decision === 'fail' ? 'Start with the blocking findings' : decision === 'review' ? 'A person still needs to review this' : 'Keep the evidence with your release';
  $('policy-next-action').textContent = decision === 'fail'
    ? `${blockers.length ? `${blockers.length} blocking finding(s) reported. ` : ''}Follow the action on each highlighted card, then scan again to compare the result.`
    : decision === 'review' ? 'Check missing metadata and coverage gaps below. No approval is implied by the absence of blocking findings.'
      : 'Export this report for your records. Passing the configured checks is not a security or compliance guarantee.';
}
const findingTitles = {
  REMOTE_CODE_ENABLED: 'Remote code is allowed to run',
  UNSAFE_DESERIALIZATION: 'The loader allows general object deserialization',
  MODEL_UNPINNED: 'Model version is not pinned',
  FIXTURE_ADVISORY_MATCH: 'Demo dependency matches a synthetic advisory',
  LICENSE_UNKNOWN: 'License information is missing',
  PARSE_ERROR: 'This source file could not be analyzed',
  INVALID_MANIFEST: 'The dependency manifest could not be read',
  INVALID_LOCKFILE: 'The lockfile could not be read',
  UNSUPPORTED_LOCKFILE: 'This lockfile format is not supported',
  UNSUPPORTED_MANIFEST: 'This manifest format needs manual review',
  UNSUPPORTED_REQUIREMENT: 'A dependency declaration needs review',
  LOCK_ENTRY_UNRESOLVED: 'The locked version could not be resolved',
  DYNAMIC_REFERENCE: 'A model or dataset reference could not be resolved',
  REVISION_UNRESOLVED: 'Model revision could not be resolved',
  REMOTE_CODE_UNRESOLVED: 'Remote-code permissions need review',
  LOADER_SAFETY_UNRESOLVED: 'Loader safety settings need review',
  LOCAL_MODEL_PROVENANCE_UNKNOWN: 'Local model origin is not established',
  NO_MODEL_REFERENCE: 'No supported model reference was found'
};
function renderFindings() {
  if (!currentReport) return;
  const severity = $('severity').value;
  const blockers = list(currentReport.analysis?.policy?.blockingFindings);
  const isBlocking = finding => Boolean(finding.blocking || (finding.id && blockers.includes(finding.id)));
  const priority = { high: 0, medium: 1, warning: 2, info: 3 };
  const findings = currentReport.findings.filter(finding => severity === 'all' || finding.severity === severity)
    .sort((a, b) => Number(isBlocking(b)) - Number(isBlocking(a)) || (priority[a.severity] ?? 4) - (priority[b.severity] ?? 4));
  $('finding-count').textContent = `${findings.length} of ${currentReport.findings.length} findings`;
  $('tab-finding-count').textContent = String(currentReport.findings.length);
  $('findings').replaceChildren();
  for (const finding of findings) {
    const level = ['high', 'medium', 'warning', 'info'].includes(finding.severity) ? finding.severity : 'unknown';
    const item = element('li', undefined, `finding level-${level}${isBlocking(finding) ? ' is-blocking' : ''}`);
    const tags = element('div', undefined, 'finding-tags');
    tags.append(element('span', level === 'info' ? 'INFORMATION' : level.toUpperCase(), `pill severity-${level}`));
    if (isBlocking(finding)) tags.append(element('span', 'POLICY BLOCKER', 'pill blocking'));
    if (finding.synthetic) tags.append(element('span', 'SYNTHETIC', 'pill synthetic'));
    item.append(tags, element('h4', findingTitles[finding.code] || String(finding.code || 'Finding').replaceAll('_', ' ')), element('p', finding.message || 'No description provided.'));
    const component = currentReport.components.find(value => value.id === finding.componentId);
    const location = element('div', undefined, 'location');
    location.append(element('span', 'SOURCE'), element('code', finding.path ? sourceLocation(finding) : component?.name ? `${component.name} · component metadata` : 'No source location supplied'));
    item.append(location);
    const remediation = element('div', undefined, 'remediation');
    remediation.append(element('strong', 'RECOMMENDED ACTION'), element('span', finding.remediation ? describe(finding.remediation) : finding.code === 'LICENSE_UNKNOWN' ? 'Verify the component’s upstream license and document the applicable terms before approving its use.' : 'No specific remediation supplied. Inspect the source evidence and document your review.'));
    const technical = element('details');
    technical.append(element('summary', `Evidence details · confidence: ${describe(finding.confidence)}`), element('p', `Rule: ${finding.code || 'Not provided'} · Category: ${describe(finding.category)}`, 'evidence'));
    if (finding.componentId) technical.append(element('p', `Component: ${finding.componentId}`, 'evidence'));
    technical.append(element('p', `Finding ID: ${finding.id || 'Not provided'}`, 'evidence'));
    item.append(remediation, technical);
    $('findings').append(item);
  }
  if (!findings.length) $('findings').append(element('li', currentReport.findings.length ? 'No findings match this severity. Choose another severity to continue reviewing.' : 'No findings reported by the supported checks. This is not a safety or compliance guarantee.', 'empty-state'));
}
function renderFingerprints() {
  const digest = currentReport.inputDigest;
  $('input-digest').value = digest ? describe(digest) : '';
  $('input-digest').placeholder = 'Input digest not provided';
  $('copy-digest').disabled = busy || !digest;
  $('digest-status').textContent = '';
  const manifest = list(currentReport.evidenceManifest);
  $('manifest-summary').textContent = `Per-file SHA-256 fingerprints · ${manifest.length} files`;
  $('manifest-empty').hidden = manifest.length > 0;
  $('evidence-manifest').replaceChildren(...manifest.map(file => {
    const row = element('tr');
    const hash = element('td');
    hash.append(element('code', file.sha256 || 'Not provided', 'file-hash'));
    row.append(element('td', file.path || 'Path not provided'), hash, element('td', file.parseStatus || 'Not provided'));
    return row;
  }));
}
function renderDiff() {
  const diff = currentReport.diff;
  $('diff-badge').textContent = diff ? (diff.coverageChanged ? 'COVERAGE CHANGED' : 'COMPARED') : 'NO COMPARISON';
  $('diff-badge').classList.toggle('synthetic', Boolean(diff?.coverageChanged));
  $('diff-context').textContent = diff
    ? `Compared with ${comparisonName || 'the submitted baseline'}. Changes are based on static inventory and finding identities, not runtime behavior. ${diff.note || ''}${diff.coverageChanged ? ' Coverage changed: removed components or resolved findings may reflect reduced visibility rather than a fix.' : ''}${currentReport.selection.skippedFiles ? ' Selected files were skipped; the comparison cannot establish complete project coverage.' : ''}`
    : 'No diff returned for this scan. Capture or import a baseline, then scan again. Saving a baseline does not retroactively compare reports.';
  $('diff-content').replaceChildren();
  $('file-diff-content').replaceChildren();
  $('file-diff').hidden = !diff;
  if (!diff) return;
  for (const [key, label] of [['changedFiles', 'Changed input files'], ['removedFiles', 'Removed input files']]) {
    const files = list(diff[key]);
    const card = element('div', undefined, 'diff-card');
    const heading = element('h4', `${label} · ${files.length}`);
    const items = element('ul');
    for (const file of files) items.append(element('li', typeof file === 'string' ? file : file?.path || describe(file)));
    card.append(heading, files.length ? items : element('p', Array.isArray(diff[key]) ? 'None' : 'Not reported by this engine', 'hint'));
    $('file-diff-content').append(card);
  }
  for (const [key, label] of [['added', 'Components added'], ['removed', 'Components removed'], ['introduced', 'Findings introduced'], ['resolved', 'Findings resolved']]) {
    const entries = list(diff[key]);
    const card = element('div', undefined, `diff-card ${key}`);
    const title = element('h4');
    title.append(element('strong', String(entries.length)), document.createTextNode(label));
    const items = element('ul');
    for (const entry of entries) {
      const text = key === 'added' || key === 'removed'
        ? `${entry.name || entry.id || 'Component'}${entry.version ? ` · ${entry.version}` : ''}${entry.revision ? ` · rev ${describe(entry.revision)}` : ''}`
        : `${entry.code || 'Finding'}: ${entry.message || entry.id || 'No description'}${entry.path ? ` (${sourceLocation(entry)})` : ''}`;
      items.append(element('li', text));
    }
    const details = element('details');
    details.append(element('summary', 'Inspect changes'), items);
    card.append(title, entries.length ? details : element('p', 'None', 'hint'));
    $('diff-content').append(card);
  }
}
function svgElement(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderGraph() {
  const graph = currentReport.analysis?.graph;
  const allNodes = list(graph?.nodes);
  const edges = list(graph?.edges);
  $('graph').replaceChildren();
  $('graph-evidence').replaceChildren();
  // Bound the visual layout; retain the complete relationship evidence in the text view and export.
  const nodes = allNodes.slice(0, 24);
  const names = new Map(allNodes.map(node => [node.id, node.label || node.id]));
  const positions = new Map(nodes.map((node, index) => [node.id, { x: index % 2 ? 320 : 20, y: 30 + Math.floor(index / 2) * 96 }]));
  let visibleEdges = 0;
  if (nodes.length) {
    const height = Math.max(160, Math.ceil(nodes.length / 2) * 96 + 30);
    const svg = svgElement('svg', { viewBox: `0 0 570 ${height}`, role: 'img', 'aria-label': 'Static component relationship graph. Full labeled edges and source locations are available in the relationship evidence text view.' });
    const defs = svgElement('defs', {});
    const marker = svgElement('marker', { id: 'edge-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#8aacbc' }));
    defs.append(marker);
    svg.append(defs);
    for (const edge of edges) {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) continue;
      visibleEdges++;
      const startX = from.x + 110;
      const endX = to.x + 110;
      const downward = to.y > from.y;
      const sameRow = to.y === from.y;
      const startY = from.y + (downward ? 56 : sameRow ? 28 : 0);
      const endY = to.y + (downward || sameRow ? 0 : 56);
      const path = sameRow && edge.source !== edge.target
        ? `M ${from.x + (to.x > from.x ? 220 : 0)} ${from.y + 28} L ${to.x + (to.x > from.x ? 0 : 220)} ${to.y + 28}`
        : edge.source === edge.target
          ? `M ${from.x + 220} ${from.y + 14} C ${from.x + 255} ${from.y - 20}, ${from.x + 255} ${from.y + 75}, ${from.x + 220} ${from.y + 42}`
          : `M ${startX} ${startY} C ${startX} ${(startY + endY) / 2}, ${endX} ${(startY + endY) / 2}, ${endX} ${endY}`;
      const line = svgElement('path', { d: path, class: 'graph-edge', 'marker-end': 'url(#edge-arrow)' });
      line.append(svgElement('title', {}, `${names.get(edge.source) || edge.source} → ${edge.relation} → ${names.get(edge.target) || edge.target} · ${sourceLocation(edge.evidence)}`));
      svg.append(line);
    }
    for (const node of nodes) {
      const { x, y } = positions.get(node.id);
      const group = svgElement('g', {});
      const type = ['model', 'dataset', 'dependency', 'application'].includes(node.type) ? node.type : 'other';
      const label = String(node.label || node.id);
      group.append(svgElement('title', {}, `${label} · ${node.type || 'Unknown type'}`), svgElement('rect', { x, y, width: 220, height: 56, rx: 8, class: `graph-node ${type}` }), svgElement('text', { x: x + 12, y: y + 19, class: 'graph-type' }, String(node.type || 'Unknown').toUpperCase()), svgElement('text', { x: x + 12, y: y + 39, class: 'graph-label' }, label.length > 27 ? `${label.slice(0, 26)}…` : label));
      svg.append(group);
    }
    $('graph').append(svg);
  } else $('graph').append(element('p', 'No relationship nodes were reported by this engine.', 'empty-state'));
  $('graph-summary').textContent = `${allNodes.length} nodes · ${edges.length} observed edges. Showing ${nodes.length} nodes and ${visibleEdges} edges; arrows follow source → target. Full labels and relations appear below.`;
  for (const edge of edges) {
    const item = element('li', `${names.get(edge.source) || edge.source} → ${edge.relation || 'references'} → ${names.get(edge.target) || edge.target}`);
    item.append(element('small', sourceLocation(edge.evidence)));
    $('graph-evidence').append(item);
  }
  if (!edges.length) $('graph-evidence').append(element('li', 'No relationships reported. Absence of an edge is not evidence of absence.'));
}
function renderReport() {
  $('report').hidden = false;
  $('welcome').hidden = true;
  document.body.classList.add('has-report');
  selectView('findings');
  $('report-title').textContent = projectName(currentReport);
  const timestamp = new Date(currentReport.generatedAt);
  $('report-meta').textContent = `${currentReport.project?.filesScanned ?? currentReport.analysis?.coverage?.filesAnalyzed ?? 'Unknown'} files scanned · ${currentReport.selection.skippedFiles} files skipped · ${Number.isNaN(timestamp.getTime()) ? 'Time not provided' : timestamp.toLocaleString()}`;
  $('sample-label').hidden = !currentReport.selection.sample;
  $('sample-label').textContent = currentReport.selection.stage === 'fixed' ? 'FIXED SAMPLE · SYNTHETIC' : 'RISKY SAMPLE · SYNTHETIC';
  renderPolicy();
  renderStats('stats', [['model', 'Model candidates'], ['dataset', 'Dataset candidates'], ['dependency', 'Direct dependencies'], ['unknown', 'Unknown licenses']].map(([type, label]) => [currentReport.components.filter(component => type === 'unknown' ? !component.license : component.type === type).length, label]));
  $('filter').value = 'all';
  $('severity').value = 'all';
  $('search').value = '';
  renderComponents();
  renderFindings();
  renderDiff();
  renderGraph();
  renderFingerprints();
  const analysis = currentReport.analysis;
  $('method').textContent = `Report format: ${currentReport.specVersion || 'Not provided'} · Engine: ${analysis?.engineVersion || 'Not provided'} · Method: ${analysis?.method || 'Not provided'} · Advisory source: ${describe(analysis?.advisorySource ?? currentReport.advisorySource)} (prototype advisories are synthetic, not live intelligence).`;
  $('coverage').textContent = `Source files successfully parsed: ${analysis?.coverage?.filesAnalyzed ?? 'Not reported'} · Source files selected for analysis: ${analysis?.coverage?.sourceFilesSelected ?? 'Not reported'} · Parse errors: ${describe(analysis?.coverage?.parseErrors)} · Unresolved calls: ${analysis?.coverage?.unresolvedCalls ?? 'Not reported'} · Selected files skipped: ${currentReport.selection.skippedFiles} (${currentReport.selection.unsupportedFiles} unsupported/excluded, ${currentReport.selection.oversizedFiles} oversized). Manifest processing is separate from successfully parsed source files.`;
  $('scope').textContent = currentReport.scope || 'Static analysis of supported declarations and references only.';
  const limitations = [...new Set([...list(currentReport.limitations), ...list(analysis?.coverage?.limitations)])];
  $('limitations').replaceChildren(...(limitations.length ? limitations : ['The engine supplied no additional limitations; this does not establish complete coverage.']).map(text => element('li', text)));
}
async function requestJSON(url, options) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch {
    if (response.status === 429 || response.status === 503) throw new Error('The server is busy or temporarily unavailable. Please wait and retry.');
    throw new Error('The server returned an unreadable response.');
  }
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Server request failed (${response.status}).`;
    const retry = response.headers.get('Retry-After');
    throw new Error(`${message}${response.status === 429 || response.status === 503 ? ` Please retry${retry ? ` after ${/^\d+$/.test(retry) ? `${retry} seconds` : retry}` : ' shortly'}.` : ''}`);
  }
  return data;
}
async function scan(payload, selection, compareWith = baseline) {
  if (!config) throw new Error('Server configuration is unavailable. Reload the page before scanning.');
  if (!selection.sample && !uploadsAllowed()) throw new Error('Uploads are disabled or hosted-upload consent is required.');
  if (compareWith && compareWith.specVersion !== '0.2.0') throw new Error('Baseline format must be 0.2.0. Clear the baseline and capture or import a current report.');
  if (compareWith && compareWith.project?.name !== payload.projectName) throw new Error(`Baseline belongs to ${projectName(compareWith)}, not ${payload.projectName}. Clear it or import a report for the same project name.`);
  status(`Scanning ${payload.files.length} ${selection.sample ? 'synthetic sample ' : ''}files on the ${serverName()}${compareWith ? '; the selected baseline is sent for comparison' : ''}…`);
  const request = { ...payload };
  if (compareWith) request.baseline = compareWith;
  const report = await requestJSON('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!Array.isArray(report.components) || !Array.isArray(report.findings)) throw new Error('The server did not return a valid inventory report.');
  currentReport = { ...report, selection };
  comparisonName = compareWith ? projectName(compareWith) : '';
  // Selection exclusions are coverage metadata, not engine findings: keep policy and diff identities consistent.
  renderReport();
  status(`${selection.sample ? 'Synthetic sample' : 'Project'} scan complete. ${selection.skippedFiles ? `${selection.skippedFiles} files skipped; see coverage. ` : ''}Review the evidence. Review changes persist only when exported.`);
  $('report-title').focus({ preventScroll: true });
  $('report').scrollIntoView({ block: 'start' });
}
function scanError(error) {
  status(`${error.message}${currentReport ? ' The previous report is still displayed.' : ''}`, true);
}
$('folder').addEventListener('change', async event => {
  if (busy || !uploadsAllowed()) { event.target.value = ''; return; }
  const selected = [...event.target.files];
  if (!selected.length) return;
  setBusy(true);
  try {
    const selection = { selectedFiles: selected.length, skippedFiles: 0, unsupportedFiles: 0, oversizedFiles: 0, sample: false };
    const accepted = [];
    let bytes = 0;
    for (const file of selected) {
      const path = file.webkitRelativePath.split('/').slice(1).join('/') || file.name;
      if (!isSupportedPath(path)) { selection.unsupportedFiles++; continue; }
      if (file.size > config.limits.fileBytes) { selection.oversizedFiles++; continue; }
      bytes += file.size;
      accepted.push({ file, path });
    }
    selection.skippedFiles = selection.unsupportedFiles + selection.oversizedFiles;
    if (!accepted.length) throw new Error('No supported files found. Choose a project with package.json, requirements.txt, Python, or JavaScript/TypeScript source.');
    if (accepted.length > config.limits.files || bytes > config.limits.totalBytes) throw new Error(`Project exceeds the ${config.limits.files}-file or ${config.limits.totalBytes.toLocaleString()}-byte limit. Select a smaller project subfolder.`);
    const files = await Promise.all(accepted.map(async ({ file, path }) => ({ path, content: await file.text() })));
    await scan({ projectName: selected[0].webkitRelativePath.split('/')[0] || 'Project', files }, selection);
  } catch (error) { scanError(error); }
  finally { setBusy(false); event.target.value = ''; }
});
async function runDemo(fixed) {
  if (busy || !config || (fixed && !demoBaseline)) return;
  setBusy(true);
  try {
    if (!demo) {
      status(`Loading bundled synthetic samples from the ${serverName()}…`);
      demo = await requestJSON('/api/demo');
    }
    const payload = fixed ? demo.after : demo.before;
    if (!Array.isArray(payload?.files)) { demo = null; throw new Error('The bundled demo fixture is unavailable.'); }
    await scan(payload, { selectedFiles: payload.files.length, skippedFiles: 0, unsupportedFiles: 0, oversizedFiles: 0, sample: true, stage: fixed ? 'fixed' : 'risky' }, fixed ? demoBaseline : null);
    if (!fixed) {
      demoBaseline = snapshot(currentReport);
      captureBaseline(currentReport, 'risky synthetic sample, automatically captured');
      status('Risky synthetic sample scanned and captured as the baseline. Run the fixed sample to compare. Any previous baseline has been replaced.');
    } else {
      captureBaseline(demoBaseline, 'risky synthetic sample');
      status('Fixed synthetic sample compared with the captured risky sample. Inspect the policy and changes; the risky baseline is retained.');
    }
  } catch (error) { scanError(error); }
  finally { setBusy(false); }
}
$('demo').addEventListener('click', () => runDemo(false));
$('demo-fixed').addEventListener('click', () => runDemo(true));
$('manage-baseline').addEventListener('click', () => {
  $('project-upload').open = true;
  $('baseline-settings').open = true;
  $('baseline-settings').querySelector('summary').focus();
  $('baseline-settings').scrollIntoView({ block: 'center' });
});
$('save-baseline').addEventListener('click', () => {
  if (busy || !currentReport) return;
  captureBaseline(currentReport, 'saved in memory');
  status(`Current report captured in browser memory as an independent baseline snapshot. It will be sent to the ${serverName()} with the next project scan for comparison; export to retain it across sessions.`);
});
$('clear-baseline').addEventListener('click', () => {
  if (busy) return;
  baseline = null;
  demoBaseline = null;
  baselineSource = '';
  renderBaseline();
  status('Baseline cleared. Existing report and its historical comparison are unchanged. Run the risky sample again to restart the guided comparison.');
});
$('baseline-file').addEventListener('change', async event => {
  if (busy || !uploadsAllowed()) { event.target.value = ''; return; }
  const file = event.target.files[0];
  if (!file) return;
  setBusy(true);
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Baseline exceeds the 5 MB import limit.');
    let imported;
    try { imported = JSON.parse(await file.text()); } catch { throw new Error('Could not parse baseline JSON. Import a previously exported AIBOM report.'); }
    const hasText = value => typeof value === 'string' && value.trim().length > 0;
    if (!imported || typeof imported !== 'object' || !Array.isArray(imported.components) || !Array.isArray(imported.findings) || !hasText(imported.project?.name)) {
      throw new Error('Invalid baseline: expected an exported report with project.name, components, and findings.');
    }
    if (imported.specVersion !== '0.2.0') throw new Error('Unsupported baseline format. Scan and export a version 0.2.0 report.');
    if (imported.components.some(component => !hasText(component?.id)) || imported.findings.some(finding => !hasText(finding?.id) || !hasText(finding?.code))) {
      throw new Error('Invalid baseline: components need stable IDs and findings need stable IDs and codes. Re-scan and export a current report.');
    }
    captureBaseline(imported, `imported from ${file.name}`);
    status(`Baseline imported into browser memory; nothing was uploaded by this import. It will be sent ${isPublic() ? 'over HTTPS ' : ''}to the ${serverName()} for validation and comparison with the next project scan. The displayed report has not changed.`);
  } catch (error) { status(`${error.message} The previous baseline is unchanged.`, true); }
  finally { setBusy(false); event.target.value = ''; }
});
$('filter').addEventListener('change', renderComponents);
$('search').addEventListener('input', renderComponents);
$('severity').addEventListener('change', renderFindings);
$('copy-digest').addEventListener('click', async () => {
  if (busy || !currentReport?.inputDigest) return;
  const digest = $('input-digest').value;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(digest);
    $('digest-status').textContent = 'Input digest copied. This unsigned hash is not a provenance attestation.';
  } catch {
    $('input-digest').focus();
    $('input-digest').select();
    $('digest-status').textContent = 'Automatic copying is unavailable. The digest is selected; use your system Copy shortcut.';
  }
});
$('export').addEventListener('click', () => {
  if (busy || !currentReport) return;
  const exported = { ...currentReport, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `${String(projectName(currentReport)).replace(/[^a-zA-Z0-9_-]/g, '-')}-aibom.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('AIBOM download requested from browser memory; exporting makes no server request. Includes review state, analysis, policy, graph, hashes, and diff when provided. Review paths and metadata before sharing.');
});
$('benchmark').addEventListener('click', async () => {
  if (!config || busy || benchmarkBusy) return;
  benchmarkBusy = true;
  setBusy(busy);
  $('benchmark-status').textContent = `Running bundled synthetic fixtures on the ${serverName()}; no visitor source files are used…`;
  $('benchmark-status').classList.remove('error');
  try {
    const result = await requestJSON('/api/benchmark');
    if (!result.summary || !Array.isArray(result.cases)) throw new Error('Invalid benchmark response.');
    const summary = result.summary;
    const percentage = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'N/A';
    renderStats('benchmark-stats', [[`${summary.passed ?? '—'}/${summary.total ?? '—'}`, 'Fixtures passed'], [percentage(summary.precision), 'Precision · fixtures only'], [percentage(summary.recall), 'Recall · fixtures only'], [`${summary.truePositives ?? '—'} / ${summary.falsePositives ?? '—'} / ${summary.falseNegatives ?? '—'}`, 'True positives / false positives / false negatives']]);
    $('benchmark-scope').textContent = `Suite ${result.suiteVersion || 'unspecified'} · ${result.scope || 'Bundled synthetic fixtures only.'}`;
    $('benchmark-cases').replaceChildren(...result.cases.map(test => {
      const row = element('tr');
      const expected = element('td');
      const actual = element('td');
      expected.append(element('pre', describe(test.expected)));
      actual.append(element('pre', describe(test.actual)));
      row.append(element('td', test.name), element('td', test.passed ? 'PASS' : 'FAIL', test.passed ? '' : 'unknown'), expected, actual);
      return row;
    }));
    $('benchmark-result').hidden = false;
    $('benchmark-status').textContent = 'Benchmark complete. These results measure this fixture suite only, not real-world accuracy.';
  } catch (error) {
    $('benchmark-status').textContent = `${error.message}${!$('benchmark-result').hidden ? ' Previous benchmark results remain displayed.' : ''}`;
    $('benchmark-status').classList.add('error');
  } finally { benchmarkBusy = false; setBusy(busy); }
});
loadConfig();
