// Shared weapon metrics (metres, weapon space): origin = centre of the strong-hand grip at the
// height of the middle finger, +Z = muzzle direction, +Y = up, +X = weapon's left.
// Used by the weapon modeller (weapons.mjs) and by the animation author (author.mjs).
export const WEAPONS = {
  pistol: {
    bore: [0, 0.062, 0], muzzle: [0, 0.062, 0.165], rear: [0, 0.062, -0.04],
    gripTilt: 18, // degrees, grip leans back
    support: null, // two-handed cup grip handled by the pistol pose
    stock: null,
  },
  smg: {
    bore: [0, 0.055, 0], muzzle: [0, 0.055, 0.33], rear: [0, 0.055, -0.16],
    gripTilt: 12,
    support: [0, 0.005, 0.2], // handguard
    stock: [0, 0.03, -0.38],
    mag: [0, -0.04, 0.075],
  },
  shotgun: {
    bore: [0, 0.05, 0], muzzle: [0, 0.05, 0.68], rear: [0, 0.05, -0.06],
    gripTilt: 25,
    support: [0, -0.005, 0.36], // pump
    stock: [0, 0.0, -0.36],
    mag: null,
  },
};
