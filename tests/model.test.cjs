const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildModel, reconcile, toggleStatus, statistics, settingsWithDefaults } = require('../src/model.cjs');
const status = (r = ' ', w = ' ', m = ' ') => `<!-- [${r}][${w}][${m}] -->`;
const flags = text => buildModel(text).tracked.map(h => [h.title, h.read, h.written, h.missing]);

test('defaults are enabled and settings arrays are independent', () => {
  const a = settingsWithDefaults(), b = settingsWithDefaults();
  a.enabledLevels.pop();
  assert.equal(b.enabledLevels.length, 6);
  assert.equal(a.autoParentRead, true); assert.equal(a.autoParentWritten, true);
  assert.deepEqual(settingsWithDefaults({ enabledLevels: [2, 2, 9, '1'] }).enabledLevels, [2]);
});

test('fresh installations and malformed saved settings safely use defaults', () => {
  for (const saved of [null, undefined, false, 0, 'invalid', []]) {
    const settings = settingsWithDefaults(saved);
    assert.deepEqual(settings.enabledLevels, [1, 2, 3, 4, 5, 6]);
    assert.equal(settings.autoParentRead, true);
    assert.equal(settings.autoParentWritten, true);
  }
  assert.equal(settingsWithDefaults({ autoParentRead: false }).autoParentRead, false);
});

test('parent clicks cascade only inside their section and either status is independent', () => {
  const original = '# Book\n## Chapter\n#### Topic A\n#### Topic B\n## Other chapter\n### Unread topic\n';
  let result = toggleStatus(original, {}, 1, 'read');
  assert.deepEqual(flags(result.text).map(h => h[1]), [false, true, true, true, false, false]);
  assert.ok(flags(result.text).every(h => !h[2]));
  result = toggleStatus(result.text, {}, 3, 'written');
  assert.deepEqual(flags(result.text).map(h => h[2]), [false, false, false, true, false, false]);
  result = toggleStatus(result.text, {}, 1, 'read');
  assert.ok(flags(result.text).every(h => !h[1]));
  assert.equal(flags(result.text)[3][2], true);
});

test('unmarking one leaf reopens every ancestor; rechecking completes the tree', () => {
  let text = toggleStatus('# Book\n## Chapter\n### A\n### B\n', {}, 0, 'read').text;
  assert.ok(flags(text).every(h => h[1]));
  text = toggleStatus(text, {}, 2, 'read').text;
  assert.deepEqual(flags(text).map(h => h[1]), [false, false, false, true]);
  text = toggleStatus(text, {}, 2, 'read').text;
  assert.ok(flags(text).every(h => h[1]));
});

test('written cascades and reopens independently; missing remains manual', () => {
  let text = toggleStatus('# Book\n## A\n## B\n', {}, 0, 'written').text;
  assert.ok(flags(text).every(h => h[2]));
  text = toggleStatus(text, {}, 1, 'written').text;
  assert.deepEqual(flags(text).map(h => h[2]), [false, false, true]);
  text = toggleStatus(text, {}, 2, 'missing').text;
  assert.deepEqual(flags(text).map(h => h[3]), [false, false, true]);
});

test('disabled levels establish boundaries but do not count or get modified', () => {
  const text = '# Root\n## Hidden one\n### A <!-- [x][ ][ ] -->\n## Hidden two\n### B <!-- [x][ ][ ] -->\n# Next\n### Unread\n';
  const model = buildModel(text, { enabledLevels: [1, 3] });
  assert.equal(model.tracked[0].read, true);
  assert.equal(model.tracked[0].descendantCount, 2);
  const result = toggleStatus(text, { enabledLevels: [1, 3] }, 0, 'written').text;
  assert.ok(result.includes('## Hidden one\n')); assert.ok(result.includes('## Hidden two\n'));
  assert.equal(buildModel(result, { enabledLevels: [1, 3] }).tracked.at(-1).written, false);
});

test('disabling either automatic status preserves parent values and stops that cascade', () => {
  const original = `# Root ${status('x', 'x')}\n## Leaf\n`;
  const text = reconcile(original, { autoParentRead: false }).text;
  assert.deepEqual(flags(text)[0].slice(1, 3), [false, false]); // default model still calculates Read
  const model = buildModel(text, { autoParentRead: false });
  assert.equal(model.tracked[0].read, true); assert.equal(model.tracked[0].written, false);
  const cleared = toggleStatus(text, { autoParentRead: false }, 0, 'read').text;
  assert.equal(buildModel(cleared, { autoParentRead: false }).tracked[1].read, false);
  assert.equal(reconcile(original, { autoParentRead: false, autoParentWritten: false }).text, original);
});

