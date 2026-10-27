// Renders the kit from content.json, set as a two-ink print: the contents with the suggested path circled, the
// stage rail, each stage's worksheets (pasted-in slips) and tools (halftone prints) linked to each other, and the
// investigations by year. The cover prints the investigations as a coarse red screen that comes into focus
// under the pointer.
const content = await fetch("content.json").then((r) => r.json());
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const INK = { red: "#c8102e", black: "#1f1c1a", paper: "rgba(241,235,223," };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const KIND = { extension: "Chrome extension", desktop: "Desktop app" };
const TOOLS_DIR = "tools/"; // browser tools are served from here, next to this page
const toolById = new Map(content.tools.map((t) => [t.id, t]));
const sheetsFor = (t) => content.worksheets.filter((w) => w.tools?.includes(t.id));
const linkList = (list, href, name) => list.map((x) => `<a href="${href(x)}">${esc(name(x))}</a>`).join(", ");
const num = (i) => String(i + 1).padStart(2, "0");
const byStage = (s) => [content.worksheets.filter((w) => w.stage === s.id), content.tools.filter((t) => t.stage === s.id)];
const ext = 'target="_blank" rel="noopener"';
const circle = `<svg class="draw" viewBox="0 0 120 104" aria-hidden="true"><path pathLength="1" d="M66 9 C 98 8, 116 32, 110 58 C 104 86, 70 100, 42 95 C 12 90, 2 64, 9 38 C 16 14, 44 3, 74 12"/></svg>`;

const sheet = (w) => `
  <article class="sheet" id="ws-${w.id}">
    ${w.step ? `<div class="stamp" title="Number ${w.step} on the suggested path">${circle}<span>${w.step}</span></div>` : ""}
    <p class="kind">Worksheet · ${esc(w.version)}</p>
    <h3>${esc(w.title)}</h3>
    <p>${esc(w.summary)}</p>
    ${w.tools ? `<p class="rel">With ${linkList(w.tools.map((id) => toolById.get(id)), (t) => `#tool-${t.id}`, (t) => t.name)}</p>` : ""}
    <p class="links"><a class="ink-link primary" href="sheets/${w.id}.html">Read it</a><a class="ink-link" href="${encodeURI(w.file)}" download>Word file</a></p>
  </article>`;

const tool = (t) => {
  const acts = [];
  if (t.launch) acts.push(`<a class="ink-link" href="${encodeURI(TOOLS_DIR + t.launch)}" ${ext}>Open ${esc(t.name)} ↗</a>`);
  if (t.store) acts.push(`<a class="ink-link" href="${t.store}" ${ext}>Add to Chrome ↗</a>`);
  if (t.source) acts.push(`<a class="ink-link" href="${t.source}" ${ext}>${acts.length ? "Code" : "Get it"} on GitHub ↗</a>`);
  acts[0] = acts[0].replace('class="ink-link"', 'class="ink-link primary"');
  const taught = sheetsFor(t);
  return `
  <article class="tool" id="tool-${t.id}">
    <div class="shot">${t.image ? `<img src="${t.image}" alt="" loading="lazy"><canvas data-src="${t.image}"></canvas>` : `<canvas data-label="${KIND[t.kind]}"></canvas>`}</div>
    <h3>${esc(t.name)}</h3>
    <p>${esc(t.summary)}</p>
    ${taught.length ? `<p class="rel">Method in ${linkList(taught, (w) => `#ws-${w.id}`, (w) => w.title)}</p>` : ""}
    ${t.needs ? `<p class="needs">${esc(t.needs)}</p>` : ""}
    <p class="links">${acts.join("")}</p>
  </article>`;
};

