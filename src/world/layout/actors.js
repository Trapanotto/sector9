// Player start and the enemy roster. Owner: D (enemies) for ENEMIES, F (director) for PLAYER_SPAWN.
// yaw: radians, 0 = facing north (-z), +π/2 = facing west (-x), π = south (+z), -π/2 = east (+x)
// (same convention as three.js camera rotation.y).
//
// role: 'guard'    — stands at a post, scans, reacts to noise / sight
//       'patrol'   — walks `patrol` waypoints (loop), y taken from the nav mesh
//       'sleeper'  — lying/sitting, wakes on noise, gunfire nearby or a staged moment
//       'ambusher' — hidden, waits for `trigger` (staged moment id) or close contact, then attacks
// weapon: 'pistol' | 'smg' | 'shotgun' | 'rifle'

export const PLAYER_SPAWN = { pos: [45, 0, 107.5], yaw: 0, zone: 'hof' };

const E = (id, role, x, y, z, yaw, weapon, o = {}) => ({ id, role, pos: [x, y, z], yaw, weapon, ...o });
const N = 0, S = Math.PI, W = Math.PI / 2, O = -Math.PI / 2;

export const ENEMIES = [
  E('e01', 'guard', 12, 0, 67, S, 'pistol', { note: 'Raucht vor Tor 2, Blick zum Hof' }),
  E('e02', 'patrol', 30, 0, 75, O, 'smg', { patrol: [[30, 75], [52, 75], [52, 97], [30, 97]] }),
  E('e03', 'guard', 8, 0, 50, S, 'pistol'),
  E('e04', 'guard', 22, 0, 58.5, W, 'shotgun'),
  E('e05', 'patrol', 6.5, 0, 40, O, 'pistol', { patrol: [[6.5, 40], [24, 40], [24, 54], [6.5, 54]] }),
  E('e06', 'guard', 12, 0, 29.6, N, 'smg', { note: 'Am Packtisch' }),
  E('e07', 'guard', 18, 0, 32, S, 'pistol'),
  E('e08', 'ambusher', 16, 0, 34.3, N, 'shotgun', { trigger: 'm03_packerei', note: 'Hinter Kartonstapel' }),
  E('e09', 'guard', 5, 0, 4.5, S, 'pistol', { note: 'Koch im Labor' }),
  E('e10', 'sleeper', 18, 0, 9.8, S, 'pistol', { note: 'Auf dem Sofa' }),
  E('e11', 'sleeper', 2, 4.5, 14.5, O, 'pistol'),
  E('e12', 'sleeper', 2, 4.5, 17.8, O, 'smg'),
  E('e13', 'guard', 3, 4.5, 6.5, O, 'pistol', { note: 'Zählt Geld, Schrei (m08)' }),
  E('e14', 'guard', 25.2, 4.5, 6.8, O, 'rifle', { note: 'Leitstand, überblickt die Halle' }),
  E('e15', 'patrol', 33.9, 0, 3, S, 'smg', { patrol: [[33.9, 3], [33.9, 58], [44.7, 58], [44.7, 3]] }),
  E('e16', 'patrol', 55.5, 0, 4, S, 'pistol', { patrol: [[55.5, 4], [55.5, 56], [66.3, 56], [66.3, 4]] }),
  E('e17', 'ambusher', 47.3, 0, 43.5, W, 'shotgun', { trigger: 'm05_halle_dunkel', note: 'In Regallücke' }),
  E('e18', 'patrol', 77, 0, 10, S, 'smg', { patrol: [[77, 10], [77, 38]], note: 'Innerhalb der Förderschleife' }),
  E('e19', 'ambusher', 94, 0, 46, W, 'pistol', { trigger: 'm09_roboter' }),
  E('e20', 'sleeper', 9, -3.7, 47.5, W, 'pistol', { note: 'Technikraum, wacht bei m04 auf' }),
  E('e21', 'guard', 84, 0, 57.5, O, 'rifle', { note: 'Vor der Kühlraumtür' }),
  E('e22', 'ambusher', 93, 0, 58, W, 'shotgun', { trigger: 'm10_kuehl' }),
];
