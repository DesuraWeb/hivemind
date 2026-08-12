// ============================================================
// CHAPO — AMBIANCE · écho de l'orbe sur toutes les pages
// Champ de particules STATIQUE (constellation lointaine),
// rendu canvas généré une fois — aucune animation continue.
// Déterministe : même ciel à chaque affichage.
// ============================================================

// ---- PARAMÈTRES ------------------------------------------
export const AMBIANCE = {
  COUNT: 220,          // nombre d'étoiles
  OPACITY: 0.05,       // opacité de base (3-6 % demandé)
  SIZE_MIN: 0.6,
  SIZE_MAX: 1.9,
  BRIGHT_RATIO: 0.12,  // part d'étoiles un peu plus visibles
  TINT: "var(--accent)",
  TINT_MIX: 0.45,      // part des étoiles teintées accent
  BASE: "#AFC6E2"      // teinte neutre froide
};

export function paint(container, opts = {}) {
  const C = { ...AMBIANCE, ...(opts.config || {}) };
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  container.appendChild(canvas);
  const g = canvas.getContext("2d");
  const probe = document.createElement("span");
  probe.style.display = "none";
  container.appendChild(probe);
  const resolve = c => { probe.style.color = c; return getComputedStyle(probe).color; };
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const draw = () => {
    const d = Math.min(2, window.devicePixelRatio || 1);
    const w = container.clientWidth || 2, h = container.clientHeight || 2;
    canvas.width = w * d; canvas.height = h * d;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const tint = resolve(C.TINT), base = resolve(C.BASE);
    seed = 12345;
    for (let i = 0; i < C.COUNT; i++) {
      const x = rnd() * w, y = rnd() * h;
      const r = C.SIZE_MIN + rnd() * (C.SIZE_MAX - C.SIZE_MIN);
      const bright = rnd() < C.BRIGHT_RATIO;
      g.globalAlpha = Math.min(0.16, C.OPACITY * (bright ? 2.4 : 0.6 + rnd()));
      g.fillStyle = rnd() < C.TINT_MIX ? tint : base;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  };
  draw();
  let t;
  const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(draw, 150); });
  ro.observe(container);
  return { repaint: draw, destroy() { ro.disconnect(); canvas.remove(); probe.remove(); clearTimeout(t); } };
}

window.ChapoAmbiance = { paint, CONFIG: AMBIANCE };
// Auto-montage : tout élément marqué data-chapo-ambiance reçoit le champ d'étoiles.
const _auto = () => document.querySelectorAll("[data-chapo-ambiance]").forEach(el => { if (!el.__chapoAmb) el.__chapoAmb = paint(el); });
new MutationObserver(_auto).observe(document.documentElement, { childList: true, subtree: true });
_auto();
window.dispatchEvent(new Event("chapo-ambiance-ready"));
