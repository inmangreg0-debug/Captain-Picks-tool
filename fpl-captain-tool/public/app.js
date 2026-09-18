const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const POSITIONS = ["All", "GKP", "DEF", "MID", "FWD"];
const SORT_OPTIONS = [
  { key: "score", label: "Score" },
  { key: "price", label: "Price" },
  { key: "ownership", label: "Ownership" },
];

let allPicks = [];
let boardFilter = "All";
let boardSort = "score";

function formatNetTransfers(n) {
  const sign = n >= 0 ? "+" : "−";
  const abs = Math.abs(n);

  let abbreviated;
  if (abs >= 1_000_000) {
    abbreviated = `${(abs / 1_000_000).toFixed(1)}M`;
  } else if (abs >= 1_000) {
    abbreviated = `${(abs / 1_000).toFixed(1)}K`;
  } else {
    abbreviated = `${abs}`;
  }

  return `${sign}${abbreviated}`;
}

function difficultyInfo(difficulty) {
  if (difficulty <= 2) return { className: "easy", label: "Easy fixture" };
  if (difficulty >= 4) return { className: "hard", label: "Tough fixture" };
  return { className: "medium", label: "Medium fixture" };
}

function playerPhotoUrl(player) {
  return player.photoCode
    ? `https://resources.premierleague.com/premierleague/photos/players/110x140/p${player.photoCode}.png`
    : null;
}

