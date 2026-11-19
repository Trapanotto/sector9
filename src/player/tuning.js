// All player / camera / weapon tunables in one place. Units: metres, seconds, radians.
const DEG = Math.PI / 180;

// --- Movement -------------------------------------------------------------
export const WALK_SPEED = 2.2;
export const SPRINT_SPEED = 4.5;
export const CROUCH_SPEED = 1.2;
export const ADS_SPEED = 1.5;
export const BACK_MUL = 0.75;          // backwards / strafe-back speed multiplier
export const STRAFE_MUL = 0.92;        // pure sideways speed multiplier
export const ACCEL = 11;               // exponential approach rate toward wish velocity (1/s): 90 % in 0.21 s
export const SPRINT_ACCEL = 5;         // slower build-up into a sprint (weight)
export const FRICTION = 14;            // approach rate toward zero with no input: 90 % stopped in 0.16 s
export const TURN_ACCEL = 16;          // faster re-direction when the wish direction opposes the velocity
export const GRAVITY = 9.81;

export const RADIUS = 0.26;            // collision circle (rounded, so door frames and corners deflect)
export const HEIGHT_STAND = 1.8;
export const HEIGHT_CROUCH = 1.2;
export const CROUCH_RATE = 9;          // smoothing rate for crouch transition
export const STEP_UP = 0.42;           // max ground rise taken as a step
export const STEP_DOWN = 0.4;          // max ground drop we stick to while grounded
export const STEP_BOX = 0.34;          // colliders whose top is at most this far above the feet are stepped onto
export const SPRINT_RAISE = 0.16;      // s after sprinting before the weapon is up enough to fire

// Body camera mount height above the feet (chest/shoulder, below the 1.68 eye line).
export const CAM_STAND = 1.52;
export const CAM_CROUCH = 1.0;

export const LEAN_DIST = 0.36;
export const LEAN_ROLL = 11 * DEG;
export const LEAN_RATE = 9;            // lean spring omega (critically damped)
export const LEAN_MARGIN = 0.16;       // camera clearance kept from walls while leaning
export const STRAFE_ROLL = 0.008;      // rad per m/s of lateral velocity

// --- Look / free aim ------------------------------------------------------
// Mouse -> world aim is exactly 1:1 (no smoothing, no lag). Free aim only decides how that motion is split
// between the gun moving inside the frame (aim offset) and the camera body turning; smoothing is applied to
// the rendered camera only (velocity feed-forward follower: no lag at a constant turn rate).
export const SENS_UNIT = 0.022 * DEG;  // rad per mouse count at sensitivity 1.0 (same scale as Source / CS games)
export const SENS_DEFAULT = 3.0;       // -> 0.066 deg per count (800 dpi: 360 deg in ~17 cm)
export const ADS_SENS_DEFAULT = 0.85;  // ~ tan(FOV_ADS/2)/tan(FOV_HIP/2): same screen-space speed when aimed
// Soft zone (half extents, rad) for each free-aim level. Inside the inner part (ZONE_INNER of the ellipse) the
// mouse moves only the gun; toward the rim more and more of the motion turns the camera body; at the rim all of
// it does. Fast mouse motion turns the body earlier (FLICK_*), so deliberate turns never feel dragged.
export const FREE_AIM = {
  aus:      { x: 0,         y: 0,         xAds: 0,          yAds: 0 },
  gering:   { x: 4 * DEG,   y: 2.8 * DEG, xAds: 0.6 * DEG,  yAds: 0.45 * DEG },
  standard: { x: 7.5 * DEG, y: 5 * DEG,   xAds: 1.2 * DEG,  yAds: 0.9 * DEG },
  stark:    { x: 12 * DEG,  y: 8 * DEG,   xAds: 2.2 * DEG,  yAds: 1.6 * DEG },
};
export const ZONE_INNER = 0.35;        // fraction of the ellipse where the camera never turns
export const FLICK_LO = 0.6;           // rad/s of mouse speed where flicks start turning the body early
export const FLICK_HI = 4.0;           // rad/s at which FLICK_MAX of the outward motion goes to the body
export const FLICK_MAX = 0.75;
export const FLICK_FILTER = 25;        // 1/s low-pass on the mouse speed used for the flick split
export const RECENTER_MOUSE = 0.9;     // body recentre per rad of mouse motion (camera catches up while moving)
export const RECENTER_MOVE = 0.55;     // 1/s per m/s walking speed: walking turns the body toward the aim
export const RECENTER_ADS = 7.0;       // 1/s, ADS keeps the gun nearly centred (time-based only while aimed)
export const RECENTER_SPRINT = 4.0;
export const PITCH_LIMIT = 1.3;        // camera body pitch clamp
export const AIM_PITCH_LIMIT = 1.4;    // world aim pitch clamp
export const CAM_LAG_MAX = 0.12;       // max angle the rendered camera may differ from the body
export const CAM_OVERSHOOT_MAX = 0.008; // rad the camera may run past the body after a hard stop
export const CAM_FOLLOW_W = 30;        // camera follower omega at the hip (critically damped)
export const CAM_FOLLOW_W_ADS = 45;    // ... aimed (near 1:1)
export const INERTIA_POS = 0.85;       // gun lag impulse (m/s) per rad of mouse motion; translation only (visual)
export const FOV_HIP = 97;
export const FOV_ADS_DELTA = 10;       // ADS FOV = hip FOV - this
export const ADS_TIME = 0.2;           // seconds to fully raise to the sights

