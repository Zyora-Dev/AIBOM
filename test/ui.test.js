import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

test('dashboard IDs are unique and every literal application target exists', () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.includes(id), `Missing DOM target: ${id}`);
  }
  for (const [, references] of html.matchAll(/\b(?:aria-controls|aria-labelledby|aria-describedby)="([^"]+)"/g)) {
    for (const id of references.split(' ')) assert.ok(ids.includes(id), `Missing accessible target: ${id}`);
  }
});

test('report tabs have matching panels and only findings is initially selected', () => {
  const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(match => match[0]);
  assert.equal(tabs.length, 4);
  assert.equal(tabs.filter(tab => tab.includes('aria-selected="true"')).length, 1);
  for (const tab of tabs) {
    const id = tab.match(/\bid="([^"]+)"/)[1];
    const target = tab.match(/aria-controls="([^"]+)"/)[1];
    const panel = html.match(new RegExp(`<div id="${target}"[^>]*>`))?.[0];
    assert.ok(panel?.includes('role="tabpanel"'));
    assert.ok(panel.includes(`aria-labelledby="${id}"`));
    assert.equal(panel.includes(' hidden'), !tab.includes('aria-selected="true"'));
  }
});

test('consent and baseline import remain accessible before any report exists', () => {
  const uploadStart = html.indexOf('<details id="project-upload"');
  const uploadEnd = html.indexOf('<aside id="demo-panel"');
  const reportStart = html.indexOf('<section id="report"');
  assert.ok(uploadStart < uploadEnd && uploadEnd < reportStart);
  for (const id of ['privacy-notice', 'upload-consent', 'folder', 'baseline-file', 'baseline-transfer']) {
    const position = html.indexOf(`id="${id}"`);
    assert.ok(position > uploadStart && position < uploadEnd, `${id} must not depend on a report`);
  }
  assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(ids.includes('status-title') && ids.includes('status-message'));
});
