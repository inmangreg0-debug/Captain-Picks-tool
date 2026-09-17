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

let bootstrapCache = { data: null, expires: 0 };

async function getBootstrap() {
  if (bootstrapCache.data && Date.now() < bootstrapCache.expires) {
    return bootstrapCache.data;
  }
  const data = await fetchJSON(`${FPL_BASE}/bootstrap-static/`);
  bootstrapCache = { data, expires: Date.now() + CACHE_MS };
  return data;
}

const POSITION_NAMES = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

function playerPhotoCode(p) {
  return p.photo ? p.photo.replace(/\.[^.]+$/, "") : null;
}

function teamBadgeUrl(team) {
  return team && team.code
    ? `https://resources.premierleague.com/premierleague/badges/70/t${team.code}.png`
    : null;
}

// How much more fixture ease should count than recent form when scoring a
// player. >1 means fixture difficulty dominates the score; tune here.
const FIXTURE_WEIGHT = 1.5;

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request to ${url} failed with status ${res.status}`);
  }
  return res.json();
}

// --- Points projection -----------------------------------------------------
//
// One source of truth for "how many points is this player likely to get in
// this match", used by both the main picks list and the player detail
// modal's next-5-fixtures table. Deliberately separate from `score` above,
// which is a relative ranking number, not a points estimate.
function projectPoints(player, fixtureDifficulty, isHome) {
  const APPEARANCE_BASE = 2;
  const FORM_WEIGHT = 0.6;
  const HOME_BONUS = 0.3;
  const isDefensive = player.position === "GKP" || player.position === "DEF";
  const fixtureMultiplier = isDefensive ? 0.35 : 0.22; // clean sheets swing more on fixture ease

  const total =
    APPEARANCE_BASE +
    (player.form || 0) * FORM_WEIGHT +
    (6 - fixtureDifficulty) * fixtureMultiplier +
    (isHome ? HOME_BONUS : 0);

  return Math.max(0, Math.round(total * 10) / 10);
}

// --- Positive/negative trait facts ------------------------------------------

function computeTeamGoals(bootstrap) {
  const totals = {};
  bootstrap.elements.forEach((p) => {
    totals[p.team] = (totals[p.team] || 0) + (p.goals_scored || 0);
  });
  return totals;
}

function percentile(sortedAscending, p) {
  if (!sortedAscending.length) return 0;
  const idx = Math.floor(p * (sortedAscending.length - 1));
  return sortedAscending[idx];
}

// Position-relative benchmarks used to judge whether a stat is actually
// notable (e.g. "elite" creativity only means something compared to peers
// in the same position).
function computeBenchmarks(bootstrap) {
  const creativityByPos = { 1: [], 2: [], 3: [], 4: [] };
  const concededPer90ByPos = { 1: [], 2: [] }; // GKP, DEF only

  bootstrap.elements.forEach((p) => {
    const pos = p.element_type;
    if (creativityByPos[pos]) {
      creativityByPos[pos].push(parseFloat(p.creativity) || 0);
    }
    if ((pos === 1 || pos === 2) && p.minutes >= 90) {
      concededPer90ByPos[pos].push((p.goals_conceded / p.minutes) * 90);
    }
  });

  const creativityThreshold = {};
  Object.keys(creativityByPos).forEach((pos) => {
    const sorted = creativityByPos[pos].slice().sort((a, b) => a - b);
    creativityThreshold[pos] = percentile(sorted, 0.8); // top 20%
  });

  const concededPer90Avg = {};
  Object.keys(concededPer90ByPos).forEach((pos) => {
    const arr = concededPer90ByPos[pos];
    concededPer90Avg[pos] = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  });

  return { creativityThreshold, concededPer90Avg };
}

function getGamesPlayed(bootstrap) {
  return bootstrap.events.filter((e) => e.finished).length || 1;
}

function getPlayerFacts(p, position, teamGoalsById, benchmarks, gamesPlayed) {
  const elementType = p.element_type;
  const form = parseFloat(p.form) || 0;
  const goals = p.goals_scored || 0;
  const assists = p.assists || 0;
  const bonus = p.bonus || 0;
  const yellow = p.yellow_cards || 0;
  const creativity = parseFloat(p.creativity) || 0;
  const teamGoals = teamGoalsById[p.team] || 0;

  let positiveStat = null;
  if (teamGoals > 0 && (goals + assists) / teamGoals >= 0.15) {
    const pct = Math.round(((goals + assists) / teamGoals) * 100);
    positiveStat = `Involved in ${pct}% of the team's goals this season`;
  } else if (creativity > 0 && creativity >= (benchmarks.creativityThreshold[elementType] || Infinity)) {
    positiveStat = `Elite chance creation for a ${position}`;
  } else if (bonus >= 8) {
    positiveStat = `Regularly picks up bonus points (${bonus} this season)`;
  }

  let negativeStat = null;
  if (form < 2) {
    negativeStat = "Form has dropped sharply recently";
  } else if ((elementType === 1 || elementType === 2) && p.minutes >= 90) {
    const per90 = (p.goals_conceded / p.minutes) * 90;
    const avg = benchmarks.concededPer90Avg[elementType] || 0;
    if (avg > 0 && per90 >= avg * 1.2) {
      negativeStat = "Defense has been conceding heavily";
    }
  }
  if (!negativeStat && yellow >= 6) {
    negativeStat = "Picking up cards often — suspension risk";
  }
  if (!negativeStat && gamesPlayed >= 3 && p.minutes > 0) {
    const startRate = (p.starts || 0) / gamesPlayed;
    if (startRate < 0.5) {
      negativeStat = "Playing time has been inconsistent";
    }
  }

  return { positiveStat, negativeStat };
}

