// ============================================================
// CHAPO — ORBE (three.js) · composant signature · v2
//
// Technique de rendu reprise de « Particles Galaxy » de
// prisoner849 (CodePen — licence MIT) : THREE.PointsMaterial
// étendu via onBeforeCompile, attributs par particule
// (aSize, aShift), mouvement organique par jitter sphérique,
// points doux (smoothstep sur gl_PointCoord), AdditiveBlending.
// Adaptations Chapo : orbe seule (disque optionnel atténué),
// couleurs par uniforms depuis les design tokens (aucune
// couleur en dur dans le shader), clusters par projet,
// états idle / focus / hover, perfs composant (DPR ≤ 2,
// pause hors viewport / onglet caché), montage en conteneur.
// ============================================================
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ---- PARAMÈTRES (la référence qui fait foi) ----------------
export const ORB_CONFIG = {
  PARTICLE_COUNT: 15000,    // budget particules (composant, pas plein écran)
  SHELL_RADIUS: 1.0,        // rayon de la coquille
  SHELL_THICKNESS: 0.10,    // épaisseur relative de la coquille
  CLUSTER_SPREAD: 0.30,     // rad — étalement angulaire d'un cluster
  VEIL_RATIO: 0.30,         // part des particules en voile uniforme (silhouette)
  PARTICLE_SIZE: 0.023,     // taille de base (monde, avec atténuation)
  SIZE_MIN: 0.5, SIZE_MAX: 1.9, // multiplicateur aléatoire par particule
  ALPHA: 0.5,               // opacité globale (l'additif sature vite)
  JITTER_SPEED: 0.55,       // vitesse du mouvement organique (aShift.z)
  JITTER_AMPL: 0.055,       // amplitude du jitter (aShift.w, unités monde)
  ROT_SPEED: 0.05,          // rad/s — rotation automatique lente
  WOBBLE: 0.05,             // rad — oscillation d'inclinaison
  COLOR_A_CSS: "var(--accent)",                                  // dégradé : avant
  COLOR_B_CSS: "color-mix(in oklab, var(--accent) 22%, #46608A)",// dégradé : arrière (bleuté fond)
  TINT_MIX: 0.65,           // poids de la teinte projet vs dégradé
  SATURATION: 0.92,         // saturation des teintes projet
  VEIL_TINT: "#6E86A6",     // teinte du voile neutre
  BACK_FADE: 0.62,          // atténuation des particules en face arrière (0-1)
  DISK_ENABLED: false,      // disque galactique : option, très atténué
  DISK_SHARE: 0.18,         // part du budget particules si activé
  DISK_RADIUS: [1.3, 2.6],  // rayons intérieur/extérieur
  DISK_ALPHA: 0.28,
  FOCUS_STRETCH: 0.14,      // étirement radial du cluster focus (reste cohérent)
  FOCUS_SIZE_BOOST: 1.3,    // grossissement des particules du cluster focus
  FOCUS_DIM: 0.20,          // luminosité du reste (0-1)
  FOCUS_DESAT: 0.85,        // désaturation du reste (0-1)
  FOCUS_ZOOM: 0.35,         // rapprochement caméra au focus
  FOCUS_DUR: 1.0,           // s — transition aller
  UNFOCUS_DUR: 0.7,         // s — transition retour
  HOVER_BRIGHTEN: 0.4,      // surbrillance additive du cluster survolé
  HOVER_RADIUS_NDC: 0.22,   // rayon de détection (centres de clusters, espace écran)
  PARALLAX: 0.10,
  CAMERA_Z: 3.05,
  FOV: 42,
  DPR_MAX: 2
};
// Compat : anciens présets (rendu v1) — l'API v2 n'en a plus besoin.
export const ORB_PRESETS = { constellation: {}, nebuleuse: {}, coquille: {} };

const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function clusterDirs(n) {
  const dirs = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) * 2 / n, r = Math.sqrt(1 - y * y), a = ga * i;
    dirs.push(new THREE.Vector3(Math.cos(a) * r, y * 0.85, Math.sin(a) * r).normalize());
  }
  return dirs;
}

