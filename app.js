// Renders the kit from content.json: the stage rail, each stage's worksheets and tools, and the investigations list.
// Then runs the Lantern hero over the investigations.
const content = await fetch("content.json").then((r) => r.json());
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const KIND = { browser: "Runs in your browser", extension: "Chrome extension", desktop: "Desktop app" };
const TOOLS_DIR = "tools/"; // browser tools are served from here, next to this page

const sheet = (w) => `
  <article class="card sheet" id="ws-${w.id}">
    <p class="meta">Worksheet · ${esc(w.version)}</p>
    <h4>${esc(w.title)}</h4>
    <p>${esc(w.summary)}</p>
    <div class="acts"><a class="act primary" href="sheets/${w.id}.html">Read</a><a class="act" href="${encodeURI(w.file)}" download>.docx</a></div>
  </article>`;

const tool = (t) => {
  const acts = [];
  if (t.launch) acts.push(`<a class="act primary" href="${encodeURI(TOOLS_DIR + t.launch)}" target="_blank" rel="noopener">Open tool</a>`);
  if (t.source) acts.push(`<a class="act${t.launch ? "" : " primary"}" href="${t.source}" target="_blank" rel="noopener">${t.launch ? "Code" : "Get it"} on GitHub</a>`);
  return `
  <article class="card" id="tool-${t.id}">
    <p class="meta">${KIND[t.kind]}</p>
    <h4>${esc(t.name)}</h4>
    <p>${esc(t.summary)}</p>
    <div class="acts">${acts.join("")}</div>
  </article>`;
};

const col = (title, list, render) => list.length ? `<div><h3 class="col-h">${title}</h3><div class="cards">${list.map(render).join("")}</div></div>` : "";

document.getElementById("stages").innerHTML = content.stages.map((s, i) => {
  const sheets = content.worksheets.filter((w) => w.stage === s.id), tools = content.tools.filter((t) => t.stage === s.id);
  return `
  <section class="stage" id="${s.id}" aria-labelledby="${s.id}-h">
    <div class="stage-head">
      <span class="num">${String(i + 1).padStart(2, "0")}</span>
      <h2 id="${s.id}-h">${esc(s.name)}</h2>
      <p>${esc(s.line)}</p>
    </div>
    <div class="stage-body">${col("Worksheets", sheets, sheet)}${col("Tools", tools, tool)}</div>
  </section>`;
}).join("");

const rail = document.querySelector(".rail ol");
rail.innerHTML = content.stages.map((s, i) => `<li><a href="#${s.id}"><span>${String(i + 1).padStart(2, "0")}</span>${esc(s.name)}</a></li>`).join("");
document.querySelector(".inv").innerHTML = content.investigations
  .map((v) => `<li><a href="${v.url}" target="_blank" rel="noopener">${esc(v.title)}</a></li>`).join("");

// the rail marks the stage in the middle of the screen, and keeps it scrolled into view on phones
const links = new Map([...rail.querySelectorAll("a")].map((a) => [a.hash.slice(1), a]));
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    links.forEach((a) => a.removeAttribute("aria-current"));
    const a = links.get(e.target.id);
    a.setAttribute("aria-current", "true");
    rail.scrollTo({ left: a.offsetLeft - (rail.clientWidth - a.offsetWidth) / 2, behavior: still ? "auto" : "smooth" });
  }
}, { rootMargin: "-45% 0px -50% 0px" });
document.querySelectorAll(".stage").forEach((s) => spy.observe(s));

// a faint lantern follows the pointer across the cards
addEventListener("pointermove", (e) => {
  const card = e.target.closest?.(".card");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
});
document.addEventListener("pointerout", (e) => {
  const card = e.target.closest?.(".card");
  if (card && !card.contains(e.relatedTarget)) card.style.setProperty("--my", "-200px");
});

// ---------- Lantern hero ----------
// The field is set with faint text: the Lab's investigations hidden among the noise of an investigation
// (timestamps, file names, coordinates, links). A soft light follows the pointer and brings it up; the
// investigations come up in colour and open their project page. It opens with a flare that lights the whole
// field for a moment, then closes down to the lantern. With nobody pointing, the light wanders on its own.
const hero = document.getElementById("hero"), copy = hero.querySelector(".copy");
const C = { ink: "#001a47", paper: "#ffffff", signal: "#ff5c6c" };
const items = content.investigations;
const noise = ["IMG_4471.jpg", "2019-03-14 08:22", "33.5138° N", "t.me/…/1182", "frame 0412", "archive.today/…", "VID_20210611.mp4",
  "sha256 9f2c…", "before:2024-06-01", "site:gov filetype:pdf", "EXIF: none", "44.0812° E", "@account_77", "web.archive.org/…",
  "UTC+3", "shadow 41°", "/r/…/comments", "dup? 0.93", "lang: ckb", "post deleted", "doc_0031.pdf", "geo: unverified"];
const ITEM_FONT = `600 13px "Azeret Mono", monospace`, NOISE_FONT = `400 12px "Azeret Mono", monospace`;

const canvas = document.createElement("canvas");
canvas.setAttribute("aria-hidden", "true");
hero.prepend(canvas);
const ctx = canvas.getContext("2d");
const p = { x: -1e4, y: -1e4, over: false };
const light = { x: 0, y: 0 };
let W = 0, H = 0, R0 = 150, cells = [], hot = null, lastSeen = -1e4, t0 = null, visible = false, queued = false;

