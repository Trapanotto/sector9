// The complete level description, assembled from the per-owner layout files. Pure data + pure functions:
// importable from Node (bake, tests) and the browser.
import { SITE, ZONES, ARCH, HALL } from './site.js';
import { PROPS, RAW } from './props.js';
import { PROP_TYPES, HIDE_PROXY_GROUPS } from './proptypes.js';
import { CONVEYORS, SORTER, AGV_ROUTES, AGVS, CRANES, ROBOTS } from './machines.js';
import { SUN, SKY, CIRCUITS, CIRCUIT_IDS, FIXTURES } from './lights.js';
import { ENEMIES } from './actors.js';
import { PLAYER_SPAWN, MOMENTS, EXTRACTION } from './moments.js';

// Benchmark camera views: the heaviest views of the level (perf HUD "bench" mode cycles them; npm test estimates
// their draw calls / triangles from the PVS). yaw convention as in actors.js; y = eye height.
export const BENCH_VIEWS = [
  { id: 'v_halle_nord', name: 'Halle Nord → Süd (alle Gänge)', pos: [50, 1.65, 3.5], yaw: Math.PI, pitch: 0 },
  { id: 'v_steg', name: 'Laufsteg Übersicht', pos: [36, 6.15, 0.8], yaw: -2.4, pitch: -0.35 },
  { id: 'v_halle_mitte', name: 'Halle Mitte → Ost', pos: [29.5, 1.65, 29.5], yaw: -Math.PI / 2, pitch: 0 },
  { id: 'v_hof', name: 'Hof → Gebäude', pos: [45, 1.65, 106], yaw: 0.15, pitch: 0.05 },
  { id: 'v_leitstand', name: 'Leitstand → Halle', pos: [26.5, 6.15, 6], yaw: -Math.PI / 2 - 0.3, pitch: -0.15 },
  { id: 'v_wareneingang', name: 'Wareneingang → Halle Süd', pos: [3, 1.65, 58], yaw: -Math.PI / 2, pitch: 0 },
  { id: 'v_sorter', name: 'Sorter → Nord', pos: [73.2, 1.65, 50], yaw: -0.1, pitch: 0 },
];

export const LAYOUT = {
  version: 1,
  site: SITE, hall: HALL,
  zones: ZONES, arch: ARCH,
  propTypes: PROP_TYPES, props: PROPS, raw: RAW, hideProxyGroups: HIDE_PROXY_GROUPS,
  conveyors: CONVEYORS, sorter: SORTER, agvRoutes: AGV_ROUTES, agvs: AGVS, cranes: CRANES, robots: ROBOTS,
  sun: SUN, sky: SKY, circuits: CIRCUITS, circuitIds: CIRCUIT_IDS, fixtures: FIXTURES,
  playerSpawn: PLAYER_SPAWN, enemies: ENEMIES,
  moments: MOMENTS, extraction: EXTRACTION,
  benchViews: BENCH_VIEWS,
};
export default LAYOUT;
