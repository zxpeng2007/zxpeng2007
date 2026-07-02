// Regenerates the Featured Repositories section of README.md between the
// FEATURED-REPOS markers: top 2 most-starred repos owned by the user
// (forks, archived repos, and the profile repo itself excluded; ties
// broken by most recent push).
//
// Usage: node scripts/update-featured-repos.mjs <github_user_name>

const [, , userName] = process.argv;

if (!userName) {
  console.error("usage: update-featured-repos.mjs <github_user_name>");
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
const res = await fetch(
  `https://api.github.com/users/${userName}/repos?per_page=100&type=owner`,
  {
    headers: {
      "User-Agent": userName,
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  },
);
if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
const repos = await res.json();

const top = repos
  .filter(
    (r) =>
      !r.fork &&
      !r.archived &&
      r.name.toLowerCase() !== userName.toLowerCase(),
  )
  .sort(
    (a, b) =>
      b.stargazers_count - a.stargazers_count ||
      new Date(b.pushed_at) - new Date(a.pushed_at),
  )
  .slice(0, 2);

if (top.length === 0) throw new Error("no eligible repos found");

const esc = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Pull the repo's own demo visual: the first image in its README, in
// document order, preferring animated gifs, then raster screenshots,
// then anything else. Falls back to GitHub's OpenGraph card when a repo
// has no README image at all.
async function heroImage(r) {
  const fallback = `https://opengraph.githubassets.com/1/${userName}/${r.name}`;

  const rd = await fetch(
    `https://api.github.com/repos/${userName}/${r.name}/readme`,
    {
      headers: {
        "User-Agent": userName,
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!rd.ok) return fallback;
  const { content } = await rd.json();
  const text = Buffer.from(content, "base64").toString("utf8");

  const urls = [];
  const re = /<img[^>]*\bsrc="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) urls.push(m[1] ?? m[2]);
  if (urls.length === 0) return fallback;

  const rank = (u) => {
    const p = u.split("?")[0].toLowerCase();
    if (p.endsWith(".gif")) return 0;
    if (/\.(png|jpe?g|webp)$/.test(p)) return 1;
    return 2;
  };
  const best = urls
    .map((u, i) => ({ u, i }))
    .sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i)[0].u;

  if (/^https?:\/\//.test(best)) return best;
  const path = best.replace(/^\.?\//, "");
  return `https://raw.githubusercontent.com/${userName}/${r.name}/${r.default_branch}/${path}`;
}

const card = (r, image) => {
  const lines = [
    `<a href="${r.html_url}"><img align="right" alt="${esc(r.name)} demo" src="${image}" width="340" /></a>`,
    ``,
    `#### [${esc(r.name)}](${r.html_url})`,
    ``,
  ];
  if (r.description) lines.push(esc(r.description), ``);
  const badges = [
    `<a href="${r.html_url}/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/${userName}/${r.name}?style=flat-square" /></a>`,
  ];
  if (r.language)
    badges.push(
      `<img alt="Top language" src="https://img.shields.io/github/languages/top/${userName}/${r.name}?style=flat-square" />`,
    );
  lines.push(badges.join("\n"), ``, `<br clear="right" />`);
  return lines.join("\n");
};

const images = await Promise.all(top.map(heroImage));
const block = top.map((r, i) => card(r, images[i])).join("\n\n");

const fs = await import("node:fs");
const readme = fs.readFileSync("README.md", "utf8");
const START = "<!-- FEATURED-REPOS:START -->";
const END = "<!-- FEATURED-REPOS:END -->";
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start)
  throw new Error("FEATURED-REPOS markers not found in README.md");

const updated =
  readme.slice(0, start + START.length) + "\n" + block + "\n" + readme.slice(end);

if (updated !== readme) {
  fs.writeFileSync("README.md", updated);
  console.log(
    "README.md updated:",
    top.map((r) => `${r.name} (${r.stargazers_count} stars)`).join(", "),
  );
} else {
  console.log("README.md already up to date");
}
