const { parser } = require('@lezer/markdown');

const DEFAULT_SETTINGS = Object.freeze({
  showMissingButton: true,
  enabledLevels: [1, 2, 3, 4, 5, 6],
  showLabels: true,
  position: 'after',
  highlightMissingHeading: true,
  showStatusBar: true,
  autoParentRead: true,
  autoParentWritten: true
});
const STATUS = /<!--\s*\[([ xX])\]\[([ xX])\](?:\[([ xX!])\])?\s*-->/;

function settingsWithDefaults(saved = {}) {
  // Obsidian returns null until this plugin has saved settings for the first time.
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  settings.enabledLevels = Array.isArray(saved.enabledLevels)
    ? [...new Set(saved.enabledLevels.filter(level => Number.isInteger(level) && level >= 1 && level <= 6))]
    : [...DEFAULT_SETTINGS.enabledLevels];
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof settings[key] !== 'boolean') settings[key] = DEFAULT_SETTINGS[key];
  }
  if (!['before', 'after'].includes(settings.position)) settings.position = 'after';
  return settings;
}

const blank = text => text.replace(/[^\r\n]/g, ' ');

function visibleMarkdown(text) {
  // Mask rather than remove excluded text, keeping all source positions intact.
  let masked = text.replace(/^(?:\uFEFF)?---[^\S\r\n]*\r?\n[\s\S]*?(?:^(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)|(?![\s\S]))/m,
    (match, offset) => offset === 0 ? blank(match) : match);
  const code = [];
  parser.parse(masked).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) { code.push([node.from, node.to]); return false; }
  }});
  let from = 0;
  const chars = masked.split('');
  while ((from = masked.indexOf('%%', from)) !== -1) {
    const protectedRange = code.find(([start, end]) => from >= start && from < end);
    if (protectedRange) { from = protectedRange[1]; continue; }
    const close = masked.indexOf('%%', from + 2);
    const end = close < 0 ? masked.length : close + 2;
    for (let i = from; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    from = end;
  }
  return chars.join('');
}

function lineTable(text) {
  const lines = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = re.exec(text)) && (match[0] || lines.length === 0)) {
    lines.push({ from: match.index, to: match.index + match[1].length, text: match[1], eol: match[2] });
    if (!match[2]) break;
  }
  return lines;
}

function parseStatus(line) {
  const match = STATUS.exec(line);
  return { read: !!match && /x/i.test(match[1]), written: !!match && /x/i.test(match[2]),
    missing: !!match && /[x!]/i.test(match[3] || ''), match };
}

function writeStatus(line, status, showMissing) {
  const old = STATUS.exec(line);
  const third = showMissing || status.missing || (old && old[3] !== undefined);
  const comment = `<!-- [${status.read ? 'x' : ' '}][${status.written ? 'x' : ' '}]${third ? `[${status.missing ? '!' : ' '}]` : ''} -->`;
  if (old) return line.slice(0, old.index) + comment + line.slice(old.index + old[0].length);
  // Do not disturb closing hashes, hard-break spaces, or indentation.
  const closing = /[ \t]+#+[ \t]*$/.exec(line);
  const trailing = /[ \t]*$/.exec(line);
  const at = closing ? closing.index : trailing.index;
  return line.slice(0, at) + ' ' + comment + line.slice(at);
}

