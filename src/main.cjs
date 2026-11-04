const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, Modal, MarkdownRenderChild, setIcon, editorInfoField } = require('obsidian');
const { Transaction } = require('@codemirror/state');
const { isolateHistory } = require('@codemirror/commands');
const { settingsWithDefaults, buildModel, reconcile, toggleStatus, statistics } = require('./model.cjs');
const { createEditorExtensions, refreshEffect } = require('./editor.cjs');

function sameHeading(current, previous) {
  return current && (!previous || (current.title === previous.title && current.level === previous.level));
}

class ReadingBadge extends MarkdownRenderChild {
  constructor(element, plugin, file, line, expected) {
    super(element);
    Object.assign(this, { plugin, file, line, expected, request: 0 });
  }
  onload() { this.plugin.readingBadges.add(this); this.refresh(); }
  onunload() {
    this.request++;
    this.plugin.readingBadges.delete(this);
    this.plugin.readingElements.delete(this.containerEl);
    this.badge?.remove();
    this.containerEl.removeClass('has-missing-extra');
  }
  async refresh() {
    const request = ++this.request;
    try {
      const text = await this.plugin.noteText(this.file);
      if (request !== this.request || this.plugin.unloaded) return;
      const heading = buildModel(text, this.plugin.settings).tracked.find(h => h.line === this.line);
      this.badge?.remove();
      this.badge = null;
      this.containerEl.removeClass('has-missing-extra');
      if (!sameHeading(heading, this.expected)) return;
      const badge = this.plugin.createStatusBadge(heading, type => this.plugin.toggleFile(this.file, this.line, type, heading));
      badge.addClass(this.plugin.settings.position === 'before' ? 'pos-before' : 'pos-after');
      this.containerEl[this.plugin.settings.position === 'before' ? 'prepend' : 'appendChild'](badge);
      this.badge = badge;
      if (heading.missing && this.plugin.settings.highlightMissingHeading) this.containerEl.addClass('has-missing-extra');
    } catch (error) { this.plugin.reportError(error); }
  }
}

