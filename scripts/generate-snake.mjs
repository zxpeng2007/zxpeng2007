// Generates a "growing snake" animation SVG from a GitHub user's public
// contribution graph. Unlike the classic snake-game solver (fixed-length
// snake, self-avoiding pathfinding), this sweeps the grid in a fixed
// serpentine (boustrophedon) order, so the snake can never self-collide,
// and grows in length by the contribution level of each cell it eats.
//
// Usage: node scripts/generate-snake.mjs <github_user_name> <out_dir>

const [, , userName, outDir = "dist"] = process.argv;

if (!userName) {
  console.error("usage: generate-snake.mjs <github_user_name> [out_dir]");
  process.exit(1);
}

const CELL = 12;
const PITCH = 16;
const MS_PER_STEP = 50;

const PALETTES = {
  light: {
    cb: "#1b1f230a",
    cs: "purple",
    ce: "#ebedf0",
    c0: "#ebedf0",
    c1: "#9be9a8",
    c2: "#40c463",
    c3: "#30a14e",
    c4: "#216e39",
  },
  dark: {
    cb: "#1b1f230a",
    cs: "purple",
    ce: "#161b22",
    c0: "#161b22",
    c1: "#01311f",
    c2: "#034525",
    c3: "#0f6d31",
    c4: "#00c647",
  },
};

async function fetchContributionCells(userName) {
  const res = await fetch(`https://github.com/users/${userName}/contributions`, {
    headers: { "User-Agent": "me@platane.me" },
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const cells = [];
  const re = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"/g;
  let m;
  while ((m = re.exec(html)) !== null)
    cells.push({ date: m[1], level: Number(m[2]) });

  if (cells.length === 0) throw new Error("no contribution cells found");

  const origin = new Date(cells[0].date);
  return cells.map(({ date, level }) => {
    const d = new Date(date);
    const days = Math.round((d.getTime() - origin.getTime()) / 86400_000);
    return { x: Math.floor(days / 7), y: d.getUTCDay(), date, level };
  });
}

// Serpentine (boustrophedon) order: down column 0, up column 1, down column 2, ...
// Guarantees a Hamiltonian path with no self-crossing, so no collision solving needed.
function toSerpentinePath(cells) {
  const byColumn = new Map();
  for (const cell of cells) {
    if (!byColumn.has(cell.x)) byColumn.set(cell.x, []);
    byColumn.get(cell.x).push(cell);
  }

  const path = [];
  const columns = [...byColumn.keys()].sort((a, b) => a - b);
  for (const x of columns) {
    const col = byColumn.get(x).sort((a, b) => a.y - b.y);
    if (x % 2 === 1) col.reverse();
    path.push(...col);
  }
  return path;
}

// Each cell's own contribution level directly sets how many steps it
// stays lit as part of the snake after being eaten (level 1 -> 1 step,
// level 4 -> 4 steps), independent of every other cell. There's no
// shared body/backlog state to carry over between days, so a run of
// high-contribution days can never snowball into a long hangover tail:
// at most ~4 overlapping cells can ever be lit at once (a run of
// several consecutive max-level days), never the whole grid.
function simulateGrowth(path) {
  const timing = new Map(); // cellIndex -> { enter, leave }
  let maxLeave = 0;

  path.forEach((cell, i) => {
    const duration = Math.max(1, cell.level);
    const leave = i + duration;
    timing.set(i, { enter: i, leave });
    maxLeave = Math.max(maxLeave, leave);
  });

  return { timing, totalSteps: Math.max(path.length, maxLeave) };
}

function pct(step, totalSteps) {
  return Math.min(100, (step / totalSteps) * 100).toFixed(2);
}

function buildSvg(cells, path, timing, totalSteps, palette) {
  const numWeeks = Math.max(...cells.map((c) => c.x)) + 1;
  const width = numWeeks * PITCH + 2 * (PITCH - CELL);
  const height = 7 * PITCH + 2 * (PITCH - CELL);
  const duration = totalSteps * MS_PER_STEP;

  const vars = Object.entries(palette)
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");

  const levelVar = (level) => `var(--c${level})`;

  let style = `:root{${vars}}`;
  style +=
    `.c{shape-rendering:geometricPrecision;stroke-width:1px;stroke:var(--cb);` +
    `animation:none ${duration}ms linear infinite;width:${CELL}px;height:${CELL}px}`;

  const rects = [];

  path.forEach((cell, i) => {
    const { enter, leave } = timing.get(i);
    const cls = `k${i}`;
    const enterPct = pct(enter, totalSteps);
    const leavePct = pct(leave, totalSteps);
    const leaveEndPct = pct(Math.min(leave + 1, totalSteps), totalSteps);

    style +=
      `@keyframes ${cls}{` +
      `${enterPct}%,${leavePct}%{fill:var(--cs)}` +
      `${leaveEndPct}%,100%{fill:var(--ce)}` +
      `}`;
    style += `.c.${cls}{fill:${levelVar(cell.level)};animation-name:${cls}}`;

    const x = (PITCH - CELL) + cell.x * PITCH;
    const y = (PITCH - CELL) + cell.y * PITCH;
    rects.push(`<rect class="c ${cls}" x="${x}" y="${y}" rx="2" ry="2"/>`);
  });

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<desc>Growing snake, length proportional to contributions eaten</desc>` +
    `<style>${style}</style>${rects.join("")}</svg>`
  );
}

const cells = await fetchContributionCells(userName);
const path = toSerpentinePath(cells);
const { timing, totalSteps } = simulateGrowth(path);

const fs = await import("node:fs");
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  `${outDir}/github-contribution-grid-snake.svg`,
  buildSvg(cells, path, timing, totalSteps, PALETTES.light),
);
fs.writeFileSync(
  `${outDir}/github-contribution-grid-snake-dark.svg`,
  buildSvg(cells, path, timing, totalSteps, PALETTES.dark),
);

console.log(`wrote ${path.length} cells, ${totalSteps} steps, ${outDir}/`);