test('exclude fenced/indented code, frontmatter, HTML, comments, quotes, and lists', () => {
  const text = '---\nvalue: |\n  # YAML example\n---\n# Real\n\n```md\n## Fenced\n```\n\n~~~\n### Tilde\n~~~\n\n    ## Indented\n\n<div>\n## HTML\n</div>\n\n%%\n## Comment\n```\n%%\n\n> ## Quoted\n\n- item\n  ### Listed\n\n## Visible\n';
  assert.deepEqual(buildModel(text).tracked.map(h => h.title), ['Real', 'Visible']);
  assert.equal(statistics(buildModel(text)).total, 2);
  assert.equal(toggleStatus(text, {}, 8, 'read').found, false);
});

test('comment markers in code do not hide later headings', () => {
  const text = '```\n%%\n```\n\n# Real\n\n`%%`\n\n## Child\n';
  assert.deepEqual(buildModel(text).tracked.map(h => h.title), ['Real', 'Child']);
});

test('setext headings remain untracked but close sections', () => {
  const text = '# A\n## Child\n\nNew section\n===========\n## Separate\n';
  const result = toggleStatus(text, {}, 0, 'read').text;
  assert.deepEqual(flags(result).map(h => h[1]), [true, true, false]);
  assert.equal(flags(result).length, 3);
});

test('preserve CRLF, closing hashes, whitespace, Unicode, unrelated comments and flags', () => {
  const text = '  # पाठ  <!-- keep this -->  ###  \r\n\r\n## Child <!-- [ ][ ][!] -->  \r\n';
  const result = toggleStatus(text, { showMissingButton: false }, 1, 'read');
  assert.equal(result.found, false);
  const updated = toggleStatus(text, { showMissingButton: false }, 2, 'read').text;
  assert.ok(updated.includes('  # पाठ  <!-- keep this --> <!-- [x][ ] -->  ###  \r\n'));
  assert.ok(updated.includes('## Child <!-- [x][ ][!] -->  \r\n'));
  assert.equal(updated.match(/\r\n/g).length, text.match(/\r\n/g).length);
  assert.ok(updated.includes('<!-- keep this -->'));
});

test('duplicate titles remain separate and reconciliation is idempotent', () => {
  const text = '# Root\n## Same\n## Same\n';
  const result = toggleStatus(text, {}, 2, 'read').text;
  assert.deepEqual(flags(result).map(h => h[1]), [false, false, true]);
  const normalized = reconcile(result, {});
  assert.equal(reconcile(normalized.text, {}).changes.length, 0);
});

test('insertion, deletion, movement, and manual status edits recalculate parents', () => {
  const initial = '# Root <!-- [x][x][ ] -->\n## A <!-- [x][x][ ] -->\n';
  assert.equal(reconcile(initial, {}).text, initial);
  const inserted = reconcile(initial + '## New\n', {}).text;
  assert.deepEqual(flags(inserted)[0].slice(1, 3), [false, false]);
  const removed = reconcile(inserted.replace('## New\n', ''), {}).text;
  assert.deepEqual(flags(removed)[0].slice(1, 3), [true, true]);
  const edited = reconcile(removed.replace('## A <!-- [x][x]', '## A <!-- [ ][x]'), {}).text;
  assert.deepEqual(flags(edited)[0].slice(1, 3), [false, true]);
  const moved = reconcile(removed + '# Other\n## B\n', {}).text;
  assert.deepEqual(flags(moved).map(h => h[1]), [true, true, false, false]);
});

test('unclosed frontmatter and comments never create tracking targets', () => {
  assert.equal(buildModel('---\n# hidden\n').tracked.length, 0);
  assert.deepEqual(buildModel('# real\n%%\n## hidden').tracked.map(h => h.title), ['real']);
  assert.equal(buildModel('', {}).tracked.length, 0);
});

test('large nested notes normalize without changing other text', () => {
  const text = '# Root\n' + Array.from({ length: 1000 }, (_, i) => `## Topic ${i}\n### Detail ${i} ${status('x', 'x')}\n`).join('');
  const result = reconcile(text, {});
  assert.equal(statistics(result.model).total, 2001);
  assert.equal(buildModel(result.text).tracked[0].read, true);
  assert.equal(reconcile(result.text, {}).changes.length, 0);
});
