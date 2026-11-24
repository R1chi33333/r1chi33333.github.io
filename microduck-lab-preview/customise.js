// customise.js — the "Customise your duck" start screen: colourway presets, per-part paint, voice presets,
// optional skates, randomise, and LET'S GO. The choice is remembered in localStorage (when available).
import { SKINS } from "./look.js";
import { voiceParams } from "./voice.js";

const KEY = "microduck.custom.v1";
export const SKIN_LIST = [
  { id: "cream", label: "Cream" }, { id: "graphite", label: "Graphite" }, { id: "lavender", label: "Lavender" }, { id: "sky", label: "Sky" },
];
export const PAINT_PARTS = [
  { id: "head", label: "Head", groups: ["head"] },
  { id: "body", label: "Body", groups: ["body"] },
  { id: "legs", label: "Legs", groups: ["legs"] },
  { id: "feet", label: "Feet", groups: ["feet"] },
];

/** four clearly different voices picked from a fixed pool of serials (deterministic) */
export function voicePresets() {
  const pool = [];
  for (let i = 0; i < 240; i++) { const serial = "MD-VC-" + (1000 + i * 7); pool.push({ serial, p: voiceParams(serial) }); }
  const byPitch = [...pool].sort((a, b) => a.p.f0 - b.p.f0);
  const low = byPitch[3], high = byPitch[byPitch.length - 4];
  const mid = byPitch.slice(90, 150);
  const warbly = [...mid].sort((a, b) => b.p.vibDepth - a.p.vibDepth)[0];
  const chirpy = [...mid].filter(v => v !== warbly).sort((a, b) => a.p.vibDepth - b.p.vibDepth)[0];
  return [
    { name: "Chirpy", serial: chirpy.serial }, { name: "Squeaky", serial: high.serial },
    { name: "Warbly", serial: warbly.serial }, { name: "Honky", serial: low.serial },
  ];
}

export const defaultChoice = () => ({ skin: "cream", parts: { head: null, body: null, legs: null, feet: null }, voice: 0, skates: false });
export function loadChoice() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!c || !SKINS[c.skin]) return null;
    const d = defaultChoice();
    for (const p of PAINT_PARTS) d.parts[p.id] = c.parts && SKINS[c.parts[p.id]] ? c.parts[p.id] : null;
    return { ...d, skin: c.skin, voice: Number.isInteger(c.voice) ? Math.max(0, Math.min(3, c.voice)) : 0, skates: !!c.skates };
  } catch (e) { return null; }
}
export function saveChoice(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* private mode etc. */ } }
export function randomChoice(rand = Math.random) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const c = defaultChoice(); c.skin = pick(SKIN_LIST).id;
  for (const p of PAINT_PARTS) c.parts[p.id] = rand() < 0.45 ? pick(SKIN_LIST).id : null;
  c.voice = Math.floor(rand() * 4); c.skates = rand() < 0.3;
  return c;
}

const swatchCss = (id) => { const s = SKINS[id]; return `--c1:${s.shell};--c2:${s.accent};--c3:${s.secondary}`; };

/**
 * Build the panel UI into `root`. hooks: { onChange(choice, what), onPlayVoice(index), onGo(choice) }
 */
export function createCustomiser(root, choice, voices, hooks) {
  let c = JSON.parse(JSON.stringify(choice));
  root.innerHTML = `
    <h2 class="cz-title">Customise your duck</h2>
    <div class="cz-body">
      <section class="cz-sec"><div class="cz-label">Colourway</div>
        <div class="cz-skins">${SKIN_LIST.map(s => `<button class="cz-skin" data-skin="${s.id}" style="${swatchCss(s.id)}" aria-pressed="false"><i></i><span>${s.label}</span></button>`).join("")}</div>
      </section>
      <section class="cz-sec"><div class="cz-label">Paint a part</div>
        ${PAINT_PARTS.map(p => `<div class="cz-part" data-part="${p.id}"><span class="cz-pl">${p.label}</span>${SKIN_LIST.map(s => `<button class="cz-sw" data-part="${p.id}" data-skin="${s.id}" style="${swatchCss(s.id)}" aria-label="${p.label}: ${s.label}" aria-pressed="false"></button>`).join("")}</div>`).join("")}
      </section>
      <section class="cz-sec"><div class="cz-label">Voice</div>
        <div class="cz-voices">${voices.map((v, i) => `<button class="cz-voice" data-voice="${i}" aria-pressed="false"><b>▶</b><span>${v.name}</span></button>`).join("")}</div>
      </section>
      <section class="cz-sec cz-row">
        <button class="cz-toggle" id="czSkates" aria-pressed="false"><i></i>Start on skates</button>
      </section>
    </div>
    <div class="cz-foot">
      <button class="btn cz-rand" id="czRand">Randomise</button>
      <button class="btn primary cz-go" id="czGo">Let's go!</button>
    </div>`;
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  function refresh() {
    $$(".cz-skin").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.skin === c.skin)));
    $$(".cz-sw").forEach(b => b.setAttribute("aria-pressed", String((c.parts[b.dataset.part] || c.skin) === b.dataset.skin)));
    $$(".cz-voice").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.voice) === c.voice)));
    root.querySelector("#czSkates").setAttribute("aria-pressed", String(c.skates));
  }
  $$(".cz-skin").forEach(b => b.onclick = () => { c.skin = b.dataset.skin; for (const k in c.parts) c.parts[k] = null; refresh(); hooks.onChange(c, "skin"); });
  $$(".cz-sw").forEach(b => b.onclick = () => { c.parts[b.dataset.part] = b.dataset.skin === c.skin ? null : b.dataset.skin; refresh(); hooks.onChange(c, "part"); });
  $$(".cz-voice").forEach(b => b.onclick = () => { c.voice = Number(b.dataset.voice); refresh(); hooks.onChange(c, "voice"); hooks.onPlayVoice(c.voice); });
  root.querySelector("#czSkates").onclick = () => { c.skates = !c.skates; refresh(); hooks.onChange(c, "skates"); };
  root.querySelector("#czRand").onclick = () => { c = randomChoice(); refresh(); hooks.onChange(c, "random"); };
  root.querySelector("#czGo").onclick = () => hooks.onGo(c);
  refresh();
  return {
    get choice() { return c; },
    set(choice) { c = JSON.parse(JSON.stringify(choice)); refresh(); },
    randomise() { root.querySelector("#czRand").click(); },
    go() { hooks.onGo(c); },
    focusGo() { root.querySelector("#czGo").focus({ preventScroll: true }); },
  };
}
