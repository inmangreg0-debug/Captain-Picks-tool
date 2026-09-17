async function loadCaptainPicks() {
  const board = document.getElementById("board");
  const gameweekLabel = document.getElementById("gameweek-label");
  const deadlineLabel = document.getElementById("deadline-label");

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

    const list = document.createElement("ol");
    list.className = "pick-list";

    data.picks.forEach((pick, index) => {
      const item = document.createElement("li");
      item.className = "pick";

      const difficultyClass =
        pick.difficulty <= 2 ? "easy" : pick.difficulty >= 4 ? "hard" : "medium";

      item.innerHTML = `
        <span class="pick__rank">${index + 1}</span>
        <span class="pick__main">
          <span class="pick__name">${pick.name}</span>
          <span class="pick__meta">${pick.position} · ${pick.team} · £${pick.price}m</span>
        </span>
        <span class="pick__fixture fixture--${difficultyClass}">
          ${pick.isHome ? "vs" : "@"} ${pick.opponent}
        </span>
        <span class="pick__form">Form ${pick.form.toFixed(1)}</span>
        <span class="pick__score">${pick.score.toFixed(1)}</span>
      `;

      list.appendChild(item);
    });

    board.innerHTML = "";
    board.appendChild(list);
  } catch (err) {
    console.error(err);
    board.innerHTML =
      '<p class="board__error">Could not load captain picks right now. Try refreshing in a minute.</p>';
  }
}

loadCaptainPicks();
