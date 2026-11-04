# Changelog

## 1.1.0

- Enable automatic parent Read and Written tracking by default.
- Mark or clear all tracked subheadings by clicking their parent or using a toggle command on the parent.
- Clear a parent's status when any tracked subheading becomes incomplete, including nested sections.
- Add independent settings for automatic Read and Written tracking. Missing / Extra remains manual.
- Parse real Markdown headings consistently across buttons, commands, navigation, and statistics.
- Exclude heading examples inside code, frontmatter, HTML blocks, Obsidian comments, blockquotes, and lists.
- Preserve source formatting, flags, unrelated comments, and line endings.
- Apply editor changes and automatic parent updates in one undo step.
- Refresh display settings immediately and retain editable comments in Source mode.
- Use unsaved editor content for status changes and statistics; protect against stale asynchronous updates.
- Prevent duplicate badges and repeated writes when opening or editing notes.
- Proofread commands, settings, tooltips, notices, progress views, and documentation.
- Add regression tests and build verification to the attested release workflow.

Existing notes are recalculated when opened or edited. Disable automatic parent tracking in settings if you prefer to maintain parent statuses manually.

## 1.0.1

- Replace the print CSS override with more specific selectors.
- Add signed, verified GitHub provenance for release assets.

## 1.0.0

- Initial public release.
