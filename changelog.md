# Changelog

What's changed in this fork, newest first. Grouped by day, not by version —
this is a running app with no release cuts.

## 2026-09-13

- Added an MIT license.

## 2026-09-11

- All-tabs list: a hamburger button next to "+" opens a checklist of every
  sheet tab, so you're not scrubbing a long horizontal tab strip to find one.
- Home screen: search flows by title, and sort by last modified (default),
  last viewed, date created, name, or most cells written.
- Right-click a flow card to rename, duplicate, or delete it.
- CardMirror: the status chip is now a local pause/resume toggle instead of a
  hard token revoke, and `pf-presence` can tell CardMirror "paused" apart from
  "not open at all."
- Fixed a bug where sharing a flow could resurrect already-deleted tabs as
  duplicates for the next person who joined.
- Fixed live edits silently failing to sync after switching between two
  browser windows (a stale-flag bug tied to backgrounded-tab throttling).
- Fixed a remote collaborator's cursor showing up on the wrong tab.
- Column headers (1AC, 1NC, etc.) are centered instead of left-aligned.
- Added a `pf-revoke-token` endpoint so CardMirror can revoke its own pairing
  from its side.

## 2026-09-10

- CardMirror integration: a paired session can push a cut card into the
  active cell of an open flow in real time (presence publishing, broadcast
  delivery, API token pairing in Settings).
- Home screen: renamed titles, a gear icon, a shareable flow URL, a
  collapsible "More settings," grid line numbers, and a bolder "+" tab button.
- The note field can auto-fill from sheet names once every tab is renamed.
- Tab now moves to the next row (same column); Shift+Tab moves to the
  previous row.
- A first-flow onboarding tip explains moving cells, multi-select, and
  drawing connecting lines.

## 2026-09-09

- Initial port: a standalone flowing web app carved out of Warroom's flow
  editor, Auto Flow parser, and `.docx`/`.xlsx` handling (see
  [README.md](README.md#relationship-to-warroom)).
- Flow cards on the home screen: scratch notes, a trash icon, a sized
  Analyze button, and a whole-flow preview strip.
- Flows are marked cloud-backed once they first sync, and deleting one never
  orphans its server-side row.
- Settings: theme, side colors, keyboard shortcuts, and density.