document.getElementById("stages").innerHTML = content.stages.map((s, i) => {
  const [sheets, tools] = byStage(s);
  return `
  <section class="stage" id="${s.id}" aria-labelledby="${s.id}-h">
    <div class="stage-head">
      <span class="num" aria-hidden="true">${num(i)}</span>
      <h2 id="${s.id}-h" class="misreg" data-text="${esc(s.name)}">${esc(s.name)}</h2>
      <p>${esc(s.line)}</p>
    </div>
    ${sheets.length ? `<div class="sheets">${sheets.map(sheet).join("")}</div>` : ""}
    ${tools.length ? `<div class="tools">${tools.map(tool).join("")}</div>` : ""}
  </section>`;
}).join("");

// the contents: every stage and what's in it, like the contents page of a zine
document.querySelector(".toc-list").innerHTML = content.stages.map((s, i) => {
  const [sheets, tools] = byStage(s);
  return `<li>
    <a class="toc-h" href="#${s.id}"><span class="name">${esc(s.name)}</span><span class="dots"></span><span class="n">${num(i)}</span></a>
    <p class="line">${esc(s.line)}</p>
    <ul class="items">${sheets.map((w) => `<li class="ws"><a href="#ws-${w.id}">${w.step ? `<b>${w.step}</b>` : ""}${esc(w.title)}</a></li>`).join("")}${tools.map((t) => `<li class="tl"><a href="#tool-${t.id}">${esc(t.name)}</a></li>`).join("")}</ul>
  </li>`;
}).join("");

const rail = document.querySelector(".rail ol");
rail.innerHTML = content.stages.map((s, i) => `<li><a href="#${s.id}"><span>${num(i)}</span>${esc(s.name)}</a></li>`).join("");

const years = [...new Set(content.investigations.map((v) => v.year))].sort((a, b) => b - a);
document.querySelector(".timeline").innerHTML = years.map((y) => `
  <section class="year"><h3>${y}</h3><ul>${content.investigations.filter((v) => v.year === y)
    .map((v) => `<li><a href="${v.url}" ${ext}>${esc(v.title)}</a></li>`).join("")}</ul></section>`).join("");

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

// a jump to a slip or print briefly marks it, so it's easy to find among its neighbours
addEventListener("hashchange", () => {
  const el = document.getElementById(location.hash.slice(1));
  if (!el?.matches(".sheet, .tool")) return;
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
});

// hand-drawn marks draw themselves the first time they're seen
const drawn = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("drawn"), drawn.unobserve(e.target))), { threshold: 0.6 });
document.querySelectorAll(".draw").forEach((s) => drawn.observe(s));

// ---------- halftone ----------
// Prints the tone of `src` (a canvas in CSS px) as a dot screen: rows offset by half a cell, dot area following
// the tone. `from` reads the tone from alpha, from darkness ("light" paper) or from lightness ("dark", a negative).
function halftone(ctx, src, { cell, color, from = "alpha", min = 0, max = 0.62, threshold = 0, dx = 0, dy = 0 }) {
  const w = src.width, h = src.height, d = src.getContext("2d").getImageData(0, 0, w, h).data;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let row = 0, y = cell / 2; y < h; y += cell * 0.866, row++) {
    for (let x = row % 2 ? cell : cell / 2; x < w; x += cell) {
      const k = ((y | 0) * w + (x | 0)) * 4;
      const lum = (d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11) / 255;
      let v = from === "alpha" ? d[k + 3] / 255 : from === "dark" ? lum : 1 - lum;
      v = Math.max(0, (v - threshold) / (1 - threshold));
      const r = Math.max(min, Math.sqrt(v) * cell * max);
      if (r < 0.35) continue;
      ctx.moveTo(x + dx + r, y + dy);
      ctx.arc(x + dx, y + dy, r, 0, 7);
    }
  }
  ctx.fill();
}
const canvasOf = (w, h) => Object.assign(document.createElement("canvas"), { width: Math.round(w), height: Math.round(h) });
// a softened copy at CSS-pixel size, which is what the screen samples
function blurred(img, w, h, sw = img.width, sh = img.height, blur = 1.2) {
  const c = canvasOf(w, h), x = c.getContext("2d", { willReadFrequently: true });
  x.filter = `blur(${blur}px)`;
  x.drawImage(img, 0, 0, sw, sh, 0, 0, w, h);
  return c;
}

