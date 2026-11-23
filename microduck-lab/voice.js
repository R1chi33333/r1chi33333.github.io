// voice.js — procedural creature voice (WebAudio). Every duck gets a timbre seeded from its serial number.
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function hashSerial(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function makeSerial(rand = Math.random) {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return "MD-" + A[Math.floor(rand() * A.length)] + A[Math.floor(rand() * A.length)] + "-" + String(Math.floor(rand() * 9000) + 1000);
}

/** timbre parameters derived from a serial */
export function voiceParams(serial) {
  const r = mulberry(hashSerial(serial));
  return {
    f0: 520 + r() * 620,            // base pitch
    formant: 900 + r() * 1700,      // bandpass centre
    q: 1.2 + r() * 5,
    wave: ["triangle", "sawtooth", "square", "triangle"][Math.floor(r() * 4)],
    detune: 4 + r() * 22,
    vibRate: 9 + r() * 24, vibDepth: 0.01 + r() * 0.05,
    breath: r() * 0.35,
    syll: 0.055 + r() * 0.06,       // syllable length
    curve: r() * 2 - 1,              // pitch contour bias
    quackiness: r(),
  };
}

export class Voice {
  constructor() { this.ctx = null; this.muted = false; this.serial = "MD-AA-0000"; this.p = voiceParams(this.serial); this.lastAt = 0; this.master = null; }
  ensure() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return this.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.32;
    const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(this.ctx.destination);
    // short noise buffer for breath
    const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
    const d = n.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
    return this.ctx;
  }
  setSerial(serial) { this.serial = serial; this.p = voiceParams(serial); }
  /** kinds: happy | startled | curious | hello | quack | sad */
  play(kind = "happy", opts = {}) {
    if (this.muted) return 0;
    const ctx = this.ensure(); if (!ctx || ctx.state !== "running" && !opts.force) { if (ctx) ctx.resume(); }
    if (!ctx) return 0;
    const now = ctx.currentTime;
    if (!opts.force && now - this.lastAt < 0.35) return 0;
    this.lastAt = now;
    const p = opts.params || this.p;
    const r = mulberry(hashSerial(p.f0 + kind) ^ Math.floor(now * 7));
    const plan = {
      happy: [[1.0, 1.25], [1.2, 1.5], [1.1, 1.65]],
      hello: [[0.9, 1.3], [1.25, 1.1]],
      curious: [[0.85, 1.45]],
      startled: [[1.7, 1.1, 0.6]],
      sad: [[1.0, 0.7], [0.9, 0.6]],
      quack: [[0.55, 0.5], [0.55, 0.48]],
    }[kind] || [[1, 1.2]];
    let t = now + 0.01, total = 0;
    for (const syl of plan) {
      const len = p.syll * (kind === "startled" ? 2.2 : kind === "quack" ? 1.7 : 1) * (0.85 + r() * 0.3);
      this._syllable(t, len, syl, p, kind);
      t += len + 0.035 + r() * 0.03; total = t - now;
    }
    return total;
  }
  _syllable(t, len, contour, p, kind) {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = p.formant * (kind === "quack" ? 0.7 : 1); bp.Q.value = p.q;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 5200;
    const dry = ctx.createGain(); dry.gain.value = 0.35;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = p.wave; o2.type = "sine"; o2.detune.value = p.detune;
    const f0 = p.f0;
    const n = contour.length;
    o1.frequency.setValueAtTime(f0 * contour[0], t); o2.frequency.setValueAtTime(f0 * contour[0] * 2, t);
    for (let i = 1; i < n; i++) {
      const tt = t + len * i / (n - 1);
      o1.frequency.exponentialRampToValueAtTime(f0 * contour[i] * (1 + p.curve * 0.05), tt);
      o2.frequency.exponentialRampToValueAtTime(f0 * contour[i] * 2, tt);
    }
    // vibrato
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = p.vibRate; lg.gain.value = f0 * p.vibDepth;
    lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
    // amplitude envelope (quack: fast AM)
    const peak = kind === "startled" ? 0.9 : 0.7;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.012); g.gain.setTargetAtTime(peak * 0.6, t + 0.02, len * 0.4);
    g.gain.setTargetAtTime(0, t + len * 0.85, 0.02);
    o1.connect(bp); o2.connect(bp); o1.connect(dry); bp.connect(g); dry.connect(g); g.connect(lp); lp.connect(this.master);
    if (p.breath > 0.05 || kind === "startled" || kind === "quack") {
      const ns = ctx.createBufferSource(); ns.buffer = this.noise;
      const nf = ctx.createBiquadFilter(); nf.type = "bandpass"; nf.frequency.value = p.formant * 1.6; nf.Q.value = 1.5;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime((p.breath + (kind === "startled" ? 0.3 : 0)) * 0.5, t + 0.01); ng.gain.setTargetAtTime(0, t + len * 0.5, 0.03);
      ns.connect(nf); nf.connect(ng); ng.connect(this.master); ns.start(t); ns.stop(t + len + 0.2);
    }
    for (const o of [o1, o2, lfo]) { o.start(t); o.stop(t + len + 0.25); }
  }
}