// Fixed-size wrapper is always rendered so rows don't shift once the image
// loads (or fails) — onerror just drops the <img>, leaving the placeholder.
function playerPhotoMarkup(player) {
  const url = playerPhotoUrl(player);
  return `<span class="player-photo">${
    url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()" />` : ""
  }</span>`;
}

function teamBadgeMarkup(player) {
  if (!player.teamBadge) return "";
  return `<img class="team-badge" src="${player.teamBadge}" alt="" loading="lazy" onerror="this.remove()" />`;
}

// Reveals players beyond `initialLimit` on click. Returns null (and does
// nothing) when there aren't more players than the limit to reveal.
function attachShowAllToggle(listEl, initialLimit) {
  const items = Array.from(listEl.children);
  if (items.length <= initialLimit) return null;

  const extra = items.slice(initialLimit);
  extra.forEach((item) => item.classList.add("is-hidden"));

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "show-all-toggle";
  toggle.textContent = `Show all (${items.length})`;

  let expanded = false;
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    if (expanded) {
      extra.forEach((item, i) => {
        item.classList.remove("is-hidden");
        if (!REDUCED_MOTION) {
          item.classList.remove("reveal-in");
          item.style.animationDelay = `${Math.min(i * 50, 400)}ms`;
          void item.offsetWidth; // restart the animation on repeat expands
          item.classList.add("reveal-in");
        }
      });
    } else {
      extra.forEach((item) => {
        item.classList.add("is-hidden");
        item.classList.remove("reveal-in");
      });
    }
    toggle.textContent = expanded ? "Show less" : `Show all (${items.length})`;
  });

  return toggle;
}

function skeletonPickRow() {
  return `
    <li class="pick skeleton-pick">
      <span class="skeleton skeleton-pick__rank"></span>
      <span class="skeleton-pick__main">
        <span class="skeleton skeleton-pick__avatar"></span>
        <span class="skeleton-pick__text">
          <span class="skeleton skeleton-pick__name"></span>
          <span class="skeleton skeleton-pick__meta"></span>
        </span>
      </span>
      <span class="skeleton skeleton-pick__fixture"></span>
      <span class="skeleton skeleton-pick__form"></span>
      <span class="skeleton skeleton-pick__score"></span>
    </li>
  `;
}

function renderSkeletonList(count) {
  return `<ol class="pick-list skeleton-list">${Array.from({ length: count }, skeletonPickRow).join("")}</ol>`;
}

function renderSkeletonBoard(count = 6) {
  return renderSkeletonList(count);
}

function renderSkeletonSection(count = 3) {
  return `
    <span class="skeleton skeleton-section-title"></span>
    <span class="skeleton skeleton-section-caption"></span>
    ${renderSkeletonList(count)}
  `;
}

function renderTrendingColumn(title, players) {
  const column = document.createElement("div");
  column.className = "trend__column";

  const heading = document.createElement("h3");
  heading.className = "trend__heading";
  heading.textContent = title;
  column.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "trend__list";
  list.innerHTML = players
    .map(
      (player) => `
        <li class="trend__row">
          <span class="trend__player">
            ${playerPhotoMarkup(player)}
            <span class="trend__name"><button type="button" class="player-link" data-player-id="${player.id}">${player.name}</button></span>
          </span>
          <span class="trend__meta">${player.position} · ${teamBadgeMarkup(player)}${player.team} · £${player.price}m</span>
          <span class="trend__net">${formatNetTransfers(player.netTransfers)}</span>
        </li>
      `
    )
    .join("");
  column.appendChild(list);

  const toggle = attachShowAllToggle(list, 6);
  if (toggle) column.appendChild(toggle);

  return column;
}

function renderPlayerList(players, options = {}) {
  const { highlightTop = false, avoidStyle = false, mediumStyle = false } = options;

  const list = document.createElement("ol");
  list.className = "pick-list";

  players.forEach((player, index) => {
    const item = document.createElement("li");
    const isTop = highlightTop && index === 0;
    item.className = [
      "pick",
      isTop ? "pick--top" : "",
      avoidStyle ? "pick--avoid" : "",
      mediumStyle ? "pick--outofform" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const { className: difficultyClass, label: difficultyLabel } = difficultyInfo(
      player.difficulty
    );

    item.innerHTML = `
      <span class="pick__rank">${index + 1}</span>
      <span class="pick__main">
        ${playerPhotoMarkup(player)}
        <span class="pick__text">
          <span class="pick__name"><button type="button" class="player-link" data-player-id="${player.id}">${player.name}</button>${
      isTop ? '<span class="pick__badge">Top pick</span>' : ""
    }</span>
          <span class="pick__meta">${player.position} · ${teamBadgeMarkup(player)}${player.team} · £${player.price}m${
      player.reason ? ` · <span class="pick__reason">${player.reason}</span>` : ""
    }</span>
        </span>
      </span>
      <span class="pick__fixture fixture--${difficultyClass}" title="${difficultyLabel}">
        ${player.isHome ? "vs" : "@"} ${player.opponent}
      </span>
      <span class="pick__form">Form ${player.form.toFixed(1)}</span>
      <span class="pick__score">
        <span class="pick__score-value">${
          player.trendingDown
            ? '<span class="pick__trend-down" title="Trending down" aria-label="Trending down">▼</span>'
            : player.trendingUp
            ? '<span class="pick__trend-up" title="Trending up" aria-label="Trending up">▲</span>'
            : ""
        }${player.score.toFixed(1)}</span>
        ${
          typeof player.projectedPoints === "number"
            ? `<span class="pick__proj">Proj: ${player.projectedPoints.toFixed(1)} pts</span>`
            : ""
        }
      </span>
    `;

    list.appendChild(item);
  });

  return list;
}

function getFilteredSortedPicks() {
  const filtered =
    boardFilter === "All" ? allPicks : allPicks.filter((p) => p.position === boardFilter);

  const sorted = [...filtered];
  if (boardSort === "price") {
    sorted.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  } else if (boardSort === "ownership") {
    sorted.sort((a, b) => parseFloat(b.ownership) - parseFloat(a.ownership));
  } else {
    sorted.sort((a, b) => b.score - a.score);
  }
  return sorted;
}

function renderBoardControls(container) {
  const controls = document.createElement("div");
  controls.className = "board-controls";

  const chipsWrap = document.createElement("div");
  chipsWrap.className = "filter-chips";
  chipsWrap.setAttribute("role", "group");
  chipsWrap.setAttribute("aria-label", "Filter by position");
  POSITIONS.forEach((pos) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip" + (boardFilter === pos ? " is-active" : "");
    chip.textContent = pos;
    chip.addEventListener("click", () => {
      if (boardFilter === pos) return;
      boardFilter = pos;
      renderBoard();
    });
    chipsWrap.appendChild(chip);
  });

  const sortWrap = document.createElement("div");
  sortWrap.className = "sort-toggle";
  sortWrap.setAttribute("role", "group");
  sortWrap.setAttribute("aria-label", "Sort by");
  SORT_OPTIONS.forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sort-btn" + (boardSort === key ? " is-active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (boardSort === key) return;
      boardSort = key;
      renderBoard();
    });
    sortWrap.appendChild(btn);
  });

  controls.appendChild(chipsWrap);
  controls.appendChild(sortWrap);
  container.appendChild(controls);
}

function renderBoard() {
  const board = document.getElementById("board");
  if (!board) return;

  board.innerHTML = "";
  renderBoardControls(board);

  const filtered = getFilteredSortedPicks();

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "board__empty";
    empty.textContent = "No players match this filter.";
    board.appendChild(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "pick-header";
  header.innerHTML = `
    <span></span>
    <span>Player</span>
    <span>Fixture</span>
    <span>Form</span>
    <span>Score</span>
  `;
  board.appendChild(header);

  const highlightTop = boardFilter === "All" && boardSort === "score";
  const picksList = renderPlayerList(filtered, { highlightTop });
  board.appendChild(picksList);
  const picksToggle = attachShowAllToggle(picksList, 6);
  if (picksToggle) board.appendChild(picksToggle);
}

function renderSection(sectionId, title, caption, players, options = {}) {
  const section = document.getElementById(sectionId);
  if (!section) return;

  if (!players || players.length === 0) {
    section.innerHTML = "";
    return;
  }

  section.innerHTML = `
    <h2 class="section-heading">${title}</h2>
    <p class="section-caption">${caption}</p>
  `;
  const list = renderPlayerList(players, options);
  section.appendChild(list);

  const toggle = attachShowAllToggle(list, options.initialLimit || 6);
  if (toggle) section.appendChild(toggle);
}

function renderTrending(data) {
  const trending = document.getElementById("trending");
  if (!trending) return;

  if (!data.trendingUp?.length && !data.trendingDown?.length) {
    trending.innerHTML = "";
    return;
  }

  trending.innerHTML = `
    <h2 class="trending__title">Trending this gameweek</h2>
    <p class="trending__caption">Net transfers in vs. out since the last deadline.</p>
  `;

  const columns = document.createElement("div");
  columns.className = "trending__columns";
  columns.appendChild(renderTrendingColumn("Trending in", data.trendingUp || []));
  columns.appendChild(renderTrendingColumn("Trending out", data.trendingDown || []));
  trending.appendChild(columns);
}

function playerFixtureRow(entry, kind) {
  if (kind === "past") {
    return `
      <tr>
        <td>${entry.isHome ? "vs" : "@"} ${entry.opponent}</td>
        <td>${entry.points}</td>
        <td>${entry.minutes}'</td>
      </tr>
    `;
  }

  const { className, label } = difficultyInfo(entry.difficulty);
  return `
    <tr>
      <td>${entry.isHome ? "vs" : "@"} ${entry.opponent}</td>
      <td><span class="fixture-tag fixture--${className}">${label}</span></td>
      <td>${entry.projectedPoints.toFixed(1)}</td>
    </tr>
  `;
}

function renderPlayerModalContent(detail) {
  const lastFiveRows = detail.lastFive.length
    ? detail.lastFive.map((h) => playerFixtureRow(h, "past")).join("")
    : '<tr><td colspan="3">No gameweeks played yet this season.</td></tr>';

  const nextFiveRows = detail.nextFive.length
    ? detail.nextFive.map((f) => playerFixtureRow(f, "future")).join("")
    : '<tr><td colspan="3">No fixtures scheduled.</td></tr>';

  const photoUrl = playerPhotoUrl(detail);
  const photoHtml = photoUrl
    ? `<img class="player-modal__photo" src="${photoUrl}" alt="" loading="lazy" onerror="this.remove()" />`
    : "";

  const positiveHtml = detail.positiveStat
    ? `<p class="player-modal__stat player-modal__stat--positive">${detail.positiveStat}</p>`
    : "";
  const negativeHtml = detail.negativeStat
    ? `<p class="player-modal__stat player-modal__stat--negative">${detail.negativeStat}</p>`
    : "";
  const reportHtml = detail.report
    ? `<p class="player-modal__report">${detail.report}</p>`
    : "";

  return `
    ${photoHtml}
    <h2 id="player-modal-name" class="player-modal__title">${detail.name}</h2>
    <p class="player-modal__meta">${detail.position} · ${detail.team} · Form ${detail.form.toFixed(1)}</p>
    ${positiveHtml}
    ${negativeHtml}
    ${reportHtml}
    <div class="player-modal__section">
      <h3 class="player-modal__heading">Last 5 gameweeks</h3>
      <table class="player-modal__table">
        <thead><tr><th>Opponent</th><th>Pts</th><th>Mins</th></tr></thead>
        <tbody>${lastFiveRows}</tbody>
      </table>
    </div>
    <div class="player-modal__section">
      <h3 class="player-modal__heading">Next 5 fixtures</h3>
      <table class="player-modal__table">
        <thead><tr><th>Opponent</th><th>Difficulty</th><th>Proj. pts</th></tr></thead>
        <tbody>${nextFiveRows}</tbody>
      </table>
    </div>
  `;
}

function openPlayerModal(id) {
  const modal = document.getElementById("player-modal");
  const body = document.getElementById("player-modal-body");
  const panel = modal ? modal.querySelector(".player-modal__panel") : null;
  if (!modal || !body) return;

  modal.hidden = false;
  document.body.classList.add("modal-open");
  body.innerHTML = '<p class="player-modal__loading">Loading player…</p>';
  if (panel) panel.classList.remove("modal--good", "modal--bad");

  requestAnimationFrame(() => {
    modal.classList.add("is-open");
  });

  fetch(`/api/player/${id}`)
    .then((res) => {
      if (!res.ok) throw new Error("Request failed");
      return res.json();
    })
    .then((detail) => {
      body.innerHTML = renderPlayerModalContent(detail);
      if (panel && detail.formTier === "good") {
        panel.classList.add("modal--good");
      } else if (panel && detail.formTier === "bad") {
        panel.classList.add("modal--bad");
      }
    })
    .catch((err) => {
      console.error(err);
      body.innerHTML =
        '<p class="player-modal__error">Could not load player details right now.</p>';
    });
}

function closePlayerModal() {
  const modal = document.getElementById("player-modal");
  const body = document.getElementById("player-modal-body");
  if (!modal) return;

  modal.classList.remove("is-open");
  document.body.classList.remove("modal-open");

  const finish = () => {
    modal.hidden = true;
    if (body) body.innerHTML = "";
  };

  if (REDUCED_MOTION) {
    finish();
  } else {
    setTimeout(finish, 200);
  }
}

function initPlayerModal() {
  const modal = document.getElementById("player-modal");
  const closeButton = document.getElementById("player-modal-close");
  if (!modal || !closeButton) return;

  closeButton.addEventListener("click", closePlayerModal);
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.dismiss === "backdrop") closePlayerModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closePlayerModal();
  });
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest(".player-link[data-player-id]");
    if (!trigger) return;
    openPlayerModal(trigger.dataset.playerId);
  });
}

async function loadCaptainPicks() {
  const board = document.getElementById("board");
  const gameweekLabel = document.getElementById("gameweek-label");
  const deadlineLabel = document.getElementById("deadline-label");

  board.innerHTML = renderSkeletonBoard(6);
  ["trending", "differentials", "avoid", "out-of-form"].forEach((id) => {
    const section = document.getElementById(id);
    if (section) section.innerHTML = renderSkeletonSection(3);
  });

  try {
    const res = await fetch("/api/captain-picks");
    if (!res.ok) throw new Error("Request failed");
    const data = await res.json();

    gameweekLabel.textContent = data.gameweek;

    if (data.deadline) {
      const deadline = new Date(data.deadline);
      deadlineLabel.textContent = `Deadline: ${deadline.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }

    if (!data.picks || data.picks.length === 0) {
      allPicks = [];
      board.innerHTML =
        '<p class="board__empty">No picks available yet — check back closer to the deadline.</p>';
      return;
    }

    allPicks = data.picks;
    boardFilter = "All";
    boardSort = "score";
    renderBoard();

    renderTrending(data);
    renderSection(
      "differentials",
      "Differentials",
      "Low-ownership players with strong underlying scores — a chance to gain ground on rivals.",
      data.differentials
    );
    renderSection(
      "avoid",
      "Think twice about captaining",
      "Popular picks carrying extra risk this week — captain with caution.",
      data.avoidThisWeek,
      { avoidStyle: true, initialLimit: 5 }
    );
    renderSection(
      "out-of-form",
      "Out of form",
      "Still widely owned, but form has dropped — worth a look before your next transfer.",
      data.outOfForm,
      { mediumStyle: true, initialLimit: 5 }
    );
  } catch (err) {
    console.error(err);
    allPicks = [];
    board.innerHTML = "";
    ["trending", "differentials", "avoid", "out-of-form"].forEach((id) => {
      const section = document.getElementById(id);
      if (section) section.innerHTML = "";
    });

    const errorMessage = document.createElement("p");
    errorMessage.className = "board__error";
    errorMessage.textContent = "Could not load captain picks right now.";

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "board__retry";
    retryButton.textContent = "Try again";
    retryButton.addEventListener("click", loadCaptainPicks);

    board.appendChild(errorMessage);
    board.appendChild(retryButton);
  }
}

