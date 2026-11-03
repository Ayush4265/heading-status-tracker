"use strict";

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  Modal,
  setIcon
} = require("obsidian");

// Safe CodeMirror 6 module resolution
let cmView = null;
let cmState = null;
try {
  cmView = require("@codemirror/view");
  cmState = require("@codemirror/state");
} catch (e) {
  console.warn("Heading Status Tracker: @codemirror modules could not be directly loaded.", e);
}

const DEFAULT_SETTINGS = {
  showMissingButton: true,
  enabledLevels: [1, 2, 3, 4, 5, 6],
  showLabels: true,
  position: "after", // "after" (default) or "before"
  highlightMissingHeading: true,
  showStatusBar: true
};

// Regex patterns
const HEADING_LINE_REGEX = /^(#{1,6})(\s+)(.*)$/;
// Matches <!-- [x][ ][!] --> or <!-- [x][ ] -->
const STATUS_REGEX = /<!--\s*\[([ xX])\]\[([ xX])\](?:\[([ xX!])\])?\s*-->/;

function parseHeadingLine(lineText) {
  const match = HEADING_LINE_REGEX.exec(lineText);
  if (!match) return null;

  const level = match[1].length;
  const wsLen = match[2].length;
  const fullContent = match[3];
  const statusMatch = STATUS_REGEX.exec(fullContent);

  let read = false;
  let written = false;
  let missing = false;
  let title = fullContent;
  let commentStart = -1;
  let commentEnd = -1;

  if (statusMatch) {
    read = statusMatch[1].toLowerCase() === "x";
    written = statusMatch[2].toLowerCase() === "x";
    missing = statusMatch[3] ? (statusMatch[3] === "!" || statusMatch[3].toLowerCase() === "x") : false;
    title = fullContent.replace(statusMatch[0], "").trim();
    commentStart = level + wsLen + statusMatch.index;
    commentEnd = commentStart + statusMatch[0].length;
  }

  return {
    isHeading: true,
    level,
    wsLen,
    read,
    written,
    missing,
    hasStatus: !!statusMatch,
    title,
    commentStart,
    commentEnd
  };
}

function updateHeadingLineStatus(lineText, newRead, newWritten, newMissing, includeMissing) {
  const match = HEADING_LINE_REGEX.exec(lineText);
  if (!match) return lineText;

  const hashes = match[1];
  const ws = match[2];
  const content = match[3];
  const statusMatch = STATUS_REGEX.exec(content);

  const rChar = newRead ? "x" : " ";
  const wChar = newWritten ? "x" : " ";
  const mChar = newMissing ? "!" : " ";

  const newComment = (includeMissing || newMissing || (statusMatch && statusMatch[3] !== undefined))
    ? `<!-- [${rChar}][${wChar}][${mChar}] -->`
    : `<!-- [${rChar}][${wChar}] -->`;

  if (statusMatch) {
    const updatedContent = content.replace(statusMatch[0], newComment);
    return `${hashes}${ws}${updatedContent}`;
  } else {
    return `${hashes}${ws}${content.trim()} ${newComment}`;
  }
}

class HeadingStatusTrackerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Register View Extensions
    this.registerReadingViewProcessor();
    this.statusEventsRegistered = false;
    this.registerLivePreviewExtension();

    // Register Status Bar
    if (this.settings.showStatusBar) {
      this.initStatusBar();
    }

    // Register Commands
    this.addCommand({
      id: "toggle-read-status",
      name: "Toggle 'Read' status on current heading",
      editorCallback: (editor) => this.toggleHeadingStatusAtCursor(editor, "read")
    });

    this.addCommand({
      id: "toggle-written-status",
      name: "Toggle 'Written' status on current heading",
      editorCallback: (editor) => this.toggleHeadingStatusAtCursor(editor, "written")
    });

    this.addCommand({
      id: "toggle-missing-status",
      name: "Toggle 'Missing / Extra' status on current heading",
      editorCallback: (editor) => this.toggleHeadingStatusAtCursor(editor, "missing")
    });

    this.addCommand({
      id: "show-heading-statistics",
      name: "Show study progress statistics for active note",
      callback: () => this.showStatisticsModal()
    });

    this.addCommand({
      id: "jump-to-next-unread",
      name: "Jump to next unread topic",
      editorCallback: (editor) => this.jumpToNextStatus(editor, "unread")
    });

    this.addCommand({
      id: "jump-to-next-missing",
      name: "Jump to next missing / extra topic",
      editorCallback: (editor) => this.jumpToNextStatus(editor, "missing")
    });

    // Add Settings Tab
    this.addSettingTab(new HeadingStatusSettingTab(this.app, this));
  }

  // --- Reading View Markdown Post Processor ---
  registerReadingViewProcessor() {
    this.registerMarkdownPostProcessor((element, context) => {
      const headings = element.querySelectorAll("h1, h2, h3, h4, h5, h6");
      if (!headings.length) return;

      const activeFile = this.app.vault.getFileByPath(context.sourcePath);
      if (!activeFile) return;

      headings.forEach((headingEl) => {
        if (headingEl.querySelector(".heading-status-container")) return;

        const level = parseInt(headingEl.tagName.substring(1), 10);
        if (!this.settings.enabledLevels.includes(level)) return;

        const headingText = headingEl.innerText.trim();
        const sectionInfo = context.getSectionInfo ? context.getSectionInfo(headingEl) : null;

        this.app.vault.cachedRead(activeFile).then((content) => {
          const lines = content.split("\n");
          let targetLineIndex = -1;
          let parsed = null;

          if (sectionInfo && sectionInfo.lineStart >= 0 && sectionInfo.lineStart < lines.length) {
            const p = parseHeadingLine(lines[sectionInfo.lineStart]);
            if (p && p.level === level) {
              targetLineIndex = sectionInfo.lineStart;
              parsed = p;
            }
          }

          if (targetLineIndex === -1 || !parsed) return;

          const badge = this.createStatusBadge(parsed, async (type) => {
            await this.app.vault.process(activeFile, (fileContent) => {
              const fileLines = fileContent.split("\n");
              if (targetLineIndex < 0 || targetLineIndex >= fileLines.length) return fileContent;

              const curParsed = parseHeadingLine(fileLines[targetLineIndex]);
              if (!curParsed || curParsed.title !== parsed.title || curParsed.level !== parsed.level) return fileContent;
              const newR = type === "read" ? !curParsed.read : curParsed.read;
              const newW = type === "written" ? !curParsed.written : curParsed.written;
              const newM = type === "missing" ? !curParsed.missing : curParsed.missing;

              fileLines[targetLineIndex] = updateHeadingLineStatus(
                fileLines[targetLineIndex],
                newR,
                newW,
                newM,
                this.settings.showMissingButton
              );
              return fileLines.join("\n");
            });

            this.updateStatusBar();
          });

          // Position badge before or after
          if (this.settings.position === "before") {
            badge.addClass("pos-before");
            headingEl.prepend(badge);
          } else {
            badge.addClass("pos-after");
            headingEl.appendChild(badge);
          }

          if (this.settings.highlightMissingHeading && parsed.missing) {
            headingEl.addClass("has-missing-extra");
          } else {
            headingEl.removeClass("has-missing-extra");
          }
        });
      });
    });
  }

  // --- Live Preview CodeMirror 6 Extension ---
  registerLivePreviewExtension() {
    if (!cmView || !cmState) return;

    const plugin = this;

    class HeadingStatusWidget extends cmView.WidgetType {
      constructor(lineNo, parsed, position) {
        super();
        this.lineNo = lineNo;
        this.parsed = parsed;
        this.position = position || "after";
      }

      eq(other) {
        return (
          other.lineNo === this.lineNo &&
          other.position === this.position &&
          other.parsed.read === this.parsed.read &&
          other.parsed.written === this.parsed.written &&
          other.parsed.missing === this.parsed.missing
        );
      }

      toDOM(view) {
        const container = plugin.createStatusBadge(this.parsed, (type) => {
          let lineNo = this.lineNo;
          try {
            const pos = view.posAtDOM(container);
            if (pos !== null && pos !== undefined) {
              lineNo = view.state.doc.lineAt(pos).number;
            }
          } catch (e) {
            // Fallback to cached lineNo
          }

          const doc = view.state.doc;
          if (lineNo < 1 || lineNo > doc.lines) return;

          const line = doc.line(lineNo);
          const curParsed = parseHeadingLine(line.text) || this.parsed;

          const newR = type === "read" ? !curParsed.read : curParsed.read;
          const newW = type === "written" ? !curParsed.written : curParsed.written;
          const newM = type === "missing" ? !curParsed.missing : curParsed.missing;

          const updatedLineText = updateHeadingLineStatus(
            line.text,
            newR,
            newW,
            newM,
            plugin.settings.showMissingButton
          );

          view.dispatch({
            changes: { from: line.from, to: line.to, insert: updatedLineText },
            userEvent: "heading-status.toggle"
          });

          plugin.updateStatusBar();
        });

        container.addClass(this.position === "before" ? "pos-before" : "pos-after");
        return container;
      }

      ignoreEvent(event) {
        return event.type === "click" || event.type === "mousedown";
      }
    }

    const livePreviewPlugin = cmView.ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = this.buildDecorations(view);
        }

        update(update) {
          if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = this.buildDecorations(update.view);
          }
        }

        buildDecorations(view) {
          const builder = new cmState.RangeSetBuilder();
          const doc = view.state.doc;
          const posSetting = plugin.settings.position || "after";

          for (const { from, to } of view.visibleRanges) {
            const startLine = doc.lineAt(from).number;
            const endLine = doc.lineAt(to).number;

            for (let l = startLine; l <= endLine; l++) {
              const line = doc.line(l);
              const parsed = parseHeadingLine(line.text);
              if (!parsed || !plugin.settings.enabledLevels.includes(parsed.level)) {
                continue;
              }

              if (posSetting === "after") {
                // Ticks appear AFTER the heading text
                if (parsed.hasStatus && parsed.commentStart >= 0) {
                  let hideFrom = line.from + parsed.commentStart;
                  if (hideFrom > line.from && line.text[parsed.commentStart - 1] === " ") {
                    hideFrom--;
                  }
                  const hideTo = line.from + parsed.commentEnd;
                  if (hideTo <= line.to && hideFrom < hideTo) {
                    builder.add(
                      hideFrom,
                      hideTo,
                      cmView.Decoration.replace({
                        widget: new HeadingStatusWidget(l, parsed, "after")
                      })
                    );
                  }
                } else {
                  // No status comment yet: place widget at the end of the line
                  builder.add(
                    line.to,
                    line.to,
                    cmView.Decoration.widget({
                      widget: new HeadingStatusWidget(l, parsed, "after"),
                      side: 1
                    })
                  );
                }
              } else {
                // Ticks appear BEFORE the heading text
                const widgetPos = line.from + parsed.level + parsed.wsLen;
                builder.add(
                  widgetPos,
                  widgetPos,
                  cmView.Decoration.widget({
                    widget: new HeadingStatusWidget(l, parsed, "before"),
                    side: 1
                  })
                );

                if (parsed.hasStatus && parsed.commentStart >= 0) {
                  let hideFrom = line.from + parsed.commentStart;
                  if (hideFrom > line.from && line.text[parsed.commentStart - 1] === " ") {
                    hideFrom--;
                  }
                  const hideTo = line.from + parsed.commentEnd;
                  if (hideTo <= line.to && hideFrom < hideTo && hideFrom >= widgetPos) {
                    builder.add(hideFrom, hideTo, cmView.Decoration.replace({}));
                  }
                }
              }
            }
          }

          return builder.finish();
        }
      },
      {
        decorations: (v) => v.decorations
      }
    );

    this.registerEditorExtension(livePreviewPlugin);
  }

  // --- Badge DOM Factory ---
  createStatusBadge(parsed, onToggle) {
    const container = document.createElement("span");
    container.className = "heading-status-container";

    // Button 1: Read
    const readBtn = document.createElement("button");
    readBtn.className = `heading-status-btn btn-read ${parsed.read ? "is-active" : ""}`;
    readBtn.title = parsed.read ? "Topic Read (Click to unmark)" : "Mark as read";
    setIcon(readBtn.createSpan({ cls: "heading-status-icon" }), parsed.read ? "check" : "square");
    if (this.settings.showLabels) readBtn.createSpan({ cls: "heading-status-label", text: "R" });
    readBtn.setAttribute("aria-label", readBtn.title);
    readBtn.setAttribute("aria-pressed", String(parsed.read));
    readBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle("read");
    });
    container.appendChild(readBtn);

    // Button 2: Written
    const writeBtn = document.createElement("button");
    writeBtn.className = `heading-status-btn btn-written ${parsed.written ? "is-active" : ""}`;
    writeBtn.title = parsed.written ? "Notes Written (Click to unmark)" : "Mark as Written in Notes";
    setIcon(writeBtn.createSpan({ cls: "heading-status-icon" }), parsed.written ? "check" : "pencil");
    if (this.settings.showLabels) writeBtn.createSpan({ cls: "heading-status-label", text: "W" });
    writeBtn.setAttribute("aria-label", writeBtn.title);
    writeBtn.setAttribute("aria-pressed", String(parsed.written));
    writeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle("written");
    });
    container.appendChild(writeBtn);

    // Button 3: Missing / Extra to read (Optional)
    if (this.settings.showMissingButton) {
      const missBtn = document.createElement("button");
      missBtn.className = `heading-status-btn btn-missing ${parsed.missing ? "is-active" : ""}`;
      missBtn.title = parsed.missing ? "Flagged as Missing/Extra (Click to clear)" : "Flag as Missing / Extra to read";
      setIcon(missBtn.createSpan({ cls: "heading-status-icon" }), "circle-alert");
    if (this.settings.showLabels) missBtn.createSpan({ cls: "heading-status-label", text: "!" });
    missBtn.setAttribute("aria-label", missBtn.title);
    missBtn.setAttribute("aria-pressed", String(parsed.missing));
      missBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle("missing");
      });
      container.appendChild(missBtn);
    }

    return container;
  }

  // --- Toggle via Hotkey / Command at Cursor ---
  toggleHeadingStatusAtCursor(editor, type) {
    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line);
    const parsed = parseHeadingLine(lineText);

    if (!parsed) {
      new Notice("Place cursor on a heading to toggle status.");
      return;
    }

    const newR = type === "read" ? !parsed.read : parsed.read;
    const newW = type === "written" ? !parsed.written : parsed.written;
    const newM = type === "missing" ? !parsed.missing : parsed.missing;

    const updated = updateHeadingLineStatus(
      lineText,
      newR,
      newW,
      newM,
      this.settings.showMissingButton
    );

    editor.setLine(cursor.line, updated);
    this.updateStatusBar();
  }

  // --- Jump to Next Unread / Missing Topic ---
  jumpToNextStatus(editor, type) {
    const doc = editor.getValue();
    const lines = doc.split("\n");
    const currentLine = editor.getCursor().line;

    for (let i = currentLine + 1; i < lines.length; i++) {
      const parsed = parseHeadingLine(lines[i]);
      if (parsed && this.settings.enabledLevels.includes(parsed.level)) {
        if ((type === "unread" && !parsed.read) || (type === "missing" && parsed.missing)) {
          editor.setCursor({ line: i, ch: 0 });
          editor.scrollIntoView({ from: { line: i, ch: 0 }, to: { line: i, ch: 0 } }, true);
          new Notice(`Jumped to: ${parsed.title}`);
          return;
        }
      }
    }

    // Wrap around search
    for (let i = 0; i <= currentLine; i++) {
      const parsed = parseHeadingLine(lines[i]);
      if (parsed && this.settings.enabledLevels.includes(parsed.level)) {
        if ((type === "unread" && !parsed.read) || (type === "missing" && parsed.missing)) {
          editor.setCursor({ line: i, ch: 0 });
          editor.scrollIntoView({ from: { line: i, ch: 0 }, to: { line: i, ch: 0 } }, true);
          new Notice(`Jumped to (top): ${parsed.title}`);
          return;
        }
      }
    }

    new Notice(type === "unread" ? "All topics in this note are marked Read!" : "No topics flagged as Missing/Extra!");
  }

  // --- Status Bar ---
  initStatusBar() {
    if (this.statusBarItem) return;
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("heading-status-statusbar");
    this.statusBarItem.addEventListener("click", () => this.showStatisticsModal());

    if (!this.statusEventsRegistered) {
    this.statusEventsRegistered = true;
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.updateStatusBar())
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.updateStatusBar())
    );
    }

    this.updateStatusBar();
  }

  async updateStatusBar() {
    if (!this.statusBarItem) return;

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      this.statusBarItem.setText("");
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const lines = content.split("\n");

    let total = 0;
    let readCount = 0;
    let writtenCount = 0;
    let missingCount = 0;

    for (const line of lines) {
      const parsed = parseHeadingLine(line);
      if (parsed && this.settings.enabledLevels.includes(parsed.level)) {
        total++;
        if (parsed.read) readCount++;
        if (parsed.written) writtenCount++;
        if (parsed.missing) missingCount++;
      }
    }

    if (total === 0) {
      this.statusBarItem.setText("");
      return;
    }

    const readPct = Math.round((readCount / total) * 100);
    const writePct = Math.round((writtenCount / total) * 100);

    let statusText = `📖 ${readCount}/${total} (${readPct}%) | ✍️ ${writtenCount}/${total} (${writePct}%)`;
    if (missingCount > 0) {
      statusText += ` | ⚠️ ${missingCount} Missing`;
    }

    this.statusBarItem.setText(statusText);
  }

  // --- Statistics Modal ---
  async showStatisticsModal() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active markdown note.");
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    new HeadingStatusStatsModal(this.app, file.basename, content, this).open();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.updateStatusBar();
  }
}

