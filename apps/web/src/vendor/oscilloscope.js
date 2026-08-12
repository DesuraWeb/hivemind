// ============================================================
// CHAPO — OSCILLOSCOPE VOCAL (canvas 2D) · composant du dock
// Forme d'onde time-domain multi-rubans (réf. « Siri wave ») :
// 3 rubans additifs déphasés + miroir + voile lumineux, effilés
// aux bords (fenêtre de Hann). Fond transparent — pour le verre
// du dock. PAS des barres de fréquences.
//
// INDUSTRIALISATION — remplacer le signal factice par Web Audio
// sans toucher au rendu :
//   const analyser = audioCtx.createAnalyser();
//   analyser.fftSize = 256;
//   const buf = new Uint8Array(analyser.fftSize);
//   osc.setSource((out) => {
//     analyser.getByteTimeDomainData(buf);
//     const step = buf.length / out.length;
//     for (let i = 0; i < out.length; i++)
//       out[i] = (buf[Math.floor(i * step)] - 128) / 128;
//   });
// ============================================================

// ---- PARAMÈTRES (la référence qui fait foi) ----------------
export const OSC_CONFIG = {
  SAMPLES: 128,           // fréquence d'échantillonnage visuelle (points par frame)
  SPEED: 0.5,             // multiplicateur temporel global (1 = temps réel)
  SMOOTHING: 0.78,        // facteur de lissage inter-frames (0 = brut, 1 = figé)
  STATE_EASE: 0.045,      // vitesse de fondu d'amplitude entre états
  MAX_AMPLITUDE: 0.46,    // amplitude max (fraction de la hauteur)
  LINE_WIDTH: 1.6,        // épaisseur du ruban principal
  EDGE_TAPER: true,       // fenêtre de Hann : l'onde s'éteint aux bords
  GLOW: 10,               // halo des rubans (le composant « vivant » du dock)
  MIRROR_SCALE: -0.72,    // ruban miroir sous l'axe (0 = désactivé)
  MIRROR_ALPHA: 0.5,      // opacité relative du miroir
  FILL_ALPHA: 0.05,       // voile lumineux entre ruban et miroir
  IDLE_ALPHA: 0.40,       // ligne plate inactive
  AMP_BY_STATE: { idle: 0, listen: 1, speak: 0.85 },
  COLORS: {               // couleur de base par état (résolue via tokens.css)
    idle: "var(--accent)",                                     // repos : cyan discret
    listen: "var(--accent)",                                   // écoute : accent
    speak: "color-mix(in oklab, var(--accent) 45%, #E6F0F6)"   // Hive : plus clair
  },
  RIBBONS: [              // déclinaisons depuis la couleur d'état ({c})
    { mix: null, alpha: 0.95, width: 1.0, amp: 1.0, shift: 0 },
    { mix: "color-mix(in oklab, {c} 55%, #7FB8E8)", alpha: 0.55, width: 0.75, amp: 0.72, shift: 21 },
    { mix: "color-mix(in oklab, {c} 32%, oklch(0.73 0.10 300))", alpha: 0.42, width: 0.7, amp: 0.52, shift: 47 }
  ]
};

// ---- SOURCE DU SIGNAL (factice : sinusoïdes bruitées) ------
// Signature identique à un wrapper AnalyserNode : remplit `out`
// de valeurs normalisées -1..1.
export function fakeVoiceSource(speed) {
  const sp = speed ?? OSC_CONFIG.SPEED;
  let t = 0;
  return (out, state) => {
    const n = out.length; t += sp / 60;
    const env = state === "idle" ? 0 :
      Math.max(0, 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(t * 1.15)) * (0.5 + 0.5 * Math.sin(t * 0.42 + 1.3)) - 0.10 * Math.sin(t * 2.9));
    const f = state === "speak" ? 2.4 : 3.4; // Hive « parle » un peu plus grave
    for (let i = 0; i < n; i++) {
      const x = i / n;
      out[i] = env * (
        0.55 * Math.sin(x * Math.PI * 2 * f + t * 4.2) +
        0.28 * Math.sin(x * Math.PI * 2 * f * 2.7 + t * 6.4) +
        0.12 * Math.sin(x * Math.PI * 2 * f * 5.3 + t * 9.5) +
        0.08 * Math.sin(x * Math.PI * 2 * 9 + t * 5.0) * Math.sin(t * 1.7)
      );
    }
  };
}