export function create(container, opts = {}) {
  const C = { ...ORB_CONFIG, ...(opts.config || {}) };
  const projects = opts.projects || [];
  const onHover = opts.onHover || (() => {});
  const onClusterClick = opts.onClusterClick || (() => {});
  const onStateChange = opts.onStateChange || (() => {});

  // --- résolution des tokens CSS en couleurs concrètes ---
  // (via canvas 2D : gère oklch / color-mix, que THREE.Color ne parse pas)
  const probe = document.createElement("span");
  probe.style.display = "none";
  container.appendChild(probe);
  const pcnv = document.createElement("canvas");
  pcnv.width = pcnv.height = 1;
  const pctx = pcnv.getContext("2d", { willReadFrequently: true });
  const resolve = css => {
    probe.style.color = css;
    pctx.fillStyle = "#000"; pctx.fillRect(0, 0, 1, 1);
    pctx.fillStyle = getComputedStyle(probe).color; pctx.fillRect(0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return new THREE.Color(d[0] / 255, d[1] / 255, d[2] / 255);
  };
  const colorA = resolve(C.COLOR_A_CSS), colorB = resolve(C.COLOR_B_CSS), veilTint = resolve(C.VEIL_TINT);

  // --- scène (fond transparent, pas de scene.background) ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(C.FOV, 1, 0.1, 20);
  camera.position.set(0, 0, C.CAMERA_Z);
  const group = new THREE.Group();
  scene.add(group);

  // --- géométrie : coquille clusterisée + voile (+ disque optionnel) ---
  const N = C.PARTICLE_COUNT;
  const diskN = C.DISK_ENABLED ? Math.floor(N * C.DISK_SHARE) : 0;
  const veilN = Math.floor((N - diskN) * C.VEIL_RATIO);
  const clusterN = N - diskN - veilN;
  const dirs = clusterDirs(projects.length);
  const totalW = projects.reduce((s, p) => s + (p.nodes || 200), 0) || 1;
  const pos = new Float32Array(N * 3), aSize = new Float32Array(N),
    aShift = new Float32Array(N * 4), aCluster = new Float32Array(N), aTint = new Float32Array(N * 3);
  const tints = projects.map(p => {
    const c = new THREE.Color(p.tint);
    if (C.SATURATION !== 1) { const h = {}; c.getHSL(h); c.setHSL(h.h, Math.min(1, h.s * C.SATURATION), h.l); }
    return c;
  });
  let k = 0;
  const put = (v, ci, tint, sizeMul) => {
    pos.set([v.x, v.y, v.z], k * 3);
    aSize[k] = (C.SIZE_MIN + Math.random() * (C.SIZE_MAX - C.SIZE_MIN)) * (sizeMul || 1);
    aShift.set([Math.random() * Math.PI * 2, Math.random() * Math.PI * 2,
      C.JITTER_SPEED * (0.4 + Math.random() * 0.6), C.JITTER_AMPL * (0.3 + Math.random() * 0.7)], k * 4);
    aCluster[k] = ci;
    aTint.set([tint.r, tint.g, tint.b], k * 3);
    k++;
  };
  projects.forEach((p, ci) => {
    const count = Math.round(clusterN * (p.nodes || 200) / totalW);
    const spread = C.CLUSTER_SPREAD * (0.7 + 0.3 * Math.sqrt((p.nodes || 200) / 520));
    const cdir = dirs[ci];
    const u = new THREE.Vector3(0, 1, 0).cross(cdir).normalize();
    if (u.lengthSq() < 0.01) u.set(1, 0, 0);
    const v = cdir.clone().cross(u).normalize();
    for (let i = 0; i < count && k < N - diskN - veilN + count; i++) {
      const dir = cdir.clone().add(u.clone().multiplyScalar(gauss() * spread)).add(v.clone().multiplyScalar(gauss() * spread)).normalize();
      const r = C.SHELL_RADIUS * (1 + (Math.random() - 0.5) * C.SHELL_THICKNESS);
      put(dir.multiplyScalar(r), ci, tints[ci]);
    }
  });
  while (k < N - diskN) { // voile uniforme
    const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, rr = Math.sqrt(1 - z * z);
    const dir = new THREE.Vector3(rr * Math.cos(a), z, rr * Math.sin(a));
    put(dir.multiplyScalar(C.SHELL_RADIUS * (1 + (Math.random() - 0.5) * C.SHELL_THICKNESS)), -1, veilTint, 0.75);
  }
  while (k < N) { // disque optionnel très atténué
    const a = Math.random() * Math.PI * 2;
    const r = C.DISK_RADIUS[0] + Math.pow(Math.random(), 1.6) * (C.DISK_RADIUS[1] - C.DISK_RADIUS[0]);
    put(new THREE.Vector3(Math.cos(a) * r, gauss() * 0.035, Math.sin(a) * r), -1, colorB, C.DISK_ALPHA);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute("aShift", new THREE.BufferAttribute(aShift, 4));
  geo.setAttribute("aCluster", new THREE.BufferAttribute(aCluster, 1));
  geo.setAttribute("aTint", new THREE.BufferAttribute(aTint, 3));

  // --- matériau : PointsMaterial + shader injecté (onBeforeCompile) ---
  const uni = {
    uTime: { value: 0 }, uColorA: { value: colorA }, uColorB: { value: colorB },
    uFocusCluster: { value: -1 }, uFocusBlend: { value: 0 }, uHoverCluster: { value: -1 },
    uStretch: { value: C.FOCUS_STRETCH }, uDim: { value: C.FOCUS_DIM }, uDesat: { value: C.FOCUS_DESAT }
  };
  const mat = new THREE.PointsMaterial({
    size: C.PARTICLE_SIZE, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending
  });
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uni);
    shader.vertexShader = `
      attribute float aSize; attribute vec4 aShift; attribute float aCluster; attribute vec3 aTint;
      uniform float uTime; uniform vec3 uColorA; uniform vec3 uColorB;
      uniform float uFocusCluster; uniform float uFocusBlend; uniform float uHoverCluster;
      uniform float uStretch; uniform float uDim; uniform float uDesat;
      varying vec3 vColor; varying float vA;
    ` + shader.vertexShader
      .replace("#include <begin_vertex>", `
        vec3 transformed = vec3( position );
        float mt = mod(aShift.x + aShift.z * uTime, PI2);
        float ms = mod(aShift.y + aShift.z * uTime, PI2);
        transformed += vec3(cos(ms) * sin(mt), cos(mt), sin(ms) * sin(mt)) * aShift.w;
        float isF = uFocusCluster < -0.5 ? 0.0 : step(abs(aCluster - uFocusCluster), 0.5);
        float fBoost = isF * uFocusBlend;
        transformed += normalize(position) * uStretch * fBoost;
      `)
      .replace("#include <project_vertex>", `
        #include <project_vertex>
        float vd = clamp((-mvPosition.z - ${(C.CAMERA_Z - C.SHELL_RADIUS).toFixed(3)}) / ${(2 * C.SHELL_RADIUS).toFixed(3)}, 0.0, 1.0);
        vec3 grad = mix(uColorA, uColorB, vd);
        vColor = mix(grad, aTint, ${C.TINT_MIX.toFixed(3)});
        float others = uFocusBlend * (1.0 - isF);
        float lum = dot(vColor, vec3(0.299, 0.587, 0.114));
        vColor = mix(vColor, vec3(lum), others * uDesat);
        float isH = uHoverCluster < -0.5 ? 0.0 : step(abs(aCluster - uHoverCluster), 0.5);
        vColor *= 1.0 + isH * ${C.HOVER_BRIGHTEN.toFixed(3)};
        vA = mix(1.0, uDim, others) * mix(1.0, ${(1 - C.BACK_FADE).toFixed(3)}, vd) * ${C.ALPHA.toFixed(3)};
      `)
      .replace("gl_PointSize = size;", `gl_PointSize = size * aSize * (1.0 + fBoost * ${(C.FOCUS_SIZE_BOOST - 1).toFixed(3)});`);
    shader.fragmentShader = `varying vec3 vColor; varying float vA;\n` + shader.fragmentShader
      .replace("vec4 diffuseColor = vec4( diffuse, opacity );", `
        float pd = length(gl_PointCoord.xy - vec2(0.5));
        vec4 diffuseColor = vec4( vColor, vA * smoothstep(0.5, 0.1, pd) );
      `);
  };
  group.add(new THREE.Points(geo, mat));

  // --- états ---
  let mode = "idle", focusId = null, trans = null, hoverCluster = -1;
  let rotY = 0, focusBlend = 0, mouse = { x: 0, y: 0 }, raf = 0, last = performance.now(), tAcc = 0;
  const _FWD = new THREE.Vector3(0, 0, 1), focusQ = new THREE.Quaternion(), _qIdle = new THREE.Quaternion(), _eIdle = new THREE.Euler();
  const clusterOf = id => projects.findIndex(p => p.id === id);

  function focus(id) {
    const ci = id == null ? -1 : clusterOf(id);
    if (id != null && ci < 0) return;
    focusId = id == null ? null : id;
    if (focusId) { uni.uFocusCluster.value = ci; focusQ.setFromUnitVectors(dirs[ci], _FWD); }
    trans = { t: 0, dur: focusId ? C.FOCUS_DUR : C.UNFOCUS_DUR, from: focusBlend, to: focusId ? 1 : 0 };
    mode = focusId ? "focusing" : "unfocusing";
    onStateChange(focusId ? "focus:" + focusId : "retour idle");
  }

  // --- survol : centre de cluster le plus proche en espace écran ---
  let lastPick = 0;
  const ndc = new THREE.Vector3();
  function pick(ev) {
    const now = performance.now();
    if (now - lastPick < 40) return; lastPick = now;
    const r = container.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * 2 - 1, my = -((ev.clientY - r.top) / r.height) * 2 + 1;
    mouse.x = mx; mouse.y = my;
    group.updateMatrixWorld();
    let best = -1, bestD = C.HOVER_RADIUS_NDC * C.HOVER_RADIUS_NDC;
    for (let i = 0; i < dirs.length; i++) {
      ndc.copy(dirs[i]).multiplyScalar(C.SHELL_RADIUS).applyMatrix4(group.matrixWorld);
      if (ndc.z < -0.15 && !focusId) continue; // face cachée
      ndc.project(camera);
      const dx = ndc.x - mx, dy = ndc.y - my, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best !== hoverCluster) {
      hoverCluster = best;
      uni.uHoverCluster.value = best;
      container.style.cursor = best >= 0 ? "pointer" : "";
    }
    onHover(best >= 0 ? projects[best] : null, ev.clientX - r.left, ev.clientY - r.top);
  }
  const onMove = e => pick(e);
  const onLeave = () => { hoverCluster = -1; uni.uHoverCluster.value = -1; container.style.cursor = ""; onHover(null, 0, 0); };
  const onClick = e => { if (e.target !== renderer.domElement) return; onClusterClick(hoverCluster >= 0 ? projects[hoverCluster].id : null); };
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerleave", onLeave);
  container.addEventListener("click", onClick);

  // --- resize ---
  const resize = () => {
    const w = container.clientWidth || 2, h = container.clientHeight || 2;
    renderer.setPixelRatio(Math.min(C.DPR_MAX, window.devicePixelRatio || 1));
    renderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  // --- boucle, avec pause onglet caché / hors viewport ---
  let inView = true;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    tAcc += dt;
    uni.uTime.value = tAcc;
    const t = tAcc;
    if (mode === "idle" || mode === "unfocusing") rotY += C.ROT_SPEED * dt;
    if (trans) {
      trans.t += dt / trans.dur;
      const u = Math.min(1, trans.t);
      focusBlend = trans.from + (trans.to - trans.from) * easeInOutCubic(u);
      if (u >= 1) {
        trans = null; mode = focusId ? "focused" : "idle";
        if (!focusId) { uni.uFocusCluster.value = -1; onStateChange("idle"); }
      }
    }
    uni.uFocusBlend.value = focusBlend;
    _eIdle.set(Math.sin(t * 0.11) * C.WOBBLE, rotY, 0);
    _qIdle.setFromEuler(_eIdle);
    group.quaternion.copy(_qIdle);
    if (focusBlend > 0) group.quaternion.slerp(focusQ, focusBlend);
    camera.position.x += (mouse.x * C.PARALLAX - camera.position.x) * 0.04;
    camera.position.y += (mouse.y * C.PARALLAX * 0.6 - camera.position.y) * 0.04;
    const camZ = focusId ? C.CAMERA_Z - C.FOCUS_ZOOM : C.CAMERA_Z;
    camera.position.z += (camZ - camera.position.z) * 0.045;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  const toggleLoop = () => {
    const run = !document.hidden && inView;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const onVis = () => toggleLoop();
  document.addEventListener("visibilitychange", onVis);
  const io = new IntersectionObserver(es => { inView = es[0]?.isIntersecting !== false; toggleLoop(); });
  io.observe(container);
  toggleLoop();
  onStateChange("idle");

  const _tmpV = new THREE.Vector3();
  return {
    focus,
    // Positions écran des centres de clusters (px conteneur) — pour tuiles ancrées.
    getClusterPositions() {
      group.updateMatrixWorld();
      const w = container.clientWidth, h = container.clientHeight;
      return projects.map((p, i) => {
        _tmpV.copy(dirs[i]).multiplyScalar(C.SHELL_RADIUS).applyMatrix4(group.matrixWorld);
        const front = _tmpV.z > -0.08;
        _tmpV.project(camera);
        return { id: p.id, x: (_tmpV.x + 1) / 2 * w, y: (1 - _tmpV.y) / 2 * h, front };
      });
    },
    get focusedId() { return focusId; },
    destroy() {
      cancelAnimationFrame(raf); raf = 0;
      ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("click", onClick);
      geo.dispose(); mat.dispose(); renderer.dispose();
      renderer.domElement.remove(); probe.remove();
    }
  };
}

window.ChapoOrb = { create, CONFIG: ORB_CONFIG, PRESETS: ORB_PRESETS };
window.dispatchEvent(new Event("chapo-orb-ready"));
