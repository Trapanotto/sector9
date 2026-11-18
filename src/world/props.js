// Visual prop construction. Static props are merged into the Batcher (one draw call per material);
// repeated small items (barrels, rollers, debris) become InstancedMeshes.
import * as THREE from 'three';
import { Batcher, rng } from './geometry.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

export function buildProps(B, layout, seed = 7) {
  const R = rng(seed);
  const rr = (a, b) => a + (b - a) * R();
  const box = (min, max, mat, o) => B.box(min, max, mat, o);
  const inst = { barrels: [], rollers: [], debris: [], papers: [], bricks: [] };

  const builders = {
    crate(p) {
      const [x0, y0, z0] = p.min, [x1, y1, z1] = p.max, t = 0.05;
      box([x0 + 0.02, y0, z0 + 0.02], [x1 - 0.02, y1 - 0.01, z1 - 0.02], 'wood', { tint: rr(0.75, 1.05) });
      // edge battens
      for (const [a, b] of [[x0, z0], [x1 - t, z0], [x0, z1 - t], [x1 - t, z1 - t]]) box([a, y0, b], [a + t, y1, b + t], 'woodDark');
      for (const y of [y0, y1 - t]) {
        box([x0, y, z0], [x1, y + t, z0 + t], 'woodDark'); box([x0, y, z1 - t], [x1, y + t, z1], 'woodDark');
        box([x0, y, z0], [x0 + t, y + t, z1], 'woodDark'); box([x1 - t, y, z0], [x1, y + t, z1], 'woodDark');
      }
    },
    pallets(p) {
      const [cx, , cz] = [(p.min[0] + p.max[0]) / 2, 0, (p.min[2] + p.max[2]) / 2];
      for (let i = 0; i < p.n; i++) {
        const y = i * 0.144, dx = rr(-0.04, 0.04), dz = rr(-0.04, 0.04), tint = rr(0.7, 1.1);
        const x0 = cx - 0.6 + dx, z0 = cz - 0.4 + dz;
        for (let k = 0; k < 3; k++) box([x0, y, z0 + k * 0.35], [x0 + 1.2, y + 0.022, z0 + k * 0.35 + 0.1], 'wood', { tint });
        for (let k = 0; k < 3; k++) box([x0 + k * 0.55, y + 0.022, z0], [x0 + k * 0.55 + 0.1, y + 0.122, z0 + 0.8], 'woodDark', { tint });
        for (let k = 0; k < 5; k++) box([x0, y + 0.122, z0 + k * 0.175], [x0 + 1.2, y + 0.144, z0 + k * 0.175 + 0.12], 'wood', { tint });
      }
    },
    barrel(p) {
      const c = [(p.min[0] + p.max[0]) / 2, 0, (p.min[2] + p.max[2]) / 2];
      inst.barrels.push({ pos: c, rot: R() * Math.PI * 2, color: [[0.75, 0.25, 0.2], [0.25, 0.4, 0.7], [0.55, 0.55, 0.5], [0.9, 0.9, 0.85]][Math.floor(R() * 4)] });
    },
    conveyor(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, y1 - 0.2, z0], [x1, y1 - 0.05, z0 + 0.08], 'paint'); box([x0, y1 - 0.2, z1 - 0.08], [x1, y1 - 0.05, z1], 'paint');
      for (let x = x0 + 0.1; x < x1; x += 1.6) {
        box([x, 0, z0 + 0.02], [x + 0.08, y1 - 0.2, z0 + 0.1], 'steel'); box([x, 0, z1 - 0.1], [x + 0.08, y1 - 0.2, z1 - 0.02], 'steel');
        box([x, 0.25, z0 + 0.1], [x + 0.06, 0.31, z1 - 0.1], 'steel');
      }
      for (let x = x0 + 0.15; x < x1 - 0.1; x += 0.26) inst.rollers.push([x, y1 - 0.12, (z0 + z1) / 2, z1 - z0 - 0.18]);
      box([x0 + 4, y1 - 0.07, z0 + 0.1], [x0 + 8.5, y1 - 0.05, z1 - 0.1], 'rubber');  // remaining belt section
      box([x1 - 1.1, 0, z1], [x1 - 0.2, 0.7, z1 + 0.5], 'paint');                       // drive motor
      B.cylinder('steel', [x1 - 0.65, 0.7, z1 + 0.25], 0.18, 0.3);
      box([x0 + 1, y1 - 0.05, z0 + 0.15], [x0 + 1.6, y1 + 0.25, z0 + 0.6], 'cardboard');
      box([x0 + 9.5, y1 - 0.05, z0 + 0.3], [x0 + 10.3, y1 + 0.4, z0 + 0.9], 'cardboard', { tint: 0.8 });
    },
    press(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, 0.9, z1], 'paint');
      for (const [a, b] of [[x0 + 0.1, z0 + 0.1], [x1 - 0.6, z0 + 0.1], [x0 + 0.1, z1 - 0.6], [x1 - 0.6, z1 - 0.6]]) box([a, 0.9, b], [a + 0.5, y1 - 0.7, b + 0.5], 'paint');
      box([x0, y1 - 0.9, z0], [x1, y1, z1], 'paint');
      box([x0 + 0.7, 1.9, z0 + 0.7], [x1 - 0.7, 2.6, z1 - 0.7], 'steel');
      box([x0 + 0.9, 0.9, z0 + 0.9], [x1 - 0.9, 1.15, z1 - 0.9], 'steel');
      for (const dx of [-0.5, 0.5]) B.cylinder('steel', [(x0 + x1) / 2 + dx, 2.6, (z0 + z1) / 2], 0.16, y1 - 3.5, { caps: false });
      box([x1, 0.4, z0 + 0.6], [x1 + 0.35, 1.9, z0 + 1.4], 'paintGrey');           // control box
      B.pipe('rubber', [x1 + 0.1, 1.9, z0 + 1.0], [x1 - 0.1, y1 - 0.5, z0 + 1.0], 0.03);
    },
    mill(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, 0.85, z1], 'paint');
      box([x0 + 0.2, 0.85, z1 - 0.7], [x0 + 1.0, y1, z1 - 0.05], 'paint');
      box([x0 + 0.1, y1 - 0.45, z0 + 0.6], [x0 + 1.1, y1 - 0.1, z1 - 0.2], 'paint');
      box([x0 + 1.0, 0.85, z0 + 0.3], [x1 - 0.1, 0.95, z1 - 0.9], 'steel');
      B.cylinder('steel', [x0 + 0.6, y1 - 1.1, z0 + 0.9], 0.1, 0.65);
    },
    tank(p) {
      const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2, r = (p.max[0] - p.min[0]) / 2 - 0.05;
      for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) box([cx + dx - 0.08, 0, cz + dz - 0.08], [cx + dx + 0.08, 0.7, cz + dz + 0.08], 'steel');
      B.cylinder('paintGrey', [cx, 0.6, cz], r, p.max[1] - 0.9, { segs: 28 });
      B.cylinder('paintGrey', [cx, p.max[1] - 0.3, cz], r * 0.5, 0.3, { segs: 20 });
      for (const y of [1.6, 3.2]) B.cylinder('steel', [cx, y, cz], r + 0.03, 0.08, { segs: 28, caps: false });
      B.pipe('rust', [cx, 4.4, cz - r], [cx, 4.4, -5.8], 0.12);
      B.pipe('rust', [cx + r, 1.2, cz], [7.8, 1.2, cz], 0.1);
      // ladder
      for (const dx of [-0.22, 0.22]) box([cx + dx - 0.02, 0.1, cz + r + 0.12], [cx + dx + 0.02, p.max[1], cz + r + 0.16], 'steel');
      for (let y = 0.4; y < p.max[1]; y += 0.3) box([cx - 0.22, y, cz + r + 0.12], [cx + 0.22, y + 0.025, cz + r + 0.16], 'steel');
    },
    cabinets(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, n = 4, w = (x1 - x0) / n;
      for (let i = 0; i < n; i++) {
        const a = x0 + i * w;
        box([a + 0.01, 0, z0], [a + w - 0.01, y1, z1], 'paintGrey', { tint: rr(0.8, 1.05) });
        box([a + 0.05, 0.15, z1], [a + w - 0.05, y1 - 0.1, z1 + 0.02], 'paintGrey', { tint: 0.75 });
      }
    },
    workbench(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, y1 - 0.06, z0], [x1, y1, z1], 'woodDark');
      for (const [a, b] of [[x0, z0], [x1 - 0.06, z0], [x0, z1 - 0.06], [x1 - 0.06, z1 - 0.06]]) box([a, 0, b], [a + 0.06, y1 - 0.06, b + 0.06], 'steel');
      box([x0 + 0.05, 0.2, z0 + 0.05], [x1 - 0.05, 0.24, z1 - 0.05], 'woodDark');
      box([x0 + 0.2, y1, z0 + 0.2], [x0 + 0.45, y1 + 0.18, z0 + 0.4], 'paint');
      box([x1 - 0.8, y1, z0 + 0.3], [x1 - 0.3, y1 + 0.25, z0 + 0.6], 'paintRed');
    },
    generator(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, 0.15, z1], 'steel');
      box([x0 + 0.1, 0.15, z0 + 0.1], [x1 - 0.1, y1, z1 - 0.1], 'paint');
      B.pipe('rust', [x1 - 0.4, y1, z0 + 0.4], [x1 - 0.4, y1 + 0.9, z0 + 0.4], 0.07);
    },
    vending(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, y1, z1], 'paintRed');
      box([x1, 0.9, z0 + 0.1], [x1 + 0.01, y1 - 0.15, z1 - 0.35], 'glassDark');
    },
    desk(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, y1 - 0.04, z0], [x1, y1, z1], 'woodDark');
      box([x0, 0, z0], [x0 + 0.45, y1 - 0.04, z1], 'paintGrey');
      for (const [a, b] of [[x1 - 0.05, z0], [x1 - 0.05, z1 - 0.05]]) box([a, 0, b], [a + 0.05, y1 - 0.04, b + 0.05], 'steel');
      box([x0 + 0.6, y1, z0 + 0.2], [x0 + 1.0, y1 + 0.32, z0 + 0.5], 'dark');      // old CRT/monitor
      for (let i = 0; i < 4; i++) { const px = rr(x0 + 0.2, x1 - 0.3), pz = rr(z0 + 0.1, z1 - 0.3); inst.papers.push([px, y1 + 0.002 + i * 0.001, pz, R() * 3]); }
    },
    filing(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, y1, z1], 'paintGrey');
      for (let y = 0.05; y < y1 - 0.2; y += 0.31) box([x0 - 0.015, y, z0 + 0.05], [x0, y + 0.27, z1 - 0.05], 'paintGrey', { tint: 0.8 });
    },
    shelf(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const mat = p.metal ? 'steel' : 'woodDark';
      for (const [a, b] of [[x0, z0], [x1 - 0.05, z0], [x0, z1 - 0.05], [x1 - 0.05, z1 - 0.05]]) box([a, 0, b], [a + 0.05, y1, b + 0.05], mat);
      const levels = 4;
      for (let k = 0; k < levels; k++) {
        const y = 0.12 + (k * (y1 - 0.2)) / (levels - 1);
        box([x0, y, z0], [x1, y + 0.03, z1], mat);
        if (k === levels - 1) break;
        const along = (x1 - x0) > (z1 - z0);
        const L = along ? x1 - x0 : z1 - z0;
        for (let s = 0.08; s < L - 0.35; s += rr(0.35, 0.7)) {
          if (R() < 0.25) continue;
          const w = rr(0.25, 0.45), h = rr(0.18, 0.38), d = Math.min(along ? z1 - z0 : x1 - x0, 0.45) - 0.04;
          const bmin = along ? [x0 + s, y + 0.03, z0 + 0.02] : [x0 + 0.02, y + 0.03, z0 + s];
          const bmax = along ? [x0 + s + w, y + 0.03 + h, z0 + 0.02 + d] : [x0 + 0.02 + d, y + 0.03 + h, z0 + s + w];
          box(bmin, bmax, R() < 0.7 ? 'cardboard' : 'paintBlue', { tint: rr(0.6, 1.0) });
        }
      }
    },
    lockers(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const n = Math.round((z1 - z0) / 0.4), w = (z1 - z0) / n;
      const fx = p.facing < 0 ? x0 : x1, s = p.facing < 0 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const a = z0 + i * w;
        box([x0, 0, a + 0.005], [x1, y1, a + w - 0.005], 'paintBlue', { tint: rr(0.75, 1.0) });
        if (R() < 0.2) {
          // door hanging open
          const m = new THREE.Matrix4().makeRotationY(s * 1.2).setPosition(fx, 0.1, a + 0.02);
          B.boxXf([-0.01, 0, 0], [0.01, 1.75, w - 0.04], 'paintBlue', m);
        } else {
          box(s > 0 ? [x1, 0.1, a + 0.02] : [x0 - 0.015, 0.1, a + 0.02], s > 0 ? [x1 + 0.015, y1 - 0.1, a + w - 0.02] : [x0, y1 - 0.1, a + w - 0.02], 'paintBlue', { tint: 0.85 });
          box(s > 0 ? [x1 + 0.015, y1 - 0.4, a + 0.08] : [x0 - 0.02, y1 - 0.4, a + 0.08], s > 0 ? [x1 + 0.02, y1 - 0.25, a + w - 0.08] : [x0 - 0.015, y1 - 0.25, a + w - 0.08], 'dark');
        }
      }
    },
    bench(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, y1 - 0.05, z0], [x1, y1, z1], 'wood');
      for (const a of [x0 + 0.1, x1 - 0.15]) box([a, 0, z0 + 0.05], [a + 0.05, y1 - 0.05, z1 - 0.05], 'steel');
    },
    console(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, y1 - 0.15, z1], 'paintGrey');
      box([x0, y1 - 0.15, z0], [x1, y1, z1 - 0.15], 'paintGrey', { tint: 0.85 });
      for (let x = x0 + 0.2; x < x1 - 0.5; x += 0.8) {
        box([x, y1, z0 + 0.05], [x + 0.5, y1 + 0.38, z0 + 0.4], 'dark');
        box([x + 0.04, y1 + 0.05, z0 + 0.4], [x + 0.46, y1 + 0.34, z0 + 0.41], 'screen');
      }
      for (let x = x0 + 0.1; x < x1 - 0.1; x += 0.12) box([x, y1 - 0.02, z1 - 0.35], [x + 0.05, y1 + 0.01, z1 - 0.3], R() < 0.3 ? 'paintRed' : 'dark');
    },
    table(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, y1 - 0.04, z0], [x1, y1, z1], 'woodDark');
      for (const [a, b] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.1, z0 + 0.05], [x0 + 0.05, z1 - 0.1], [x1 - 0.1, z1 - 0.1]]) box([a, 0, b], [a + 0.05, y1 - 0.04, b + 0.05], 'steel');
      for (let i = 0; i < 5; i++) inst.papers.push([rr(x0 + 0.2, x1 - 0.2), y1 + 0.002 + i * 0.001, rr(z0 + 0.1, z1 - 0.2), R() * 3]);
    },
    rack(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const bays = Math.round((x1 - x0) / 2.5), bw = (x1 - x0) / bays;
      for (let i = 0; i <= bays; i++) {
        const x = x0 + i * bw - (i === bays ? 0.08 : 0);
        box([x, 0, z0], [x + 0.08, y1, z0 + 0.08], 'paintBlue'); box([x, 0, z1 - 0.08], [x + 0.08, y1, z1], 'paintBlue');
        for (let y = 0.4; y < y1; y += 0.9) box([x + 0.02, y, z0 + 0.08], [x + 0.06, y + 0.04, z1 - 0.08], 'paintBlue');
      }
      for (const y of [1.5, 3.0]) {
        box([x0, y, z0], [x1, y + 0.12, z0 + 0.06], 'paintRed'); box([x0, y, z1 - 0.06], [x1, y + 0.12, z1], 'paintRed');
        for (let i = 0; i < bays; i++) {
          if (R() < 0.25) continue;
          const bx = x0 + i * bw + 0.15;
          const cz = (z0 + z1) / 2;
          for (let k = 0; k < 2; k++) {
            const px = bx + k * (bw / 2);
            box([px, y + 0.12, cz - 0.4], [px + bw / 2 - 0.3, y + 0.26, cz + 0.4], 'wood', { tint: 0.85 });
            if (R() < 0.75) box([px + 0.05, y + 0.26, cz - 0.35], [px + bw / 2 - 0.35, y + 0.26 + rr(0.4, 1.1), cz + 0.35], R() < 0.5 ? 'cardboard' : 'wood', { tint: rr(0.7, 1) });
          }
        }
      }
    },
    forklift(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max, cx = (x0 + x1) / 2;
      box([x0 + 0.15, 0.25, z0 + 0.9], [x1 - 0.15, 1.1, z1], 'yellow');
      box([x0 + 0.15, 0.25, z1 - 0.5], [x1 - 0.15, 1.3, z1], 'dark');
      for (const [a, b] of [[x0 + 0.2, z0 + 0.95], [x1 - 0.25, z0 + 0.95], [x0 + 0.2, z1 - 0.65], [x1 - 0.25, z1 - 0.65]]) box([a, 1.1, b], [a + 0.05, y1, b + 0.05], 'dark');
      box([x0 + 0.2, y1 - 0.06, z0 + 0.95], [x1 - 0.2, y1, z1 - 0.6], 'dark');
      for (const dx of [-0.45, 0.4]) box([cx + dx, 0.05, z0 + 0.7], [cx + dx + 0.07, y1 + 0.2, z0 + 0.8], 'steel');
      for (const dx of [-0.35, 0.25]) box([cx + dx, 0.05, z0], [cx + dx + 0.1, 0.1, z0 + 0.75], 'steel');
      const wheel = (x, z, r) => B.pipe('rubber', [x, r, z], [x + 0.25, r, z], r, { segs: 14 });
      wheel(x0, z0 + 1.1, 0.3); wheel(x1 - 0.25, z0 + 1.1, 0.3); wheel(x0 + 0.05, z1 - 0.4, 0.25); wheel(x1 - 0.3, z1 - 0.4, 0.25);
      box([cx - 0.25, 1.1, z0 + 1.5], [cx + 0.25, 1.5, z0 + 1.9], 'dark');
    },
    container(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      const mat = p.min[2] > 0 ? 'paintRed' : 'paintBlue';
      box([x0 + 0.05, 0.05, z0 + 0.05], [x1 - 0.05, y1 - 0.05, z1 - 0.05], mat);
      for (let x = x0 + 0.25; x < x1 - 0.2; x += 0.28) {
        box([x, 0.15, z0], [x + 0.12, y1 - 0.15, z0 + 0.05], mat, { tint: 0.92 });
        box([x, 0.15, z1 - 0.05], [x + 0.12, y1 - 0.15, z1], mat, { tint: 0.92 });
      }
      for (const [a, b] of [[x0, z0], [x1 - 0.15, z0], [x0, z1 - 0.15], [x1 - 0.15, z1 - 0.15]]) box([a, 0, b], [a + 0.15, y1, b + 0.15], 'rust');
      box([x0, y1 - 0.12, z0], [x1, y1, z1], 'rust'); box([x0, 0, z0], [x1, 0.12, z1], 'rust');
      for (const dz of [0.6, 1.1, 1.5, 2.0]) box([x1, 0.2, z0 + dz - 0.03], [x1 + 0.05, y1 - 0.2, z0 + dz + 0.03], 'steel');
    },
    trailer(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 1.2, z0], [x1, y1, z1], 'paintGrey');
      box([x0 + 0.2, 0.9, z0], [x1 - 0.2, 1.2, z1 - 0.4], 'dark');
      box([x0 + 0.1, 1.25, z1], [(x0 + x1) / 2 - 0.01, y1 - 0.05, z1 + 0.04], 'paintGrey', { tint: 0.8 });
      box([(x0 + x1) / 2 + 0.01, 1.25, z1], [x1 - 0.1, y1 - 0.05, z1 + 0.04], 'paintGrey', { tint: 0.8 });
      for (const dx of [0.4, 1.0, 1.8, 2.4]) box([x0 + dx, 1.3, z1 + 0.04], [x0 + dx + 0.04, y1 - 0.1, z1 + 0.08], 'steel');
      for (const z of [z1 - 2.5, z1 - 3.6]) for (const x of [x0 + 0.1, x1 - 0.45]) B.pipe('rubber', [x, 0.5, z], [x + 0.35, 0.5, z], 0.5, { segs: 16 });
    },
    dumpster(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0 + 0.05, 0.1, z0 + 0.05], [x1 - 0.05, y1 - 0.05, z1 - 0.05], 'paint');
      box([x0, y1 - 0.15, z0], [x1, y1 - 0.05, z1], 'paint', { tint: 0.8 });
      const m = new THREE.Matrix4().makeRotationX(0.5).setPosition(x0, y1, z1);
      B.boxXf([0, 0, -(z1 - z0)], [x1 - x0, 0.03, 0], 'dark', m);
    },
    van(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0.45, z0], [x1, y1, z1 - 1.2], 'paintGrey');
      box([x0, 0.45, z1 - 1.2], [x1, y1 - 0.7, z1], 'paintGrey');
      box([x0 - 0.01, y1 - 1.1, z1 - 1.15], [x1 + 0.01, y1 - 0.75, z1 - 0.3], 'glassDark');
      for (const z of [z0 + 0.8, z1 - 0.9]) for (const x of [x0 - 0.02, x1 - 0.23]) B.pipe('rubber', [x, 0.38, z], [x + 0.25, 0.38, z], 0.38, { segs: 16 });
    },
    barrier(p) {
      const [x0, , z0] = p.min, [x1, y1, z1] = p.max;
      box([x0, 0, z0], [x1, 0.3, z1], 'concreteOut');
      box([x0, 0.3, z0 + 0.15], [x1, y1, z1 - 0.15], 'concreteOut');
    },
    railing(p) {
      const [ax, az] = p.from, [bx, bz] = p.to;
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 1.4));
      const yA = p.slope ? p.slope[0] : p.y, yB = p.slope ? p.slope[1] : p.y;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = yA + (yB - yA) * t;
        box([x - 0.03, y, z - 0.03], [x + 0.03, y + 1.05, z + 0.03], 'yellow');
      }
      for (const h of [0.5, 1.05]) B.pipe('yellow', [ax, yA + h, az], [bx, yB + h, bz], 0.025, { segs: 8 });
    },
  };

  for (const p of layout.props) builders[p.type]?.(p);

  // ---- doors: frames, open leaves, the loading door roller shutter
  for (const d of layout.doors) {
    const h = d.height, [a0, a1] = d.a, t0 = d.t0 - 0.02, t1 = d.t1 + 0.02, f = 0.06;
    if (d.axis === 'x') {
      box([a0, 0, t0], [a0 + f, h, t1], 'steel'); box([a1 - f, 0, t0], [a1, h, t1], 'steel'); box([a0, h - f, t0], [a1, h, t1], 'steel');
    } else {
      box([t0, 0, a0], [t1, h, a0 + f], 'steel'); box([t0, 0, a1 - f], [t1, h, a1], 'steel'); box([t0, h - f, a0], [t1, h, a1], 'steel');
    }
    if (d.leafBox) {
      box(d.leafBox.min, d.leafBox.max, 'rust');
    }
    if (d.shutter) {
      // rolled-up shutter hanging 1.2 m into the opening (well above head height), drum above
      const z = d.t0 - 0.12;
      for (let y = h - 1.2; y < h; y += 0.1) box([a0 + 0.05, y, z - 0.04], [a1 - 0.05, y + 0.09, z], 'corrugated', { tint: 0.85 + 0.1 * Math.sin(y * 7) });
      B.pipe('rust', [a0, h + 0.3, z - 0.2], [a1, h + 0.3, z - 0.2], 0.3, { segs: 14 });
      box([a0 - 0.15, 0, z - 0.1], [a0, h + 0.6, z], 'steel'); box([a1, 0, z - 0.1], [a1 + 0.15, h + 0.6, z], 'steel');
    }
  }
  // ---- window frames (mullions)
  for (const w of layout.windows) {
    const [x0, y0, z0] = w.min, [x1, y1, z1] = w.max, f = 0.05;
    if (w.normal === 'z') {
      const zc = (z0 + z1) / 2;
      box([x0, y0, zc - 0.03], [x1, y0 + f, zc + 0.03], 'steel'); box([x0, y1 - f, zc - 0.03], [x1, y1, zc + 0.03], 'steel');
      for (let x = x0; x <= x1 + 1e-3; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 0.75))) box([Math.min(x, x1 - f), y0, zc - 0.03], [Math.min(x + f, x1), y1, zc + 0.03], 'steel');
      if (y1 - y0 > 1.4) box([x0, (y0 + y1) / 2, zc - 0.03], [x1, (y0 + y1) / 2 + f, zc + 0.03], 'steel');
    } else {
      const xc = (x0 + x1) / 2;
      box([xc - 0.03, y0, z0], [xc + 0.03, y0 + f, z1], 'steel'); box([xc - 0.03, y1 - f, z0], [xc + 0.03, y1, z1], 'steel');
      for (let z = z0; z <= z1 + 1e-3; z += (z1 - z0) / Math.max(1, Math.round((z1 - z0) / 0.75))) box([xc - 0.03, y0, Math.min(z, z1 - f)], [xc + 0.03, y1, Math.min(z + f, z1)], 'steel');
      if (y1 - y0 > 1.4) box([xc - 0.03, (y0 + y1) / 2, z0], [xc + 0.03, (y0 + y1) / 2 + f, z1], 'steel');
    }
  }

  // ---- roof trusses, purlins, pipes, cable trays
  for (let z = -4.5; z < 15.6; z += 4) {
    box([-23.6, 7.55, z - 0.1], [7.8, 7.95, z + 0.1], 'steel');
    box([-23.6, 7.55, z - 0.04], [7.8, 7.6, z + 0.04], 'steel');
    for (let x = -21; x < 7.8; x += 3) {
      const m = new THREE.Matrix4().makeRotationZ(((Math.round(x) % 2) ? 1 : -1) * 0.55).setPosition(x, 7.0, z);
      B.boxXf([-0.04, 0, -0.04], [0.04, 0.9, 0.04], 'steel', m);
    }
    box([-23.6, 6.95, z - 0.08], [7.8, 7.05, z + 0.08], 'steel');
  }
  for (let x = -22; x < 7.8; x += 3.5) box([x - 0.05, 7.95, -5.8], [x + 0.05, 8.0, 15.6], 'steel');
  for (let z = -16; z < -6.2; z += 3.5) box([-23.6, 6.6, z - 0.1], [19.6, 6.95, z + 0.1], 'steel');
  // wall pipes (hall west + south, bay north)
  B.pipe('rust', [-23.3, 6.2, -5.8], [-23.3, 6.2, 15.3], 0.14);
  B.pipe('paint', [-23.1, 5.8, -5.8], [-23.1, 5.8, 15.3], 0.08);
  B.pipe('rust', [-23.3, 6.2, 15.3], [7.5, 6.2, 15.3], 0.14);
  B.pipe('rust', [7.5, 6.2, 15.3], [7.5, 0.4, 15.3], 0.14);
  B.pipe('paint', [-23.1, 5.8, 15.1], [-23.1, 0.3, 15.1], 0.08);
  B.pipe('rust', [-23.3, 5.6, -17.3], [19.3, 5.6, -17.3], 0.16);
  B.pipe('paintGrey', [-23.3, 5.2, -17.2], [19.3, 5.2, -17.2], 0.07);
  for (const x of [-12, 0, 12]) B.pipe('rust', [x, 5.6, -17.3], [x, 0.3, -17.3], 0.12);
  // corridor ceiling cable tray + pipes
  box([10.0, 2.85, -5.8], [10.45, 2.9, 15.6], 'steel');
  B.pipe('paintGrey', [8.45, 2.95, -5.8], [8.45, 2.95, 15.6], 0.06);
  B.pipe('rust', [8.65, 3.0, -5.8], [8.65, 3.0, 15.6], 0.05);
  // sagging cables between trusses (catenaries) — merged
  for (let i = 0; i < 9; i++) {
    const x0 = rr(-22, 6), z0 = rr(-5, 15), x1 = x0 + rr(-6, 6), z1 = z0 + rr(-4, 4);
    catenary(B, [x0, 7.5, z0], [Math.max(-23, Math.min(7.4, x1)), 7.5, Math.max(-5.5, Math.min(15.2, z1))], rr(0.6, 2.2));
  }
  for (let i = 0; i < 4; i++) {   // loose hanging cable ends
    const x = rr(-20, 5), z = rr(-4, 14);
    B.pipe('rubber', [x, 7.5, z], [x + rr(-0.2, 0.2), rr(3.8, 5.5), z + rr(-0.2, 0.2)], 0.012, { segs: 5 });
  }
  // floor cables / hoses
  for (const [a, b] of [[[-13, 12.7], [-18, 13.5]], [[3.2, 13.2], [0.5, 14.8]], [[-8, -9.4], [-11.5, -7.5]]]) {
    floorCable(B, a, b, R);
  }

  // ---- debris: concrete chunks, bricks, papers (instanced)
  const debrisSpots = [[-12.5, 5.5, 2.2], [-2, -2, 1.5], [-8, -12, 2], [8, -12, 2.5], [15, 2, 2], [-20, 9, 2], [9.4, 6, 1.0], [-5, 13.5, 2.0], [15, -10, 2], [-2, 19, 3], [10, 23, 4]];
  for (const [cx, cz, r] of debrisSpots) {
    const n = Math.round(r * 9);
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, d = Math.sqrt(R()) * r;
      inst.debris.push([cx + Math.cos(a) * d, cz + Math.sin(a) * d, rr(0.03, 0.14), R()]);
    }
    for (let i = 0; i < r * 2; i++) inst.papers.push([cx + rr(-r, r), 0.004 + R() * 0.004, cz + rr(-r, r), R() * 6]);
  }
  for (let i = 0; i < 40; i++) inst.bricks.push([rr(-15, -10), rr(3.5, 7.5), R()]);   // rubble under the roof hole

  return inst;
}