// tool prints: red for the tone, black only in the darkest parts, a little out of register. A tool without a
// screenshot gets its kind (Chrome extension, Desktop app) set large and printed through the same screen.
async function print(canvas) {
  let img = null;
  if (canvas.dataset.src) {
    img = new Image();
    img.src = canvas.dataset.src;
    try { await img.decode(); } catch { return; }
  }
  new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1;
    if (!r.width) return;
    canvas.width = r.width * d; canvas.height = r.height * d;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(d, 0, 0, d, 0, 0);
    if (!img) {
      const c = canvasOf(r.width, r.height), x = c.getContext("2d"), fs = r.width / 7;
      x.font = `italic 800 ${fs}px Fraunces`; x.textAlign = "center"; x.textBaseline = "middle";
      const words = canvas.dataset.label.split(" ");
      words.forEach((w, k) => x.fillText(w, r.width / 2, r.height / 2 + (k - (words.length - 1) / 2) * fs * 1.02));
      halftone(ctx, blurred(c, r.width, r.height, c.width, c.height, 1.6), { cell: 6.5, color: INK.red, min: 0.6 });
      return;
    }
    const src = blurred(img, r.width, r.height, img.width, Math.min(img.width * (r.height / r.width), img.height), 0.8);
    // a dark interface is printed as a negative, so its light parts carry the ink
    const px = src.getContext("2d").getImageData(0, 0, src.width, src.height).data;
    let sum = 0;
    for (let k = 0; k < px.length; k += 64) sum += (px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11) / 255;
    const from = sum / (px.length / 64) < 0.4 ? "dark" : "light";
    halftone(ctx, src, { cell: 4.6, color: INK.red, from, max: 0.6, threshold: from === "dark" ? 0.12 : 0 });
    ctx.globalCompositeOperation = "multiply";
    halftone(ctx, src, { cell: 4.6, color: INK.black, from, threshold: 0.55, max: 0.5, dx: 1.4, dy: 1 });
  }).observe(canvas);
}

// ---------- cover ----------
// The investigations' titles fill the top of the cover, printed as a coarse red screen you can almost read.
// Where the pointer is, the screen clears and the titles come up as sharp type, printed in two passes out of
// register; a click there opens the investigation. With nobody pointing, the focus wanders on its own.
const field = document.getElementById("field"), fx = field.getContext("2d");
let W = 0, H = 0, D = 1, crisp, ghost, dots, lens, words = [];
const look = { x: 0, y: 0 }, aim = { x: 0, y: 0 };
let lastMove = -1e4, visible = false, queued = false;
const lensR = () => Math.max(110, Math.min(210, W * 0.14));

