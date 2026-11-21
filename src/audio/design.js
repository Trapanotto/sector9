// Sound design for the contract events: gunfire (layered, space-dependent tails, distant recordings, bursts),
// impacts by surface with debris, ricochets, near-miss whizz, casings, reload stages, doors / roller doors, glass,
// light circuits, player damage/death, flashlight, footsteps (player + enemies), motion foley + mic wind, and the
// enemy voice behaviour (alert, squad replies, chatter, reload calls, pain, death, dying, pleading). Owner: E.
//
// K (kit, built in audio.js): { ctx, E (engine), bank, sched, V (voices), T (tension), now(), classAt(x,y,z),
//   listenerClass(), L (listener {x,y,z}), surfaceBelow(x,y,z), enemyIndex(e) }
// Everything here is event-driven or runs in update() without allocations (shared opts object, scheduler pool).

const MAG = { pistol: 13, smg: 25, rifle: 30, shotgun: 6 };
const SHOT = { pistol: 'weapon.pistol.shot', rifle: 'weapon.rifle.shot', shotgun: 'weapon.shotgun.shot', smg: 'weapon.rifle.shot' };
const SHOT_PITCH = { pistol: 1, rifle: 1, shotgun: 1, smg: 1.12 };
const SHOT_GAIN = { pistol: 1, rifle: 1.1, shotgun: 1.15, smg: 0.85 };
const BURST = { smg: 'weapon.smg.burst', rifle: 'weapon.rifle.burst' };
const OUTDOOR_ECHO = { x: 48, y: 6, z: 32 };   // building facade the yard echoes come back from

