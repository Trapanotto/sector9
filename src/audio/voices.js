// Enemy voices: each enemy is one consistent "person". Owner: E.
//
// The library's voice lines come from many recordings; one recording/author = one real speaker. A profile picks,
// per line category, ONE author (so an enemy's pains always come from the same throat, his death cry from one
// speaker, …), prefers a "lead" author that covers many categories (TyrantTim: callouts + hit + death + dying +
// plead + cough; riippumattog: taunts + command + pain + plead + cough) and adds a small fixed pitch offset.
// Neighbouring enemy ids get different authors. Lines never repeat back-to-back per enemy and per category
// (bank.pick with a per-profile lastRef), per-category cooldowns keep the chatter believable.
// Pure logic (no Web Audio) — tested in Node.

export const LINE_CATS = ['alert', 'command', 'reload', 'taunt', 'hit', 'plead', 'surprise', 'pain', 'scream', 'death',
  'dying', 'cough', 'effort', 'breath.panic'];
// seconds before the same enemy may use that category again
export const COOLDOWN = { alert: 7, command: 4.5, reload: 4, taunt: 9, hit: 6, plead: 6, surprise: 5, pain: 0.45, scream: 2,
  death: 0, dying: 5, cough: 14, effort: 1.2, 'breath.panic': 9 };
// lines that interrupt whatever the enemy is saying
const URGENT = new Set(['pain', 'scream', 'death', 'dying', 'surprise']);
// "chatter" lines limited to MAX_TALKERS enemies at once (shouting over each other is fine for pain)
const CHATTER = new Set(['alert', 'command', 'reload', 'taunt', 'hit', 'plead', 'cough']);
const MAX_TALKERS = 2;
const LEADS = ['TyrantTim', 'riippumattog'];
// never used as a normal line: reserved for staged moments (beating behind the cash-room door)
export const RESERVED = new Set(['voice/dying_08.mp3', 'voice/pain_23.mp3', 'voice/pain_24.mp3', 'voice/pain_25.mp3', 'voice/pain_26.mp3', 'voice/dying_09.mp3']);

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** authors per category: Map cat → [{author, clips:[index]}] sorted by clip count desc */
export function authorsByCategory(bank) {
  const out = new Map();
  for (const cat of LINE_CATS) {
    const s = bank.sounds.get(`voice.${cat}`);
    const m = new Map();
    if (s) for (const i of s.enabled) {
      const c = bank.clips[i];
      if (RESERVED.has(c.file)) continue;
      if (!m.has(c.author)) m.set(c.author, []);
      m.get(c.author).push(i);
    }
    out.set(cat, [...m].map(([author, clips]) => ({ author, clips })).sort((a, b) => b.clips.length - a.clips.length || (a.author < b.author ? -1 : 1)));
  }
  return out;
}

/** build `n` voice profiles (index = enemy index) */
export function buildProfiles(bank, ids) {
  const by = authorsByCategory(bank);
  return ids.map((id, k) => {
    const lead = k % 3 === 2 ? null : LEADS[k % 3];
    const prof = { id, index: k, lead, pitch: 1 + (((hash(id) % 1000) / 1000) - 0.5) * 0.08, pools: {}, authors: {}, last: {} };
    for (const cat of LINE_CATS) {
      const list = by.get(cat) ?? [];
      if (!list.length) { prof.pools[cat] = []; continue; }
      let pickA = lead ? list.find((a) => a.author === lead) : null;
      // single-clip authors would repeat the same line → only accept the lead with ≥ 1 clip for rare cats, else ≥ 2
      if (!pickA) {
        const rich = list.filter((a) => a.clips.length >= 2);
        const pool = rich.length ? rich : list;
        pickA = pool[(k + (hash(cat) % 7)) % pool.length];
      }
      prof.pools[cat] = pickA.clips;
      prof.authors[cat] = pickA.author;
      prof.last[cat] = { last: -1 };
    }
    return prof;
  });
}

/**
 * Voice controller. speak(enemyIndex, cat, opts) → handle. env = { now(), play(name, o), opts(), ownerBusy(owner),
 * stopOwner(owner), talkers() } supplied by audio.js (wraps the engine) so this stays testable.
 */
export function createVoices(bank, ids, env) {
  const profiles = buildProfiles(bank, ids);
  const n = ids.length;
  const cool = new Float64Array(n * LINE_CATS.length).fill(-1e9);
  const catIdx = Object.fromEntries(LINE_CATS.map((c, i) => [c, i]));
  const lastLine = new Int32Array(n).fill(-1);       // last clip index per enemy (any category)
  const V = { profiles, spoken: 0, blocked: 0, owner: (k) => 1000 + k };
  V.reset = () => { cool.fill(-1e9); lastLine.fill(-1); };
  V.ready = (k, cat) => env.now() - cool[k * LINE_CATS.length + catIdx[cat]] >= (COOLDOWN[cat] ?? 2);
  /**
   * k enemy index, cat line category, o { pos|follow, gain, delay, force, dist }.
   * Returns the engine handle (0 if suppressed).
   */
  V.speak = (k, cat, pos, gain = 1, delay = 0, force = false) => {
    if (k < 0 || k >= n || catIdx[cat] === undefined) return 0;
    const p = profiles[k];
    const ci = catIdx[cat], now = env.now();
    if (!force && now - cool[k * LINE_CATS.length + ci] < (COOLDOWN[cat] ?? 2)) { V.blocked++; return 0; }
    const owner = V.owner(k);
    if (env.ownerBusy(owner)) {
      if (URGENT.has(cat) || force) env.stopOwner(owner);
      else { V.blocked++; return 0; }
    }
    if (CHATTER.has(cat) && !force && env.talkers() >= MAX_TALKERS) { V.blocked++; return 0; }
    const pool = p.pools[cat];
    const o = env.opts();
    o.pos = pos; o.gain = gain; o.delay = delay; o.owner = owner; o.pitch = p.pitch; o.pitchVar = 0.012;
    o.pool = pool && pool.length ? pool : null; o.lastRef = p.last[cat] ?? null; o.cat = 'voice';
    o.prio = URGENT.has(cat) ? 8 : 7;
    const h = env.play(`voice.${cat}`, o);
    cool[k * LINE_CATS.length + ci] = now;
    if (h) { V.spoken++; lastLine[k] = o.lastRef?.last ?? -1; }
    return h;
  };
  V.lastLine = lastLine;
  return V;
}
