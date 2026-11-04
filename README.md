# Heading Status Tracker

Track study progress beside Markdown headings in Obsidian. Mark topics **Read**, **Written**, or **Missing / Extra**, and keep parent headings synchronized with their subheadings.

## What's new in 1.1.0

Automatic parent tracking for **Read and Written is enabled by default**, including in existing notes. Parent statuses are recalculated when notes are opened or edited. No background scan rewrites unopened notes.

- When all tracked subheadings are Read, their parent becomes Read. The same applies independently to Written.
- Unmarking one subheading clears that status on its parents, all the way up the hierarchy.
- Clicking a parent marks or clears the selected status throughout its section, including nested tracked subheadings. It does not affect the next section.
- Missing / Extra remains a manual flag and does not propagate.

To keep manual parent tracking, turn off **Automatically update parent Read status** or **Automatically update parent Written status** in the plugin settings. Disabling either setting preserves the current stored values and stops section-wide changes for that status.

## Using the plugin

In **Reading view** or **Live Preview**, click the buttons beside a heading:

- **R — Read**: mark a topic as read.
- **W — Written**: mark a topic as written.
- **! — Missing / Extra**: flag a topic for additional study.

Calculated parent buttons explain their behavior in a tooltip. A heading with no tracked subheadings remains manual. Parent completion is determined by subheadings; text directly under a parent does not have a separate status.

In **Source mode**, status comments remain editable. Use the command palette or assigned hotkeys to toggle a heading's status. Place the cursor on the heading line before running a toggle command.

Available commands:

- Toggle Read on the current heading.
- Toggle Written on the current heading.
- Toggle Missing / Extra on the current heading.
- Show study progress for the current note.
- Jump to the next unread heading.
- Jump to the next Missing / Extra heading.

Navigation wraps to the top of the note. The statistics dialog shows Read and Written totals and a list of flagged headings. Clicking a flagged heading opens the correct note at that heading. The desktop status bar shows progress for the current note, including unsaved edits.

## Settings

Open **Settings → Heading Status Tracker** to configure:

- Automatic parent tracking for Read and Written independently.
- Button placement before or after headings.
- Button labels and the Missing / Extra button.
- Highlighting of flagged headings.
- The desktop progress status bar.
- Tracked heading levels H1 through H6.

Changes take effect immediately. Only enabled heading levels contribute to progress and parent completion. Disabled levels still define section boundaries, so changes do not spill into neighboring sections. Hiding the Missing / Extra button preserves existing flags.

## Markdown support and stored data

The plugin tracks document-level, hash-prefixed headings, including skipped levels such as H2 followed by H4. Underline-style headings are not tracked, but still define section boundaries. Headings inside blockquotes, lists, fenced or indented code, YAML frontmatter, HTML blocks, and Obsidian comments are excluded.

Progress is stored in an HTML comment on each heading line:

```markdown
## Example topic <!-- [x][ ][!] -->
```

The fields represent Read, Written, and Missing / Extra, in that order. Older two-field comments are supported. The plugin preserves existing flags, unrelated comments, closing hashes, whitespace, and line endings.

Removing a leaf heading's status comment resets its progress. When automatic parent tracking is enabled, parent comments are recalculated from their subheadings. Clicking a status button and its resulting parent updates form one editor undo step.

## Installation

Search for **Heading Status Tracker** in Obsidian's community plugins, install it, and enable it. Requires Obsidian **1.15.0 or later**.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from a [GitHub release](https://github.com/Ayush4265/heading-status-tracker/releases). Copy them into `<vault>/.obsidian/plugins/heading-status-tracker/`, then reload Obsidian and enable the plugin.

## Privacy and synchronization

The plugin works offline. It makes no network requests, collects no telemetry, requires no account or payment, and does not access files outside the vault. Progress travels with your Markdown notes through your existing sync service. No separate sync integration is required.

## Development and verification

Requires Node.js 22 or later and npm. Install the locked dependencies, run tests, and build the plugin:

```sh
npm ci
npm test
npm run build
```

Development source lives in `src/`. The release `main.js` bundles the Markdown parser; Obsidian and CodeMirror modules remain external and are provided by Obsidian. No runtime dependency installation is needed. Third-party license notices are included in the repository and the release bundle.

Tests cover parent cascades, child unchecking, hierarchy and section boundaries, excluded Markdown, preserved formatting, settings, reading-view interactions, unsaved edits, actual CodeMirror widgets, and Undo/Redo.

GitHub Actions runs tests and builds from committed source. It creates and verifies signed provenance attestations for all three installation files before publishing a release. Verify downloaded files with the GitHub CLI:

```sh
gh attestation verify main.js --repo Ayush4265/heading-status-tracker
gh attestation verify styles.css --repo Ayush4265/heading-status-tracker
gh attestation verify manifest.json --repo Ayush4265/heading-status-tracker
```

For a new release, update `package.json`, `manifest.json`, `versions.json`, `CHANGELOG.md`, and the lockfile together. Pushing the manifest change to `main` triggers the release workflow.

## License

MIT. Copyright (c) 2026 atharva savnerkar.
