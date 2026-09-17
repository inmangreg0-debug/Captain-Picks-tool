// Captain Picks — MVP server
//
// What this does:
// 1. Pulls player + fixture data from the official Fantasy Premier League API
// 2. Scores every available, regularly-playing player for the upcoming
//    gameweek using: recent form + fixture ease + a small home bonus
// 3. Serves the top 15 as JSON to the frontend in /public
//
// Why a server at all (not a browser-only page): the FPL API blocks
// direct browser requests (CORS), so the fetch has to happen server-side.
// This also lets us cache results instead of hammering FPL's API on
// every page load.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const FPL_BASE = "https://fantasy.premierleague.com/api";

// Simple in-memory cache. Good enough for an MVP with one server instance;
// swap for a real cache (Redis, or Vercel KV) once this moves off a single box.
let cache = { data: null, expires: 0 };
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

const POSITION_NAMES = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request to ${url} failed with status ${res.status}`);
  }
  return res.json();
}

async function getCaptainPicks() {
  if (cache.data && Date.now() < cache.expires) {
    return cache.data;
  }

  const bootstrap = await fetchJSON(`${FPL_BASE}/bootstrap-static/`);

  const nextEvent =
    bootstrap.events.find((e) => e.is_next) ||
    bootstrap.events.find((e) => e.is_current);

  if (!nextEvent) {
    throw new Error("Could not find an upcoming or current gameweek");
  }

  const fixtures = await fetchJSON(`${FPL_BASE}/fixtures/?event=${nextEvent.id}`);

  const teamsById = {};
  bootstrap.teams.forEach((t) => {
    teamsById[t.id] = t;
  });

  // Map each team to its next fixture. NOTE: this MVP takes only the first
  // fixture per team, so double-gameweeks aren't handled yet — a good
  // "next step" to build on.
  const teamFixture = {};
  fixtures.forEach((f) => {
    if (teamFixture[f.team_h] === undefined) {
      teamFixture[f.team_h] = {
        opponentId: f.team_a,
        difficulty: f.team_h_difficulty,
        isHome: true,
      };
    }
    if (teamFixture[f.team_a] === undefined) {
      teamFixture[f.team_a] = {
        opponentId: f.team_h,
        difficulty: f.team_a_difficulty,
        isHome: false,
      };
    }
  });

  const OWNERSHIP_DIFFERENTIAL_MAX = 10; // percent — "nobody has them" territory
  const OWNERSHIP_AVOID_MIN = 15; // percent — popular enough that a bad week stings

  const scoredPlayers = bootstrap.elements
    .filter((p) => p.status === "a") // "a" = available (not injured/suspended/on loan out)
    .filter((p) => p.minutes >= 180) // has actually been playing regularly
    .filter(
      (p) =>
        p.chance_of_playing_next_round === null ||
        p.chance_of_playing_next_round >= 75
    )
    .map((p) => {
      const fixture = teamFixture[p.team];
      if (!fixture) return null;

      const form = parseFloat(p.form) || 0;
      const fixtureScore = 6 - fixture.difficulty; // difficulty 1 (easy) -> 5, 5 (hard) -> 1
      const homeBonus = fixture.isHome ? 0.5 : 0;
      const score = Math.round((form + fixtureScore + homeBonus) * 10) / 10;

      const team = teamsById[p.team];
      const opponent = teamsById[fixture.opponentId];

      return {
        name: `${p.first_name} ${p.second_name}`,
        team: team ? team.name : "Unknown",
        position: POSITION_NAMES[p.element_type] || "",
        opponent: opponent ? opponent.short_name : "???",
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
        form,
        price: (p.now_cost / 10).toFixed(1),
        ownership: p.selected_by_percent,
        score,
      };
    })
    .filter(Boolean);

  const picks = [...scoredPlayers].sort((a, b) => b.score - a.score).slice(0, 15);

  // Low-ownership players from the same pool who are still scoring well —
  // a chance to gain ground on the rest of your mini-league.
  const differentials = scoredPlayers
    .filter((p) => parseFloat(p.ownership) < OWNERSHIP_DIFFERENTIAL_MAX)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Widely-owned players worth a second thought. This pool intentionally
  // skips the availability/minutes filters above, since injury and rotation
  // doubts are exactly what we want to flag here.
  const avoidCandidates = bootstrap.elements
    .filter((p) => parseFloat(p.selected_by_percent) > OWNERSHIP_AVOID_MIN)
    .map((p) => {
      const fixture = teamFixture[p.team];
      if (!fixture) return null;

      const form = parseFloat(p.form) || 0;
      const fixtureScore = 6 - fixture.difficulty;
      const homeBonus = fixture.isHome ? 0.5 : 0;
      const score = Math.round((form + fixtureScore + homeBonus) * 10) / 10;

      const team = teamsById[p.team];
      const opponent = teamsById[fixture.opponentId];
      const flagged =
        p.chance_of_playing_next_round !== null &&
        p.chance_of_playing_next_round < 75;

      let reason;
      if (flagged) {
        reason = "Rotation risk";
      } else if (fixture.difficulty >= 4) {
        reason = "Tough fixture";
      } else {
        reason = "Poor form";
      }

      return {
        name: `${p.first_name} ${p.second_name}`,
        team: team ? team.name : "Unknown",
        position: POSITION_NAMES[p.element_type] || "",
        opponent: opponent ? opponent.short_name : "???",
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
        form,
        price: (p.now_cost / 10).toFixed(1),
        ownership: p.selected_by_percent,
        score,
        reason,
        flagged,
      };
    })
    .filter(Boolean);

  const avoidThisWeek = avoidCandidates
    .sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      return a.score - b.score;
    })
    .slice(0, 5)
    .map(({ flagged, ...rest }) => rest);

  // Net transfers this gameweek, used to surface players the crowd is
  // moving in and out of ahead of the deadline.
  const transferMovers = bootstrap.elements.map((p) => {
    const team = teamsById[p.team];
    return {
      name: `${p.first_name} ${p.second_name}`,
      team: team ? team.name : "Unknown",
      position: POSITION_NAMES[p.element_type] || "",
      price: (p.now_cost / 10).toFixed(1),
      netTransfers: p.transfers_in_event - p.transfers_out_event,
    };
  });

  const trendingUp = [...transferMovers]
    .sort((a, b) => b.netTransfers - a.netTransfers)
    .slice(0, 6);

  const trendingDown = [...transferMovers]
    .sort((a, b) => a.netTransfers - b.netTransfers)
    .slice(0, 6);

  const result = {
    gameweek: nextEvent.name,
    deadline: nextEvent.deadline_time,
    picks,
    differentials,
    avoidThisWeek,
    trendingUp,
    trendingDown,
  };

  cache = { data: result, expires: Date.now() + CACHE_MS };
  return result;
}

app.get("/api/captain-picks", async (req, res) => {
  try {
    const picks = await getCaptainPicks();
    res.json(picks);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not load captain picks right now. Try again shortly.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Captain picks tool running at http://localhost:${PORT}`);
});
