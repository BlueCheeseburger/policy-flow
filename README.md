# Policy Flow

A flowing app for competitive policy debate. Open the page and start flowing —
no account, no sign-up, nothing to install.

- **Flow.** A seven-column policy grid (1AC → 2AR), tabs per position, arrows
  between cells, multi-cell selection, find, undo, zoom, keyboard shortcuts.
- **Auto Flow.** Drop a `.docx` speech doc and it reads the tag/cite hierarchy
  and lays the cards out. The parser needs no API key at all; adding one lets a
  model sort cards into the right tab and column and write short summaries.
- **Share.** Turn a flow into a room and hand out the link. Everyone who opens
  it edits the same flow live, with colored cursors.
- **`.xlsx` in and out.** How a flow moves between this and anything else.

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
