const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Element', 'Node', 'Window', 'DOMRect', 'Range']) global[key] = dom.window[key];
global.getComputedStyle = dom.window.getComputedStyle;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
const { EditorState, StateField, StateEffect } = require('@codemirror/state');
const { EditorView } = require('@codemirror/view');
const { history, undo } = require('@codemirror/commands');
const setLive = StateEffect.define();
const liveField = StateField.define({ create: () => true, update: (value, tr) => tr.effects.reduce((old, effect) => effect.is(setLive) ? effect.value : old, value) });
const infoField = StateField.define({ create: () => null, update: value => value });
const notices = [];
for (const [name, fn] of Object.entries({
  addClass(...names) { this.classList.add(...names); },
  removeClass(...names) { this.classList.remove(...names); },
  empty() { this.replaceChildren(); },
  setText(text) { this.textContent = text; },
  createEl(tag, options = {}) { const node = document.createElement(tag); if (options.cls) node.className = options.cls; if (options.text) node.textContent = options.text; this.appendChild(node); return node; },
  createSpan(options) { return this.createEl('span', options); },
  createDiv(options) { return this.createEl('div', options); }
})) dom.window.HTMLElement.prototype[name] = fn;

class MockPlugin {
  async loadData() { return null; }
  async saveData(settings) { this.saved = settings; }
  registerEditorExtension(extension) { this.extension = extension; }
  registerMarkdownPostProcessor(processor) { this.processor = processor; }
  registerEvent() {}
  registerDomEvent(element, event, callback) { element.addEventListener(event, callback); }
  addCommand(command) { (this.commands ||= []).push(command); }
  addSettingTab(tab) { this.settingTab = tab; }
  addStatusBarItem() { return document.body.createSpan(); }
}
class MockMarkdownView {
  constructor(file, editor, mode = 'source') { Object.assign(this, { file, editor, mode }); }
  getMode() { return this.mode; }
}
class MockRenderChild { constructor(element) { this.containerEl = element; } }
class MockModal {
  constructor(app) { this.app = app; this.contentEl = document.body.createDiv(); }
  open() { this.onOpen(); }
  close() { this.onClose(); this.contentEl.remove(); }
}
class MockSetting {
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addToggle(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addDropdown(callback) { callback({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
}
const obsidian = { Plugin: MockPlugin, MarkdownView: MockMarkdownView, MarkdownRenderChild: MockRenderChild,
  PluginSettingTab: class { constructor(app) { this.app = app; this.containerEl = document.body.createDiv(); } },
  Setting: MockSetting, Modal: MockModal, Notice: class { constructor(text) { notices.push(text); } },
  setIcon(element, icon) { element.setAttribute('data-icon', icon); }, editorLivePreviewField: liveField, editorInfoField: infoField };
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'obsidian' ? obsidian : originalLoad.call(this, name, ...args); };
const Tracker = require('../src/main.cjs');
const ReleaseTracker = require('../main.js');
Module._load = originalLoad;
const { buildModel } = require('../src/model.cjs');
const { refreshEffect } = require('../src/editor.cjs');

function fakeEditor(initial) {
  let text = initial;
  return { getValue: () => text, getCursor: () => ({ line: 0, ch: 0 }),
    offsetToPos(offset) { const prefix = text.slice(0, offset).split('\n'); return { line: prefix.length - 1, ch: prefix.at(-1).length }; },
    transaction(spec) { for (const change of [...spec.changes].reverse()) { const lines = text.split('\n'); const offset = p => lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.ch; text = text.slice(0, offset(change.from)) + change.text + text.slice(offset(change.to)); } },
    setCursor(position) { this.cursor = position; }, scrollIntoView() {} };
}
async function fixture(text, mode = 'preview') {
  const file = { path: 'note.md', extension: 'md', basename: 'Note' };
  const editor = fakeEditor(text);
  const views = [new MockMarkdownView(file, editor, mode)];
  let disk = text, writes = 0, read = null, active = file;
  const plugin = new Tracker();
  plugin.app = {
    vault: { getFileByPath: () => file, async cachedRead() { return read ? read() : disk; },
      async process(target, callback) { assert.equal(target, file); const next = callback(disk); if (next !== disk) writes++; disk = next; }, on() { return {}; } },
    workspace: { iterateAllLeaves(callback) { views.forEach(view => callback({ view })); }, getActiveFile: () => active,
      on() { return {}; }, onLayoutReady() {}, getLeaf() { return { openFile: async () => {}, view: views[0] }; } }
  };
  await plugin.onload();
  return { plugin, file, editor, views, get disk() { return disk; }, get writes() { return writes; }, setRead(fn) { read = fn; }, setActive(file) { active = file; } };
}
function cleanup(f) { f.plugin.onunload(); for (const badge of [...f.plugin.readingBadges]) badge.onunload(); f.plugin.statusBarItem?.remove(); }
async function render(f, html, section) {
  const root = document.body.createDiv(); root.innerHTML = html;
  const children = [];
  await f.plugin.processor(root, { sourcePath: f.file.path, getSectionInfo: () => section || { lineStart: 0, lineEnd: f.disk.split('\n').length - 1, text: f.disk },
    addChild(child) { children.push(child); child.onload(); } });
  await Promise.all(children.map(child => child.refresh()));
  return { root, children };
}

test('reading view parent cascade, rapid toggles, and immediate settings refresh', async () => {
  const f = await fixture('# Parent\n## A\n## B');
  const rendered = await render(f, '<h1>Parent</h1><h2>A</h2><h2>B</h2>');
  assert.equal(rendered.root.querySelectorAll('.heading-status-container').length, 3);
  rendered.root.querySelector('h1 .btn-read').click();
  await Promise.all(f.plugin.fileQueues.values());
  assert.ok(buildModel(f.disk).tracked.every(h => h.read));
  for (const badge of rendered.children) await badge.refresh();
  assert.match(rendered.root.querySelector('h1 .btn-read').title, /Automatically calculated/);
  rendered.root.querySelectorAll('h2 .btn-read')[1].click();
  await Promise.all(f.plugin.fileQueues.values());
  assert.deepEqual(buildModel(f.disk).tracked.map(h => h.read), [false, true, false]);
  f.plugin.settings.position = 'before'; f.plugin.settings.showLabels = false;
  await f.plugin.saveSettings();
  for (const badge of rendered.children) await badge.refresh();
  assert.equal(rendered.root.querySelectorAll('.heading-status-container').length, 3);
  assert.equal(rendered.root.querySelectorAll('.heading-status-label').length, 0);
  assert.equal(rendered.root.querySelectorAll('.pos-before').length, 3);
  cleanup(f); rendered.root.remove();
});

test('reading view maps duplicate titles and setext boundaries to exact source lines', async () => {
  const f = await fixture('Intro\n=====\n## Same\n## Same');
  const rendered = await render(f, '<h1>Intro</h1><h2>Same</h2><h2>Same</h2>');
  assert.equal(rendered.root.querySelector('h1 .heading-status-container'), null);
  rendered.root.querySelectorAll('h2 .btn-read')[1].click();
  await Promise.all(f.plugin.fileQueues.values());
  assert.deepEqual(buildModel(f.disk).tracked.map(h => h.read), [false, true]);
  cleanup(f); rendered.root.remove();
});

test('open editors retain unsaved text when a reading badge toggles a heading', async () => {
  const f = await fixture('# Parent\n## Original', 'source');
  f.views[0].editor = fakeEditor('# Parent\n## Original\n## Unsaved');
  await f.plugin.toggleFile(f.file, 0, 'written', { title: 'Parent', level: 1 });
  assert.ok(f.views[0].editor.getValue().includes('Unsaved'));
  assert.ok(buildModel(f.views[0].editor.getValue()).tracked.every(h => h.written));
  assert.equal(f.writes, 0);
  cleanup(f);
});

test('reconciliation touches only open notes and avoids redundant writes', async () => {
  const f = await fixture('# Parent\n## Read <!-- [x][ ][ ] -->');
  await f.plugin.reconcileOpenNotes();
  assert.equal(f.writes, 1);
  await f.plugin.reconcileOpenNotes();
  assert.equal(f.writes, 1);
  f.views.length = 0;
  await f.plugin.reconcileOpenNotes();
  assert.equal(f.writes, 1);
  cleanup(f);
});

test('stale badges cannot write to a changed heading', async () => {
  const f = await fixture('# Changed\n## A');
  await f.plugin.toggleFile(f.file, 0, 'read', { title: 'Old title', level: 1 });
  assert.equal(f.writes, 0);
  cleanup(f);
});

test('progress uses unsaved editor content and stale asynchronous reads are discarded', async () => {
  const f = await fixture('# Saved', 'source');
  f.views[0].editor = fakeEditor('# Parent\n## Unsaved <!-- [x][ ][ ] -->');
  await f.plugin.updateStatusBar();
  assert.match(f.plugin.statusBarItem.textContent, /Read 2\/2/);
  f.views[0].mode = 'preview';
  let resolve;
  f.setRead(() => new Promise(done => { resolve = done; }));
  const pending = f.plugin.updateStatusBar();
  f.setActive(null); await f.plugin.updateStatusBar();
  resolve('# Late'); await pending;
  assert.equal(f.plugin.statusBarItem.textContent, '');
  cleanup(f);
});

test('real CodeMirror widgets and commands update without duplicates and disappear in Source mode', async () => {
  const f = await fixture('# Parent\n## A\n## B', 'source');
  const host = document.body.createDiv();
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: f.editor.getValue(), extensions: [history(), liveField, infoField.init(() => ({ editor: f.editor })), f.plugin.extension] }) });
  assert.equal(host.querySelectorAll('.heading-status-container').length, 3);
  host.querySelector('.btn-written').click();
  assert.ok(buildModel(view.state.doc.toString()).tracked.every(h => h.written));
  assert.equal(host.querySelectorAll('.heading-status-container').length, 3);
  assert.equal(undo(view), true);
  assert.ok(buildModel(view.state.doc.toString()).tracked.every(h => !h.written));
  const command = f.plugin.commands.find(command => command.id === 'toggle-read-status');
  command.editorCallback(f.editor);
  assert.ok(buildModel(view.state.doc.toString()).tracked.every(h => h.read));
  assert.equal(undo(view), true);
  assert.ok(buildModel(view.state.doc.toString()).tracked.every(h => !h.read));
  f.plugin.settings.position = 'before'; f.plugin.generation++;
  view.dispatch({ effects: refreshEffect.of(f.plugin.generation) });
  assert.equal(host.querySelectorAll('.pos-before').length, 3);
  view.dispatch({ effects: setLive.of(false) });
  assert.equal(host.querySelectorAll('.heading-status-container').length, 0);
  view.destroy(); cleanup(f); host.remove();
});