function layout() {
  const hr = hero.getBoundingClientRect(), cr = copy.getBoundingClientRect();
  const pad = 28, box = { l: cr.left - hr.left - pad, r: cr.right - hr.left + pad, t: cr.top - hr.top - pad, b: cr.bottom - hr.top + pad };
  // first pass: where tokens can go, row by row, stepping around the copy
  const slots = [];
  for (let y = 22, r = 0; y < H - 10; y += 30, r++) {
    let x = 10 + ((r * 53) % 90);
    while (x < W - 60) {
      if (y > box.t && y < box.b && x + 120 > box.l && x < box.r) { x = box.r; continue; }
      slots.push({ x, y, r });
      x += 150 + ((slots.length * 37) % 60);
    }
  }
  // second pass: lay tokens on those rows; investigations take slots at a rate that spreads them over the field
  const queue = [...items].sort(() => Math.random() - 0.5);
  cells = [];
  let left = slots.length;
  for (let r = 0, k = 0; k < slots.length; r++) {
    let x = -Infinity;
    for (const s of slots.filter((s) => s.r === r)) {
      k++; left--;
      const sx = Math.max(s.x, x);
      const room = (s.y > box.t && s.y < box.b && sx < box.l ? box.l : W - 10) - sx;
      if (room < 60) continue;
      let c;
      if (queue.length && room >= 160 && Math.random() < queue.length / (left + 1)) {
        const it = queue.shift();
        ctx.font = ITEM_FONT;
        let label = it.title;
        while (ctx.measureText(label).width > room && label.length > 12) label = label.slice(0, -2).trimEnd() + "…";
        c = { x: sx, y: s.y, w: ctx.measureText(label).width, text: label, item: it };
      } else {
        ctx.font = NOISE_FONT;
        const text = noise[(r * 7 + k * 3) % noise.length];
        c = { x: sx, y: s.y, w: ctx.measureText(text).width, text };
        if (c.w > room) continue;
      }
      cells.push(c);
      x = c.x + c.w + 40;
    }
  }
}

function frame(t) {
  queued = false;
  t0 ??= t;
  if (p.over) lastSeen = t;
  const auto = t - lastSeen > 1500 || still;
  // wander a loop around the copy, so the light keeps finding things
  const tx = auto ? W * (0.5 + 0.38 * Math.cos(t * 0.00019)) : p.x;
  const ty = auto ? H * (0.5 + 0.36 * Math.sin(t * 0.00031)) : p.y;
  light.x += (tx - light.x) * (auto ? 0.03 : 0.16);
  light.y += (ty - light.y) * (auto ? 0.03 : 0.16);
  // the opening flare: the whole field lit, then closing to the lantern
  const flare = still ? 0 : Math.max(0, 1 - (t - t0) / 2200) ** 2;
  R0 = Math.min(300, Math.max(150, W * 0.22));
  const R = R0 * (1 + flare * 5);
  const fx = light.x + (W / 2 - light.x) * flare, fy = light.y + (H / 2 - light.y) * flare;

  ctx.globalAlpha = 1; ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, R * 1.3);
  g.addColorStop(0, "rgba(120,160,255,0.10)"); g.addColorStop(1, "rgba(120,160,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = "middle";
  hot = null;
  for (const c of cells) {
    const d = Math.hypot(c.x + Math.min(c.w, 200) / 2 - fx, c.y - fy), lit = Math.max(0, 1 - d / R) ** 1.5;
    if (c.item) {
      const over = !auto && flare < 0.1 && p.x > c.x && p.x < c.x + c.w && Math.abs(p.y - c.y) < 11 && lit > 0.15;
      if (over) hot = c;
      ctx.font = ITEM_FONT;
      ctx.globalAlpha = 0.1 + lit * 0.9;
      ctx.fillStyle = lit > 0.05 ? C.signal : C.paper;
      ctx.fillText(c.text, c.x, c.y);
      if (over) ctx.fillRect(c.x, c.y + 10, c.w, 1.5);
    } else {
      ctx.font = NOISE_FONT;
      ctx.globalAlpha = 0.05 + lit * 0.35;
      ctx.fillStyle = C.paper;
      ctx.fillText(c.text, c.x, c.y);
    }
  }
  canvas.style.cursor = hot ? "pointer" : "";
  if (!still && visible) schedule();
}
const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };

await document.fonts.ready;
new ResizeObserver(() => {
  const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
  W = r.width; H = r.height; canvas.width = W * d; canvas.height = H * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  light.x = W / 2; light.y = H / 2;
  layout(); schedule();
}).observe(canvas);
new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) schedule(); }).observe(canvas);
addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  p.x = e.clientX - r.left; p.y = e.clientY - r.top; p.over = p.y >= 0 && p.y <= r.height;
});
// a click opens an investigation only where the light already is; elsewhere (and on touch) it brings the light there
canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const c = cells.find((c) => c.item && x > c.x && x < c.x + c.w && Math.abs(y - c.y) < 11);
  if (c && Math.hypot(x - light.x, y - light.y) < R0 * 0.6) window.open(c.item.url, "_blank", "noopener");
  else { p.x = x; p.y = y; p.over = true; schedule(); }
});