function layoutField() {
  const r = field.getBoundingClientRect();
  D = devicePixelRatio || 1; W = r.width; H = r.height;
  field.width = W * D; field.height = H * D;
  [crisp, ghost, dots, lens] = Array.from({ length: 4 }, () => canvasOf(W * D, H * D));
  const c = crisp.getContext("2d");
  c.scale(D, D);
  const fs = Math.max(16, Math.min(32, W / 40)), lh = fs * 1.75, gap = fs * 0.28;
  c.font = `italic 700 ${fs}px Fraunces`;
  c.fillStyle = INK.black;
  const items = [...content.investigations].sort(() => Math.random() - 0.5);
  words = [];
  let x = 0, y = fs * 0.85, k = 0;
  while (y < H + fs) {
    const it = items[k++ % items.length];
    for (const w of [...it.title.split(" "), "/"]) {
      const ww = c.measureText(w).width;
      if (x + ww > W) { x = 0; y += lh; }
      c.fillText(w, x, y);
      if (w !== "/") words.push({ x, y: y - fs * 0.78, w: ww, h: fs, item: it });
      x += ww + gap;
    }
  }
  const g = ghost.getContext("2d");
  g.drawImage(crisp, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = INK.red; g.fillRect(0, 0, ghost.width, ghost.height);
  const dc = dots.getContext("2d");
  dc.scale(D, D);
  halftone(dc, blurred(crisp, W, H, crisp.width, crisp.height, 2.2), { cell: Math.max(4, fs / 5.5), color: INK.red, min: 0.75, max: 0.66 });
  if (!look.x) { look.x = aim.x = W * 0.3; look.y = aim.y = H * 0.5; }
}

function frame(t) {
  queued = false;
  const idle = still || t - lastMove > 2500;
  if (idle) {
    aim.x = W * (0.5 + 0.4 * Math.cos(t * 0.00017));
    aim.y = H * (0.5 + 0.3 * Math.sin(t * 0.00029));
  }
  look.x += (aim.x - look.x) * (idle ? 0.025 : 0.2);
  look.y += (aim.y - look.y) * (idle ? 0.025 : 0.2);
  const R = lensR();

  fx.setTransform(1, 0, 0, 1, 0, 0);
  fx.clearRect(0, 0, field.width, field.height);
  fx.drawImage(dots, 0, 0);
  // wipe the screen away under the focus, then print the type there in two passes
  fx.setTransform(D, 0, 0, D, 0, 0);
  const fade = fx.createRadialGradient(look.x, look.y, R * 0.35, look.x, look.y, R);
  fade.addColorStop(0, INK.paper + "0.96)"); fade.addColorStop(1, INK.paper + "0)");
  fx.fillStyle = fade; fx.fillRect(0, 0, W, H);
  const lx = lens.getContext("2d");
  for (const [layer, ox, oy, mode] of [[ghost, 3, 2, "multiply"], [crisp, 0, 0, "source-over"]]) {
    lx.setTransform(1, 0, 0, 1, 0, 0);
    lx.globalCompositeOperation = "source-over";
    lx.clearRect(0, 0, lens.width, lens.height);
    lx.drawImage(layer, 0, 0);
    lx.globalCompositeOperation = "destination-in";
    lx.setTransform(D, 0, 0, D, 0, 0);
    const m = lx.createRadialGradient(look.x, look.y, R * 0.45, look.x, look.y, R * 0.95);
    m.addColorStop(0, "#000"); m.addColorStop(1, "rgba(0,0,0,0)");
    lx.fillStyle = m; lx.fillRect(0, 0, W, H);
    fx.globalCompositeOperation = mode;
    fx.setTransform(1, 0, 0, 1, 0, 0);
    fx.drawImage(lens, ox * D, oy * D);
  }
  fx.globalCompositeOperation = "source-over";
  field.style.cursor = hit(aim.x, aim.y) ? "pointer" : "crosshair";
  if (!still && visible) schedule();
}
const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
const hit = (x, y) => Math.hypot(x - look.x, y - look.y) < lensR() * 0.5 && words.find((w) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h);

await document.fonts.load("italic 700 40px Fraunces");
await document.fonts.ready;
document.querySelectorAll(".shot canvas").forEach(print);
new ResizeObserver(() => { layoutField(); schedule(); }).observe(field);
new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) schedule(); }).observe(field);
field.addEventListener("pointermove", (e) => {
  const r = field.getBoundingClientRect();
  aim.x = e.clientX - r.left; aim.y = e.clientY - r.top; lastMove = performance.now(); schedule();
});
// a click on sharp type opens that investigation; anywhere else (and the first tap on touch) brings the focus there
field.addEventListener("click", (e) => {
  const r = field.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const w = hit(x, y);
  if (w) window.open(w.item.url, "_blank", "noopener");
  else { aim.x = x; aim.y = y; lastMove = performance.now(); schedule(); }
});
