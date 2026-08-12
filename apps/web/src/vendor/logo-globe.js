// ============================================================
// CHAPO — LOGO GLOBE (canvas 2D) · mini-orbe du rail nav
// Petit globe de particules cyan en rotation continue, monté
// sur tout élément [data-chapo-logo]. Léger (pas de WebGL),
// pause quand l'onglet est caché.
// ============================================================
export const LOGO_CONFIG = {
  COUNT: 120,          // particules
  ROT_SPEED: 0.55,     // rad/s
  SIZE_MIN: 0.5,       // px — rayon particule (avant profondeur)
  SIZE_MAX: 1.3,
  DEPTH_FADE: 0.72,    // atténuation de la face arrière (0-1)
  ALPHA: 0.95,
  SQUASH: 0.97,        // léger aplatissement vertical
  DPR_MAX: 3
};

function start(el) {
  if (el.dataset.chapoLogoDone) return;
  el.dataset.chapoLogoDone = "1";
  const C = LOGO_CONFIG;
  if (!el.style.position) el.style.position = "relative";
  const cv = document.createElement("canvas");
  cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  el.appendChild(cv);
  const g = cv.getContext("2d");
  // couleurs résolues depuis les tokens
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  const resolve = c => { probe.style.color = c; return getComputedStyle(probe).color; };
  const base = resolve("var(--accent)");
  const light = resolve("color-mix(in oklab, var(--accent) 45%, white)");
  probe.remove();
  // sphère de Fibonacci
  const pts = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < C.COUNT; i++) {
    const y = 1 - (i + 0.5) * 2 / C.COUNT, r = Math.sqrt(1 - y * y), a = ga * i;
    pts.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, s: C.SIZE_MIN + Math.random() * (C.SIZE_MAX - C.SIZE_MIN) });
  }
  let raf = 0, last = performance.now(), rot = Math.random() * 6.28;
  const size = () => {
    const d = Math.min(C.DPR_MAX, window.devicePixelRatio || 1);
    cv.width = Math.max(2, el.clientWidth * d);
    cv.height = Math.max(2, el.clientHeight * d);
    g.setTransform(d, 0, 0, d, 0, 0);
  };
  size();
  const frame = now => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    rot += C.ROT_SPEED * dt;
    const w = el.clientWidth, h = el.clientHeight, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 1;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    g.clearRect(0, 0, w, h);
    for (const p of pts) {
      const xr = p.x * cos + p.z * sin, zr = -p.x * sin + p.z * cos;
      const depth = (zr + 1) / 2; // 0 = arrière, 1 = avant
      g.globalAlpha = C.ALPHA * (1 - C.DEPTH_FADE * (1 - depth));
      g.fillStyle = depth > 0.78 ? light : base;
      g.beginPath();
      g.arc(cx + xr * R, cy + p.y * R * C.SQUASH, p.s * (0.55 + 0.65 * depth), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;
  };
  const toggle = () => {
    if (!document.hidden && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  document.addEventListener("visibilitychange", toggle);
  toggle();
}

const scan = () => document.querySelectorAll("[data-chapo-logo]").forEach(start);
scan();
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
