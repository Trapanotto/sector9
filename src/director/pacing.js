// Dynamic tension tracker + optional ambient events + machine noise masking. Cheap: a few scalar updates per
// frame, the ambient scan (≤ 30 spots) runs at most every 2 s. Owner: F.
//
// tension (0..1) = recent contact (shots, enemy fire, damage, alerts) + player injury + enemies left + boosts from
// staged moments, smoothed. Reported to audio through ctx.audio.setTension?.(level) and the 'f:tension' event.
// Ambient events (distant shout, clatter, a machine starting …) only fire when things are quiet: low tension, no
// moment running, no contact for a while — they carry the dread between the staged moments.
// masking (0..1): loud running machines near the player (conveyor loop, robot, crane). D may scale hearing by
// (1 - masking); E may duck footsteps. Exposed as ctx.director.masking.
import { createRng, hash32 } from './rng.js';

export function createPacing(ctx, data, runtime) {
  const A = data.AMBIENT;
  const rng = createRng(1);
  const zoneIndex = new Map(ctx.layout.zones.map((z, i) => [z.id, i]));
  const maskZones = new Map();   // zone index → [machine kind, id, level]
  for (const [zid, list] of Object.entries(A.masking)) { const i = zoneIndex.get(zid); if (i !== undefined) maskZones.set(i, list); }
  const tensionEvt = { level: 0 };
  const st = {
    tension: 0, raw: 0, sinceContact: 999, sinceAmbient: 0, nextAmbient: 60, sinceMoment: 999, masking: 0,
    reported: -1, reportT: 0, scanT: 0, maskT: 0, ambientCount: 0, lastAmbient: '',
  };
  const pos = { x: 0, y: 0, z: 0 };

  const contact = () => { st.sinceContact = 0; };
  ctx.events.on('weapon:fire', contact);
  ctx.events.on('enemy:fire', contact);
  ctx.events.on('player:damage', contact);
  ctx.events.on('enemy:alert', contact);
  ctx.events.on('moment', () => { st.sinceMoment = 0; });

  function machineRunning(kind, id) {
    const M = ctx.machines;
    const r = kind === 'conveyor' ? M?.conveyor?.(id) : kind === 'robot' ? M?.robot?.(id) : kind === 'crane' ? M?.crane?.(id) : null;
    return !!r && r.state === 'running';
  }
  function updateMasking(dt) {
    st.maskT -= dt;
    if (st.maskT > 0) return;
    st.maskT = 0.25;
    const z = runtime.env.playerZone;
    let m = 0;
    const list = maskZones.get(z);
    if (list) for (let i = 0; i < list.length; i++) { const e = list[i]; if (e[2] > m && machineRunning(e[0], e[1])) m = e[2]; }
    st.masking += (m - st.masking) * 0.5;
    if (st.masking < 0.01) st.masking = 0;
  }

  function ambient() {
    // reservoir-sample one spot 14–45 m away whose zone is not in view
    const P = ctx.player.pos;
    let pick = -1, n = 0;
    for (let i = 0; i < A.spots.length; i++) {
      const s = A.spots[i];
      const dx = s[0] - P.x, dy = s[1] - P.y, dz = s[2] - P.z, d = Math.hypot(dx, dy * 2, dz);
      if (d < 14 || d > 45) continue;
      if (ctx.world.isPointVisible?.(s[0], s[1], s[2])) continue;
      n++;
      if (rng.next() * n < 1) pick = i;
    }
    if (pick < 0) return false;
    const s = A.spots[pick], cues = A.cues[s[3]];
    const cue = cues[rng.int(cues.length)];
    pos.x = s[0]; pos.y = s[1]; pos.z = s[2];
    ctx.audio?.playAt?.(cue, pos, { volume: 0.55 });
    st.lastAmbient = `${cue} @ ${s[3]}`;
    st.ambientCount++;
    return true;
  }

  return {
    st,
    get tension() { return st.tension; },
    get masking() { return st.masking; },
    reset(seed) {
      rng.seed(hash32('pacing', seed));
      st.tension = st.raw = 0; st.sinceContact = 999; st.sinceAmbient = 0; st.sinceMoment = 999; st.masking = 0;
      st.nextAmbient = rng.range(A.firstDelay[0], A.firstDelay[1]); st.reported = -1; st.reportT = 0; st.scanT = 0; st.maskT = 0;
      st.ambientCount = 0; st.lastAmbient = '';
      runtime.tension.boost = 0;
      ctx.audio?.setTension?.(0);
    },
    update(dt) {
      st.sinceContact += dt; st.sinceAmbient += dt; st.sinceMoment += dt;
      updateMasking(dt);
      // ---- tension
      const P = ctx.player;
      const contactT = Math.exp(-st.sinceContact / 22);
      const hurt = 1 - Math.max(0, Math.min(1, (P.health ?? 100) / 100));
      const list = ctx.enemies?.list;
      let alive = 0; if (list) for (let i = 0; i < list.length; i++) if (!list[i].dead) alive++;
      const left = list?.length ? alive / list.length : 0;
      const boost = runtime.tension.boost;
      runtime.tension.boost = Math.max(0, boost - dt * 0.02);          // a staged moment's push fades over ~20 s
      st.raw = Math.min(1, 0.5 * contactT + 0.3 * hurt + 0.12 * left + Math.min(0.6, boost) + 0.1 * st.masking);
      const k = st.raw > st.tension ? 1.5 : 0.12;                       // rises fast, settles slowly
      st.tension += (st.raw - st.tension) * Math.min(1, dt * k);
      st.reportT -= dt;
      if (st.reportT <= 0 && Math.abs(st.tension - st.reported) > 0.03) {
        st.reportT = 0.25; st.reported = st.tension;
        ctx.audio?.setTension?.(st.tension);
        tensionEvt.level = st.tension; ctx.events.emit('f:tension', tensionEvt);
      }
      // ---- ambient events (only when quiet)
      st.scanT -= dt;
      if (st.scanT > 0) return;
      st.scanT = 2;
      if (st.sinceAmbient < st.nextAmbient || st.tension > A.maxTension || st.sinceContact < A.quietAfterContact
        || st.sinceMoment < A.quietAfterMoment || runtime.running() > 0) return;
      if (ambient()) { st.sinceAmbient = 0; st.nextAmbient = rng.range(A.interval[0], A.interval[1]); }
    },
  };
}
