// Regenerates the Featured Repositories section: picks the top 2
// most-starred repos owned by the user (forks, archived repos, and the
// profile repo excluded; ties broken by most recent push), renders each
// as a fixed-layout SVG card (assets/featured-N.svg) with the repo's
// own README hero image embedded, and splices matching <a><img></a>
// tags between the FEATURED-REPOS markers in README.md.
//
// SVG cards are used because GitHub sanitizes CSS out of README HTML:
// fonts and absolute positioning only survive inside an <img>-embedded
// SVG. Consequences: images must be base64-embedded (the CSP on
// raw.githubusercontent blocks external loads inside SVGs), and gifs
// render as a static frame, so a mid-animation poster frame is
// extracted with ImageMagick where available (always, on CI).
//
// Usage: node scripts/update-featured-repos.mjs <github_user_name>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , userName] = process.argv;

if (!userName) {
  console.error("usage: update-featured-repos.mjs <github_user_name>");
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
const apiHeaders = {
  "User-Agent": userName,
  Accept: "application/vnd.github+json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const res = await fetch(
  `https://api.github.com/users/${userName}/repos?per_page=100&type=owner`,
  { headers: apiHeaders },
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

// ---------------------------------------------------------------------------
// Hero image: first image in the repo's README, gifs preferred, then
// raster screenshots, then anything else; GitHub's OpenGraph card as
// fallback. Returns raw bytes ready for embedding, or null.
// ---------------------------------------------------------------------------

async function heroImageUrl(r) {
  const fallback = `https://opengraph.githubassets.com/1/${userName}/${r.name}`;

  const rd = await fetch(
    `https://api.github.com/repos/${userName}/${r.name}/readme`,
    { headers: apiHeaders },
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
  return `https://raw.githubusercontent.com/${userName}/${r.name}/${r.default_branch}/${best.replace(/^\.?\//, "")}`;
}

function imageMagick() {
  for (const bin of ["magick", "convert"]) {
    try {
      execFileSync(bin, ["-version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* not available */
    }
  }
  return null;
}

const IM = imageMagick();
// Rendered at 2x the on-card 328x164 box for crisp display.
const POSTER_W = 656;
const POSTER_H = 328;
// Animated gifs become a CSS flipbook: up to this many frames sampled
// evenly across the animation, embedded as JPEGs and cycled with
// keyframes (a data-URI gif inside an SVG <image> renders frozen, but
// CSS animation inside GitHub-served SVGs works).
const MAX_FLIP_FRAMES = 16;

const resizeArgs = [
  "-resize", `${POSTER_W}x${POSTER_H}^`,
  "-gravity", "center",
  "-extent", `${POSTER_W}x${POSTER_H}`,
  "-strip",
];

function imIdentify(tmp, format) {
  return execFileSync(
    IM === "magick" ? "magick" : "identify",
    IM === "magick" ? ["identify", "-format", format, tmp] : ["-format", format, tmp],
    { stdio: "pipe" },
  ).toString();
}

async function heroImageData(r) {
  const url = await heroImageUrl(r);
  const resp = await fetch(url, { headers: { "User-Agent": userName } });
  if (!resp.ok) return null;
  const bytes = Buffer.from(await resp.arrayBuffer());
  const mime = resp.headers.get("content-type")?.split(";")[0] || "image/png";

  if (IM) {
    const tmp = path.join(os.tmpdir(), `hero-${r.name}`);
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-"));
    fs.writeFileSync(tmp, bytes);
    try {
      const frameCount = parseInt(imIdentify(tmp, "%n\n").trim().split("\n")[0], 10);

      if (mime === "image/gif" && Number.isFinite(frameCount) && frameCount > 1) {
        // Real animation duration from per-frame delays (centiseconds).
        const delays = imIdentify(tmp, "%T\n")
          .trim().split("\n").map((d) => parseInt(d, 10) || 0);
        let cycleSec = delays.reduce((a, b) => a + b, 0) / 100;
        if (!(cycleSec > 0)) cycleSec = frameCount * 0.06;

        // Coalesce composites the delta-patch frames into full images.
        execFileSync(
          IM,
          [tmp, "-coalesce", ...resizeArgs, "-quality", "80", path.join(frameDir, "f-%04d.jpg")],
          { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 },
        );
        const all = fs.readdirSync(frameDir).sort();
        const n = Math.min(MAX_FLIP_FRAMES, all.length);
        const picked = Array.from({ length: n }, (_, i) =>
          all[Math.floor((i * all.length) / n)],
        );
        const frames = picked.map((f) =>
          fs.readFileSync(path.join(frameDir, f)).toString("base64"),
        );
        console.log(
          `flipbook for ${r.name}: ${n}/${all.length} frames, ${cycleSec.toFixed(1)}s cycle, via ${IM}`,
        );
        return { kind: "anim", mime: "image/jpeg", frames, cycleSec };
      }

      const poster = execFileSync(
        IM,
        [`${tmp}[0]`, ...resizeArgs, "png:-"],
        { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 },
      );
      console.log(`poster for ${r.name}: via ${IM}`);
      return { kind: "static", mime: "image/png", base64: poster.toString("base64") };
    } catch (e) {
      console.error(`poster extraction failed for ${r.name}: ${e.message}`);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(frameDir, { recursive: true, force: true });
    }
  } else {
    console.log(`imagemagick unavailable; embedding raw image for ${r.name}`);
  }

  return { kind: "static", mime, base64: bytes.toString("base64") };
}

// ---------------------------------------------------------------------------
// Fixed-layout SVG card. Everything is absolutely positioned on an
// 846x196 canvas; Cambria (with serif fallbacks) for all text; light
// and dark palettes switch via prefers-color-scheme, matching how the
// README's <picture> blocks behave.
// ---------------------------------------------------------------------------

const LANG_COLORS = {
  Python: "#3572A5",
  "Jupyter Notebook": "#DA5B0B",
  HTML: "#e34c26",
  CSS: "#663399",
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Shell: "#89e051",
  MATLAB: "#e16737",
  Cuda: "#3A4E3A",
};

const STAR_PATH =
  "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z";

function fmtPct(n) {
  return n.toFixed(3).replace(/\.?0+$/, "");
}

// Flipbook CSS: frame i is fully visible for its 1/F share of the
// cycle and hidden otherwise, with explicit 0% stops and near-instant
// (0.01%) snaps between stops — without a 0% stop browsers would tween
// opacity across the whole waiting period.
function flipbookCss(frameCount, cycleSec) {
  const EPS = 0.01;
  let css = `.gf{opacity:0;animation:none ${cycleSec}s linear infinite}`;
  for (let i = 0; i < frameCount; i++) {
    const a = (i / frameCount) * 100;
    const b = ((i + 1) / frameCount) * 100;
    let kf;
    if (i === 0) {
      kf = `0%,${fmtPct(b)}%{opacity:1}${fmtPct(b + EPS)}%,100%{opacity:0}`;
    } else if (i === frameCount - 1) {
      kf = `0%,${fmtPct(a - EPS)}%{opacity:0}${fmtPct(a)}%,100%{opacity:1}`;
    } else {
      kf = `0%,${fmtPct(a - EPS)}%{opacity:0}${fmtPct(a)}%,${fmtPct(b)}%{opacity:1}${fmtPct(b + EPS)}%,100%{opacity:0}`;
    }
    css += `@keyframes g${i}{${kf}}.gf.g${i}{animation-name:g${i}}`;
  }
  return css;
}

function svgCard(r, image) {
  const W = 846;
  const H = 212;
  const IMG_Y = (H - 164) / 2;
  const META_BASELINE = H - 27;
  const FONT = "Cambria, Georgia, 'Times New Roman', serif";
  const langColor = LANG_COLORS[r.language] ?? "#8b949e";
  const stars = r.stargazers_count;

  let imagePart = "";
  let flipCss = "";
  if (image) {
    const box = `x="502" y="${IMG_Y}" width="328" height="164"`;
    const clip = `  <clipPath id="hero"><rect ${box} rx="6"/></clipPath>`;
    const frameRect = `  <rect class="frame" x="502.5" y="${IMG_Y + 0.5}" width="327" height="163" rx="6"/>`;
    if (image.kind === "anim") {
      flipCss = flipbookCss(image.frames.length, image.cycleSec);
      const layers = image.frames
        .map(
          (b64, i) =>
            `    <image class="gf g${i}" ${box} preserveAspectRatio="xMidYMid slice" href="data:${image.mime};base64,${b64}"/>`,
        )
        .join("\n");
      imagePart = [clip, `  <g clip-path="url(#hero)">`, layers, `  </g>`, frameRect].join("\n");
    } else {
      imagePart = [
        clip,
        `  <image ${box} preserveAspectRatio="xMidYMid slice" clip-path="url(#hero)" href="data:${image.mime};base64,${image.base64}"/>`,
        frameRect,
      ].join("\n");
    }
  }

  const langPart = r.language
    ? [
        `  <circle cx="122" cy="${META_BASELINE - 5}" r="6" fill="${langColor}"/>`,
        `  <text class="meta" x="134" y="${META_BASELINE}">${esc(r.language)}</text>`,
      ].join("\n")
    : "";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <style>
    text, div { font-family: ${FONT}; }
    .card { fill: #ffffff; stroke: #d1d9e0; }
    .frame { fill: none; stroke: #d1d9e0; }
    .name { fill: #0969da; font-size: 22px; font-weight: 700; }
    .desc { font-family: ${FONT}; font-size: 15px; line-height: 1.5; color: #59636e; margin: 0; overflow: hidden; max-height: 90px; }
    .meta { fill: #59636e; font-size: 14px; }
    .star { fill: #59636e; }
    @media (prefers-color-scheme: dark) {
      .card { fill: #161b22; stroke: #3d444d; }
      .frame { stroke: #3d444d; }
      .name { fill: #4493f8; }
      .desc { color: #9198a1; }
      .meta { fill: #9198a1; }
      .star { fill: #9198a1; }
    }
    ${flipCss}
  </style>
  <rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8"/>
  <text class="name" x="28" y="48">${esc(r.name)}</text>
  <foreignObject x="28" y="64" width="440" height="94">
    <div xmlns="http://www.w3.org/1999/xhtml" class="desc">${esc(r.description ?? "")}</div>
  </foreignObject>
  <g transform="translate(28, ${META_BASELINE - 17})"><path class="star" d="${STAR_PATH}"/></g>
  <text class="meta" x="50" y="${META_BASELINE}">${stars}</text>
${langPart}
${imagePart}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Write assets and splice the README block.
// ---------------------------------------------------------------------------

fs.mkdirSync("assets", { recursive: true });

const images = await Promise.all(top.map(heroImageData));

const anchors = top.map((r, i) => {
  const file = `assets/featured-${i}.svg`;
  const svg = svgCard(r, images[i]);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== svg) {
    fs.writeFileSync(file, svg);
    console.log(`wrote ${file}`);
  }
  return `<a href="${r.html_url}"><img alt="${esc(r.name)}" src="https://raw.githubusercontent.com/${userName}/${userName}/main/${file}" width="846" /></a>`;
});

const block = anchors.join("\n\n");

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
