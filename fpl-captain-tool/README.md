# Captain Picks — FPL MVP tool

A free web tool that ranks Fantasy Premier League captain candidates for
the upcoming gameweek. This is the wedge tool for the content-to-app plan:
ship this free, drive traffic to it with weekly content, then grow it into
the full app once it's getting real usage.

## What it does

1. Pulls player + fixture data from the official FPL API
2. Scores every available, regularly-playing player using:
   - recent form
   - how easy their next fixture is
   - a small bonus for playing at home
3. Shows the top 15 as a ranked list, with the score fully visible —
   no black box

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

The first load might take a second — it's fetching live data from FPL.
Results are cached for 10 minutes so you're not hitting their API on
every refresh.

## How to keep building this with Claude Code

This project is intentionally small and readable so you can hand it to
Claude Code and describe what you want next in plain English. Some good
next steps, roughly in the order they'd matter most:

1. **"Let users enter their own squad"** — right now this ranks the
   whole league. The natural next step is letting someone paste their
   15 players and only ranking captain options from their squad.
2. **"Add a written reason for each pick"** — pipe the ranked list
   through the Claude API and have it write a one-line rationale per
   player (e.g. "easy home fixture + in-form"). This is the AI touch
   layered on top of the transparent scoring, not a replacement for it.
3. **"Handle double gameweeks"** — `server.js` currently only looks at
   each team's first fixture in a gameweek; some weeks teams play twice.
4. **"Deploy this so other people can use it"** — move it to
   [Vercel](https://vercel.com): push this to a GitHub repo, connect
   the repo in Vercel, and it deploys automatically. You'll want to
   convert the Express routes to Vercel serverless functions, or just
   deploy as-is on a small host like Render/Railway if that's simpler.
5. **"Add accounts so people can save their squad"** — this is when
   you'd bring in something like [Supabase](https://supabase.com) for
   login + storage.

## Files

- `server.js` — fetches FPL data, computes scores, serves `/api/captain-picks`
- `public/index.html` — the page structure
- `public/style.css` — visual design
- `public/app.js` — fetches picks and renders them in the browser
