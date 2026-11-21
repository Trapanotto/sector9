// Binding runtime budgets (lowest tier, worst view). The perf HUD shows live numbers; `npm test` checks the
// static parts. Per-workstream shares must add up to the frame totals. See CONTRACT.md §budgets.
export const BUDGETS = {
  frame: { drawCalls: 120, triangles: 200_000, fullscreenPasses: 2, dynamicLights: 1, textureMB: 150, frameMs: 16.7 },
  // static world (A + B): merged per zone and material class, PVS + frustum culled
  static: { drawCalls: 60, triangles: 140_000, textureMB: 70 },
  // per workstream (worst view, low tier)
  A: { drawCalls: 10, triangles: 15_000, textureMB: 20, note: 'dynamic machines: AGVs, crane, robot, doors, glass shards' },
  B: { drawCalls: 2, triangles: 200, textureMB: 30, note: 'sky + composite; lightmaps 2048xH RGBA8 x2 + probes ~3 MB' },
  C: { drawCalls: 6, triangles: 12_000, textureMB: 12, note: 'arms + weapon (+ muzzle flash sprite), fx decals/impacts pooled' },
  D: { drawCalls: 32, triangles: 30_000, textureMB: 16, note: '≤ 8k tris per character at LOD0, LOD1 ≤ 2.5k beyond 15 m, ≤ 4 visible at LOD0' },
  E: { drawCalls: 0, triangles: 0, textureMB: 0, note: 'audio: ≤ 24 voices, decoded buffers ≤ 60 MB' },
  F: { drawCalls: 2, triangles: 500, textureMB: 4, note: 'world-space UI/markers only; HUD is DOM' },
};