// --- Statistics Modal Class ---
class HeadingStatusStatsModal extends Modal {
  constructor(app, noteName, content, plugin) {
    super(app);
    this.noteName = noteName;
    this.content = content;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("heading-status-modal");

    contentEl.createEl("h2", { text: `Study Progress: ${this.noteName}` });

    const lines = this.content.split("\n");
    let total = 0;
    let readCount = 0;
    let writtenCount = 0;
    let missingList = [];

    for (let i = 0; i < lines.length; i++) {
      const parsed = parseHeadingLine(lines[i]);
      if (parsed && this.plugin.settings.enabledLevels.includes(parsed.level)) {
        total++;
        if (parsed.read) readCount++;
        if (parsed.written) writtenCount++;
        if (parsed.missing) {
          missingList.push({ line: i, title: parsed.title, level: parsed.level });
        }
      }
    }

    const readPct = total > 0 ? Math.round((readCount / total) * 100) : 0;
    const writePct = total > 0 ? Math.round((writtenCount / total) * 100) : 0;

    // Stat cards
    const grid = contentEl.createDiv({ cls: "heading-status-stats-grid" });

    const readCard = grid.createDiv({ cls: "heading-status-card heading-status-card-read" });
    readCard.createDiv({ text: "Topics read" });
    readCard.createDiv({ cls: "heading-status-card-val", text: `${readCount} / ${total} (${readPct}%)` });

    const writeCard = grid.createDiv({ cls: "heading-status-card heading-status-card-written" });
    writeCard.createDiv({ text: "Notes Written" });
    writeCard.createDiv({ cls: "heading-status-card-val", text: `${writtenCount} / ${total} (${writePct}%)` });

    const missCard = grid.createDiv({ cls: "heading-status-card heading-status-card-missing" });
    missCard.createDiv({ text: "Missing / Extra" });
    missCard.createDiv({ cls: "heading-status-card-val", text: `${missingList.length}` });

    // Missing Items List
    if (missingList.length > 0) {
      contentEl.createEl("h4", { text: "Topics Flagged as Missing / Extra:" });
      const listEl = contentEl.createDiv({ cls: "heading-status-missing-list" });

      missingList.forEach((item) => {
        const itemEl = listEl.createDiv({ cls: "heading-status-missing-item" });
        itemEl.createSpan({ text: `${"#".repeat(item.level)} ${item.title}` });
        const lineBadge = itemEl.createSpan({ text: `Line ${item.line + 1}`, cls: "text-muted" });

        itemEl.addEventListener("click", () => {
          this.close();
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view && view.editor) {
            view.editor.setCursor({ line: item.line, ch: 0 });
            view.editor.scrollIntoView({ from: { line: item.line, ch: 0 }, to: { line: item.line, ch: 0 } }, true);
          }
        });
      });
    } else {
      contentEl.createEl("p", {
        text: "✨ No topics currently flagged as missing or needing extra reading.",
        cls: "text-muted"
      });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// --- Settings Tab ---
class HeadingStatusSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Heading Status Tracker Settings" });

    new Setting(containerEl)
      .setName("Position")
      .setDesc("Display ticks after the heading text (recommended) or before.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("after", "After Heading (e.g. Topic Name [R] [W] [!])")
          .addOption("before", "Before Heading (e.g. [R] [W] [!] Topic Name)")
          .setValue(this.plugin.settings.position || "after")
          .onChange(async (val) => {
            this.plugin.settings.position = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show 'Missing / Extra' Button")
      .setDesc("Adds a third amber button (!) beside headings to flag topics missing from notes or requiring extra reading.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showMissingButton).onChange(async (val) => {
          this.plugin.settings.showMissingButton = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Button Labels (R, W, !)")
      .setDesc("Displays compact letters inside the buttons beside the icons.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showLabels).onChange(async (val) => {
          this.plugin.settings.showLabels = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Highlight Missing Headings")
      .setDesc("Displays an amber indicator bar on headings marked as missing or extra.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.highlightMissingHeading).onChange(async (val) => {
          this.plugin.settings.highlightMissingHeading = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Status Bar Study Progress")
      .setDesc("Shows a study progress overview in the bottom status bar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (val) => {
          this.plugin.settings.showStatusBar = val;
          await this.plugin.saveSettings();
          if (val) {
            this.plugin.initStatusBar();
          } else if (this.plugin.statusBarItem) {
            this.plugin.statusBarItem.remove();
            this.plugin.statusBarItem = null;
          }
        })
      );

    containerEl.createEl("h3", { text: "Active Heading Levels" });
    containerEl.createEl("p", {
      text: "Select which heading levels display status ticks:",
      cls: "setting-item-description"
    });

    for (let lvl = 1; lvl <= 6; lvl++) {
      new Setting(containerEl)
        .setName(`Heading ${lvl} (H${lvl})`)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enabledLevels.includes(lvl)).onChange(async (val) => {
            if (val) {
              if (!this.plugin.settings.enabledLevels.includes(lvl)) {
                this.plugin.settings.enabledLevels.push(lvl);
              }
            } else {
              this.plugin.settings.enabledLevels = this.plugin.settings.enabledLevels.filter((x) => x !== lvl);
            }
            await this.plugin.saveSettings();
          })
        );
    }
  }
}

module.exports = HeadingStatusTrackerPlugin;