// ---- RENDU (indépendant de la source) ----------------------
export function create(container, opts = {}) {
  const C = { ...OSC_CONFIG, ...(opts.config || {}) };
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;";
  container.appendChild(canvas);
  const g = canvas.getContext("2d");
  let state = opts.state || "idle";
  let source = opts.source || fakeVoiceSource();
  const target = new Float32Array(C.SAMPLES), disp = new Float32Array(C.SAMPLES);
  let amp = 0, raf = 0;

  // résolution des couleurs CSS (var / color-mix / oklch) en rgb concrets
  const probe = document.createElement("span");
  probe.style.display = "none";
  container.appendChild(probe);
  const resolve = c => { probe.style.color = c; return getComputedStyle(probe).color; };
  let base = "", ribbons = [];
  const refreshColors = () => {
    base = resolve(C.COLORS[state] || C.COLORS.idle);
    ribbons = C.RIBBONS.map(r => ({ ...r, col: r.mix ? resolve(r.mix.split("{c}").join(base)) : base }));
  };
  refreshColors();

  const size = () => {
    const d = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, canvas.clientWidth * d);
    canvas.height = Math.max(2, canvas.clientHeight * d);
    g.setTransform(d, 0, 0, d, 0, 0);
  };
  const ro = new ResizeObserver(size);
  ro.observe(canvas); size();

  function frame() {
    const w = canvas.clientWidth, h = canvas.clientHeight, mid = h / 2;
    source(target, state);
    amp += (C.AMP_BY_STATE[state] - amp) * C.STATE_EASE;
    for (let i = 0; i < C.SAMPLES; i++) disp[i] += (target[i] - disp[i]) * (1 - C.SMOOTHING);
    g.clearRect(0, 0, w, h);
    g.lineCap = "round"; g.lineJoin = "round";
    const n = C.SAMPLES;
    const px = i => i / (n - 1) * w;
    const val = (i, shift, k) => {
      const win = C.EDGE_TAPER ? 0.5 * (1 - Math.cos(Math.PI * 2 * i / (n - 1))) : 1;
      return disp[(i + shift) % n] * k * win * amp * C.MAX_AMPLITUDE * h;
    };
    const trace = (shift, k, close) => {
      g.beginPath();
      g.moveTo(px(0), mid + val(0, shift, k));
      for (let i = 1; i < n - 1; i++) {
        const y1 = mid + val(i, shift, k), y2 = mid + val(i + 1, shift, k);
        g.quadraticCurveTo(px(i), y1, (px(i) + px(i + 1)) / 2, (y1 + y2) / 2);
      }
      g.lineTo(px(n - 1), mid + val(n - 1, shift, k));
      if (close) {
        for (let i = n - 1; i >= 0; i--) g.lineTo(px(i), mid + val(i, shift, k * C.MIRROR_SCALE));
        g.closePath();
      }
    };
    if (state === "idle" && amp < 0.02) {
      g.globalAlpha = C.IDLE_ALPHA; g.strokeStyle = base; g.lineWidth = C.LINE_WIDTH; g.shadowBlur = 0;
      trace(0, 1, false); g.stroke();
    } else {
      g.globalCompositeOperation = "lighter";
      // voile lumineux entre le ruban principal et son miroir
      if (C.FILL_ALPHA > 0 && C.MIRROR_SCALE !== 0) {
        g.globalAlpha = C.FILL_ALPHA; g.fillStyle = base; g.shadowBlur = 0;
        trace(0, 1, true); g.fill();
      }
      for (const r of ribbons) {
        g.strokeStyle = r.col;
        if (C.GLOW > 0) { g.shadowBlur = C.GLOW; g.shadowColor = r.col; }
        g.globalAlpha = r.alpha; g.lineWidth = C.LINE_WIDTH * r.width;
        trace(r.shift, r.amp, false); g.stroke();
        if (C.MIRROR_SCALE !== 0) {
          g.globalAlpha = r.alpha * C.MIRROR_ALPHA;
          trace(r.shift, r.amp * C.MIRROR_SCALE, false); g.stroke();
        }
      }
      g.globalCompositeOperation = "source-over";
    }
    g.shadowBlur = 0; g.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState: s => { state = s; refreshColors(); if (opts.onState) opts.onState(s); },
    get state() { return state; },
    setSource: fn => { source = fn; },
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); canvas.remove(); probe.remove(); }
  };
}

window.ChapoOscillo = { create, fakeVoiceSource, CONFIG: OSC_CONFIG };
window.dispatchEvent(new Event("chapo-oscillo-ready"));
