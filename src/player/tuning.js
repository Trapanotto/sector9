// All player / camera / weapon tunables in one place. Units: metres, seconds, radians.
const DEG = Math.PI / 180;

// --- Movement -------------------------------------------------------------
export const WALK_SPEED = 2.2;
export const SPRINT_SPEED = 4.5;
export const CROUCH_SPEED = 1.2;
export const ADS_SPEED = 1.5;
export const BACK_MUL = 0.75;          // backwards / strafe-back speed multiplier
export const ACCEL = 6.5;              // exponential approach rate toward wish velocity (1/s)
export const SPRINT_ACCEL = 3.8;       // slower build-up into a sprint (weight)
export const FRICTION = 8.5;           // approach rate toward zero with no input
export const GRAVITY = 9.81;

export const RADIUS = 0.3;
export const HEIGHT_STAND = 1.8;
export const HEIGHT_CROUCH = 1.2;
export const CROUCH_RATE = 7;          // smoothing rate for crouch transition
export const STEP_UP = 0.42;           // max ground rise taken as a step
export const STEP_DOWN = 0.4;          // max ground drop we stick to while grounded

// Body camera mount height above the feet (chest/shoulder, below the 1.68 eye line).
export const CAM_STAND = 1.52;
export const CAM_CROUCH = 1.0;

export const LEAN_DIST = 0.36;
export const LEAN_ROLL = 11 * DEG;
export const LEAN_RATE = 7;
export const LEAN_MARGIN = 0.16;       // camera clearance kept from walls while leaning
export const STRAFE_ROLL = 0.008;      // rad per m/s of lateral velocity

// --- Look / free aim ------------------------------------------------------
export const SENS = 0.0021;            // rad per mouse pixel
export const ADS_SENS_MUL = 0.7;
export const DEAD_X = 12 * DEG;        // free-aim dead zone (half extents), hip
export const DEAD_Y = 8 * DEG;
export const DEAD_X_ADS = 2.2 * DEG;   // ... while aiming down sights
export const DEAD_Y_ADS = 1.6 * DEG;
export const RECENTER_HIP = 1.0;       // 1/s, camera body slowly turns toward the aim
export const RECENTER_ADS = 5.0;
export const RECENTER_SPRINT = 4.0;
export const PITCH_LIMIT = 1.3;        // camera body pitch clamp
export const AIM_PITCH_LIMIT = 1.4;    // world aim pitch clamp
export const CAM_LAG_MAX = 0.42;       // max angle the camera may trail the body target
export const CAM_FOLLOW_W = 11;        // camera follow spring (rad/s), zeta below (<1 = overshoot)
export const CAM_FOLLOW_Z = 0.62;
export const FOV_HIP = 97;
export const FOV_ADS = 87;
export const ADS_TIME = 0.22;          // seconds to fully raise to the sights

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
export const OFF_HIP = [0.058, -0.255, -0.445];      // -> gun at about (0.058, -0.155, -0.345)
export const HIP_ROT = [0.0, 0.0, -0.05];            // slight cant at hip
export const ADS_DIST = 0.28;                         // camera -> gun origin distance in ADS
export const LOW_POS = [-0.05, -0.09, 0.07];          // low-ready offset (camera space)
export const LOW_ROT = [-0.62, 0.30, 0.38];           // low-ready rotation (gun local euler)
export const WALL_CHECK = 0.8;                        // forward ray length for wall low-ready
export const WALL_FULL = 0.38;                        // distance at which the gun is fully lowered

// --- Weapon ---------------------------------------------------------------
export const MAG_SIZE = 15;
export const SPARE_MAGS = 3;
export const FIRE_INTERVAL = 1 / 6;
export const DAMAGE = 55;
export const NOISE_RADIUS = 40;
export const RECOIL_ROT = 4.9;         // muzzle-flip impulse (rad/s) -> ~9 deg peak at hip
export const RECOIL_BACK = 1.28;       // m/s impulse backwards
export const RECOIL_UP = 0.42;
export const CAM_KICK = 0.5;           // camera pitch impulse per shot
export const AIM_CLIMB = 0.006;        // permanent aim walk per shot (rad)
export const AIM_CLIMB_X = 0.004;
export const RELOAD_TACTICAL = 1.65;
export const RELOAD_EMPTY = 2.15;

// --- Flashlight -----------------------------------------------------------
export const FLASH_INTENSITY = 70;     // candela (physically based lights in r170)
export const FLASH_DISTANCE = 35;
export const FLASH_ANGLE = 0.44;
export const FLASH_PENUMBRA = 0.85;

export const MAX_HEALTH = 100;