// --- Body-cam motion ------------------------------------------------------
export const STEP_LEN_WALK = 1.0;      // metres per step
export const STEP_LEN_SPRINT = 1.5;
export const BOB_V_WALK = 0.018, BOB_V_SPRINT = 0.042;       // vertical bounce
export const BOB_X_WALK = 0.010, BOB_X_SPRINT = 0.022;       // lateral sway
export const BOB_ROLL_WALK = 0.010, BOB_ROLL_SPRINT = 0.030;
export const BOB_PITCH_WALK = 0.006, BOB_PITCH_SPRINT = 0.018;
export const BOB_YAW_WALK = 0.004, BOB_YAW_SPRINT = 0.014;
export const STEP_JOLT_WALK = 0.08, STEP_JOLT_SPRINT = 0.22; // downward velocity impulse per footfall
export const BREATH_RATE = 0.23;       // Hz idle
export const LAND_MIN_SPEED = 1.2;

// --- Viewmodel poses (camera space, see player.js poseViewmodel) ----------
// Hip: gun origin (top of the grip) ends up at PIVOT_HIP + R_aim * OFF_HIP.
export const PIVOT_HIP = [0.0, 0.10, 0.10];          // roughly between the shoulders, above the chest cam
// Arms nearly extended (two-handed ready, gun just below the camera line): seen from the chest camera the forearms
// then enter from the lower corners and converge on the gun. The old compressed pose (gun 0.35 m out, 0.16 m low)
// put the wrists straight below the gun, so the forearms hung vertically and both hands merged into one column.
export const OFF_HIP = [0.03, -0.165, -0.50];        // -> gun at about (0.03, -0.065, -0.40)
export const HIP_ROT = [0.0, 0.0, -0.05];            // slight cant at hip
export const ADS_DIST = 0.28;                         // camera -> gun origin distance in ADS
export const LOW_POS = [-0.05, -0.09, 0.07];          // low-ready offset (camera space)
export const LOW_ROT = [-0.62, 0.30, 0.38];           // low-ready rotation (gun local euler)
// Arms (camera space, right side; the left is mirrored): shoulder joint relative to the chest camera and the
// direction the elbows bend toward (down, out, slightly back) for the two-bone arm IK in viewmodel.js.
export const SHOULDER = [0.175, -0.05, 0.085];
export const ELBOW_POLE = [0.9, -1.0, 0.1];
export const WALL_CHECK = 0.95;                      // forward ray length for wall low-ready
export const WALL_FULL = 0.5;                         // distance at which the gun is fully lowered

// --- Weapon ---------------------------------------------------------------
export const MAG_SIZE = 15;
export const SPARE_MAGS = 3;
export const FIRE_INTERVAL = 1 / 6;
export const FIRE_BUFFER = 0.25;       // s a click stays queued (too early: cycling, raising from sprint/low-ready)
export const RELOAD_BUFFER = 0.35;     // s a reload press stays queued (e.g. pressed while sprinting)
export const DAMAGE = 55;
export const NOISE_RADIUS = 40;
export const RECOIL_ROT = 4.9;         // muzzle-flip impulse (rad/s) -> ~9 deg peak at hip
export const RECOIL_BACK = 1.28;       // m/s impulse backwards
export const RECOIL_UP = 0.42;
export const CAM_KICK = 0.5;           // camera pitch impulse per shot
export const AIM_CLIMB = 0.006;        // permanent aim walk per shot (rad)
export const AIM_CLIMB_X = 0.004;
export const RELOAD_TACTICAL = 1.55;
export const RELOAD_EMPTY = 1.75;      // + slide release with the support thumb

// --- Flashlight -----------------------------------------------------------
export const FLASH_INTENSITY = 70;     // candela (physically based lights in r170)
export const FLASH_DISTANCE = 35;
export const FLASH_ANGLE = 0.44;
export const FLASH_PENUMBRA = 0.85;

export const MAX_HEALTH = 100;