// --- Written prediction report ----------------------------------------------

function fixtureAdjective(difficulty) {
  if (difficulty <= 2) return "favorable";
  if (difficulty >= 4) return "tough";
  return "even";
}

// Combines fields already computed elsewhere (form, fixture ease, home/away,
// the two trait facts, and the points projection) into a short natural-
// language summary. Template varies by trend so picks don't all read the same.
function generateReport(player, projectedPoints) {
  const homeAway = player.isHome ? "home" : "away";
  const adjective = fixtureAdjective(player.difficulty);
  const opponent = player.opponent || "their opponent";
  const trend = player.form >= 5 ? "up" : player.form < 3 ? "down" : "neutral";

  let opening;
  if (trend === "up") {
    opening = `In strong form heading into a ${adjective} ${homeAway} fixture against ${opponent}.`;
  } else if (trend === "down") {
    const outlook =
      adjective === "favorable" ? "winnable on paper" : adjective === "tough" ? "a tough ask" : "a fair test";
    opening = `Form has cooled recently, and this ${homeAway} fixture against ${opponent} looks ${outlook}.`;
  } else {
    opening = `Steady recent form heading into a ${adjective} ${homeAway} fixture against ${opponent}.`;
  }

  const rawTrait = player.positiveStat || player.negativeStat || null;
  const traitLine = rawTrait ? (/[.!?]$/.test(rawTrait) ? rawTrait : `${rawTrait}.`) : null;

  let verdict;
  if (projectedPoints >= 6) {
    verdict =
      trend === "down"
        ? `Projected for ${projectedPoints} points — worth a punt despite the dip in form.`
        : `Projected for ${projectedPoints} points — a strong pick this week.`;
  } else if (projectedPoints >= 4) {
    verdict =
      trend === "up"
        ? `Projected for ${projectedPoints} points — a solid pick this week.`
        : `Projected for ${projectedPoints} points — a reasonable option this week.`;
  } else {
    verdict =
      trend === "down"
        ? `Projected for ${projectedPoints} points — better options are probably available.`
        : `Projected for ${projectedPoints} points — a low-risk, low-reward pick.`;
  }

  return [opening, traitLine, verdict].filter(Boolean).join(" ");
}