function initPlayerSearch() {
  const container = document.getElementById("player-search");
  const input = document.getElementById("player-search-input");
  const resultsList = document.getElementById("player-search-results");
  if (!container || !input || !resultsList) return;

  let debounceTimer = null;
  let requestId = 0;

  function clearResults() {
    resultsList.innerHTML = "";
    resultsList.hidden = true;
  }

  function renderResults(results) {
    if (!results.length) {
      clearResults();
      return;
    }

    resultsList.innerHTML = results
      .map(
        (r) => `
          <li class="player-search__result">
            <button type="button" class="player-search__result-btn" data-player-id="${r.id}">
              ${playerPhotoMarkup(r)}
              <span class="player-search__result-text">
                <span class="player-search__result-name">${r.name}</span>
                <span class="player-search__result-meta">${r.position} · ${r.team}</span>
              </span>
            </button>
          </li>
        `
      )
      .join("");
    resultsList.hidden = false;
  }

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(debounceTimer);

    if (!query) {
      clearResults();
      return;
    }

    debounceTimer = setTimeout(() => {
      const thisRequestId = ++requestId;
      fetch(`/api/players/search?q=${encodeURIComponent(query)}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Request failed"))))
        .then((data) => {
          if (thisRequestId !== requestId) return; // a newer search superseded this one
          renderResults(data.results || []);
        })
        .catch(() => {
          if (thisRequestId !== requestId) return;
          clearResults();
        });
    }, 300);
  });

  resultsList.addEventListener("click", (e) => {
    const button = e.target.closest(".player-search__result-btn[data-player-id]");
    if (!button) return;
    openPlayerModal(button.dataset.playerId);
    clearResults();
    input.value = "";
  });

  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) clearResults();
  });
}

function initPullToRefresh() {
  if (!("ontouchstart" in window)) return;

  const THRESHOLD = 70;
  let startY = null;
  let pulling = false;
  let indicator = null;

  function createIndicator() {
    const el = document.createElement("div");
    el.className = "ptr-indicator";
    el.innerHTML = '<span class="ptr-spinner"></span>';
    document.body.appendChild(el);
    return el;
  }

  function removeIndicator() {
    if (indicator) {
      indicator.remove();
      indicator = null;
    }
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (window.scrollY > 0 || document.body.classList.contains("modal-open")) {
        startY = null;
        return;
      }
      startY = e.touches[0].clientY;
      pulling = false;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (startY === null || window.scrollY > 0) return;
      const delta = e.touches[0].clientY - startY;
      if (delta > 10) {
        pulling = true;
        if (!indicator) indicator = createIndicator();
        const pull = Math.min(delta, THRESHOLD * 1.5);
        indicator.style.opacity = String(Math.min(pull / THRESHOLD, 1));
        indicator.classList.toggle("is-ready", pull >= THRESHOLD);
      }
    },
    { passive: true }
  );

  document.addEventListener("touchend", (e) => {
    if (!pulling || startY === null) {
      startY = null;
      return;
    }

    const delta = e.changedTouches[0].clientY - startY;
    pulling = false;
    startY = null;

    if (delta >= THRESHOLD) {
      if (indicator) indicator.classList.add("is-loading");
      loadCaptainPicks().finally(removeIndicator);
    } else {
      removeIndicator();
    }
  });
}

initPlayerModal();
initPlayerSearch();
initPullToRefresh();
loadCaptainPicks();
