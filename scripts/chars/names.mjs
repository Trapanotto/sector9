// UAL1 (DEF-*) -> UAL2 bone names (mirror of charspec.ual1_to_ual2).
// Accepts both raw glTF names ("DEF-spine.001") and three.js-sanitised ones ("DEF-spine001").
export function ual1ToUal2(n) {
  const s0 = n.replace(/\./g, '');
  const m = { root: 'root', 'DEF-hips': 'pelvis', 'DEF-spine001': 'spine_01', 'DEF-spine002': 'spine_02',
    'DEF-spine003': 'spine_03', 'DEF-neck': 'neck_01', 'DEF-head': 'Head' };
  if (m[s0]) return m[s0];
  let r = s0.match(/^DEF-(shoulder|upper_arm|forearm|hand|thigh|shin|foot|toe)(L|R)$/);
  if (r) {
    const simple = { shoulder: 'clavicle', upper_arm: 'upperarm', forearm: 'lowerarm', hand: 'hand',
      thigh: 'thigh', shin: 'calf', foot: 'foot', toe: 'ball' };
    return `${simple[r[1]]}_${r[2].toLowerCase()}`;
  }
  r = s0.match(/^DEF-f_(index|middle|ring|pinky)(\d\d)(L|R)$/);
  if (r) return `${r[1]}_${r[2]}_${r[3].toLowerCase()}`;
  r = s0.match(/^DEF-thumb(\d\d)(L|R)$/);
  if (r) return `thumb_${r[1]}_${r[2].toLowerCase()}`;
  return null;
}
