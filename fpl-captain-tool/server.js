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
import { Redis } from "@upstash/redis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const FPL_BASE = "https://fantasy.premierleague.com/api";

// Vercel's Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN;
// Redis.fromEnv() picks those up automatically.
const redis = Redis.fromEnv();
const GAMEWEEK_INDEX_KEY = "gameweeks:index";

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

// FPL's bootstrap-static teams array doesn't include brand colors, so this is
// hardcoded from each club's actual primary kit/crest color. Keyed by
// team.short_name. Covers every club that's appeared in the Premier League
// in recent seasons (not just the current 20) so promotion/relegation
// doesn't leave a team silently falling back to the default gold.
const TEAM_COLORS = {
  ARS: "#EF0107",
  AVL: "#670E36",
  BOU: "#DA291C",
  BRE: "#E30613",
  BHA: "#0057B8",
  BUR: "#6C1D45",
  CHE: "#034694",
  COV: "#78D0F2",
  CRY: "#1B458F",
  EVE: "#003399",
  FUL: "#000000",
  HUL: "#F18A01",
  IPS: "#3A64A3",
  LEE: "#FFCD00",
  LEI: "#003090",
  LIV: "#C8102E",
  LUT: "#F78F1E",
  MCI: "#6CABDD",
  MUN: "#DA291C",
  NEW: "#241F20",
  NFO: "#DD0000",
  NOR: "#FFF200",
  SHU: "#EE2737",
  SOU: "#D71920",
  SUN: "#EB172B",
  TOT: "#132257",
  WAT: "#FBEE23",
  WBA: "#122F67",
  WHU: "#7A263A",
  WOL: "#FDB913",
};
const DEFAULT_TEAM_COLOR = "#d8a843"; // matches --gold, for any team not in the map above

