# Heading Status Tracker

Track study progress directly beside Markdown headings in Obsidian. Mark each topic as **read**, **written**, or **missing / extra reading**.

## Features

- Compact R, W, and ! buttons in reading view and the editor.
- Enable any combination of heading levels H1 through H6.
- Place buttons before or after headings and optionally hide labels.
- Highlight headings flagged for extra reading.
- View note progress in the desktop status bar or the statistics dialog.
- Jump to the next unread or flagged topic, wrapping to the top of the note.

## Usage

Open a Markdown note with headings and click a status button to toggle it. To use a command, place the cursor on a heading and open the command palette. Commands include toggling each status, showing study progress statistics, and jumping to unread or missing topics. Assign shortcuts in Obsidian's hotkey settings if desired.

Choose **Settings → Heading Status Tracker** to configure buttons, heading levels, highlighting, and the status bar. Reopen the note or reload the plugin after changing display settings. The status bar is a desktop feature.

Status is stored in an HTML comment on the heading line:

```markdown
## Example topic <!-- [x][ ][!] -->
```

The fields represent read, written, and missing / extra, in that order. Removing a status comment resets that heading's progress. The plugin handles hash-prefixed headings; setext headings are not supported.

## Installation

Once listed in the community directory, search for **Heading Status Tracker** under Obsidian's community plugins and enable it.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from a GitHub release into `<vault>/.obsidian/plugins/heading-status-tracker/`, then reload Obsidian and enable the plugin. Requires Obsidian 1.15.0 or later.

## Privacy and synchronization

The plugin works offline. It makes no network requests, uses no telemetry, requires no account or payment, and does not access files outside the vault. Progress is saved in your Markdown notes, so your existing sync service can synchronize it. No Fly.io or LiveSync integration is included or required.

## Development

`main.js` is the readable JavaScript source and the release entry point; no build step or bundled dependencies are required. Obsidian supplies the `obsidian`, `@codemirror/view`, and `@codemirror/state` modules at runtime. Check syntax with `node --check main.js`.

## Release verification

GitHub Actions packages the committed source and creates signed provenance attestations for all three release files before publication. The workflow checks JavaScript syntax, version metadata, and CSS overrides, then verifies each attestation.

To verify a downloaded asset with the GitHub CLI:

```sh
gh attestation verify main.js --repo Ayush4265/heading-status-tracker
gh attestation verify styles.css --repo Ayush4265/heading-status-tracker
```

For a new release, update `manifest.json` and `versions.json` together on `main`. The release workflow publishes the new version automatically.

## License

MIT. Copyright (c) 2026 atharva savnerkar.