test('packaged plugin loads with only Obsidian and CodeMirror runtime modules', async () => {
  const f = await fixture('# Parent\n## A');
  const release = new ReleaseTracker();
  release.app = f.plugin.app;
  await release.onload();
  assert.equal(release.settings.autoParentRead, true);
  assert.equal(release.settings.autoParentWritten, true);
  assert.equal(release.commands.length, 6);
  release.onunload(); release.statusBarItem?.remove(); cleanup(f);
});

test('duplicate processor calls and badge unloading do not leak controls', async () => {
  const f = await fixture('# Parent\n## A');
  const root = document.body.createDiv(); root.innerHTML = '<h1>Parent</h1><h2>A</h2>';
  const children = [];
  const context = { sourcePath: f.file.path, getSectionInfo: () => ({ lineStart: 0, lineEnd: 1, text: f.disk }), addChild(child) { children.push(child); child.onload(); } };
  await Promise.all([f.plugin.processor(root, context), f.plugin.processor(root, context)]);
  await Promise.all(children.map(child => child.refresh()));
  assert.equal(children.length, 2);
  assert.equal(root.querySelectorAll('.heading-status-container').length, 2);
  children.forEach(child => child.onunload());
  assert.equal(root.querySelectorAll('.heading-status-container').length, 0);
  assert.equal(f.plugin.readingBadges.size, 0);
  cleanup(f); root.remove();
});

test('print styles hide badges without important overrides; settings render', async () => {
  const css = require('node:fs').readFileSync('styles.css', 'utf8');
  assert.doesNotMatch(css, /!important/);
  assert.match(css, /@media print\s*\{[\s\S]*\.markdown-preview-view \.heading-status-container/);
  const f = await fixture('# Parent');
  f.plugin.settingTab.display();
  f.plugin.settings.showStatusBar = false; f.plugin.updateStatusBarVisibility();
  assert.equal(f.plugin.statusBarItem, null);
  f.plugin.settings.showStatusBar = true; f.plugin.updateStatusBarVisibility();
  assert.ok(f.plugin.statusBarItem);
  cleanup(f);
});

after(() => { dom.window.close(); });