function getTeamColor(team) {
  return (team && TEAM_COLORS[team.short_name]) || DEFAULT_TEAM_COLOR;
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

// --- Underlying-quality score ------------------------------------------------
//
// Both `score` (picks ranking) and `projectPoints` (points estimate) used to
// run on raw recent `form` alone, which can overreact to a single big or bad
// game. `qualityScore` blends that recent form with steadier signals so one
// wild match doesn't swing a player's number too far:
//  - points_per_game (season-long average) tempers a short hot/cold streak
//  - expected-goal involvements (xG + xA per 90) for MID/FWD — a better read
//    on a player's real chance quality than a handful of results
//  - expected goals conceded per 90 for GKP/DEF — a better clean-sheet-odds
//    signal than what literally went in, since it reflects the defense's
//    true quality against rather than a few bounces of the ball
//
// Falls back to blended form alone when FPL hasn't published xG data yet for
// a player, rather than treating a missing stat as a zero (which would
// otherwise look like a perfect defense or a total goal threat blank).
const FORM_RECENCY_WEIGHT = 0.6; // recent form
const FORM_SEASON_WEIGHT = 0.4; // points_per_game (season-long)

const XGI_WEIGHT = 1.15; // xG involvement counts slightly more than blended form
const XGC_WEIGHT = 1; // xG conceded counts about the same as blended form
const XG_SCALE = 10; // puts per-90 xG rates (~0–1) on FPL's 0–10 form scale
const XGC_BREAKEVEN = 1.5; // ~per-match expected goals conceded that's "average"

// How far a single gameweek's `form` value can jump week-over-week before
// it's treated as a standout (or disastrous) one-off rather than a real
// step-change in ability, and how far that jump gets pulled back toward
// last week's value when it is. Only applies for one cycle: next gameweek's
// snapshot becomes the new baseline, so a genuine step-change still shows
// up in full within a week or two.
const FORM_JUMP_DAMPENING_THRESHOLD = 3; // raw form-scale points, week-over-week
const FORM_JUMP_DAMPENING_FACTOR = 0.5; // 0 = ignore the jump entirely, 1 = no damping

// Softens a single standout (or disastrous) game's grip on the blended form
// number by comparing raw `form` against last gameweek's cached snapshot
// (see getPreviousFormById/saveGameweekSnapshot). `previousFormById` is null
// when no snapshot is available yet (first gameweek, Redis unreachable) or
// undefined for a given player when they weren't in the previous snapshot's
// (partial) coverage — the check is skipped gracefully in either case and
// the raw value is used as-is.
function dampSingleGameJump(playerId, rawForm, previousFormById) {
  const previousForm = previousFormById ? previousFormById.get(playerId) : undefined;
  if (previousForm == null) return rawForm;

  const jump = rawForm - previousForm;
  if (Math.abs(jump) < FORM_JUMP_DAMPENING_THRESHOLD) return rawForm;

  return previousForm + jump * FORM_JUMP_DAMPENING_FACTOR;
}

// Recent form blended with season-long points_per_game, so one huge or awful
// match doesn't swing a player's number too far. This is the one blended
// "how good is this player right now" number — qualityScore folds in xG on
// top of it for scoring/projections, and getFormStatus (below) buckets it
// for the trend arrows, the out-of-form list, and the modal's green/red tint.
function blendedForm(p, previousFormById) {
  const rawForm = parseFloat(p.form) || 0;
  const form = dampSingleGameJump(p.id, rawForm, previousFormById);
  const pointsPerGame = parseFloat(p.points_per_game) || 0;
  return form * FORM_RECENCY_WEIGHT + pointsPerGame * FORM_SEASON_WEIGHT;
}

function qualityScore(p, position, previousFormById) {
  const form = blendedForm(p, previousFormById);

  if (position === "MID" || position === "FWD") {
    const xgi = parseFloat(p.expected_goal_involvements_per_90);
    if (!Number.isFinite(xgi)) return form;
    const xgiScore = xgi * XG_SCALE;
    return (form + xgiScore * XGI_WEIGHT) / (1 + XGI_WEIGHT);
  }

  if (position === "GKP" || position === "DEF") {
    const xgc = parseFloat(p.expected_goals_conceded_per_90);
    if (!Number.isFinite(xgc)) return form;
    const xgcScore = Math.max(0, XGC_BREAKEVEN - xgc) * XG_SCALE;
    return (form + xgcScore * XGC_WEIGHT) / (1 + XGC_WEIGHT);
  }

  return form;
}

// --- Form status -------------------------------------------------------
//
// Single source of truth for whether a player counts as trending up,
// trending down, or neither. This used to be computed separately in four
// places with four different thresholds (trend arrows at raw form >=6/<3,
// the modal's green/red tint at raw form >=5/<3, the out-of-form cut at raw
// form <5) — so a player could show a green modal while getting no trend
// arrow in the picks list, or land in the out-of-form section without the
// modal ever calling them "bad". Everything now reads blendedForm(p) against
// one pair of thresholds.
const FORM_STATUS_GOOD_MIN = 5;
const FORM_STATUS_BAD_MAX = 3;

function getFormStatus(p, previousFormById) {
  const value = blendedForm(p, previousFormById);
  if (value >= FORM_STATUS_GOOD_MIN) return "good";
  if (value < FORM_STATUS_BAD_MAX) return "bad";
  return "neutral";
}

// --- Points projection -----------------------------------------------------
//
// One source of truth for "how many points is this player likely to get in
// this match", used by both the main picks list and the player detail
// modal's next-5-fixtures table. Deliberately separate from `score` above,
// which is a relative ranking number, not a points estimate.
function projectPoints(player, fixtureDifficulty, isHome) {
  const APPEARANCE_BASE = 2;
  const QUALITY_WEIGHT = 0.6;
  const HOME_BONUS = 0.3;
  const isDefensive = player.position === "GKP" || player.position === "DEF";
  const fixtureMultiplier = isDefensive ? 0.35 : 0.22; // clean sheets swing more on fixture ease

  const total =
    APPEARANCE_BASE +
    (player.quality || 0) * QUALITY_WEIGHT +
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

// Goals conceded per team, read off goalkeepers only (outfield players'
// goals_conceded can under/over-count relative to actual team minutes, but
// a team's GKs collectively track its real defensive record).
function computeTeamConceded(bootstrap) {
  const totals = {};
  bootstrap.elements.forEach((p) => {
    if (p.element_type === 1) {
      totals[p.team] = (totals[p.team] || 0) + (p.goals_conceded || 0);
    }
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

function plural(n, singular, pluralWord) {
  return n === 1 ? singular : pluralWord || `${singular}s`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Position-specific numeric clause for the report's opening fact. Returns a
// subject-less clause (e.g. "kept 2 clean sheets in 4 starts") so callers can
// drop it after a name, a pronoun, or nothing at all. Deliberately distinct
// from positiveStat/negativeStat (the short tag shown above the report) so
// the report adds new information rather than repeating it.
function statFact(player) {
  const starts = player.starts || 0;
  const bonus = player.bonus || 0;

  if (starts === 0) {
    return `barely featured this season, with zero starts`;
  }

  if (player.position === "GKP") {
    const cleanSheets = player.cleanSheets || 0;
    const saves = player.saves || 0;
    const goalsConceded = player.goalsConceded || 0;
    if (cleanSheets > 0) {
      return `kept ${cleanSheets} clean ${plural(cleanSheets, "sheet")} in ${starts} ${plural(starts, "start")}, conceding just ${goalsConceded}`;
    }
    if (saves >= 10) {
      return `made ${saves} saves across ${starts} ${plural(starts, "start")} behind a shaky defense`;
    }
    return `conceded ${goalsConceded} in ${starts} ${plural(starts, "start")} without a clean sheet to show for it`;
  }

  if (player.position === "DEF") {
    const cleanSheets = player.cleanSheets || 0;
    const goalsConceded = player.goalsConceded || 0;
    if (cleanSheets > 0) {
      return `kept ${cleanSheets} clean ${plural(cleanSheets, "sheet")} in ${starts} ${plural(starts, "start")}`;
    }
    if (bonus >= 6) {
      return `picked up ${bonus} bonus ${plural(bonus, "point")} this season despite going without a clean sheet`;
    }
    return `conceded ${goalsConceded} in ${starts} ${plural(starts, "start")} without a clean sheet`;
  }

  // MID / FWD
  const goals = player.goalsScored || 0;
  const assists = player.assists || 0;
  if (goals + assists >= 2) {
    return `posted ${goals} ${plural(goals, "goal")} and ${assists} ${plural(assists, "assist")} in ${starts} ${plural(starts, "start")}`;
  }
  if (bonus >= 6) {
    return `banked ${bonus} bonus ${plural(bonus, "point")} this season despite limited end product in front of goal`;
  }
  return `managed just ${goals} ${plural(goals, "goal")} and ${assists} ${plural(assists, "assist")} in ${starts} ${plural(starts, "start")}`;
}

// Ties the opening fact to the upcoming matchup using real opponent numbers
// (goals scored/conceded per game this season) rather than a generic
// "favorable fixture" label.
function matchupClause(player) {
  const opponent = player.opponent || "their opponent";
  const isAttacker = player.position === "MID" || player.position === "FWD";
  const perGame = isAttacker ? player.opponentConcededPerGame : player.opponentGoalsPerGame;

  if (perGame == null) {
    return `The matchup is rated ${player.difficulty}/5 for difficulty, ${player.isHome ? "at home" : "away"} to ${opponent}`;
  }

  const value = perGame.toFixed(1);
  if (isAttacker) {
    if (player.difficulty <= 2) {
      return `${opponent}'s defense has been leaky, conceding ${value} a game`;
    }
    if (player.difficulty >= 4) {
      return `${opponent} have held firm at the back, conceding just ${value} a game`;
    }
    return `${opponent} are conceding ${value} a game, a fair test either way`;
  }

  if (player.difficulty >= 4) {
    return `That record is tested by ${opponent}, who are averaging ${value} goals a game`;
  }
  if (player.difficulty <= 2) {
    return `${opponent} have managed just ${value} goals a game, a kind matchup`;
  }
  return `${opponent} are averaging ${value} goals a game, a fair test either way`;
}

function positionCategory(position) {
  if (position === "GKP") return "goalkeepers";
  if (position === "DEF") return "defenders";
  if (position === "FWD") return "forwards";
  return "midfielders";
}

// Closer templates for the report's final sentence. Rotates the same way
// statFact's opener does (by player id/form) so the ending varies as much
// as the opening — previously every report converged on one repeated
// "Projected for {X} points — [safer pick / stronger options exist]"
// template, restating a number that's already shown elsewhere on the card.
// Only two of the four (the ones that name a projection) mention the
// number at all; the other two deliver a plain-language verdict instead.
// Deliberately mixed short/long so reports don't all land at the same
// length and cadence.
const POSITIVE_CLOSERS = [
  (pts) => `Projected for ${pts} points — a near-lock captain option.`,
  () => `Worth the gamble if you're chasing a rank climb.`,
  (pts, player) =>
    `Projected for ${pts} points, currently outscoring most ${positionCategory(player.position)} in his price bracket.`,
  () => `Nothing flashy, but the underlying numbers back it up.`,
];

// Weak projections get their own skeptical pair rather than being forced
// into the (misleadingly upbeat) positive rotation above.
const SKEPTICAL_CLOSERS = [
  () => `The raw numbers don't back up the hype here.`,
  () => `There's real risk in this one.`,
];

function verdictClause(projectedPoints, player) {
  if (projectedPoints < 3.5) {
    const index = player.id % SKEPTICAL_CLOSERS.length;
    return SKEPTICAL_CLOSERS[index](projectedPoints, player);
  }
  const index = (player.id + Math.floor(projectedPoints)) % POSITIVE_CLOSERS.length;
  return POSITIVE_CLOSERS[index](projectedPoints, player);
}

// Combines a real recent stat, a matchup read using the opponent's actual
// scoring/conceding rate, and a verdict on the points projection into a
// tight, three-sentence analyst-style note. Both the opener and the closer
// rotate per player (by id and form/points) so reports don't all read as
// "{Name} is/has... Projected for {X} points — {same closer every time}".
function generateReport(player, projectedPoints) {
  const name = player.name;
  const trend = player.form >= 5 ? "up" : player.form < 3 ? "down" : "neutral";
  const fact = statFact(player);

  const openers = [
    (f) => `${capitalize(f)}.`,
    (f) => `He's ${f}.`,
    (f) =>
      trend === "down"
        ? `Quiet lately, but he's ${f}.`
        : `${capitalize(f)}, and the underlying numbers back it up.`,
    (f) => `${name} has ${f}.`,
  ];
  const openerIndex = (player.id + Math.floor(player.form)) % openers.length;
  const opening = openers[openerIndex](fact);

  const matchup = matchupClause(player);
  const verdict = verdictClause(projectedPoints, player);

  return [opening, matchup, verdict]
    .filter(Boolean)
    .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`))
    .join(" ");
}

// Builds the one scored player record shared by every section of the app
// (picks, differentials, avoid, out-of-form, trending) — used to be
// duplicated near-verbatim in four places, which is exactly how the GKP cap
// fix above only landed in one of them. `ctx` carries the
// per-gameweek lookups computed once in getCaptainPicks (fixtures, teams,
// season goal/conceded totals, benchmarks).
function buildPlayerRecord(p, ctx) {
  const { teamFixture, teamsById, teamGoalsById, teamConcededById, benchmarks, gamesPlayed, previousFormById } = ctx;

  const fixture = teamFixture[p.team];
  const position = POSITION_NAMES[p.element_type] || "";
  const form = parseFloat(p.form) || 0;
  const quality = qualityScore(p, position, previousFormById);
  const formStatus = getFormStatus(p, previousFormById);
  const fixtureScore = fixture ? 6 - fixture.difficulty : 3; // difficulty 1 (easy) -> 5, 5 (hard) -> 1
  const homeBonus = fixture && fixture.isHome ? 0.5 : 0;
  const score = Math.round((quality + fixtureScore * FIXTURE_WEIGHT + homeBonus) * 10) / 10;

  const team = teamsById[p.team];
  const opponent = fixture ? teamsById[fixture.opponentId] : null;
  const difficulty = fixture ? fixture.difficulty : 3;
  const isHome = fixture ? fixture.isHome : false;
  const { positiveStat, negativeStat } = getPlayerFacts(p, position, teamGoalsById, benchmarks, gamesPlayed);
  const projectedPoints = projectPoints({ position, quality }, difficulty, isHome);

  const player = {
    id: p.id,
    name: `${p.first_name} ${p.second_name}`,
    team: team ? team.name : "Unknown",
    position,
    opponent: opponent ? opponent.short_name : "???",
    isHome,
    difficulty,
    form,
    price: (p.now_cost / 10).toFixed(1),
    ownership: p.selected_by_percent,
    score,
    photoCode: playerPhotoCode(p),
    teamBadge: teamBadgeUrl(team),
    teamColor: getTeamColor(team),
    positiveStat,
    negativeStat,
    formStatus,
    trendingDown: formStatus === "bad",
    trendingUp: formStatus === "good",
    projectedPoints,
    consistencyTag: null, // set by applyVolatilityAdjustments for the targeted top-of-position candidates it checks
    starts: p.starts || 0,
    cleanSheets: p.clean_sheets || 0,
    goalsConceded: p.goals_conceded || 0,
    goalsScored: p.goals_scored || 0,
    assists: p.assists || 0,
    saves: p.saves || 0,
    bonus: p.bonus || 0,
    opponentGoalsPerGame: fixture ? (teamGoalsById[fixture.opponentId] || 0) / gamesPlayed : null,
    opponentConcededPerGame: fixture ? (teamConcededById[fixture.opponentId] || 0) / gamesPlayed : null,
  };
  player.report = generateReport(player, projectedPoints);
  return player;
}

// --- Consistency / volatility check -----------------------------------
//
// `score` above is built from recent form + xG, which both reward a player
// coming off one huge haul just as much as one coming off five steady
// decent games — this section tells those two apart. Deliberately scoped to
// a *targeted* candidate list (each position's current top ~20 by score),
// not the full player pool, since it costs one extra FPL API call per
// candidate checked and hundreds of players would mean hundreds of calls
// every cache cycle for players nowhere near the picks/tier lists anyway.
const VOLATILITY_CANDIDATE_LIMIT = 20; // per position
const VOLATILITY_CV_MIN_GAMES = 3; // need at least this many recent games to judge consistency
// Calibrated against real mid-season data, not picked round: FPL's per-match
// scoring is inherently lumpy (clean-sheet swings, one big attacking return
// among quiet games), so with only a handful of gameweeks played, CV across
// the top-of-position candidate pool typically spans ~0.3-1.5 with a median
// around 0.7 — a 0.6 cutoff flagged 70%+ of picks as "boom-or-bust", which
// defeats the point of a minority-outlier signal. 1.0 flags roughly the
// top ~10-15% of that pool, in line with how tier lists elsewhere in this
// app treat their own top slice (S tier = top ~10%).
const VOLATILITY_CV_THRESHOLD = 1.0; // coefficient of variation (stddev / mean) at/above this = "boom-or-bust"
const VOLATILITY_PENALTY_WEIGHT = 0.5; // flat score penalty applied to boom-or-bust players — tune here
const VOLATILITY_FETCH_CONCURRENCY = 8; // parallel element-summary requests while checking volatility

function coefficientOfVariation(values) {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean <= 0) return null; // ratio isn't meaningful for a player who barely scored at all
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// Runs `fn` over `items` with at most `limit` in flight at once, so checking
// ~80 candidates (20 per position x 4) doesn't fire that many requests at
// FPL's API in the same instant.
async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Flags and penalizes "boom-or-bust" players — high variance across their
// last 5 gameweek point totals relative to the mean — rather than leaving
// that risk hidden inside a score that reads the same whether it came from
// five steady 6-point games or one 20-point haul and four blanks. Mutates
// the given records in place: they're the same objects referenced from
// recordsById, so both the score penalty and the consistencyTag carry
// through to every section (picks, differentials, tier lists, ...) built
// from those objects afterwards.
async function applyVolatilityAdjustments(candidates) {
  await mapWithConcurrency(candidates, VOLATILITY_FETCH_CONCURRENCY, async (player) => {
    try {
      const summary = await fetchJSON(`${FPL_BASE}/element-summary/${player.id}/`);
      const lastFive = summary.history.slice(-5).map((h) => h.total_points);
      if (lastFive.length < VOLATILITY_CV_MIN_GAMES) return;

      const cv = coefficientOfVariation(lastFive);
      if (cv == null || cv < VOLATILITY_CV_THRESHOLD) return;

      player.consistencyTag = "Boom-or-bust";
      player.score = Math.round((player.score - VOLATILITY_PENALTY_WEIGHT) * 10) / 10;
    } catch (err) {
      // One player's element-summary failing shouldn't take down the whole
      // picks response — they just keep their un-penalized score and no tag.
      console.error(`Volatility check failed for player ${player.id}:`, err);
    }
  });
}

// --- Tier lists --------------------------------------------------------
//
// Buckets a position's scored-player pool into tiers (S/A/B/C/D) based on
// each player's rank within that position's own score distribution this
// gameweek, rather than fixed score thresholds — form and fixtures shift
// week to week, so a fixed cutoff would drift out of sync with what's
// actually a strong score for that position right now.
const TIER_CUTOFFS = [
  { tier: "S", cumulative: 0.1 }, // top ~10%
  { tier: "A", cumulative: 0.3 }, // next ~20%
  { tier: "B", cumulative: 0.55 },
  { tier: "C", cumulative: 0.8 },
  { tier: "D", cumulative: 1 },
];

function buildTierList(pool) {
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  const n = sorted.length;
  return sorted.map((player, index) => {
    const rankFraction = (index + 1) / n;
    const cutoff = TIER_CUTOFFS.find((c) => rankFraction <= c.cumulative) || TIER_CUTOFFS[TIER_CUTOFFS.length - 1];
    return { ...player, tier: cutoff.tier };
  });
}

// Reads last gameweek's cached snapshot (see saveGameweekSnapshot) to get
// each player's `form` going into this gameweek, for dampSingleGameJump
// above. The snapshot only covers last week's top-15-overall picks — not
// every player — so this is necessarily partial coverage; callers already
// treat a missing entry the same as no snapshot at all. Returns null (never
// throws) when there's no previous gameweek, no saved snapshot for it, or
// Redis is unreachable, so the dampening check is skipped gracefully rather
// than breaking the picks response.
async function getPreviousFormById(currentEventId) {
  if (currentEventId <= 1) return null;
  try {
    const snapshot = await redis.get(`gameweek:${currentEventId - 1}`);
    if (!snapshot || !Array.isArray(snapshot.picks)) return null;

    const map = new Map();
    snapshot.picks.forEach((p) => {
      if (typeof p.form === "number") map.set(p.id, p.form);
    });
    return map;
  } catch (err) {
    console.error("Could not load previous gameweek's form for dampening:", err);
    return null;
  }
}

// Looks up how last gameweek's #1 pick (by score, from the saved snapshot)
// actually scored, using the FPL API's per-gameweek live endpoint — a
// credibility check shown at the top of the page. Returns null (never
// throws) when there's no previous gameweek, no saved snapshot for it, or
// the live stats aren't available yet, so the frontend can just show
// nothing rather than an error. Only ever has real data starting from the
// second gameweek after this ships, since it depends on a prior snapshot.
async function getLastGameweekResult(currentEventId) {
  if (currentEventId <= 1) return null;
  const previousEventId = currentEventId - 1;

  try {
    const snapshot = await redis.get(`gameweek:${previousEventId}`);
    if (!snapshot || !Array.isArray(snapshot.picks) || snapshot.picks.length === 0) return null;

    const topPick = [...snapshot.picks].sort((a, b) => b.score - a.score)[0];
    if (!topPick) return null;

    const live = await fetchJSON(`${FPL_BASE}/event/${previousEventId}/live/`);
    const liveEntry = live.elements.find((e) => e.id === topPick.id);
    const actualPoints = liveEntry ? liveEntry.stats.total_points : null;
    if (actualPoints == null) return null;

    return {
      playerId: topPick.id,
      name: topPick.name,
      predictedRank: 1,
      actualPoints,
      gameweek: snapshot.gameweek,
    };
  } catch (err) {
    console.error("Could not load last gameweek's result:", err);
    return null;
  }
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
  const previousFormById = await getPreviousFormById(nextEvent.id);

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

  const POSITION_ORDER = ["GKP", "DEF", "MID", "FWD"];
  const OWNERSHIP_DIFFERENTIAL_MAX = 10; // percent — "nobody has them" territory
  const OWNERSHIP_AVOID_MIN = 15; // percent — popular enough that a bad week stings

  const teamGoalsById = computeTeamGoals(bootstrap);
  const teamConcededById = computeTeamConceded(bootstrap);
  const benchmarks = computeBenchmarks(bootstrap);
  const gamesPlayed = getGamesPlayed(bootstrap);

  const recordCtx = { teamFixture, teamsById, teamGoalsById, teamConcededById, benchmarks, gamesPlayed, previousFormById };

  // Every player gets a record, not just the ones eligible for the picks
  // sections below — avoidThisWeek pulls from a wider pool (any player above
  // the ownership threshold, including injury/rotation doubts) than
  // scoredPlayers' regularly-playing filter, so it needs to look up records
  // for players outside that pool too.
  const recordsById = {};
  bootstrap.elements.forEach((p) => {
    recordsById[p.id] = buildPlayerRecord(p, recordCtx);
  });

  const scoredPlayers = bootstrap.elements
    .filter((p) => p.status === "a") // "a" = available (not injured/suspended/on loan out)
    .filter((p) => p.minutes >= 180) // has actually been playing regularly
    .filter(
      (p) =>
        p.chance_of_playing_next_round === null ||
        p.chance_of_playing_next_round >= 75
    )
    .filter((p) => teamFixture[p.team]) // has a fixture this gameweek
    .map((p) => recordsById[p.id]);

  // Targeted volatility check (see applyVolatilityAdjustments above): each
  // position's current top ~20 by score, not the full pool. Mutates those
  // records' score/consistencyTag in place, so it has to run before picks,
  // differentials, avoidThisWeek, outOfForm, trending, and tierLists below
  // are built — they all sort/slice by score and need the adjusted number.
  const volatilityCandidates = POSITION_ORDER.flatMap((pos) =>
    scoredPlayers
      .filter((p) => p.position === pos)
      .sort((a, b) => b.score - a.score)
      .slice(0, VOLATILITY_CANDIDATE_LIMIT)
  );
  await applyVolatilityAdjustments(volatilityCandidates);

  // Top 15 per position, merged, rather than a single top-15-overall cut —
  // keeps every position fully represented so the position filter chips on
  // the frontend have real depth to show instead of whatever survived an
  // overall cross-position cut.
  const picks = POSITION_ORDER.flatMap((pos) =>
    scoredPlayers
      .filter((p) => p.position === pos)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
  );

  // Squads only ever carry 1-2 keepers, so no GKP-driven section should ever
  // surface more than 2 — INTENTIONAL, applied per-position (not a global
  // cut) so it can't silently regress the way it did before: outOfForm was
  // once fixed for DEF/MID/FWD depth without carrying this same cap over,
  // letting backup/rotation keepers with a single bad game flood that list.
  // Do not remove without re-checking both `differentials` and `outOfForm`.
  const GKP_CAP = 2;

  // Low-ownership players from the same pool who are still scoring well —
  // a chance to gain ground on the rest of your mini-league. Built from
  // scoredPlayers, so it already inherits that pool's minutes >= 180 filter.
  // Same per-position depth treatment as `picks` above, except goalkeepers
  // are capped (see GKP_CAP above) so the section isn't just a wall of
  // similarly-scored keepers.
  // Cloned (not the shared recordsById objects) so flagging the top
  // differential below can't leak isSleeperPick onto the same player's
  // entry in picks/outOfForm/etc., which reference those objects directly.
  const differentials = POSITION_ORDER.flatMap((pos) =>
    scoredPlayers
      .filter((p) => p.position === pos && parseFloat(p.ownership) < OWNERSHIP_DIFFERENTIAL_MAX)
      .sort((a, b) => b.score - a.score)
      .slice(0, pos === "GKP" ? GKP_CAP : 15)
  ).map((p) => ({ ...p }));

  if (differentials.length > 0) {
    [...differentials].sort((a, b) => b.score - a.score)[0].isSleeperPick = true;
  }

  // Widely-owned players worth a second thought. This pool intentionally
  // skips the availability/minutes filters above, since injury and rotation
  // doubts are exactly what we want to flag here.
  const avoidCandidates = bootstrap.elements
    .filter((p) => parseFloat(p.selected_by_percent) > OWNERSHIP_AVOID_MIN)
    .filter((p) => teamFixture[p.team])
    .map((p) => {
      const record = recordsById[p.id];
      const flagged =
        p.chance_of_playing_next_round !== null &&
        p.chance_of_playing_next_round < 75;

      let reason;
      if (flagged) {
        reason = "Rotation risk";
      } else if (record.difficulty >= 4) {
        reason = "Tough fixture";
      } else {
        reason = "Poor form";
      }

      return { ...record, reason, flagged };
    });

  const avoidThisWeek = avoidCandidates
    .sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      return a.score - b.score;
    })
    .slice(0, 15)
    .map(({ flagged, ...rest }) => rest);

  // Regularly-playing players whose form has genuinely dropped — a sustained
  // trend, unlike avoidThisWeek's single-gameweek risk flags. Filters on
  // formStatus (the same getFormStatus() result driving the trend arrows and
  // the modal's tint) rather than a separate form cutoff, so a player can't
  // be flagged out-of-form here while showing green everywhere else.
  // Ownership is intentionally NOT a filter here (only minutes, via
  // scoredPlayers, and form are) — requiring >=10% ownership on top of "bad"
  // form very nearly empties this section, since players who are genuinely
  // out of form are exactly the ones managers have already transferred out.
  // Goalkeepers are capped (see GKP_CAP above, INTENTIONAL): there are far
  // fewer eligible GKPs than outfield players, so a much larger fraction of
  // the GKP pool ends up with "bad" form (backup/rotation keepers who
  // conceded heavily in their few appearances), which would otherwise flood
  // this list with keepers even though a squad only ever needs 1-2.
  const outOfForm = POSITION_ORDER.flatMap((pos) =>
    scoredPlayers
      .filter((p) => p.position === pos && p.formStatus === "bad")
      .sort((a, b) => a.form - b.form)
      .slice(0, pos === "GKP" ? GKP_CAP : 15)
  );

  // Net transfers this gameweek, used to surface players the crowd is
  // moving in and out of ahead of the deadline.
  const transferMovers = bootstrap.elements.map((p) => ({
    ...recordsById[p.id],
    netTransfers: p.transfers_in_event - p.transfers_out_event,
  }));

  const trendingUp = [...transferMovers]
    .sort((a, b) => b.netTransfers - a.netTransfers)
    .slice(0, 15);

  const trendingDown = [...transferMovers]
    .sort((a, b) => a.netTransfers - b.netTransfers)
    .slice(0, 15);

  const tierLists = {};
  POSITION_ORDER.forEach((pos) => {
    tierLists[pos] = buildTierList(scoredPlayers.filter((p) => p.position === pos));
  });

  const lastGameweekResult = await getLastGameweekResult(nextEvent.id);

  const result = {
    gameweek: nextEvent.name,
    eventId: nextEvent.id,
    deadline: nextEvent.deadline_time,
    picks,
    differentials,
    avoidThisWeek,
    outOfForm,
    trendingUp,
    trendingDown,
    tierLists,
    lastGameweekResult,
  };

  cache = { data: result, expires: Date.now() + CACHE_MS };

  try {
    await saveGameweekSnapshot(result);
  } catch (err) {
    // Redis being unreachable shouldn't break the live picks response.
    console.error("Failed to save gameweek snapshot:", err);
  }

  return result;
}

// Saves a one-time-per-gameweek snapshot (top 15 picks by score) so past
// gameweeks stay browsable after they roll over. Guarded by an existence
// check so repeated cache refreshes within the same gameweek don't keep
// re-writing it.
async function saveGameweekSnapshot(result) {
  const key = `gameweek:${result.eventId}`;
  const alreadySaved = await redis.exists(key);
  if (alreadySaved) return;

  const topPicks = [...result.picks].sort((a, b) => b.score - a.score).slice(0, 15);
  const snapshot = {
    gameweek: result.gameweek,
    eventId: result.eventId,
    deadline: result.deadline,
    picks: topPicks,
  };

  await redis.set(key, snapshot);
  await redis.sadd(GAMEWEEK_INDEX_KEY, result.eventId);
}

app.get("/api/gameweek/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid gameweek id" });
  }

  try {
    const snapshot = await redis.get(`gameweek:${id}`);
    if (!snapshot) {
      return res.status(404).json({ error: "No saved snapshot for that gameweek." });
    }
    res.json(snapshot);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load that gameweek right now. Try again shortly." });
  }
});

app.get("/api/gameweeks", async (req, res) => {
  try {
    const ids = await redis.smembers(GAMEWEEK_INDEX_KEY);
    const gameweeks = ids.map(Number).sort((a, b) => b - a);
    res.json({ gameweeks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load saved gameweeks right now. Try again shortly." });
  }
});

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

  // Same dampening as the picks list (see dampSingleGameJump) so a player's
  // quality/form status can't disagree between the list and this modal.
  const currentEvent = bootstrap.events.find((e) => e.is_next) || bootstrap.events.find((e) => e.is_current);
  const previousFormById = currentEvent ? await getPreviousFormById(currentEvent.id) : null;

  const quality = qualityScore(player, position, previousFormById);
  const formStatus = getFormStatus(player, previousFormById);
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
    const projectedPoints = projectPoints({ position, quality }, f.difficulty, f.is_home);

    return {
      opponent: opponent ? opponent.short_name : "???",
      isHome: f.is_home,
      difficulty: f.difficulty,
      projectedPoints,
    };
  });

  const teamGoalsById = computeTeamGoals(bootstrap);
  const teamConcededById = computeTeamConceded(bootstrap);
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
    : projectPoints({ position, quality }, 3, false);

  const nextFixtureRaw = summary.fixtures[0];
  const nextFixtureOpponentId = nextFixtureRaw
    ? nextFixtureRaw.is_home
      ? nextFixtureRaw.team_a
      : nextFixtureRaw.team_h
    : null;

  const name = `${player.first_name} ${player.second_name}`;

  const report = generateReport(
    {
      id: player.id,
      name,
      position,
      form,
      difficulty: nextFixture ? nextFixture.difficulty : 3,
      isHome: nextFixture ? nextFixture.isHome : false,
      opponent: nextFixture ? nextFixture.opponent : null,
      positiveStat,
      negativeStat,
      starts: player.starts || 0,
      cleanSheets: player.clean_sheets || 0,
      goalsConceded: player.goals_conceded || 0,
      goalsScored: player.goals_scored || 0,
      assists: player.assists || 0,
      saves: player.saves || 0,
      bonus: player.bonus || 0,
      opponentGoalsPerGame:
        nextFixtureOpponentId != null ? (teamGoalsById[nextFixtureOpponentId] || 0) / gamesPlayed : null,
      opponentConcededPerGame:
        nextFixtureOpponentId != null ? (teamConcededById[nextFixtureOpponentId] || 0) / gamesPlayed : null,
    },
    projectedPoints
  );

  return {
    id: player.id,
    name,
    team: team ? team.name : "Unknown",
    position,
    form,
    photoCode: playerPhotoCode(player),
    teamBadge: teamBadgeUrl(team),
    teamColor: getTeamColor(team),
    positiveStat,
    negativeStat,
    formStatus,
    trendingDown: formStatus === "bad",
    trendingUp: formStatus === "good",
    formTier: formStatus,
    projectedPoints,
    report,
    lastFive,
    nextFive,
    yellowCards: player.yellow_cards || 0,
    redCards: player.red_cards || 0,
    tackles: player.tackles || 0,
    clearancesBlocksInterceptions: player.clearances_blocks_interceptions || 0,
    recoveries: player.recoveries || 0,
    defensiveContribution: player.defensive_contribution || 0,
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
