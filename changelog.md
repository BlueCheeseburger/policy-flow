# Changelog

What's changed in this fork, newest first. Grouped by day, not by version —
this is a running app with no release cuts.

## 2026-11-09

- Auto Flow's parse switch is on the first screen, before you upload.
- While Auto Flow writes into a new flow, a progress card shows how far
  along it is and which tab it's on, and the flow is locked until it's done,
  so a click or keystroke can't land in a cell that's about to be rewritten.
- Cards the parser can't sort (under a generic header like "OFF", or in a
  doc with no speech label) are no longer guessed onto a tab. After the
  rest is written, each one is shown with its pocket, hat and block, and you
  click where it goes on a small copy of the flow: an empty cell, or the
  line between two cells to slot it in. "Place all from this block" puts a
  whole block in order in one click.

## 2026-11-07

- Auto Flow can parse instead of using AI: a switch in the Auto Flow
  dialog, off every time it opens. Each pocket becomes a tab (or, when the
  pocket is just a speech label, the hat or block that names the position;
  a 1NC's "OFF" blocks are named by their first tagline). Every tagline and
  analytic gets a row, in document order.
- Hats are double underlined with a blank row above and below; blocks are
  single underlined; rows under a hat are indented 8px, and 8px more under a
  block. The same rules apply to sections sent from CardMirror, where a
  pocket opens (or makes) the tab it names. Needs plugin 0.1.5 for hats and
  pockets; older plugins' headings still come in as blocks.
- Double underline: ⌘⇧U, and a button next to Underline.
- CardMirror plugin 0.1.5 sends each heading's level (pocket, hat or
  block), so sent sections get hat styling and pockets open their tab.
- Short cites in the team's format ("Rather 26 — Dan Rather. …") are read
  correctly; they used to come out empty.

## 2026-11-05

- ⌘A in a cell selects just that cell; anywhere else in the flow it selects
  the grid, not the toolbar and notes around it.
- Sending from CardMirror while offline or unable to connect now says so,
  instead of doing nothing. A slow reconnect shows "Connecting…".
- Rows from CardMirror keep a tag's underlined words, once CardMirror sends
  them (needs a CardMirror update).
- CardMirror plugin 0.1.4 ships the connection messages and underline
  support, and its help says how to change the send key.

## 2026-09-24

- Notes drawer: the CX button and a new RFD button open one drawer beside the
  grid with a tab for each. The RFD is free text for the reason for decision,
  with a word count. Both notes save as you type, sync live to everyone in
  the flow, and carry over when a flow is duplicated.
- Rows sent from CardMirror have a teal stripe down their left edge.
- Exporting to .xlsx now includes the cross-ex and RFD notes as their own
  sheets, and importing that file brings them back as notes.
- Fixed: .xlsx export and import stopped at 60 rows, silently dropping the
  rest of a longer flow.
- Fixed: exporting a flow with two tabs of the same name (or two long names
  that match once cut to Excel's 31 characters) failed.
- Fixed: arrows in a live flow never reached partners and disappeared after a
  reload. Drawing, moving, deleting, and undoing arrows now syncs.
- Fixed: undo in a shared flow could erase a partner's text. It now undoes
  only your own step and leaves everything your partners did, however many
  steps back you go.
- Fixed: the first edit after opening a flow sometimes couldn't be undone
  (when live sync finished before the local copy, or the tab opened in the
  background).

## 2026-09-23

- Fixed: reloading a flow that hadn't been shared yet dropped you on Home.
- Fixed: reloading right after opening a share link (or on a slow
  connection) dropped you on Home with the link gone. Your own shared flows
  now reopen straight from the link, even offline.
- Fixed: ⌘Z while typing in the cross-ex notes, the find box, or a rename
  field undid the grid instead.
- Fixed: tab order wasn't saved in live flows, so reordered or duplicated
  tabs jumped back on reload and partners saw a different order.
- Fixed: typing in a shared flow in the first moment after opening it could
  overwrite the room's saved copy with this browser's older one.
- Fixed: a save could write back an old copy of the flow list, erasing a new
  share link or the flag that lets deleting a flow remove its cloud copy.
  Auto Flow and the startup sync had the same problem.
- Fixed: duplicating a flow left its cross-ex notes behind, and deleting one
  left its notes and saved round analysis in browser storage.
- CardMirror plugin 0.1.3: when a flow is open but doesn't answer, the
  message says so instead of "No flow is open", and the paused message names
  the right command.
- CardMirror plugin 0.1.1: a **Policy Flow: Settings and pairing code**
  command opens the plugin's own settings window, with the pairing code, the
  titles toggle, and "What it does" / "Setting it up" / "Good to know"
  sections taken straight from this README. CardMirror only shows a settings
  gear for plugins in its installed list, so a plugin loaded from a file had
  nowhere to enter a code. Pressing `~` with no code set opens the window too.
- README: a "Using the CardMirror plugin" section.
- CardMirror plugin 0.1.2: on CardMirror builds that support it (1.12.0-bcb.2
  and newer), the same README sections also appear as expandable sections
  under the plugin's gear in Settings → Plugins. Plugins loaded from a file
  get a gear there too.

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
- The CardMirror chip only appears once you've generated a pairing code,
  and only says "Not connected" when the link has really been down for a
  few seconds (Connected / Connecting / Paused otherwise). Settings can issue
  a new code without disconnecting first.
- Cross-ex notes show that they're shared: the header says "Live" and how
  many others are in the flow, and a partner's colored marker sits on the
  point they're typing in.
- CardMirror plugin v0.1.0 released.

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
