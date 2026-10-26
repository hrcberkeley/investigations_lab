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
  if (t.store) acts.push(`<a class="act primary" href="${t.store}" target="_blank" rel="noopener">Add to Chrome</a>`);
  if (t.source) acts.push(`<a class="act${acts.length ? "" : " primary"}" href="${t.source}" target="_blank" rel="noopener">${acts.length ? "Code" : "Get it"} on GitHub</a>`);
  return `
  <article class="card tool" id="tool-${t.id}">
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

// a faint lantern follows the pointer across the tools
addEventListener("pointermove", (e) => {
  const card = e.target.closest?.(".tool");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
});
document.addEventListener("pointerout", (e) => {
  const card = e.target.closest?.(".tool");
  if (card && !card.contains(e.relatedTarget)) card.style.setProperty("--my", "-200px");
});

// ---------- Lantern hero ----------
// The field is set with faint text: the Lab's investigations hidden among the noise of an investigation
// (timestamps, file names, coordinates, links), drifting past in rows like feeds. A soft light follows the
// pointer: the noise parts around it, the rows slow down under it, and the investigations come up in colour
// and open their project page. A click sends a pulse across the field that lights everything it passes.
// It opens with one such pulse from the centre; with nobody pointing, the light wanders and pulses on its own.
const hero = document.getElementById("hero"), copy = hero.querySelector(".copy");
const css = getComputedStyle(document.documentElement), v = (n) => css.getPropertyValue(n).trim();
const C = { ground: v("--night"), paper: v("--paper"), signal: v("--red-light") };
const items = content.investigations;
const noise = ["IMG_4471.jpg", "2019-03-14 08:22", "33.5138° N", "t.me/…/1182", "frame 0412", "archive.today/…", "VID_20210611.mp4",
  "sha256 9f2c…", "before:2024-06-01", "site:gov filetype:pdf", "EXIF: none", "44.0812° E", "@account_77", "web.archive.org/…",
  "UTC+3", "shadow 41°", "/r/…/comments", "dup? 0.93", "lang: ckb", "post deleted", "doc_0031.pdf", "geo: unverified"];
const ITEM_FONT = `600 13px "Azeret Mono", monospace`, NOISE_FONT = `400 12px "Azeret Mono", monospace`, ROW = 30;

const canvas = document.createElement("canvas");
canvas.setAttribute("aria-hidden", "true");
hero.prepend(canvas);
const ctx = canvas.getContext("2d");
const p = { x: -1e4, y: -1e4, over: false };
const light = { x: 0, y: 0 };
const waves = [];
let W = 0, H = 0, R = 150, rows = [], box = null, hot = null, lastSeen = -1e4, last = null, nextPing = 0;
let visible = false, queued = false, opened = false;

const pulse = (x, y, reach = Math.hypot(W, H) * 0.6) => waves.push({ x, y, r: 0, reach });
const width = (c) => { ctx.font = c.item ? ITEM_FONT : NOISE_FONT; return ctx.measureText(c.text).width; };

// each row is a strip a little wider than the hero that loops as it drifts; investigations are dealt out
// across the rows and dropped in among the noise at random
function layout() {
  const hr = hero.getBoundingClientRect(), cr = copy.getBoundingClientRect();
  box = { l: cr.left - hr.left - 24, r: cr.right - hr.left + 24, t: cr.top - hr.top - 16, b: cr.bottom - hr.top + 16 };
  const n = Math.max(1, Math.floor((H - 12) / ROW));
  rows = Array.from({ length: n }, (_, r) => ({ y: 22 + r * ROW, off: Math.random() * 600, v: (r % 2 ? -1 : 1) * (6 + Math.random() * 10), cells: [] }));
  [...items].sort(() => Math.random() - 0.5).forEach((it, i) => {
    const text = it.title.length > 56 ? it.title.slice(0, 54).trimEnd() + "…" : it.title;
    rows[i % n].cells.push({ text, item: it });
  });
  rows.forEach((row, r) => {
    let len = row.cells.reduce((a, c) => a + (c.w = width(c)) + 80, 0);
    for (let k = r * 5; len < W + 320; k++) {
      const c = { text: noise[k % noise.length] };
      row.cells.splice(Math.floor(Math.random() * (row.cells.length + 1)), 0, c);
      len += (c.w = width(c)) + 80;
    }
    let x = 0;
    for (const c of row.cells) { c.x = x; x += c.w + 48 + Math.random() * 64; }
    row.L = x;
  });
}

// 0 where a token would sit under the copy, rising to 1 a little way out from it
function clear(x, w, y) {
  const dx = Math.max(box.l - x - w, 0, x - box.r), dy = Math.max(box.t - y, 0, y - box.b);
  return Math.min(1, Math.hypot(dx, dy) / 60);
}

function frame(t) {
  queued = false;
  const dt = last == null ? 0 : Math.min(50, t - last);
  last = t;
  if (p.over) lastSeen = t;
  const auto = still || t - lastSeen > 1500;
  // wander a loop around the copy, so the light keeps finding things
  const tx = auto ? W * (0.5 + 0.4 * Math.cos(t * 0.00019)) : p.x;
  const ty = auto ? H * (0.5 + 0.38 * Math.sin(t * 0.00031)) : p.y;
  light.x += (tx - light.x) * (auto ? 0.03 : 0.18);
  light.y += (ty - light.y) * (auto ? 0.03 : 0.18);
  R = Math.min(280, Math.max(140, W * 0.2));
  if (!still && auto && t > nextPing) { pulse(light.x, light.y, R * 3); nextPing = t + 5200; }
  for (const wv of waves) wv.r += dt * 0.45;
  while (waves.length && waves[0].r > waves[0].reach) waves.shift();

  ctx.globalAlpha = 1; ctx.fillStyle = C.ground; ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, R * 1.6);
  g.addColorStop(0, "rgba(255,190,160,0.10)"); g.addColorStop(1, "rgba(255,190,160,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.paper; ctx.lineWidth = 1;
  for (const wv of waves) {
    ctx.globalAlpha = 0.12 * (1 - wv.r / wv.reach);
    ctx.beginPath(); ctx.arc(wv.x, wv.y, wv.r, 0, 7); ctx.stroke();
  }

  ctx.textBaseline = "middle";
  hot = null;
  for (const row of rows) {
    // rows nearly stop under the light, so what it finds can be read and clicked
    const near = Math.exp(-((row.y - light.y) ** 2) / (R * R * 0.3));
    if (!still) row.off += (row.v * dt / 1000) * (1 - 0.94 * near);
    for (const c of row.cells) {
      const x = (((c.x + row.off) % row.L) + row.L) % row.L - 160;
      c.sx = -1e4;
      if (x > W || x + c.w < 0) continue;
      const cx = x + Math.min(c.w, 200) / 2, dy = row.y - light.y, d = Math.hypot(cx - light.x, dy);
      let lit = Math.max(0, 1 - d / R) ** 1.5;
      for (const wv of waves) {
        const off = Math.abs(Math.hypot(cx - wv.x, row.y - wv.y) - wv.r);
        if (off < 50) lit = Math.max(lit, (1 - off / 50) * (1 - wv.r / wv.reach) * 0.9);
      }
      // the noise parts around the light; the investigations hold still in it
      const y = c.item ? row.y : row.y + Math.sign(dy || 1) * 18 * Math.exp(-(d * d) / 9000);
      const m = clear(x, c.w, y);
      if (m === 0) continue;
      c.sx = x; c.sy = y;
      if (c.item) {
        const over = !auto && m > 0.6 && p.x > x && p.x < x + c.w && Math.abs(p.y - y) < 11 && lit > 0.15;
        if (over) hot = c;
        ctx.font = ITEM_FONT;
        ctx.globalAlpha = (0.12 + lit * 0.88) * m;
        ctx.fillStyle = lit > 0.05 ? C.signal : C.paper;
        ctx.fillText(c.text, x, y);
        if (over) ctx.fillRect(x, y + 10, c.w, 1.5);
      } else {
        ctx.font = NOISE_FONT;
        ctx.globalAlpha = (0.06 + lit * 0.34) * m;
        ctx.fillStyle = C.paper;
        ctx.fillText(c.text, x, y);
      }
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
  layout();
  if (!opened && !still) { opened = true; pulse(W / 2, H / 2); nextPing = performance.now() + 4000; }
  schedule();
}).observe(canvas);
new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) schedule(); }).observe(canvas);
addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  p.x = e.clientX - r.left; p.y = e.clientY - r.top; p.over = p.y >= 0 && p.y <= r.height;
});
// a click opens an investigation only where the light already is; elsewhere (and on touch) it brings the
// light there and sends a pulse out from it
canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const c = rows.flatMap((row) => row.cells).find((c) => c.item && x > c.sx && x < c.sx + c.w && Math.abs(y - c.sy) < 11);
  if (c && Math.hypot(x - light.x, y - light.y) < R * 0.6) window.open(c.item.url, "_blank", "noopener");
  else { p.x = x; p.y = y; p.over = true; if (!still) pulse(x, y); schedule(); }
});
