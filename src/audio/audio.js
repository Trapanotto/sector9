// STUB (workstream E replaces this with CC0 recordings, voices/screams, zone acoustics and occlusion).
// Keeps the interface: ctx.audio.play(id, opts), ctx.audio.playAt(id, pos, opts), ctx.audio.setListener(),
// ctx.audio.unlock() (call from a user gesture), ctx.audio.volume. The stub only counts requests (window.__ctx.audio.log).
export function createAudio(ctx) {
  const a = {
    id: 'audio', order: ctx.ORDER.audio, volume: ctx.settings.data.volume ?? 0.8, unlocked: false,
    log: [], ac: null,
    unlock() {
      if (a.unlocked) return;
      try { a.ac = new (window.AudioContext || window.webkitAudioContext)(); a.unlocked = true; } catch { /* no audio */ }
    },
    /** non-positional sound (UI, own weapon, radio): id from the sound catalogue (E defines), opts { volume } */
    play(id, opts) { if (a.log.length < 200) a.log.push(['play', id]); return null; },
    /** positional sound at world pos {x,y,z}: opts { volume, zone } — E applies zone reverb + portal occlusion */
    playAt(id, pos, opts) { if (a.log.length < 200) a.log.push(['playAt', id, pos.x, pos.y, pos.z]); return null; },
    setVolume(v) { a.volume = v; ctx.settings.data.volume = v; ctx.settings.save(); },
  };
  a.init = () => {
    // map gameplay events to (future) sounds — E keeps/extends this wiring
    ctx.events.on('weapon:fire', () => a.play('pistol_shot'));
    ctx.events.on('enemy:fire', (e) => a.playAt('enemy_shot', e.enemy.pos));
    ctx.events.on('door:state', (e) => {
      const d = e.door, m = (d.a + d.b) / 2, ax = d.axis === 'x';
      a.playAt(d.kind === 'roller' ? 'roller_door' : 'door', { x: ax ? m : d.at, y: d.y0 + 1, z: ax ? d.at : m });
    });
    ctx.events.on('glass:break', (e) => a.playAt('glass_break', e.point ?? { x: 0, y: 0, z: 0 }));
    ctx.events.on('enemy:death', (e) => a.playAt('death_groan', e.enemy.pos));
    ctx.events.on('player:damage', () => a.play('player_hurt'));
  };
  a.update = () => {};
  return a;
}
