const { EditorState, StateEffect } = require('@codemirror/state');
const { ViewPlugin, WidgetType, Decoration } = require('@codemirror/view');
const { editorLivePreviewField } = require('obsidian');
const { buildModel, reconcile } = require('./model.cjs');

const refreshEffect = StateEffect.define();

function createEditorExtensions(plugin) {
  const filter = EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged) return transaction;
    const result = reconcile(transaction.newDoc.toString(), plugin.settings);
    return result.changes.length ? [transaction, { changes: result.changes, sequential: true }] : transaction;
  });

  class StatusWidget extends WidgetType {
    constructor(heading, generation) { super(); this.heading = heading; this.generation = generation; }
    eq(other) {
      const a = this.heading, b = other.heading;
      return this.generation === other.generation && a.from === b.from && a.text === b.text &&
        a.read === b.read && a.written === b.written && a.missing === b.missing &&
        !!a.calculatedRead === !!b.calculatedRead && !!a.calculatedWritten === !!b.calculatedWritten;
    }
    toDOM(view) {
      const container = plugin.createStatusBadge(this.heading, type => {
        let position;
        try { position = view.posAtDOM(container); } catch { return; }
        const current = view.state.doc.lineAt(position);
        plugin.toggleEditor(view, current.number - 1, type, this.heading);
      });
      container.addClass(plugin.settings.position === 'before' ? 'pos-before' : 'pos-after');
      return container;
    }
    ignoreEvent(event) { return event.type === 'mousedown' || event.type === 'click'; }
  }

  const decorationPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      plugin.editorViews.add(view);
      this.decorations = this.build(view);
      // Existing notes are normalized outside the constructor/update cycle.
      plugin.scheduleReconcile();
    }
    destroy() { plugin.editorViews.delete(this.view); }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet ||
          update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false) ||
          update.transactions.some(tr => tr.reconfigured || tr.effects.some(effect => effect.is(refreshEffect)))) {
        this.decorations = this.build(update.view);
      }
    }
    build(view) {
      // Source mode retains editable comments and uses commands for status changes.
      if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
      const model = buildModel(view.state.doc.toString(), plugin.settings);
      const ranges = [];
      for (const heading of model.tracked) {
        if (!view.visibleRanges.some(range => heading.to >= range.from && heading.from <= range.to)) continue;
        if (heading.missing && plugin.settings.highlightMissingHeading) {
          ranges.push(Decoration.line({ class: 'heading-status-missing-line' }).range(heading.from));
        }
        const widget = new StatusWidget(heading, plugin.generation);
        const match = heading.match;
        if (plugin.settings.position === 'before') {
          ranges.push(Decoration.widget({ widget, side: -1 }).range(heading.from + heading.prefixLength));
          if (match) ranges.push(Decoration.replace({}).range(heading.from + match.index, heading.from + match.index + match[0].length));
        } else if (match) {
          ranges.push(Decoration.replace({ widget }).range(heading.from + match.index, heading.from + match.index + match[0].length));
        } else {
          const closing = /[ \t]+#+[ \t]*$/.exec(heading.text);
          ranges.push(Decoration.widget({ widget, side: 1 }).range(closing ? heading.from + closing.index : heading.to));
        }
      }
      return Decoration.set(ranges, true);
    }
  }, { decorations: value => value.decorations });
  return [filter, decorationPlugin];
}

module.exports = { createEditorExtensions, refreshEffect };
