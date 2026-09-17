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

function renderTrendingColumn(title, players) {
  const rows = players
    .map(
      (player) => `
        <li class="trend__row">
          <span class="trend__name">${player.name}</span>
          <span class="trend__meta">${player.position} · ${player.team} · £${player.price}m</span>
          <span class="trend__net">${formatNetTransfers(player.netTransfers)}</span>
        </li>
      `
    )
    .join("");

  return `
    <div class="trend__column">
      <h3 class="trend__heading">${title}</h3>
      <ul class="trend__list">${rows}</ul>
    </div>
  `;
}

function renderPlayerList(players, options = {}) {
  const { highlightTop = false, avoidStyle = false } = options;

  const list = document.createElement("ol");
  list.className = "pick-list";

  players.forEach((player, index) => {
    const item = document.createElement("li");
    const isTop = highlightTop && index === 0;
    item.className = [
      "pick",
      isTop ? "pick--top" : "",
      avoidStyle ? "pick--avoid" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const { className: difficultyClass, label: difficultyLabel } = difficultyInfo(
      player.difficulty
    );

    item.innerHTML = `
      <span class="pick__rank">${index + 1}</span>
      <span class="pick__main">
        <span class="pick__name">${player.name}${
      isTop ? '<span class="pick__badge">Top pick</span>' : ""
    }</span>
        <span class="pick__meta">${player.position} · ${player.team} · £${player.price}m${
      player.reason ? ` · <span class="pick__reason">${player.reason}</span>` : ""
    }</span>
      </span>
      <span class="pick__fixture fixture--${difficultyClass}" title="${difficultyLabel}">
        ${player.isHome ? "vs" : "@"} ${player.opponent}
      </span>
      <span class="pick__form">Form ${player.form.toFixed(1)}</span>
      <span class="pick__score">${player.score.toFixed(1)}</span>
    `;

    list.appendChild(item);
  });

  return list;
}

function renderSection(sectionId, title, caption, players, options) {
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
  section.appendChild(renderPlayerList(players, options));
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
    <div class="trending__columns">
      ${renderTrendingColumn("Trending in", data.trendingUp || [])}
      ${renderTrendingColumn("Trending out", data.trendingDown || [])}
    </div>
  `;
}

async function loadCaptainPicks() {
  const board = document.getElementById("board");
  const gameweekLabel = document.getElementById("gameweek-label");
  const deadlineLabel = document.getElementById("deadline-label");

  board.innerHTML = '<p class="board__loading">Pulling this week\'s fixtures and form…</p>';

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
      board.innerHTML =
        '<p class="board__empty">No picks available yet — check back closer to the deadline.</p>';
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

    board.innerHTML = "";
    board.appendChild(header);
    board.appendChild(renderPlayerList(data.picks, { highlightTop: true }));

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
      { avoidStyle: true }
    );
  } catch (err) {
    console.error(err);
    board.innerHTML = "";
    ["trending", "differentials", "avoid"].forEach((id) => {
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

loadCaptainPicks();
