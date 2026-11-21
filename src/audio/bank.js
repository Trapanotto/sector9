// Sound bank: the manifest (public/assets/audio/manifest.json) as an indexed, allocation-free model.
// Pure JS (no Web Audio) so Node tests can use it. Owner: E.
//
// Every manifest variation becomes a "clip" with a numeric index. Clips flagged `disabled` in the manifest are
// never chosen (scripts/audio/disable.mjs sets the flag). Variation picks never repeat back-to-back per sound
// (and per voice profile, see voices.js).

/** decode sample rate per sound name (Hz); 0 = the AudioContext rate (impulse responses must match it).
 *  The bodycam chain band-limits to ~8.5 kHz, so most material is decoded well below 48 kHz to keep the
 *  decoded PCM small (CONTRACT §9: ≤ 60 MB). */
export function decodeRate(name) {
  if (name.startsWith('ir.')) return 0;
  if (/^voice\.(muffled|snore|breath\.panic)/.test(name)) return 16000;
  if (/^(amb\.|loop\.|machine\.|voice\.distant|weapon\.distant|door\.roller)/.test(name)) return 22050;
  if (/^(voice\.|door\.)/.test(name)) return 22050;
  return 24000;   // one-shots: 12 kHz bandwidth, above the mic's 8.5 kHz low-pass
}

/** load priority: 0 = before the menu (awaited in load()), 1 = right after (combat essentials, decoded and kept),
 *  2 = background fetch, decoded on demand (LRU) */
export function loadTier(name) {
  if (/^(ir\.|weapon\.pistol\.shot|step\.(concrete|asphalt|gravel)|amb\.outside|foley\.cloth|foley\.lightswitch)/.test(name)) return 0;
  if (/^(weapon\.|bullet\.|impact\.|debris\.|glass\.|step\.|foley\.|voice\.(alert|command|pain|death|scream|surprise|reload|taunt|hit|player\.pain|radio|plead|effort)|door\.(open|close|slam|kick))/.test(name)) return 1;
  return 2;
}

/** bus/category of a sound name → engine category (see CATS in engine.js) */
export function categoryOf(name) {
  if (name.startsWith('weapon.distant')) return 'weapon';
  if (name.startsWith('weapon.casing') || name.startsWith('weapon.pistol.mag') || name.startsWith('weapon.pistol.slide') || name.startsWith('weapon.dryfire')) return 'handling';
  if (name.startsWith('weapon.')) return 'weapon';
  if (/^(bullet|impact|debris|glass)\./.test(name)) return 'impact';
  if (name.startsWith('step.')) return 'step';
  if (name.startsWith('foley.')) return 'foley';
  if (name.startsWith('voice.player')) return 'player';
  if (name.startsWith('voice.radio')) return 'radio';
  if (name.startsWith('voice.')) return 'voice';
  if (name.startsWith('door.')) return 'door';
  if (name.startsWith('amb.')) return 'amb';
  if (name.startsWith('loop.') || name.startsWith('machine.')) return 'machine';
  if (name.startsWith('ir.')) return 'ir';
  return 'foley';
}

/** stand-ins when a sound has no enabled variation (keeps every event audible after clips are dropped) */
export const FALLBACK = {
  'voice.hit': 'voice.pain', 'voice.surprise': 'voice.pain', 'voice.plead': 'voice.dying', 'voice.taunt': 'voice.command',
  'voice.reload': 'voice.command', 'voice.alert': 'voice.command', 'voice.scream': 'voice.death', 'voice.death': 'voice.scream',
  'voice.dying': 'voice.pain', 'voice.distant.scream': 'voice.scream', 'voice.distant.shout': 'voice.alert',
  'impact.sheetmetal': 'impact.metal', 'impact.cardboard': 'impact.wood', 'impact.wood': 'impact.concrete',
  'impact.flesh': 'foley.bodyfall', 'weapon.rifle.shot': 'weapon.pistol.shot', 'weapon.shotgun.shot': 'weapon.rifle.shot',
  'weapon.smg.burst': 'weapon.rifle.burst', 'weapon.pistol.magin': 'weapon.pistol.mag', 'door.slam': 'door.close',
  'door.kick': 'door.slam', 'step.wood': 'step.concrete', 'step.asphalt': 'step.concrete', 'step.gravel': 'step.concrete',
  'step.metal': 'step.concrete', 'glass.debris': 'glass.shatter', 'debris.concrete': 'impact.concrete',
  'weapon.distant.outdoor': 'weapon.distant.indoor', 'weapon.distant.indoor': 'weapon.distant.outdoor',
  'voice.player.breath.exert': 'voice.player.breath.calm', 'foley.gear': 'foley.cloth', 'foley.cloth': 'foley.gear',
};

