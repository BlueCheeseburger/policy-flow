# Policy Flow plugin for CardMirror

Sends cards from CardMirror into the Policy Flow sheet you have open, and
jumps back to a card when you right-click its row in the flow.

- **`~` (Send to flow)** on a tag or analytic sends that card and its short
  cite into the focused column. On a pocket, hat, or block it sends every card
  under it as one run. The titles are underlined, and you can turn them off in
  the plugin's settings.
- **Right-click a sent row** in Policy Flow to jump to that card in CardMirror.
  If its document isn't open, both apps tell you which one to open.
- **Policy Flow: Pause or resume sending** (command palette) stops sends from
  this CardMirror. The CardMirror chip in the flow's toolbar pauses the other
  end.

Desktop CardMirror only. It needs 0.1.0-beta.22 or newer for plugin settings.
With 1.12.0-bcb.2 or newer, right-click jumps work from launch and bring
CardMirror to the front. On older builds, press `~` once per session before
right-click jumping.

## Install

1. In CardMirror, open Settings → Plugins, turn on **Enable plugins**, and
   relaunch.
2. Install the plugin. On the CardMirror fork (1.12.0-bcb.2 or newer), paste
   `BlueCheeseburger/policy-flow` into the Plugins tab. It's on the fork's
   allowlist. Upstream CardMirror and older builds don't allow installing it
   by name, so download `plugin.js` from the
   [latest release](https://github.com/BlueCheeseburger/policy-flow/releases/latest)
   and use **Load plugin from file…**.
3. In Policy Flow, open Settings → CardMirror → **Generate pairing code**.
4. In CardMirror, run **Policy Flow: Settings and pairing code** from the
   command palette (or just press `~`, which opens it when no code is set)
   and paste the code in. On builds where the plugin has a row in Settings →
   Plugins, its gear works too.

## How it connects

The plugin and the flow tab share one private Supabase Realtime channel,
named by the SHA-256 of the pairing code. The plugin hashes the code it
holds, and the flow tab reads the stored hash back, which only its owner can
do. Every send and every jump gets an acknowledgement from the other side, so
the toast says what actually happened. The protocol lives in
[`src/lib/cardMirrorLink.ts`](../src/lib/cardMirrorLink.ts), which both
sides import.

## Building a release

```bash
npm run build:plugin
```

That writes `dist/plugin.js` and `dist/cardmirror-plugin.json`. Bump
`version` in `cardmirror-plugin.json` first, then attach both files to a
GitHub release. CardMirror installs from the repository's latest release.
