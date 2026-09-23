# Policy Flow

A flowing app for competitive policy debate. Open the page and start flowing —
no account, no sign-up, nothing to install.

## The five biggest things it does

1. **Flow, with real-time co-flowing.** A seven-column policy grid (1AC → 2AR)
   with tabs per position, arrows between cells, multi-cell selection, find,
   undo, zoom, a bullet-point cross-ex doc beside the grid, and keyboard
   shortcuts. Unlike a shared Google Sheet, every flow is a live room: anyone
   with the link edits it at once with colored cursors, no account for anyone.
2. **Auto Flow.** Drop a Verbatim-format `.docx` speech doc and it parses the
   tag/cite hierarchy straight into flow tabs and columns for free, no API key
   needed; adding one lets a model sort cards into the right tab/column and
   write short summaries instead.
3. **CardMirror plugin.** Press `~` on a tag in CardMirror to drop it (with
   its cite) into the column you're flowing, or on a hat or block to send
   every card under it at once. Right-click any row that came in that way to
   jump straight back to the card. See [cardmirror-plugin/](cardmirror-plugin/).
4. **Local-first, no account required, ever.** Flows are saved to this
   browser and work fully offline; a one-time transfer code moves them to a
   new device or browser without creating an account anywhere.
5. **`.xlsx` in and out.** Import an existing spreadsheet flow or export this
   one, so it's never a dead end for a team still living in Sheets.

See [changelog.md](changelog.md) for what's changed in this fork over time.

## Using the CardMirror plugin