function buildModel(text, inputSettings) {
  const settings = settingsWithDefaults(inputSettings);
  const lines = lineTable(text);
  const masked = visibleMarkdown(text);
  const headings = [];
  let lineIndex = 0;
  // Only document-level headings are tracked; quoted/list examples stay untouched.
  for (let node = parser.parse(masked).topNode.firstChild; node; node = node.nextSibling) {
    const kind = /^(ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!kind) continue;
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1].from <= node.from) lineIndex++;
    const line = lines[lineIndex];
    const level = Number(kind[2]);
    const status = parseStatus(line.text);
    const prefix = /^( {0,3}#{1,6})(?:[ \t]+|$)/.exec(line.text);
    const tracked = kind[1] === 'ATX' && !!prefix && settings.enabledLevels.includes(level);
    const title = line.text.replace(STATUS, '').replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
    headings.push({ ...line, line: lineIndex, level, title, tracked, ...status,
      prefixLength: prefix ? prefix[0].length : 0, end: text.length, descendants: [], parent: null });
  }
  const stack = [];
  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop().end = heading.from;
    heading.parent = stack[stack.length - 1] || null;
    stack.push(heading);
  }
  // Fold aggregates upward in linear time, including across untracked levels.
  for (let i = headings.length - 1; i >= 0; i--) {
    const heading = headings[i];
    heading.calculatedRead = heading.tracked && heading.descendantCount > 0 && settings.autoParentRead;
    heading.calculatedWritten = heading.tracked && heading.descendantCount > 0 && settings.autoParentWritten;
    if (heading.calculatedRead) heading.read = heading.allRead;
    if (heading.calculatedWritten) heading.written = heading.allWritten;
    if (heading.parent) {
      const parent = heading.parent;
      parent.descendantCount = (parent.descendantCount || 0) + (heading.descendantCount || 0) + (heading.tracked ? 1 : 0);
      parent.allRead = (parent.allRead ?? true) && (heading.allRead ?? true) && (!heading.tracked || heading.read);
      parent.allWritten = (parent.allWritten ?? true) && (heading.allWritten ?? true) && (!heading.tracked || heading.written);
    }
  }
  return { text, lines, headings, tracked: headings.filter(h => h.tracked), settings };
}

function applyChanges(text, changes) {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  }
  return text;
}

function statusChanges(model, desired) {
  const changes = [];
  for (const heading of model.tracked) {
    const value = desired.get(heading.from) || heading;
    const old = parseStatus(heading.text);
    if (old.read === value.read && old.written === value.written && old.missing === value.missing) continue;
    const updated = writeStatus(heading.text, value, model.settings.showMissingButton);
    const match = old.match;
    // Limit edits to the status comment to preserve selections and undo mapping.
    if (match) {
      const next = STATUS.exec(updated);
      changes.push({ from: heading.from + match.index, to: heading.from + match.index + match[0].length, insert: next[0] });
    } else {
      let at = 0;
      while (at < heading.text.length && heading.text[at] === updated[at]) at++;
      changes.push({ from: heading.from + at, to: heading.from + at, insert: updated.slice(at, at + updated.length - heading.text.length) });
    }
  }
  return changes;
}

function reconcile(text, settings) {
  const model = buildModel(text, settings);
  const changes = statusChanges(model, new Map());
  return { model, changes, text: applyChanges(text, changes) };
}

function toggleStatus(text, settings, line, type) {
  const model = buildModel(text, settings);
  const target = model.tracked.find(h => h.line === line);
  if (!target || !['read', 'written', 'missing'].includes(type)) return { text, changes: [], found: false };
  const value = !target[type];
  const cascade = type === 'read' ? model.settings.autoParentRead : type === 'written' && model.settings.autoParentWritten;
  const desired = new Map();
  for (const heading of model.tracked) {
    if (heading === target || (cascade && heading.from > target.from && heading.from < target.end)) {
      desired.set(heading.from, { ...heading, [type]: value });
    }
  }
  const first = applyChanges(text, statusChanges(model, desired));
  const final = reconcile(first, settings).text;
  return { text: final, changes: diffLines(text, final), found: true };
}

function diffLines(before, after) {
  // Status operations never insert line breaks, so a per-line minimal diff is safe.
  const a = lineTable(before), b = lineTable(after), changes = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].text === b[i].text) continue;
    let start = 0, endA = a[i].text.length, endB = b[i].text.length;
    while (start < endA && start < endB && a[i].text[start] === b[i].text[start]) start++;
    while (endA > start && endB > start && a[i].text[endA - 1] === b[i].text[endB - 1]) { endA--; endB--; }
    changes.push({ from: a[i].from + start, to: a[i].from + endA, insert: b[i].text.slice(start, endB) });
  }
  return changes;
}

function statistics(model) {
  const headings = model.tracked;
  return { total: headings.length, read: headings.filter(h => h.read).length,
    written: headings.filter(h => h.written).length, missing: headings.filter(h => h.missing) };
}

module.exports = { DEFAULT_SETTINGS, STATUS, settingsWithDefaults, buildModel, reconcile, toggleStatus, statistics, applyChanges, diffLines };
