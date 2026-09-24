# Notes for Claude Code sessions working on policy-flow

## End-of-response: flag anything outstanding the user hasn't answered

Every response end with a divider  
(`---`) followed by an "Outstanding" list whenever something is  
outstanding — a question you asked that they haven't answered, a  
decision you flagged as needing their input, a choice you offered  
(e.g. "want me to do X or Y?") that they moved past without picking.  
Keep each item short: what you asked, and why it's still open. Omit  
the divider and section entirely when nothing is outstanding — don't  
manufacture one. This applies to every response from here on, not  
just this session; check before ending each one.

## Keep the README's fork- section current

In`README.md` have a section near the top, right under the title, listing what this repo's top 5 main features are, and what sets it apart from other similar services. Keep entries short (a sentence or two), and sort the top 5 by how big the feature is to users. 

Add a reference to `changelog.md` to have our fork's changes there. Have a `changelog.md` file.

## Misc

- Do not include my personal info in your commits.
- Keep commit messages short
- Automatically push and commit after major features have been pushed
- **This only applies to local sessions, do not do this if you are a cloud session:** I am directing my agent working on policy-card-cutter (another policy debate vercel vite web app), to follow your look and feel, so your Claude Code session will recieve messages from that agent. The codebase for policy-card-cutter is `Downloads/policy-card-cutter`, so you can always just look at the actual code, just don't edit that code since its not your codebase.

