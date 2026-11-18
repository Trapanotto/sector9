// All gameplay tunables for the hostile AI in one place.
// Units: metres, seconds, radians. Changing values here needs no other code changes.
const DEG = Math.PI / 180;

export const TUNING = {
  // ---- damage model ----------------------------------------------------------------------
  health: 100,
  torsoMultiplier: 1.0,
  limbMultiplier: 0.5,
  torsoVitalChance: 0.3,      // chance a torso hit counts double (heart/lungs) -> 50 dmg player round kills at once
  staggerMin: 0.35, staggerMax: 0.65,   // seconds a wounded enemy is rocked (no moving, no shooting)

  // ---- perception ------------------------------------------------------------------------
  vision: {
    range: 35,
    halfAngle: 55 * DEG,        // 110 deg cone around the head direction
    combatHalfAngle: 85 * DEG,  // wider once they know where you are
    closeAwareness: 2.5,        // within this distance (and LOS) they notice you in any direction
    tickMin: 0.08, tickMax: 0.13,   // seconds between sight checks per enemy (randomised -> staggered)
  },
  detection: {
    // seconds until the meter is full for a fully visible, standing, still player:
    //   baseTime + d * timePerMetre + (d / range)^2 * farTime   (5 m ~ 0.5 s, 10 m ~ 0.8 s, 20 m ~ 1.6 s, 35 m ~ 3.3 s)
    baseTime: 0.25, timePerMetre: 0.045, farTime: 1.5,
    movingMul: 0.75,      // time multiplier (<1 = faster detection) when the player walks
    sprintMul: 0.55,      // ... sprints
    crouchMul: 1.6,       // ... is crouched (slower)
    peripheralMul: 1.5,   // ... is in the outer part of the cone (> peripheralAngle off-centre)
    peripheralAngle: 30 * DEG,
    partialMul: 1.4,      // ... only head or only chest is visible
    alertMul: 0.5,        // ... enemy is already suspicious / searching / recently alerted
    closeMul: 0.4,        // ... player is inside closeAwareness
    decayPerSec: 0.22,    // meter drain when nothing is seen
    suspiciousAt: 0.45,   // meter level that turns idle/patrol into 'suspicious'
  },
  hearing: {
    footstepRange: 18,    // metres at player.noise == 1
    wallMul: 0.5,         // hearing radius multiplier when the line is blocked
    gunshotRadius: 15,    // alertNoise() radius >= this is treated as gunfire
  },

  // ---- reaction & accuracy ---------------------------------------------------------------
  reaction: {
    min: 0.35, max: 0.7,                 // first spotting -> first possible shot
    reacquireMin: 0.22, reacquireMax: 0.42, reacquireGap: 0.9,   // when you re-appear after > gap seconds hidden
    damagedMin: 0.3, damagedMax: 0.55,   // after being hit (on top of the stagger)
  },
  accuracy: {
    // Aim error radius at the target (metres) = (baseError + errorPerMetre * distance) * multipliers.
    baseError: 0.12,
    errorPerMetre: 0.03,
    initialMul: 6.0,        // multiplier at the moment they get the sight line ...
    settleTime: 2.0,        // ... easing down to 1.0 after this many seconds of continuous sight
    selfMovingMul: 1.7,     // shooter is moving
    targetSpeedMul: 0.14,   // + this per m/s of player speed
    suppressedMul: 2.0,     // player shot at / near them recently
    suppressTime: 1.1,
    sightDecay: 1.5,        // settle time drains this fast (s per s) while the sight line is broken
    aimTolerance: 0.22,     // radians: body/weapon must point this close to the target before firing
    verticalScale: 0.8,     // vertical error relative to horizontal
  },
  fire: {
    damage: 50,
    burstMin: 1, burstMax: 4,           // single shots per burst
    gapMin: 0.17, gapMax: 0.36,         // between shots in a burst
    pauseMin: 0.5, pauseMax: 1.1,       // between bursts
    magPistol: 12, magRifle: 20,
    reloadMin: 2.3, reloadMax: 2.9,
    maxRange: 60,
  },

  // ---- squad ----------------------------------------------------------------------------
  ally: {
    radius: 12,                          // allies this close (or with LOS to the spotter) get alerted
    delayMin: 0.6, delayMax: 1.4,
    shoutDelayMin: 0.15, shoutDelayMax: 0.45,
    reportError: 1.5,                    // metres of error in the position passed on
  },

  // ---- movement --------------------------------------------------------------------------
  move: {
    radius: 0.3,
    walk: 1.3, cautious: 1.1, search: 1.45, combat: 2.3, run: 3.7,
    accel: 7,
    separation: 0.85,
    woundedMul: 0.8,
    repathInterval: 0.6,
  },

  // ---- combat tactics --------------------------------------------------------------------
  combat: {
    loseSightToSearch: 14,      // non-pushers hold their position this long without sight before searching
    pushAfter: 3.0,             // seconds without sight before one enemy may push the last known position
    pushChance: 0.45,           // per decision tick once allowed
    maxPushers: 1,              // simultaneous pushers (2 while >= 6 hostiles are fighting)
    coverRadius: 14,
    guardLeash: 9,              // 'guard' spawns stay within this of their post
    coverMinThreatDist: 4,
    peekMin: 1.4, peekMax: 2.8,
    hideMin: 1.0, hideMax: 2.4,
    repositionChance: 0.04,     // per decision tick while in cover
    decisionMin: 0.5, decisionMax: 0.9,
    holdCrouchChance: 0.4,
  },
  search: { sweepMin: 4, sweepMax: 7, extraPoints: 1, giveUp: 24, alertDecay: 60 },
  suspicious: { turnMin: 0.6, turnMax: 1.2, lookMin: 3, lookMax: 5, guardLeash: 12, timeout: 16 },

  // ---- performance -----------------------------------------------------------------------
  budget: { pathsPerFrame: 2, coverPerFrame: 1 },
};
