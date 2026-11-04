const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EditorState, StateField } = require('@codemirror/state');
const { history, undo, redo } = require('@codemirror/commands');
const { buildModel, reconcile, toggleStatus } = require('../src/model.cjs');
const livePreview = StateField.define({ create: () => true, update: value => value });
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'obsidian' ? { editorLivePreviewField: livePreview } : originalLoad.call(this, name, ...args); };
const { createEditorExtensions } = require('../src/editor.cjs');
Module._load = originalLoad;

function harness(doc) {
  const plugin = { settings: {}, editorViews: new Set() };
  let state = EditorState.create({ doc, extensions: [history(), createEditorExtensions(plugin)] });
  const dispatch = transaction => { state = transaction.state || state.update(transaction).state; };
  return { plugin, get state() { return state; }, dispatch };
}

test('a child edit and parent updates share one undo/redo transaction', () => {
  const h = harness('# Parent\n## A\n## B <!-- [x][ ][ ] -->');
  const before = h.state.doc.toString();
  const result = toggleStatus(before, {}, 1, 'read');
  h.dispatch({ changes: result.changes, userEvent: 'input.heading-status' });
  assert.ok(buildModel(h.state.doc.toString()).tracked.every(item => item.read));
  assert.equal(undo({ state: h.state, dispatch: h.dispatch }), true);
  assert.equal(h.state.doc.toString(), before);
  assert.equal(redo({ state: h.state, dispatch: h.dispatch }), true);
  assert.ok(buildModel(h.state.doc.toString()).tracked.every(item => item.read));
});

test('typing status comments also updates the parent in the same transaction', () => {
  const h = harness('# Parent\n## A');
  h.dispatch({ changes: { from: h.state.doc.length, insert: ' <!-- [x][x][ ] -->' }, userEvent: 'input.type' });
  const headings = buildModel(h.state.doc.toString()).tracked;
  assert.ok(headings.every(item => item.read && item.written));
  assert.equal(reconcile(h.state.doc.toString(), {}).changes.length, 0);
  undo({ state: h.state, dispatch: h.dispatch });
  assert.equal(h.state.doc.toString(), '# Parent\n## A');
});

test('filter preserves selection position through inserted parent comments', () => {
  const h = harness('# Parent\n## A');
  h.dispatch({ changes: { from: h.state.doc.length, insert: ' <!-- [x][ ][ ] -->' }, selection: { anchor: 11 }, userEvent: 'input.type' });
  assert.equal(h.state.doc.lineAt(h.state.selection.main.head).number, 2);
});

test('parent cascade then rapid child clicks remain consistent', () => {
  const h = harness('# Parent\n## A\n## B');
  for (const line of [0, 1, 2, 1, 2]) {
    h.dispatch({ changes: toggleStatus(h.state.doc.toString(), {}, line, 'written').changes });
    assert.equal(reconcile(h.state.doc.toString(), {}).changes.length, 0);
  }
  assert.ok(buildModel(h.state.doc.toString()).tracked.every(item => item.written));
});
