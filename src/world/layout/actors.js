// The enemy roster. Owner: D (enemies). (The player start lives in moments.js, owner F.)
// yaw: radians, 0 = facing north (-z), +π/2 = facing west (-x), π = south (+z), -π/2 = east (+x)
// (same convention as three.js camera rotation.y).
//
// role: 'guard'    — stands at a post doing `act`, scans, reacts to noise / sight
//       'patrol'   — walks `patrol` waypoints (loop), y taken from the nav mesh
//       'sleeper'  — lying (bed) or dozing (seat); hears only loud things nearby, gets up slowly
//       'ambusher' — hidden and silent; armed by its `trigger` (staged moment id) or close contact, then waits
//                    for the player to pass / come close and opens fire
// weapon: 'pistol' | 'smg' | 'shotgun' | 'rifle'
// act (unaware activity, see src/enemies/brain.js ACTIVITIES): guard, patrol, pack, lab, console, cash, sit,
//   sleep, smoke, phone, talk, tv, lean, hide. Weapons are holstered/laid down during non-weapon activities
//   (drawing costs reaction time).
// bed: [x, y, z, yaw] body midpoint on the mattress/sofa, yaw = direction the head points.
// seat: [x, y, z, yaw] actor root for the sit clips (≈ 0.37 m in front of the seat centre, y = floor), yaw = facing.
// group: director handle (ctx.enemies.alert/ambush/wake/… accept group names). look: character variant.
// surrenders: false → never gives up; brave: never breaks (no flee / surrender).

const E = (id, role, x, y, z, yaw, weapon, o = {}) => ({ id, role, pos: [x, y, z], yaw, weapon, ...o });
const N = 0, S = Math.PI, W = Math.PI / 2, O = -Math.PI / 2;

export const ENEMIES = [
  // ---- yard / dock
  E('e01', 'guard', 11.5, 0, 66.6, S, 'pistol', { act: 'smoke', group: 'tor', look: 'thug_jacket', note: 'Raucht vor Tor 2, Blick zum Hof' }),
  E('e02', 'patrol', 30, 0, 75, O, 'smg', { group: 'tor', look: 'thug_hoodie', brave: true, patrol: [[30, 75], [52, 75], [52, 97], [30, 97]] }),
  // ---- goods-in
  E('e03', 'guard', 0.32, 0, 50, O, 'pistol', { act: 'lean', group: 'we', look: 'thug_tee', note: 'Lehnt an der Westwand' }),
  E('e04', 'guard', 16, 0, 58.9, N, 'shotgun', { act: 'console', group: 'we', look: 'thug_worker', note: 'Am Stapler' }),
  E('e05', 'patrol', 6.5, 0, 40, O, 'pistol', { group: 'we', look: 'thug_jacket', patrol: [[6.5, 40], [24, 40], [24, 54], [6.5, 54]] }),
  // ---- packing area (m03): both work with their backs to the goods-in passage
  E('e06', 'guard', 12, 0, 29.05, N, 'smg', { act: 'pack', group: 'pack', look: 'thug_female', note: 'Am Packtisch' }),
  E('e07', 'guard', 18, 0, 29.05, N, 'pistol', { act: 'pack', group: 'pack', look: 'thug_tee' }),
  E('e08', 'ambusher', 16, 0, 34.3, N, 'shotgun', { trigger: 'm03_packerei', act: 'hide', group: 'pack', look: 'thug_balaclava', surrenders: false, note: 'Hinter Kartonstapel' }),
  // ---- lab / social room
  E('e09', 'guard', 3, 0, 4.95, S, 'pistol', { act: 'lab', group: 'west', look: 'thug_worker', note: 'Koch im Labor' }),
  E('e10', 'sleeper', 13.32, 0, 5, O, 'pistol', { act: 'sit', seat: [13.32, 0, 5, O], group: 'west', look: 'thug_hoodie', note: 'Döst auf dem Stuhl im Sozialraum' }),
  // ---- mezzanine
  E('e11', 'sleeper', 2, 4.5, 16.0, O, 'pistol', { act: 'sleep', bed: [2, 4.7, 14.5, W], group: 'og', look: 'thug_tee' }),
  E('e12', 'guard', 10, 4.5, 22.63, N, 'smg', { act: 'sit', seat: [10, 4.5, 22.63, N], group: 'og', look: 'thug_jacket', note: 'Sitzt auf dem Sofa vor dem Fernseher (Schlafecke)' }),
  E('e13', 'guard', 3.6, 4.5, 5.75, N, 'pistol', { act: 'cash', group: 'og', look: 'thug_female', note: 'Zählt Geld, Schrei (m08)' }),
  E('e14', 'guard', 25.2, 4.5, 6.8, O, 'rifle', { group: 'og', look: 'thug_balaclava', brave: true, note: 'Leitstand, überblickt die Halle' }),
  // ---- racking hall
  E('e15', 'patrol', 33.9, 0, 3, S, 'smg', { group: 'halle', look: 'thug_hoodie', patrol: [[33.9, 3], [33.9, 58], [44.7, 58], [44.7, 3]] }),
  E('e16', 'patrol', 55.5, 0, 4, S, 'pistol', { group: 'halle', look: 'thug_worker', patrol: [[55.5, 4], [55.5, 56], [66.3, 56], [66.3, 4]] }),
  E('e17', 'ambusher', 47.3, 0, 43.5, W, 'shotgun', { trigger: 'm05_halle_dunkel', act: 'hide', group: 'halle', look: 'thug_balaclava', surrenders: false, note: 'In Regallücke' }),
  // ---- automation / shipping / cold store
  E('e18', 'patrol', 77, 0, 10, S, 'smg', { group: 'auto', look: 'thug_tee', patrol: [[77, 10], [77, 38]], note: 'Innerhalb der Förderschleife' }),
  E('e19', 'ambusher', 94, 0, 46, W, 'pistol', { trigger: 'm09_roboter', act: 'hide', group: 'auto', look: 'thug_jacket' }),
  E('e20', 'sleeper', 9, -3.7, 48.3, O, 'pistol', { act: 'sleep', bed: [9, -3.5, 49.5, O], group: 'keller', look: 'thug_worker', note: 'Technikraum, wacht bei m04 auf' }),
  E('e21', 'guard', 84, 0, 57.5, O, 'rifle', { act: 'guard', group: 'kuehl', look: 'thug_hoodie', brave: true, note: 'Vor der Kühlraumtür' }),
  E('e22', 'ambusher', 93, 0, 58, W, 'shotgun', { trigger: 'm10_kuehl', act: 'hide', group: 'kuehl', look: 'thug_balaclava', surrenders: false }),
];