The plugin connects [CardMirror](https://github.com/BlueCheeseburger/cardmirror)
to your open flow, so you can build the flow from your speech doc without
copying and pasting.

**What it does**

- **Sends cards.** Put the cursor on a tag in CardMirror and press `~`. The
  tag lands in the flow column you last clicked into, with its short cite
  (`Tag — Smith 24`).
- **Sends whole sections.** Press `~` on a pocket, hat, or block and every
  card under it comes over in order, as one run of rows. Section titles come
  in underlined; you can turn that off in the plugin's settings. Cards never
  get threaded between rows you've already written. If there isn't room
  below your cursor, the run starts further down. ⌘Z removes the whole send
  at once.
- **Jumps back.** Right-click any row that came from CardMirror and
  CardMirror scrolls to that card and comes to the front. If the document
  isn't open, you're told which one to open.
- **Tells you what happened.** Each send shows a message in CardMirror, like
  "Sent 6 rows to Adv 1", "Policy Flow is paused", or "No flow is open".

**Setting it up**

1. In CardMirror (desktop), open Settings → Plugins, turn on
   **Enable plugins**, and relaunch.
2. Install the plugin. On the CardMirror fork (1.12.0-bcb.2 or newer), type
   `BlueCheeseburger/policy-flow` into the Plugins tab. On other versions,
   download `plugin.js` from the
   [latest release](https://github.com/BlueCheeseburger/policy-flow/releases/latest)
   and choose **Load plugin from file…**.
3. Here in Policy Flow, open Settings → CardMirror → **Generate pairing code**.
4. Back in CardMirror, open the command palette and run
   **Policy Flow: Settings and pairing code**, then paste the code in. The
   first `~` also opens it if no code is set. On builds where the plugin has
   a row in Settings → Plugins, its gear works too.

Once you're paired, the flow's toolbar shows **CardMirror: Connected**.
Click it to pause sends, and click again to resume. The pairing code belongs
to this browser, so if you clear site data or switch browsers, generate a new
one. **New code** in Settings replaces the old code, and **Disconnect**
unpairs completely.

**Good to know**

- Cards go into the flow tab you last clicked in, if you have several open.
- Anyone sharing a live flow with you sees the rows you send, but they can't
  see or send through your pairing.
- On CardMirror versions older than 1.12.0-bcb.2, press `~` once after
  launching before right-click jumping works, and CardMirror won't come to
  the front on its own.

## Running it

```bash
npm install
npm run dev
```

`npm run build` typechecks and builds; `npm test` runs the headless suite.

## Configuration

Copy `.env.example` to `.env` and fill in a Supabase project:

```
VITE_SUPABASE_URL=…
VITE_SUPABASE_ANON_KEY=…
```

The anon key is a *publishable* key — it is meant to be in the browser and is
protected by row-level security. Never put a service-role key here.

Cloud features additionally need **anonymous sign-ins enabled** in the Supabase
dashboard (Authentication → Sign In / Providers), and `supabase/schema.sql`
applied. Without either, the app still runs: flows save locally and everything
except sharing works.

## Deploying

Import the repo on Vercel; the Vite preset is auto-detected and needs no
`vercel.json`. Routing is hash-based (`#/join/<token>`), so there are no
rewrites to configure either.

Set both `VITE_SUPABASE_*` variables in the Vercel project **before** the first
build. Vite inlines `import.meta.env` at build time, not at runtime — a build
that runs without them produces a bundle with no Supabase config baked in, and
the deployed app silently runs in local-only mode until you redeploy. That is
by design (the app is meant to work offline), which is exactly why it fails
quietly rather than visibly.

## How it is put together

```
src/lib/        pure logic — parsing, selection, arrows, cell HTML, xlsx shapes
src/platform/   everything that touches the outside world
src/components/ the UI
scripts/        headless tests for src/lib
```

`src/lib` has no browser or network dependency beyond the DOM, which is why the
tests in `scripts/` can run it headlessly. Anything that reaches outward — the
database, the AI provider, file pickers, `.docx` unzipping — lives in
`src/platform` behind a small interface, so the parts worth trusting stay
testable and the parts that can fail stay in one place.

## Things worth knowing

**Your flows belong to this browser.** There are no accounts. The app signs in
anonymously on first load, which gives this browser a durable but nameless
identity, and that identity owns your flows. Clearing site data or moving to
another machine loses them unless you use a transfer code (Settings → Moving to
another browser) first.

**A share link is the whole password.** Anyone who has it can read and edit that
flow, forever. There is no passcode and no expiry. Don't post one publicly.

**An API key here is not protected.** It sits in browser storage because a page
with no accounts has nowhere better to put it, and anything running in this
origin can read it. On a shared laptop, prefer LM Studio or no key at all. The
key is never included in an export.

**LM Studio is Chrome/Firefox only.** This page is HTTPS and LM Studio is
`http://localhost`; those browsers allow it, Safari does not. LM Studio's CORS
setting also has to be on.

## Rules the code follows

These are not style preferences — each one is a bug that already happened once.

- **Nothing is silently truncated.** Work that can be batched is batched
  (Auto Flow's sort and summary steps); work that genuinely needs one coherent
  blob is capped only after *asking*, with real numbers, and declining cancels
  the call. A prompt built from two-thirds of a document produces a confidently
  wrong answer that looks exactly like a right one.
- **A failure is never laundered into a success.** An unparseable reply throws.
  Zero placements out of a non-empty input is an error, not an empty result.
- **A shortfall is counted and shown.** "N of M sorted" appears on every path
  that ends a run, so a partial result can't look like a small input.
- **The provider's own error text survives.** It is never paraphrased away on
  its way to the user.
- **Retries only where the user has no retry button.** Everything with a visible
  "try again" fails immediately instead of spending 100 seconds in invisible
  backoff — that is what turned a hover summary into "random popups" mid-round.
- **Every color is a token, defined for both light and dark.** A value defined
  once silently produces the wrong contrast in the other mode.

## Relationship to Warroom

The flow editor, the Auto Flow parser, and the `.docx` and `.xlsx` handling are
ported from [Warroom](https://github.com/BlueCheeseburger/warroom), along with
their tests, which is most of the reason the port can be trusted. Warroom's
team features — shared team files, Google Sheets export, team-scoped flows —
are not here and are not planned. `.xlsx` is the bridge between the two.

## License

MIT — see [LICENSE](LICENSE).