/** legacy / convenience ids other workstreams may pass to ctx.audio.play/playAt → cue or sound names */
export const ALIASES = {
  pistol_shot: 'cue.player_shot', enemy_shot: 'cue.enemy_shot', door: 'door.open', roller_door: 'door.roller.open',
  glass_break: 'cue.glass', death_groan: 'voice.dying', player_hurt: 'voice.player.pain', scream_male: 'cue.scream_room',
  scream: 'voice.scream', footstep: 'step.concrete', impact: 'impact.concrete', ricochet: 'bullet.ricochet',
  whizz: 'bullet.whizz', casing: 'weapon.casing', reload: 'cue.player_reload', empty: 'weapon.dryfire', dryfire: 'weapon.dryfire',
  bodyfall: 'foley.bodyfall', switch: 'foley.switch', breaker: 'foley.switch', phone: 'machine.phone', buzzer: 'machine.alarm',
  siren: 'machine.alarm.siren', alarm: 'machine.alarm', beeper: 'loop.beeper', static: 'loop.static', radio: 'cue.radio',
  cough: 'voice.cough', alert: 'voice.alert', pain: 'voice.pain', death: 'voice.death', taunt: 'voice.taunt',
  distant_scream: 'voice.distant.scream', distant_shout: 'voice.distant.shout', hiss: 'machine.pneumatic',
};

export function createBank(manifest) {
  const sounds = new Map();   // name → { name, gain, cat, clips: [clipIndex], enabled: [clipIndex], last }
  const clips = [];           // flat list
  const credits = manifest._credits ?? {};
  for (const [name, s] of Object.entries(manifest.sounds)) {
    const rec = { name, gain: s.gain ?? 1, cat: categoryOf(name), desc: s.desc ?? '', clips: [], enabled: [], last: -1, tier: loadTier(name), rate: decodeRate(name) };
    s.variations.forEach((v, vi) => {
      const src = (v.source ?? '').split('#')[0];
      const c = {
        index: clips.length, sound: rec, vi, file: v.file, dur: v.duration, ch: v.channels ?? 1, loop: !!v.loop,
        loopStart: v.loopStart ?? 0, loopEnd: v.loopEnd ?? v.duration, bytes: v.bytes ?? 0, peakDb: v.peak_db ?? -1,
        lufs: v.lufs ?? -20, source: src, author: credits[src]?.author ?? src, text: v.text ?? '',
        onset: v.onset ?? 0, peakAt: v.peakAt ?? 0, tailEnd: v.tailEnd ?? v.duration, disabled: !!v.disabled,
        // runtime (engine): encoded bytes, decoded buffer, LRU stamp, pending decode
        enc: null, buf: null, used: 0, decoding: null, failed: false, playing: 0,
      };
      clips.push(c); rec.clips.push(c.index);
      if (!c.disabled) rec.enabled.push(c.index);
    });
    sounds.set(name, rec);
  }
  const bank = {
    sounds, clips, manifest,
    has: (name) => sounds.has(name),
    /** resolve a sound name to one that has enabled clips (fallback chain), or null */
    resolve(name) {
      let n = name, hops = 0;
      while (n && hops++ < 4) {
        const s = sounds.get(n);
        if (s && s.enabled.length) return s;
        n = FALLBACK[n];
      }
      return null;
    },
    /** pick a clip index of a sound: never the same as last time (when there is a choice). `pool` optionally
     *  restricts to a subset (array of clip indices, e.g. one speaker's lines); `lastRef` {last} tracks repeats
     *  for that pool. rnd() in [0,1). Returns -1 if nothing is playable. */
    pick(name, rnd = Math.random, pool = null, lastRef = null) {
      const s = bank.resolve(name);
      if (!s) return -1;
      const list = pool && pool.length ? pool : s.enabled;
      const ref = lastRef ?? s;
      if (list.length === 1) { ref.last = list[0]; return list[0]; }
      let k = Math.floor(rnd() * list.length) % list.length;
      if (list[k] === ref.last || list[k] === s.last) k = (k + 1 + Math.floor(rnd() * (list.length - 1))) % list.length;
      if (list[k] === ref.last) k = (k + 1) % list.length;
      ref.last = list[k]; s.last = list[k];
      return list[k];
    },
    /** decoded size estimate in bytes for a clip at its decode rate (ctxRate for rate 0) */
    decodedBytes(c, ctxRate = 48000) {
      const rate = c.sound.rate || ctxRate;
      const dur = c.loop ? c.loopEnd + 0.25 : c.dur;
      return Math.ceil(dur * rate) * c.ch * 4;
    },
    totalDecodedBytes(ctxRate = 48000) { let b = 0; for (const c of clips) b += bank.decodedBytes(c, ctxRate); return b; },
  };
  return bank;
}