export function installDesign(K) {
  const { ctx, E, sched, V } = K;
  const ev = ctx.events;
  const D = { bursts: 0, whizz: 0, impacts: 0 };
  const P = () => ctx.player;
  const rnd = Math.random;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const d2L = (x, y, z) => Math.hypot(x - K.L.x, y - K.L.y, z - K.L.z);

  // ---- tiny helpers (shared opts object; positions are copied by the engine at play time)
  const at = { x: 0, y: 0, z: 0 };
  function playAt(name, x, y, z, gain = 1, pitch = 1, delay = 0, extra) {
    const o = E.opts(); at.x = x; at.y = y; at.z = z; o.pos = at; o.gain = gain; o.pitch = pitch; o.delay = delay;
    if (extra) extra(o);
    return E.play(name, o);
  }
  function play2D(name, gain = 1, pitch = 1, delay = 0, extra) {
    const o = E.opts(); o.gain = gain; o.pitch = pitch; o.delay = delay; o.twoD = true;
    if (extra) extra(o);
    return E.play(name, o);
  }
  // scheduled versions (fn receives the scheduler item)
  const fnAt = (it) => playAt(it.s, it.x, it.y, it.z, it.b, it.a ?? 1);
  const fn2D = (it) => play2D(it.s, it.b, it.a ?? 1);
  const later = (dt, name, x, y, z, gain, pitch = 1) => sched.at(K.now() + dt, fnAt, name, x, y, z, pitch, gain);
  const later2D = (dt, name, gain, pitch = 1) => sched.at(K.now() + dt, fn2D, name, 0, 0, 0, pitch, gain);
  D.playAt = playAt; D.play2D = play2D; D.later = later; D.later2D = later2D;

  // ==========================================================================================================
  // gunfire
  /** space-dependent tail layers for a shot at (x,y,z) in acoustic class cls (twoD: player's own gun) */
  function tail(cls, x, y, z, gain, twoD) {
    const g = gain;
    const L = (name, gg, dly, f) => (twoD ? play2D(name, gg, 1, dly, f) : playAt(name, x, y, z, gg, 1, dly, f));
    switch (cls) {
      case 'hall_large': case 'hall_medium':
        // big hall: the distant-indoor recording is mostly hall slap and roll-off
        L('weapon.distant.indoor', g * (cls === 'hall_large' ? 0.42 : 0.3), 0.05 + rnd() * 0.03, (o) => { o.lp = 5200; o.send = 0.6; o.prio = 6; o.skipLead = true; });
        break;
      case 'outdoor': {
        // crack outside, the echo comes back from the building facade 0.3–0.7 s later
        const o2 = E.opts(); o2.pos = OUTDOOR_ECHO; o2.gain = g * 0.36; o2.delay = 0.3 + Math.min(0.45, Math.hypot(x - OUTDOOR_ECHO.x, z - OUTDOOR_ECHO.z) / 343);
        o2.occlude = false; o2.lp = 2600; o2.prio = 6; o2.ref = 30;
        E.play('weapon.distant.outdoor', o2);
        break;
      }
      case 'basement':
        // concrete box: low boom (the shot itself, slowed + low-passed) and a dense tail
        L(twoD ? 'weapon.pistol.shot' : 'weapon.rifle.shot', g * 0.55, 0.008, (o) => { o.pitch = 0.72; o.lp = 700; o.send = 1.4; o.prio = 6; });
        L('weapon.distant.indoor', g * 0.3, 0.03, (o) => { o.lp = 2600; o.prio = 6; });
        break;
      case 'stairwell': case 'corridor':
        L('weapon.distant.indoor', g * 0.26, 0.02, (o) => { o.lp = 4200; o.prio = 6; });
        break;
      case 'room_large':
        L('weapon.distant.indoor', g * 0.22, 0.03, (o) => { o.lp = 4500; o.prio = 6; });
        break;
      default: break;   // small rooms: the convolution/algorithmic room does it
    }
  }

  let lastOwnShot = -10;
  ev.on('weapon:fire', () => {
    const cls = K.listenerClass();
    // own pistol: 2D at the chest mic, strong send into the room the listener is in
    play2D('weapon.pistol.shot', 1.0, 1, 0, (o) => { o.send = 2.2; o.prio = 10; o.pitchVar = 0.02; o.cat = 'weapon'; });
    tail(cls, 0, 0, 0, 0.9, true);
    // casing: hits the floor ~0.4 s later next to the right foot, by surface
    const p = P().pos, surf = K.lastStepSurface ?? 'concrete';
    const g = surf === 'gravel' ? 0.15 : surf === 'wood' ? 0.35 : 0.5;
    const pitch = surf === 'metal' ? 1.12 : surf === 'wood' ? 0.85 : 1;
    later(0.33 + rnd() * 0.2, 'weapon.casing', p.x + 0.4 * Math.cos(P().yaw), p.y + 0.05, p.z - 0.4 * Math.sin(P().yaw), g, pitch);
    // very close & enclosed: brief ear ring (rate-limited, subtle)
    const now = K.now();
    if ((cls === 'room_small' || cls === 'corridor' || cls === 'stairwell' || cls === 'basement' || cls === 'cold_store') && now - lastOwnShot > 3) E.mic?.ring(0.25, 1.6);
    lastOwnShot = now;
    K.T.danger(0.07);
  });

  // enemy fire: near recording, distant recording beyond ~30 m, bursts for automatic weapons
  const lastShot = new Float64Array(64).fill(-10), burstH = new Float64Array(64), burstUntil = new Float64Array(64), rounds = new Int32Array(64);
  ev.on('enemy:fire', (e) => {
    const en = e.enemy; if (!en) return;
    const k = K.enemyIndex(en), w = en.def?.weapon ?? 'pistol', now = K.now();
    const x = en.pos.x, y = en.pos.y + 1.4, z = en.pos.z;
    const d = d2L(x, y, z);
    const near = SHOT[w] ?? SHOT.pistol, gain = SHOT_GAIN[w] ?? 1;
    // automatic fire: rounds < 0.2 s apart → one burst recording instead of single shots
    const auto = BURST[w] && now - lastShot[k] < 0.2;
    lastShot[k] = now;
    if (auto && now < burstUntil[k]) { rounds[k]++; checkReload(k, en, w); return; }
    if (auto) {
      burstH[k] = playAt(BURST[w], x, y, z, gain * 0.9, 1, 0, (o) => { o.prio = 9; o.max = 200; });
      burstUntil[k] = now + 1.3; D.bursts++;
    } else {
      // near layer fades out between 25 and 60 m, distant layer fades in from 20 m
      const nearG = gain * clamp01((60 - d) / 35);
      if (nearG > 0.01) playAt(near, x, y, z, nearG, SHOT_PITCH[w] ?? 1, 0, (o) => { o.prio = 9; o.max = 220; });
      const farG = clamp01((d - 20) / 30);
      if (farG > 0.01) {
        const outside = K.listenerClass() === 'outdoor' && K.classAt(x, y, z) === 'outdoor';
        playAt(outside ? 'weapon.distant.outdoor' : 'weapon.distant.indoor', x, y, z, farG * 0.9, 1, 0, (o) => { o.prio = 8; o.ref = 30; o.max = 400; o.send = 0.3; });
      }
      if (d < 60) tail(K.classAt(x, y, z), x, y, z, gain * 0.8, false);
      if (d < 3.5) E.mic?.ring(0.6, 2.2);
      else if (w === 'shotgun' && d < 6) E.mic?.ring(0.4, 1.8);
    }
    if (d < 14) later(0.35 + rnd() * 0.25, 'weapon.casing', x + 0.4, en.pos.y + 0.05, z, 0.35);
    rounds[k]++;
    checkReload(k, en, w);
    K.T.danger(d < 30 ? 0.22 : 0.08);
    // some shouting while shooting
    if (rnd() < 0.08) V.speak(k, rnd() < 0.5 ? 'taunt' : 'command', en.pos, 1, 0.2);
  });
  function checkReload(k, en, w) {
    if (rounds[k] < (MAG[w] ?? 13)) return;
    rounds[k] = 0;
    // enemy reload: callout (sometimes) + mag handling at his position
    if (rnd() < 0.6) V.speak(k, 'reload', en.pos, 1, 0.15);
    later(0.3, 'weapon.pistol.mag', en.pos.x, en.pos.y + 1.1, en.pos.z, 0.6);
    later(1.4, 'weapon.pistol.magin', en.pos.x, en.pos.y + 1.1, en.pos.z, 0.6);
  }
  D.update = (dt) => {
    // end bursts when the shooter stops (> 0.25 s without a round)
    const now = K.now();
    for (let k = 0; k < 64; k++) {
      if (burstH[k] && now - lastShot[k] > 0.25) { E.stop(burstH[k], 0.12); burstH[k] = 0; burstUntil[k] = 0; }
    }
    updateSteps(dt);
    updateEnemyAwareness();
  };

  // ---- every round: impacts, ricochets, whizz
  const IMPACT = {
    concrete: 'impact.concrete', plaster: 'impact.concrete', tile: 'impact.concrete', dirt: 'impact.concrete',
    metal: 'impact.metal', wood: 'impact.wood', cardboard: 'impact.cardboard', plastic: 'impact.cardboard',
    rubber: 'impact.cardboard', fabric: 'impact.cardboard', glass: 'glass.debris', flesh: 'impact.flesh',
  };
  ev.on('shot', (r) => {
    if (!r) return;
    if (r.hit && !r.target && r.point) {
      const s = r.surface || 'concrete', px = r.point.x, py = r.point.y, pz = r.point.z;
      let name = IMPACT[s] ?? 'impact.concrete', pitch = 1, g = 0.9;
      if (s === 'metal' && (r.kind === 'door' || r.kind === 'dynamic' || rnd() < 0.4)) name = 'impact.sheetmetal';
      if (s === 'plastic') { pitch = 1.25; g = 0.7; }
      if (s === 'rubber' || s === 'fabric') { pitch = 0.8; g = 0.45; }
      if (s === 'dirt') pitch = 0.82;
      if (s !== 'glass' || !r.glassBroken) playAt(name, px, py, pz, g, pitch, 0, (o) => { o.pitchVar = 0.05; if (s === 'rubber' || s === 'fabric' || s === 'dirt') o.lp = 2500; });
      D.impacts++;
      // debris layer on stone
      if ((s === 'concrete' || s === 'plaster' || s === 'tile') && rnd() < 0.75) later(0.03 + rnd() * 0.08, 'debris.concrete', px, py - 0.2, pz, 0.5 + rnd() * 0.3);
      if (s === 'dirt') later(0.02, 'debris.concrete', px, py, pz, 0.3, 0.7);
      // ricochet
      const ric = s === 'metal' ? 0.28 : s === 'concrete' || s === 'tile' ? 0.1 : 0;
      if (rnd() < ric) later(0.015 + rnd() * 0.03, 'bullet.ricochet', px, py, pz, 0.7);
    }
    // near miss: rounds not fired by the player passing close to the listener
    if (r.shooter !== P() && r.origin && r.dir) {
      const o = r.origin, d = r.dir, L = K.L;
      const t = (L.x - o.x) * d.x + (L.y - o.y) * d.y + (L.z - o.z) * d.z;
      const tMax = r.hit ? r.t : 80;
      if (t > 1.5 && t < tMax + 0.5) {
        const cx = o.x + d.x * t, cy = o.y + d.y * t, cz = o.z + d.z * t;
        const miss = Math.hypot(cx - L.x, cy - L.y, cz - L.z);
        if (miss < 2.4 && r.target !== P()) {
          const w = r.shooter?.def?.weapon;
          playAt('bullet.whizz', cx, cy, cz, (1 - miss / 2.4) * 0.95 + 0.2, w === 'rifle' ? 1.15 : 1, 0, (o2) => { o2.prio = 9; o2.occlude = false; o2.ref = 1; });
          D.whizz++;
          K.T.danger(0.25);
        }
      }
    }
  });
  ev.on('hit', (r) => {
    if (!r?.point || !r.target) return;
    if (r.target === P()) return;   // player: player:damage
    playAt('impact.flesh', r.point.x, r.point.y, r.point.z, 0.85, 1, 0, (o) => { o.pitchVar = 0.06; });
  });

  // ==========================================================================================================
  // player weapon handling, damage, death, flashlight
  ev.on('weapon:reload', (w) => {
    const T = w?.reloading > 0 ? w.reloading : 1.8;
    play2D('weapon.pistol.mag', 0.75, 1, 0.05, (o) => { o.cat = 'handling'; });
    later2D(0.18, 'foley.gear', 0.3);
    later2D(T * 0.55, 'weapon.pistol.magin', 0.85);
  });
  ev.on('weapon:reloaded', () => { play2D('weapon.pistol.slide', 0.8, 1, 0, (o) => { o.cat = 'handling'; }); });
  ev.on('weapon:empty', () => { play2D('weapon.dryfire', 0.8); });
  ev.on('player:flashlight', () => { play2D('foley.lightswitch', 0.28, 1.45, 0, (o) => { o.cat = 'handling'; o.lp = 6000; }); });
  let lastPain = -10;
  ev.on('player:damage', (e) => {
    const amt = e?.amount ?? 10, now = K.now();
    // bullet into the vest right under the mic: dull thump, then the grunt
    play2D('impact.flesh', 0.95, 0.85, 0, (o) => { o.lp = 2200; o.cat = 'impact'; o.prio = 9; });
    play2D('foley.bodyfall', 0.35 + Math.min(0.4, amt / 60), 1.2, 0.01, (o) => { o.lp = 500; o.cat = 'foley'; o.prio = 8; });
    if (now - lastPain > 0.6) { lastPain = now; later2D(0.07 + rnd() * 0.08, 'voice.player.pain', 0.9); }
    if (amt >= 20) E.mic?.ring(0.45, 1.8);
    K.T.damage(amt, e?.health ?? 100);
  });
  ev.on('player:death', () => {
    play2D('foley.bodyfall', 1, 0.9, 0.25, (o) => { o.cat = 'foley'; o.prio = 10; });
    play2D('foley.gear', 0.6, 1, 0.3, (o) => { o.cat = 'foley'; });
    later2D(0.05, 'voice.player.pain', 1);
    E.mic?.muffle(900, 0, 0);
  });

  // ==========================================================================================================
  // enemies: alert, damage, death; squad replies, chatter
  const alerted = new Uint8Array(64), pleaded = new Uint8Array(64), dyingSched = new Uint8Array(64);
  const fromEvent = new Uint8Array(64);
  let firstAlert = true, lastChatter = -10;
  function mouth(en) { return en.pos; }
  function onAlert(en) {
    const k = K.enemyIndex(en); if (k < 0 || alerted[k]) return;
    alerted[k] = 1;
    const d = d2L(en.pos.x, en.pos.y + 1.6, en.pos.z);
    const sleeper = en.def?.role === 'sleeper';
    if (d > 38) {
      // far away inside the building: a distant shout reads better than a quiet close-miked line
      playAt('voice.distant.shout', en.pos.x, en.pos.y + 1.6, en.pos.z, 1, V.profiles[k]?.pitch ?? 1, 0.1 + rnd() * 0.3, (o) => { o.cat = 'voice'; o.ref = 12; });
    } else {
      if (sleeper) { V.speak(k, 'surprise', mouth(en), 1, 0.05, true); sched.at(K.now() + 0.7 + rnd() * 0.4, fnSpeak, 'alert', 0, 0, 0, en, 1, k); }
      else V.speak(k, rnd() < 0.65 ? 'alert' : 'command', mouth(en), 1, 0.1 + rnd() * 0.25);
      // squad reply: nearest other conscious enemy within 22 m answers with a command
      let best = null, bd = 22;
      for (const o of ctx.enemies?.list ?? []) {
        if (o === en || o.dead) continue;
        const dd = Math.hypot(o.pos.x - en.pos.x, o.pos.z - en.pos.z);
        if (dd < bd) { bd = dd; best = o; }
      }
      if (best) sched.at(K.now() + 0.9 + rnd() * 0.9, fnSpeak, rnd() < 0.7 ? 'command' : 'alert', 0, 0, 0, best, 1, K.enemyIndex(best));
      // the officer answers the first close contact
      if (firstAlert && d < 14) { firstAlert = false; later2D(0.5 + rnd() * 0.3, 'voice.player.command', 0.9); }
    }
    K.T.danger(d < 25 ? 0.35 : 0.12);
  }
  const fnSpeak = (it) => { const en = it.a; if (!en || en.dead) return; V.speak(it.k, it.s, en.pos, it.b); };
  ev.on('enemy:alert', (e) => { const en = e?.enemy; if (!en) return; const k = K.enemyIndex(en); if (k >= 0) fromEvent[k] = 1; onAlert(en); });
  // fallback for enemy modules that only set `alerted`: poll the flag (cheap: one pass, 3 times a second)
  let pollT = 0;
  function updateEnemyAwareness() {
    const now = K.now();
    if (now - pollT < 0.33) return;
    pollT = now;
    const list = ctx.enemies?.list; if (!list) return;
    let fighters = 0, cand = null;
    for (let i = 0; i < list.length; i++) {
      const en = list[i];
      if (en.dead) continue;
      if (en.alerted && !alerted[i]) onAlert(en);
      if (en.alerted && d2L(en.pos.x, en.pos.y, en.pos.z) < 45) { fighters++; if (!cand || rnd() < 0.35) cand = en; }
    }
    // combat chatter: one line every few seconds while enemies are fighting near the player
    if (cand && fighters && now - lastChatter > 3.5 + rnd() * 3) {
      lastChatter = now;
      const k = K.enemyIndex(cand);
      const r = rnd();
      V.speak(k, r < 0.5 ? 'command' : r < 0.8 ? 'taunt' : 'alert', cand.pos, 1);
    }
  }
  ev.on('enemy:damage', (e) => {
    const en = e?.enemy; if (!en) return;
    const k = K.enemyIndex(en);
    // decide after this frame's events: a lethal hit emits enemy:death right after enemy:damage
    sched.at(K.now() + 0.03, fnHurt, e.part ?? '', 0, 0, 0, en, e.amount ?? 30, k);
    if (!alerted[k]) onAlert(en);
  });
  const fnHurt = (it) => {
    const en = it.a, k = it.k;
    if (!en || en.dead) return;
    const part = it.s, amt = it.b;
    const p = mouth(en);
    if (part === 'legs' && rnd() < 0.5) V.speak(k, rnd() < 0.5 ? 'effort' : 'scream', p, 1, 0, true);
    else if (amt > 45 && rnd() < 0.5) V.speak(k, 'scream', p, 1, 0, true);
    else V.speak(k, 'pain', p, 1, 0, true);
    if (en.health > 35 && rnd() < 0.3) sched.at(K.now() + 0.9 + rnd() * 0.5, fnSpeak, 'hit', 0, 0, 0, en, 1, k);
    if (en.health <= 35 && !pleaded[k] && rnd() < 0.55) { pleaded[k] = 1; sched.at(K.now() + 1.3 + rnd() * 0.8, fnSpeak, 'plead', 0, 0, 0, en, 1, k); }
    if (en.health <= 50 && rnd() < 0.3) sched.at(K.now() + 2.5 + rnd() * 1.5, fnSpeak, 'breath.panic', 0, 0, 0, en, 0.7, k);
  };
  ev.on('enemy:death', (e) => {
    const en = e?.enemy; if (!en) return;
    const k = K.enemyIndex(en), x = en.pos.x, y = en.pos.y, z = en.pos.z;
    E.stopOwner(V.owner(k), 0.04);
    sched.cancel(fnSpeak, k); sched.cancel(fnHurt, k);
    const head = e.part === 'head';
    if (d2L(x, y + 1.5, z) > 35) {
      // far end of the hall / another room: the distant-scream recordings carry the space with them
      if (!head) playAt('voice.distant.scream', x, y + 1.2, z, 1, V.profiles[k]?.pitch ?? 1, 0.02, (o) => { o.cat = 'voice'; o.ref = 12; o.max = 140; });
    } else if (!head || rnd() < 0.2) V.speak(k, head ? 'pain' : 'death', en.pos, 1, 0.02, true);
    later(0.3 + rnd() * 0.2, 'impact.metal', x + 0.4, y + 0.1, z, 0.3, 0.75);       // weapon hits the floor
    later(0.55 + rnd() * 0.35, 'foley.bodyfall', x, y + 0.2, z, 0.95);
    later(0.75 + rnd() * 0.3, 'foley.gear', x, y + 0.2, z, 0.4);
    // some die slowly: groans a few seconds later
    if (!head && !dyingSched[k] && rnd() < 0.4) {
      dyingSched[k] = 1;
      sched.at(K.now() + 3 + rnd() * 3, fnDying, '', x, y + 0.3, z, en, 0.8, k);
      if (rnd() < 0.5) sched.at(K.now() + 10 + rnd() * 5, fnDying, '', x, y + 0.3, z, en, 0.55, k);
    }
    K.T.kill();
  });
  const fnDying = (it) => { if (!K.V) return; at.x = it.x; at.y = it.y; at.z = it.z; V.speak(it.k, 'dying', at, it.b, 0, true); };

  // ==========================================================================================================
  // doors, roller doors, glass, light circuits
  const doorPos = (d, out) => { const m = (d.a + d.b) / 2, ax = d.axis === 'x'; out.x = ax ? m : d.at; out.y = d.y0 + 1.1; out.z = ax ? d.at : m; return out; };
  const dp = { x: 0, y: 0, z: 0 };
  const prevState = new Map();
  const METAL_DOOR = /notausgang|we_west|we_sued|technik/;
  const roller = new Map();   // door id → { h, end }
  ev.on('door:state', (e) => {
    const d = e?.door; if (!d) return;
    const prev = prevState.get(e.id) ?? d.stateInit ?? 'closed';
    prevState.set(e.id, e.state);
    doorPos(d, dp);
    const st = e.state;
    if (d.kind === 'roller') {
      const travel = Math.abs((d.target ?? (st === 'open' ? 1 : 0)) - (d.t ?? 0)) / Math.max(0.05, d.speed ?? 0.8);
      const r = roller.get(e.id); if (r?.h) E.stop(r.h, 0.15);
      let h = 0;
      if ((st === 'closed' || st === 'locked') && travel > 2.5) {
        // slow motorised close: motor run, thud at the bottom
        h = playAt('door.roller.close', dp.x, d.y1 - 0.6, dp.z, 0.9, 1, 0, (o) => { o.offset = 1.5; o.dur = travel + 0.3; o.ref = 5; });
        later(travel, 'door.slam', dp.x, d.y0 + 0.3, dp.z, 0.6, 0.7);
      } else if (st === 'closed' || st === 'locked') {
        // pulled/dropped down: rattle + slam, aligned so the slam lands when the curtain hits the floor
        const c = K.bank.sounds.get('door.roller.slam'), clip = c ? K.bank.clips[c.enabled[0]] : null;
        const off = clip ? Math.max(0, clip.peakAt - travel) : 0;
        h = playAt('door.roller.slam', dp.x, d.y1 - 0.5, dp.z, 1.0, 1, 0, (o) => { o.offset = off; o.dur = travel + 1.6; o.prio = 8; o.ref = 6; });
      } else {
        // motor run (skip the lead-in), clunk at the top
        h = playAt(st === 'half' ? 'door.roller.rattle' : 'door.roller.open', dp.x, d.y1 - 0.6, dp.z, 0.9, 1, 0, (o) => { o.offset = st === 'half' ? 1.0 : 1.2; o.dur = travel + 0.4; o.ref = 5; });
        later(travel, 'impact.sheetmetal', dp.x, d.y1 - 0.4, dp.z, 0.45, 0.7);
      }
      roller.set(e.id, { h });
      K.T.doorSlam(st, d);
    } else if (d.kind === 'slide') {
      playAt('machine.pneumatic', dp.x, dp.y + 0.8, dp.z, 0.7, 1, 0, (o) => { o.dur = 1.4; o.cat = 'door'; });
      playAt('door.roller.rattle', dp.x, dp.y, dp.z, 0.4, 1.3, 0.1, (o) => { o.offset = 1.2; o.dur = 1.5; o.lp = 3000; o.cat = 'door'; });
    } else {
      const metal = METAL_DOOR.test(e.id);
      const fast = (d.speed ?? 1.6) > 2.6;
      if (st === 'open' || st === 'half') {
        if (prev === 'locked') playAt('door.kick', dp.x, dp.y, dp.z, 1.0);                     // forced open
        else if (metal) playAt('door.metal', dp.x, dp.y, dp.z, 0.9, 1, 0, (o) => { o.offset = 0.3; o.dur = 2.6; });
        else playAt('door.open', dp.x, dp.y, dp.z, 0.85);
      } else {
        if (fast) playAt('door.slam', dp.x, dp.y, dp.z, 1.0);
        else if (metal) {
          const c = K.bank.sounds.get('door.metal'), clip = c ? K.bank.clips[c.enabled[0]] : null;
          playAt('door.metal', dp.x, dp.y, dp.z, 0.9, 1, 0, (o) => { o.offset = clip ? Math.max(0, clip.peakAt - 0.7) : 5.2; o.dur = 1.9; });
        } else playAt('door.close', dp.x, dp.y, dp.z, 0.85, 1, 0.25, (o) => { o.dur = 1.2; });
        if (st === 'locked') playAt('foley.switch', dp.x, dp.y, dp.z, 0.5, 1.2, 0.5);           // bolt
      }
    }
    E.resolve();          // portal transmission changed
  });
  ev.on('door:locked', (e) => {
    const d = e?.door; if (!d) return;
    doorPos(d, dp);
    // somebody tries a locked door: handle rattle
    playAt('door.close', dp.x, dp.y, dp.z, 0.45, 1.25, 0, (o) => { o.dur = 0.22; });
    playAt('foley.switch', dp.x, dp.y, dp.z, 0.35, 1.4, 0.12);
  });
  ev.on('glass:break', (e) => {
    const p = e?.point ?? e?.pane?.min; if (!p) return;
    const x = p.x ?? p[0], y = p.y ?? p[1], z = p.z ?? p[2];
    playAt('glass.shatter', x, y, z, 1.0, 1, 0, (o) => { o.prio = 8; o.pitchVar = 0.05; });
    later(0.25 + rnd() * 0.25, 'glass.debris', x, Math.max(y - 1.2, 0.1), z, 0.7);
    if (rnd() < 0.5) later(0.7 + rnd() * 0.4, 'glass.debris', x, Math.max(y - 1.4, 0.1), z, 0.4);
    E.resolve();
  });
  const circLevel = new Map();
  ev.on('lights:circuit', (e) => {
    const prev = circLevel.get(e.id) ?? 1;
    circLevel.set(e.id, e.level);
    const c = K.circuitCentre(e.id);
    if (!c) return;
    const off = e.level < prev - 0.2, on = e.level > prev + 0.2;
    if (off) {
      // breaker clunk somewhere in that area, the flicker of the tubes, then the hum is gone
      playAt('foley.switch', c.x, c.y, c.z, 1.0, 0.85, 0, (o) => { o.ref = 6; o.clip = K.heavySwitch(); });
      const f = K.nearestFixture(e.id);
      if (f) playAt('machine.light.flicker', f.x, f.y, f.z, 0.6, 1, 0.05, (o) => { o.dur = Math.max(0.4, Math.min(2.5, e.fade || 0.6)); });
      K.T.lightsOut(e.id);
    } else if (on) {
      const f = K.nearestFixture(e.id);
      if (f) playAt('machine.light.flicker', f.x, f.y, f.z, 0.7);
      playAt('foley.switch', c.x, c.y, c.z, 0.7, 1, 0, (o) => { o.ref = 6; });
    }
  });

  // ==========================================================================================================
  // footsteps + motion foley + mic wind
  const STEP = { concrete: 'step.concrete', asphalt: 'step.asphalt', gravel: 'step.gravel', metal: 'step.metal', wood: 'step.wood' };
  let lx = NaN, lz = NaN, ly = 0, acc = 0, stepN = 0, lastYaw = 0, still = 0, wasMoving = false, airborne = 0;
  const eAcc = new Float32Array(64), eX = new Float32Array(64).fill(NaN), eZ = new Float32Array(64);
  function updateSteps(dt) {
    const p = P(); if (!p || ctx.state !== 'playing' || dt <= 0) { lx = NaN; return; }
    if (Number.isNaN(lx)) { lx = p.pos.x; lz = p.pos.z; ly = p.pos.y; lastYaw = p.yaw; }
    const dx = p.pos.x - lx, dz = p.pos.z - lz, dy = p.pos.y - ly, h = Math.hypot(dx, dz);
    lx = p.pos.x; lz = p.pos.z; ly = p.pos.y;
    const speed = p.moving ?? h / dt;
    if (h > 2) { acc = 0; return; }                 // teleport
    // landing after a drop
    if (dy < -0.04 * 60 * dt) airborne += -dy; else if (airborne > 0.5) {
      const s = K.surfaceBelow(p.pos.x, p.pos.y, p.pos.z);
      play2D(STEP[s] ?? STEP.concrete, Math.min(1, 0.5 + airborne * 0.3), 0.9, 0, (o) => { o.cat = 'step'; });
      play2D('foley.gear', 0.4, 1, 0.02, (o) => { o.cat = 'foley'; });
      airborne = 0;
    } else airborne = 0;
    const moving = speed > 0.4;
    if (moving !== wasMoving && rnd() < 0.6) play2D('foley.cloth', moving ? 0.28 : 0.18, 1, 0, (o) => { o.cat = 'foley'; });
    wasMoving = moving;
    const stride = p.crouched ? 0.55 : speed > 3.4 ? 0.95 : speed < 1.5 ? 0.6 : 0.75;
    acc += h;
    if (acc >= stride && moving) {
      acc = 0; stepN++;
      const s = K.surfaceBelow(p.pos.x, p.pos.y, p.pos.z);
      K.lastStepSurface = s;
      const g = p.crouched ? 0.16 : speed > 3.4 ? 0.72 : speed < 1.5 ? 0.22 : 0.4;
      play2D(STEP[s] ?? STEP.concrete, g, 1, 0, (o) => { o.cat = 'step'; o.pitchVar = 0.05; o.lp = p.crouched ? 3500 : 20000; o.send = 0.6; });
      if (speed > 3.4 && stepN % 2 === 0) play2D('foley.gear', 0.22, 1, 0.03, (o) => { o.cat = 'foley'; });
      else if (stepN % 5 === 0) play2D('foley.cloth', 0.12, 1, 0.02, (o) => { o.cat = 'foley'; });
    }
    // mic wind / handling: fast movement and fast turns rub the vest and buffet the capsule
    let dyaw = p.yaw - lastYaw; lastYaw = p.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const turn = Math.min(1, Math.abs(dyaw) / dt / 6);
    const out = K.listenerClass() === 'outdoor' ? 0.12 + 0.06 * Math.sin(K.now() * 0.31) * Math.sin(K.now() * 0.13) : 0;
    E.mic?.setWind(Math.max(out, (speed - 2.6) / 2.2 * 0.8 + turn * 0.25));
    if (turn > 0.7 && rnd() < dt * 2) play2D('foley.cloth', 0.15, 1.1, 0, (o) => { o.cat = 'foley'; });
    still = moving ? 0 : still + dt;
    // enemies' footsteps (only near ones; positional with occlusion)
    const list = ctx.enemies?.list;
    if (!list) return;
    for (let i = 0; i < list.length && i < 64; i++) {
      const en = list[i];
      if (en.dead) { eX[i] = NaN; continue; }
      const ex = en.pos.x, ez = en.pos.z;
      if (Number.isNaN(eX[i])) { eX[i] = ex; eZ[i] = ez; continue; }
      const mv = Math.hypot(ex - eX[i], ez - eZ[i]);
      eX[i] = ex; eZ[i] = ez;
      if (mv > 1.5) continue;
      eAcc[i] += mv;
      const v = mv / dt;
      const st = v > 2.8 ? 0.95 : 0.72;
      if (eAcc[i] >= st) {
        eAcc[i] = 0;
        const dd = d2L(ex, en.pos.y, ez);
        if (dd > 32) continue;
        const s = K.surfaceBelow(ex, en.pos.y, ez);
        playAt(STEP[s] ?? STEP.concrete, ex, en.pos.y + 0.05, ez, v > 2.8 ? 1.0 : 0.6, 1, 0, (o) => { o.pitchVar = 0.06; o.prio = 3; });
      }
    }
  }

  D.reset = () => {
    alerted.fill(0); pleaded.fill(0); dyingSched.fill(0); fromEvent.fill(0); rounds.fill(0); lastShot.fill(-10);
    burstH.fill(0); burstUntil.fill(0); firstAlert = true; prevState.clear(); roller.clear(); circLevel.clear();
    lx = NaN; acc = 0; eX.fill(NaN); eAcc.fill(0);
  };
  D.onAlert = onAlert;
  return D;
}