class HeadingStatusTracker extends Plugin {
  async onload() {
    this.settings = settingsWithDefaults(await this.loadData());
    this.editorViews = new Set();
    this.readingBadges = new Set();
    this.readingElements = new WeakSet();
    this.fileQueues = new Map();
    this.generation = 0;
    this.unloaded = false;
    this.statusRequest = 0;
    this.registerEditorExtension(createEditorExtensions(this));
    this.registerMarkdownPostProcessor(async (element, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      if (!file) return;
      let model;
      try { model = buildModel(await this.noteText(file), this.settings); }
      catch (error) { this.reportError(error); return; }
      if (this.unloaded) return;
      const all = Array.from(element.matches('h1,h2,h3,h4,h5,h6') ? [element] : element.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .filter(heading => !heading.closest('blockquote,li,pre'));
      for (const heading of all) {
        if (this.readingElements.has(heading) || heading.querySelector('.heading-status-container')) continue;
        const section = context.getSectionInfo(heading);
        if (!section) continue;
        // Resolve this element's exact line within its rendered section. No title-based guessing.
        const candidates = Array.from(all).filter(h => context.getSectionInfo(h)?.lineStart === section.lineStart);
        const index = candidates.indexOf(heading);
        const headings = model.headings.filter(h => h.line >= section.lineStart && h.line <= section.lineEnd);
        const match = headings[index];
        if (match && /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(match.text) && match.level === Number(heading.tagName.slice(1))) {
          this.readingElements.add(heading);
          context.addChild(new ReadingBadge(heading, this, file, match.line, match));
        }
      }
    });
    for (const [type, label] of [['read', 'Read'], ['written', 'Written'], ['missing', 'Missing / Extra']]) {
      this.addCommand({ id: `toggle-${type}-status`, name: `Toggle ${label} on the current heading`,
        editorCallback: editor => this.toggleAtCursor(editor, type) });
    }
    this.addCommand({ id: 'show-heading-statistics', name: 'Show study progress for the current note', callback: () => this.showStatistics() });
    for (const [type, label] of [['unread', 'unread'], ['missing', 'Missing / Extra']]) {
      this.addCommand({ id: type === 'unread' ? 'jump-to-next-unread' : 'jump-to-next-missing',
        name: `Jump to the next ${label} heading`, editorCallback: editor => this.jump(editor, type) });
    }
    this.addSettingTab(new HeadingStatusSettings(this.app, this));
    const changed = () => this.scheduleRefresh();
    this.registerEvent(this.app.workspace.on('editor-change', changed));
    this.registerEvent(this.app.workspace.on('active-leaf-change', changed));
    this.registerEvent(this.app.workspace.on('layout-change', () => { this.scheduleReconcile(); this.scheduleRefresh(); }));
    this.registerEvent(this.app.workspace.on('file-open', () => { this.scheduleReconcile(); this.scheduleRefresh(); }));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file.extension !== 'md' || !this.openMarkdownViews().some(view => view.file?.path === file.path)) return;
      this.scheduleReconcile();
      this.scheduleRefresh();
    }));
    this.updateStatusBarVisibility();
    this.app.workspace.onLayoutReady(() => { if (!this.unloaded) { this.scheduleReconcile(); this.scheduleRefresh(); } });
  }
  onunload() {
    this.unloaded = true;
    clearTimeout(this.reconcileTimer);
    clearTimeout(this.refreshTimer);
    this.statusRequest++;
  }
  reportError(error) {
    console.error('Heading Status Tracker:', error);
    if (!this.unloaded) new Notice('Heading Status Tracker could not update this note. Please try again.');
  }
  openMarkdownViews() {
    const views = [];
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof MarkdownView && leaf.view.file) views.push(leaf.view); });
    return views;
  }
  editingView(file) {
    return this.openMarkdownViews().find(view => view.file?.path === file.path && view.getMode() === 'source');
  }
  async noteText(file) {
    const view = this.editingView(file);
    return view ? view.editor.getValue() : this.app.vault.cachedRead(file);
  }
  queueFile(file, callback) {
    const key = file.path;
    const operation = (this.fileQueues.get(key) || Promise.resolve()).catch(() => {}).then(() => {
      if (!this.unloaded) return callback();
    });
    this.fileQueues.set(key, operation);
    operation.finally(() => { if (this.fileQueues.get(key) === operation) this.fileQueues.delete(key); }).catch(() => {});
    return operation;
  }
  scheduleReconcile() {
    if (this.unloaded) return;
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => this.reconcileOpenNotes().catch(error => this.reportError(error)), 80);
  }
  async reconcileOpenNotes() {
    if (this.unloaded) return;
    const files = new Map();
    for (const view of this.openMarkdownViews()) files.set(view.file.path, view.file);
    for (const file of files.values()) {
      await this.queueFile(file, async () => {
        if (this.unloaded) return;
        const view = this.editingView(file);
        if (view) {
          const text = view.editor.getValue();
          const result = reconcile(text, this.settings);
          if (result.changes.length) this.applyEditorChanges(view.editor, result.changes, false);
        } else {
          const text = await this.app.vault.cachedRead(file);
          if (this.unloaded || !reconcile(text, this.settings).changes.length) return;
          // Recheck the open editor after the read to avoid overwriting newly unsaved work.
          if (this.editingView(file)) { this.scheduleReconcile(); return; }
          await this.app.vault.process(file, current => this.unloaded || this.editingView(file) ? current : reconcile(current, this.settings).text);
        }
      });
    }
    this.scheduleRefresh();
  }
  applyEditorChanges(editor, changes, history = true) {
    if (!changes.length) return;
    const view = [...this.editorViews].find(view => {
      const info = view.state.field(editorInfoField, false);
      return info?.editor === editor;
    });
    if (view) {
      view.dispatch({ changes, userEvent: 'input.heading-status', annotations: history
        ? isolateHistory.of('full') : Transaction.addToHistory.of(false) });
    } else {
      editor.transaction({ changes: changes.map(change => ({ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.insert })) });
    }
  }
  toggleEditor(view, line, type, expected) {
    const text = view.state.doc.toString();
    const heading = buildModel(text, this.settings).tracked.find(h => h.line === line);
    if (!sameHeading(heading, expected)) return;
    const result = toggleStatus(text, this.settings, line, type);
    if (result.changes.length) view.dispatch({ changes: result.changes, userEvent: 'input.heading-status', annotations: isolateHistory.of('full') });
    this.scheduleRefresh();
  }
  toggleAtCursor(editor, type) {
    const result = toggleStatus(editor.getValue(), this.settings, editor.getCursor().line, type);
    if (!result.found) { new Notice('Place the cursor on a tracked Markdown heading.'); return; }
    this.applyEditorChanges(editor, result.changes);
    this.scheduleRefresh();
  }
  toggleFile(file, line, type, expected) {
    return this.queueFile(file, async () => {
      const view = this.editingView(file);
      if (view) {
        const text = view.editor.getValue();
        const heading = buildModel(text, this.settings).tracked.find(h => h.line === line);
        if (sameHeading(heading, expected)) this.applyEditorChanges(view.editor, toggleStatus(text, this.settings, line, type).changes);
      } else {
        await this.app.vault.process(file, text => {
          if (this.unloaded || this.editingView(file)) return text;
          const heading = buildModel(text, this.settings).tracked.find(h => h.line === line);
          return sameHeading(heading, expected) ? toggleStatus(text, this.settings, line, type).text : text;
        });
      }
      this.scheduleRefresh();
    }).catch(error => this.reportError(error));
  }
  createStatusBadge(heading, toggle) {
    const container = document.createElement('span');
    container.className = 'heading-status-container';
    for (const [type, label, icon, text] of [
      ['read', 'Read', 'book-open', 'R'], ['written', 'Written', 'pencil', 'W'], ['missing', 'Missing / Extra', 'circle-alert', '!']
    ]) {
      if (type === 'missing' && !this.settings.showMissingButton) continue;
      const button = container.createEl('button', { cls: `heading-status-btn btn-${type} ${heading[type] ? 'is-active' : ''}` });
      button.type = 'button';
      const calculated = type === 'read' ? heading.calculatedRead : type === 'written' && heading.calculatedWritten;
      const action = heading[type] ? 'Clear' : 'Mark';
      button.title = calculated ? `${label}: Automatically calculated from subheadings. ${action} this section and all tracked subheadings.` : `${action} ${label}.`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(heading[type]));
      if (calculated) button.addClass('is-calculated');
      setIcon(button.createSpan({ cls: 'heading-status-icon' }), heading[type] && type !== 'missing' ? 'check' : icon);
      if (this.settings.showLabels) button.createSpan({ cls: 'heading-status-label', text });
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggle(type); });
    }
    return container;
  }
  scheduleRefresh() {
    if (this.unloaded) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.unloaded) return;
      this.updateStatusBar().catch(error => this.reportError(error));
      for (const badge of this.readingBadges) badge.refresh();
    }, 40);
  }
  updateStatusBarVisibility() {
    if (this.settings.showStatusBar && !this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass('heading-status-statusbar');
      this.registerDomEvent(this.statusBarItem, 'click', () => this.showStatistics());
    } else if (!this.settings.showStatusBar && this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
  }
  async updateStatusBar() {
    const request = ++this.statusRequest;
    const item = this.statusBarItem;
    if (!item) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { item.setText(''); return; }
    const text = await this.noteText(file);
    if (this.unloaded || request !== this.statusRequest || item !== this.statusBarItem) return;
    const stats = statistics(buildModel(text, this.settings));
    const percentage = count => Math.round(count / stats.total * 100);
    item.setText(stats.total ? `Read ${stats.read}/${stats.total} (${percentage(stats.read)}%) | Written ${stats.written}/${stats.total} (${percentage(stats.written)}%)${stats.missing.length ? ` | Missing / Extra ${stats.missing.length}` : ''}` : '');
  }
  jump(editor, type) {
    const headings = buildModel(editor.getValue(), this.settings).tracked;
    const matches = headings.filter(h => type === 'unread' ? !h.read : h.missing);
    if (!matches.length) { new Notice(type === 'unread' ? 'All tracked headings are Read.' : 'No headings are flagged Missing / Extra.'); return; }
    const next = matches.find(h => h.line > editor.getCursor().line) || matches[0];
    this.goToHeading(editor, next.line);
  }
  goToHeading(editor, line) {
    const position = { line, ch: 0 };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position }, true);
  }
  async showStatistics() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('Open a Markdown note to view study progress.'); return; }
    try { new ProgressModal(this.app, this, file, await this.noteText(file)).open(); }
    catch (error) { this.reportError(error); }
  }
  async saveSettings() {
    this.settings = settingsWithDefaults(this.settings);
    await this.saveData(this.settings);
    this.generation++;
    this.updateStatusBarVisibility();
    for (const view of this.editorViews) view.dispatch({ effects: refreshEffect.of(this.generation) });
    this.scheduleReconcile();
    this.scheduleRefresh();
  }
}

