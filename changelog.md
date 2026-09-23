# Changelog

What's changed in this fork, newest first. Grouped by day, not by version —
this is a running app with no release cuts.

## 2026-09-22

- CardMirror is now a plugin: the built-in integration was removed from
  CardMirror, so everyone re-pairs through the plugin (install it, then paste
  a code from Settings → CardMirror into its settings).
- Send a whole pocket, hat, or block: every card under it lands as one
  contiguous run in the focused column, each with its own cite, and titles
  come in underlined. One ⌘Z takes the whole batch back out.
- Right-click a row sent from CardMirror to jump back to that card in
  CardMirror. If the doc isn't open, you're told which one to open.
- Cross-ex doc: a CX button opens a bullet-point outline beside the grid.
  Only points and sub-points are allowed (Enter, Tab, ⇧Tab), pasted lists get
  split into bullets, and partners in a live room share it.
- Fixed: cards sent from CardMirror never arrived. The server broadcast to a
  topic nothing listened on, and still reported success. The plugin now talks
  to the flow tab directly and only reports success once the tab confirms it.
- Fixed: the flow tab looked "not open" to CardMirror five minutes after it
  was opened, because its presence timestamp never refreshed.
- Fixed: a send landed in every open flow tab at once. Now only the tab you
  last worked in takes it.
- Fixed: anyone who shared a live room with you could read or inject your
  CardMirror sends. The channel is now named by your pairing code's hash,
  which only you can read.
- Fixed: undo and redo in a live flow never reached partners, and a reload
  brought the undone text back. A duplicated tab also showed up blank for
  everyone else.
- The CardMirror chip now shows whether the connection is actually up
  (Connected / Connecting / Paused), and Settings can issue a new code
  without disconnecting first.

## 2026-09-15

- AI prompts are editable in Settings → AI. Save stays disabled until you
  change something, edited prompts are marked, and each can be reset.

## 2026-09-14

- OpenAI is available as a model provider alongside Gemini and LM Studio.
- Fixed the home-screen search icon overlapping its placeholder text.

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