async function getCaptainPicks() {
  if (cache.data && Date.now() < cache.expires) {
    return cache.data;
  }

  const bootstrap = await getBootstrap();

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

  const teamGoalsById = computeTeamGoals(bootstrap);
  const benchmarks = computeBenchmarks(bootstrap);
  const gamesPlayed = getGamesPlayed(bootstrap);

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

      const position = POSITION_NAMES[p.element_type] || "";
      const form = parseFloat(p.form) || 0;
      const fixtureScore = 6 - fixture.difficulty; // difficulty 1 (easy) -> 5, 5 (hard) -> 1
      const homeBonus = fixture.isHome ? 0.5 : 0;
      const score =
        Math.round((form + fixtureScore * FIXTURE_WEIGHT + homeBonus) * 10) / 10;

      const team = teamsById[p.team];
      const opponent = teamsById[fixture.opponentId];
      const { positiveStat, negativeStat } = getPlayerFacts(
        p,
        position,
        teamGoalsById,
        benchmarks,
        gamesPlayed
      );
      const projectedPoints = projectPoints({ position, form }, fixture.difficulty, fixture.isHome);

      const player = {
        id: p.id,
        name: `${p.first_name} ${p.second_name}`,
        team: team ? team.name : "Unknown",
        position,
        opponent: opponent ? opponent.short_name : "???",
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
        form,
        price: (p.now_cost / 10).toFixed(1),
        ownership: p.selected_by_percent,
        score,
        photoCode: playerPhotoCode(p),
        teamBadge: teamBadgeUrl(team),
        positiveStat,
        negativeStat,
        trendingDown: form < 3,
        projectedPoints,
      };
      player.report = generateReport(player, projectedPoints);
      return player;
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

      const position = POSITION_NAMES[p.element_type] || "";
      const form = parseFloat(p.form) || 0;
      const fixtureScore = 6 - fixture.difficulty;
      const homeBonus = fixture.isHome ? 0.5 : 0;
      const score =
        Math.round((form + fixtureScore * FIXTURE_WEIGHT + homeBonus) * 10) / 10;

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

      const { positiveStat, negativeStat } = getPlayerFacts(
        p,
        position,
        teamGoalsById,
        benchmarks,
        gamesPlayed
      );
      const projectedPoints = projectPoints({ position, form }, fixture.difficulty, fixture.isHome);

      const player = {
        id: p.id,
        name: `${p.first_name} ${p.second_name}`,
        team: team ? team.name : "Unknown",
        position,
        opponent: opponent ? opponent.short_name : "???",
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
        form,
        price: (p.now_cost / 10).toFixed(1),
        ownership: p.selected_by_percent,
        score,
        reason,
        flagged,
        photoCode: playerPhotoCode(p),
        teamBadge: teamBadgeUrl(team),
        positiveStat,
        negativeStat,
        trendingDown: form < 3,
        projectedPoints,
      };
      player.report = generateReport(player, projectedPoints);
      return player;
    })
    .filter(Boolean);

  const avoidThisWeek = avoidCandidates
    .sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      return a.score - b.score;
    })
    .slice(0, 5)
    .map(({ flagged, ...rest }) => rest);

  const OWNERSHIP_OUT_OF_FORM_MIN = 10; // percent — moderate-to-high ownership

  // Regularly-playing, still widely-owned players whose form has dropped —
  // a sustained trend, unlike avoidThisWeek's single-gameweek risk flags.
  const outOfForm = scoredPlayers
    .filter((p) => parseFloat(p.ownership) >= OWNERSHIP_OUT_OF_FORM_MIN)
    .sort((a, b) => a.form - b.form)
    .slice(0, 5);

  // Net transfers this gameweek, used to surface players the crowd is
  // moving in and out of ahead of the deadline.
  const transferMovers = bootstrap.elements.map((p) => {
    const team = teamsById[p.team];
    const position = POSITION_NAMES[p.element_type] || "";
    const fixture = teamFixture[p.team];
    const form = parseFloat(p.form) || 0;
    const opponentTeam = fixture ? teamsById[fixture.opponentId] : null;
    const isHome = fixture ? fixture.isHome : false;
    const difficulty = fixture ? fixture.difficulty : 3;
    const opponent = opponentTeam ? opponentTeam.short_name : "???";
    const { positiveStat, negativeStat } = getPlayerFacts(
      p,
      position,
      teamGoalsById,
      benchmarks,
      gamesPlayed
    );
    const projectedPoints = projectPoints({ position, form }, difficulty, isHome);

    const player = {
      id: p.id,
      name: `${p.first_name} ${p.second_name}`,
      team: team ? team.name : "Unknown",
      position,
      price: (p.now_cost / 10).toFixed(1),
      netTransfers: p.transfers_in_event - p.transfers_out_event,
      photoCode: playerPhotoCode(p),
      teamBadge: teamBadgeUrl(team),
      form,
      opponent,
      isHome,
      difficulty,
      positiveStat,
      negativeStat,
      trendingDown: form < 3,
      projectedPoints,
    };
    player.report = generateReport(player, projectedPoints);
    return player;
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
    outOfForm,
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

async function getPlayerDetail(id) {
  const bootstrap = await getBootstrap();
  const player = bootstrap.elements.find((p) => p.id === id);
  if (!player) return null;

  const teamsById = {};
  bootstrap.teams.forEach((t) => {
    teamsById[t.id] = t;
  });

  const summary = await fetchJSON(`${FPL_BASE}/element-summary/${id}/`);
  const form = parseFloat(player.form) || 0;
  const position = POSITION_NAMES[player.element_type] || "";
  const team = teamsById[player.team];

  const lastFive = summary.history
    .slice(-5)
    .reverse()
    .map((h) => {
      const opponent = teamsById[h.opponent_team];
      return {
        opponent: opponent ? opponent.short_name : "???",
        isHome: h.was_home,
        points: h.total_points,
        minutes: h.minutes,
      };
    });

  // Same projectPoints() used for the main picks list, just read as a rough
  // points estimate per fixture rather than a ranking score.
  const nextFive = summary.fixtures.slice(0, 5).map((f) => {
    const opponentId = f.is_home ? f.team_a : f.team_h;
    const opponent = teamsById[opponentId];
    const projectedPoints = projectPoints({ position, form }, f.difficulty, f.is_home);

    return {
      opponent: opponent ? opponent.short_name : "???",
      isHome: f.is_home,
      difficulty: f.difficulty,
      projectedPoints,
    };
  });

  const teamGoalsById = computeTeamGoals(bootstrap);
  const benchmarks = computeBenchmarks(bootstrap);
  const gamesPlayed = getGamesPlayed(bootstrap);
  const { positiveStat, negativeStat } = getPlayerFacts(
    player,
    position,
    teamGoalsById,
    benchmarks,
    gamesPlayed
  );

  const nextFixture = nextFive[0];
  const projectedPoints = nextFixture
    ? nextFixture.projectedPoints
    : projectPoints({ position, form }, 3, false);

  const report = generateReport(
    {
      form,
      difficulty: nextFixture ? nextFixture.difficulty : 3,
      isHome: nextFixture ? nextFixture.isHome : false,
      opponent: nextFixture ? nextFixture.opponent : null,
      positiveStat,
      negativeStat,
    },
    projectedPoints
  );

  return {
    id: player.id,
    name: `${player.first_name} ${player.second_name}`,
    team: team ? team.name : "Unknown",
    position,
    form,
    photoCode: playerPhotoCode(player),
    teamBadge: teamBadgeUrl(team),
    positiveStat,
    negativeStat,
    trendingDown: form < 3,
    projectedPoints,
    report,
    lastFive,
    nextFive,
  };
}

app.get("/api/players/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) {
    return res.json({ results: [] });
  }

  try {
    const bootstrap = await getBootstrap();
    const teamsById = {};
    bootstrap.teams.forEach((t) => {
      teamsById[t.id] = t;
    });

    const results = bootstrap.elements
      .filter((p) => {
        const first = p.first_name.toLowerCase();
        const second = p.second_name.toLowerCase();
        const web = (p.web_name || "").toLowerCase();
        return first.includes(q) || second.includes(q) || web.includes(q);
      })
      .slice(0, 10)
      .map((p) => {
        const team = teamsById[p.team];
        return {
          id: p.id,
          name: `${p.first_name} ${p.second_name}`,
          team: team ? team.name : "Unknown",
          position: POSITION_NAMES[p.element_type] || "",
          photoCode: playerPhotoCode(p),
        };
      });

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed. Try again shortly." });
  }
});

app.get("/api/player/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid player id" });
  }

  try {
    const detail = await getPlayerDetail(id);
    if (!detail) {
      return res.status(404).json({ error: "Player not found" });
    }
    res.json(detail);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not load player details right now. Try again shortly.",
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Captain picks tool running at http://localhost:${PORT}`);
  });
}

export default app;