class ProgressModal extends Modal {
  constructor(app, plugin, file, text) { super(app); Object.assign(this, { plugin, file, text }); }
  onOpen() {
    const content = this.contentEl;
    content.empty(); content.addClass('heading-status-modal');
    content.createEl('h2', { text: `Study progress: ${this.file.basename}` });
    const stats = statistics(buildModel(this.text, this.plugin.settings));
    const grid = content.createDiv({ cls: 'heading-status-stats-grid' });
    for (const [label, count, cls] of [['Read', stats.read, 'read'], ['Written', stats.written, 'written'], ['Missing / Extra', stats.missing.length, 'missing']]) {
      const card = grid.createDiv({ cls: `heading-status-card heading-status-card-${cls}` });
      card.createDiv({ text: label });
      card.createDiv({ cls: 'heading-status-card-val', text: cls === 'missing' ? String(count) : `${count} / ${stats.total} (${stats.total ? Math.round(count / stats.total * 100) : 0}%)` });
    }
    if (!stats.total) content.createEl('p', { text: 'This note has no tracked Markdown headings.' });
    if (stats.missing.length) {
      content.createEl('h3', { text: 'Missing / Extra headings' });
      const list = content.createDiv({ cls: 'heading-status-missing-list' });
      for (const heading of stats.missing) {
        const button = list.createEl('button', { cls: 'heading-status-missing-item', text: `${heading.title} — line ${heading.line + 1}` });
        button.type = 'button';
        button.addEventListener('click', async () => {
          this.close();
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(this.file, { state: { mode: 'source' } });
          if (!(leaf.view instanceof MarkdownView)) return;
          const current = buildModel(leaf.view.editor.getValue(), this.plugin.settings).tracked.find(h => h.line === heading.line);
          if (sameHeading(current, heading)) this.plugin.goToHeading(leaf.view.editor, current.line);
        });
      }
    } else content.createEl('p', { text: 'No headings are flagged Missing / Extra.' });
  }
  onClose() { this.contentEl.empty(); }
}

class HeadingStatusSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const container = this.containerEl;
    container.empty();
    const toggle = (key, name, description) => new Setting(container).setName(name).setDesc(description).addToggle(control => control
      .setValue(this.plugin.settings[key]).onChange(async value => { this.plugin.settings[key] = value; await this.plugin.saveSettings(); }));
    toggle('autoParentRead', 'Automatically update parent Read status', 'Keep parents synchronized with their tracked subheadings. Clicking a parent marks or clears Read throughout its section. Enabled by default.');
    toggle('autoParentWritten', 'Automatically update parent Written status', 'Keep parents synchronized with their tracked subheadings. Clicking a parent marks or clears Written throughout its section. Enabled by default.');
    new Setting(container).setName('Button position').setDesc('Choose where status buttons appear beside headings.').addDropdown(control => control
      .addOption('after', 'After the heading').addOption('before', 'Before the heading').setValue(this.plugin.settings.position)
      .onChange(async value => { this.plugin.settings.position = value; await this.plugin.saveSettings(); }));
    toggle('showMissingButton', 'Show Missing / Extra button', 'Show the button used to flag topics for additional study. Hiding it preserves existing flags.');
    toggle('showLabels', 'Show button labels', 'Display R, W, and ! beside the status icons.');
    toggle('highlightMissingHeading', 'Highlight Missing / Extra headings', 'Show an amber border beside flagged headings.');
    toggle('showStatusBar', 'Show progress in the status bar', 'Display progress for the current note in the desktop status bar.');
    new Setting(container).setName('Tracked heading levels').setHeading();
    container.createEl('p', { cls: 'setting-item-description', text: 'Only selected levels contribute to progress and parent completion. Other headings still define section boundaries.' });
    for (let level = 1; level <= 6; level++) new Setting(container).setName(`Heading ${level} (H${level})`).addToggle(control => control
      .setValue(this.plugin.settings.enabledLevels.includes(level)).onChange(async enabled => {
        this.plugin.settings.enabledLevels = enabled ? [...this.plugin.settings.enabledLevels, level] : this.plugin.settings.enabledLevels.filter(item => item !== level);
        await this.plugin.saveSettings();
      }));
  }
}

module.exports = HeadingStatusTracker;