function catenary(B, a, b, sag) {
  const n = 10;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
    if (prev) B.pipe('rubber', prev, p, 0.015, { segs: 5, caps: false, rows: 2 });
    prev = p;
  }
}
function floorCable(B, a, b, R) {
  const n = 8;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = [a[0] + (b[0] - a[0]) * t + Math.sin(t * 9 + R()) * 0.25, 0.02, a[1] + (b[1] - a[1]) * t + Math.cos(t * 7) * 0.2];
    if (prev) B.pipe('rubber', prev, p, 0.02, { segs: 6, caps: false, rows: 2 });
    prev = p;
  }
}

// Instanced meshes for repeated small props.
export function buildInstanced(inst, mats, scales) {
  const out = [];
  const local = (fn) => { const b = new Batcher(scales, () => [1, 1, 1]); fn(b); return b.build(); };
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  if (inst.barrels.length) {
    const g = local((b) => {
      b.cylinder('barrel', [0, 0, 0], 0.29, 0.88, { segs: 20, rows: 4 });
      for (const y of [0.0, 0.29, 0.58, 0.86]) b.cylinder('barrel', [0, y, 0], 0.3, 0.025, { segs: 20, caps: false });
    }).get('barrel');
    const m = new THREE.InstancedMesh(g, mats.barrel, inst.barrels.length);
    inst.barrels.forEach((it, i) => {
      dummy.position.set(it.pos[0], 0, it.pos[2]); dummy.rotation.set(0, it.rot, 0); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); m.setColorAt(i, col.setRGB(...it.color));
    });
    out.push(tag(m, 'metal'));
  }
  if (inst.rollers.length) {
    const g = local((b) => b.pipe('steel', [0, 0, -0.5], [0, 0, 0.5], 0.045, { segs: 10 })).get('steel');
    const m = new THREE.InstancedMesh(g, mats.steel, inst.rollers.length);
    inst.rollers.forEach(([x, y, z, len], i) => {
      dummy.position.set(x, y, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, len); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    out.push(tag(m, 'metal'));
  }
  if (inst.debris.length) {
    const g = local((b) => b.box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 'ceiling', { seg: 2 })).get('ceiling');
    const m = new THREE.InstancedMesh(g, mats.ceiling, inst.debris.length);
    const R = rng(99);
    inst.debris.forEach(([x, z, s, r], i) => {
      dummy.position.set(x, s * 0.3, z); dummy.rotation.set(R() * 3, r * 6, R() * 3);
      dummy.scale.set(s * (0.8 + R()), s * (0.5 + R() * 0.6), s * (0.8 + R())); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); const k = 0.6 + R() * 0.5; m.setColorAt(i, col.setRGB(k, k * 0.98, k * 0.95));
    });
    m.castShadow = false;
    out.push(tag(m, 'concrete', false));
  }
  if (inst.bricks.length) {
    const g = local((b) => b.box([-0.11, -0.035, -0.055], [0.11, 0.035, 0.055], 'brick', { seg: 1 })).get('brick');
    const m = new THREE.InstancedMesh(g, mats.brickIn, inst.bricks.length);
    inst.bricks.forEach(([x, z, r], i) => {
      dummy.position.set(x, 0.035, z); dummy.rotation.set(0, r * 6, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    out.push(tag(m, 'concrete', false));
  }
  if (inst.papers.length) {
    const g = new THREE.PlaneGeometry(0.21, 0.297).rotateX(-Math.PI / 2);
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count * 3).fill(1), 3));
    const m = new THREE.InstancedMesh(g, mats.paper, inst.papers.length);
    const R = rng(5);
    inst.papers.forEach(([x, y, z, r], i) => {
      dummy.position.set(x, y, z); dummy.rotation.set((R() - 0.5) * 0.08, r, (R() - 0.5) * 0.08); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix); const k = 0.45 + R() * 0.55; m.setColorAt(i, col.setRGB(k, k * 0.97, k * 0.88));
    });
    m.castShadow = false;
    out.push(tag(m, 'wood', false));
  }
  return out;
}

function tag(m, surface, cast = true) {
  m.userData.surface = surface;
  m.castShadow = cast; m.receiveShadow = true;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere?.();
  return m;
}

export { v3 };
