// The ONE material of the world art (static props + machines): B's dynamic material (probe-volume lighting,
// flashlight, muzzle, fog, exposure — src/render/materials.js) with the art atlas as its map, extended through
// onBeforeCompile by the art vertex format (kit.js):
//   aTile  atlas rect per vertex → uv (in tile units) repeats inside its tile (textureGrad keeps mips seamless)
//   aArt   rgb = tint × baked AO, a = emissive×16 | 200+k: conveyor belt k (uv.v scrolls with uBelt[k])
//   alpha  atlas alpha < 0.5 is cut out (pallet openings, rack lacing, wire decks, mesh)
// Skinned meshes (machines) use the same material: three compiles the skinning variant automatically.
import * as THREE from 'three';
import { createDynamicMaterial } from '../../render/materials.js';

export const MAX_BELTS = 4;

const V_DECL = /* glsl */`
attribute vec4 aTile; attribute vec4 aArt;
uniform float uBelt[${MAX_BELTS}];
varying vec4 vTile; varying vec3 vArtC; varying float vEmit;
`;
const V_MAIN = /* glsl */`
  vTile = aTile; vArtC = aArt.rgb;
  float aflag = aArt.a * 255.0;
  vEmit = aflag < 199.5 ? aflag / 16.0 : 0.0;
  if (aflag > 199.5) { int bi = int(aflag - 199.5); for (int k = 0; k < ${MAX_BELTS}; k++) if (k == bi) vUv.y += uBelt[k]; }
`;
const F_DECL = /* glsl */`
varying vec4 vTile; varying vec3 vArtC; varying float vEmit;
`;
const F_MAP = /* glsl */`
  vec2 tUv = vTile.xy + fract(vUv) * vTile.zw;
  vec4 tTex = textureGrad(uMap, tUv, dFdx(vUv) * vTile.zw, dFdy(vUv) * vTile.zw);
  if (tTex.a < 0.5) discard;
  albedo *= tTex.rgb * vArtC;
`;

function patch(src, find, repl, what) {
  if (!src.includes(find)) { console.error(`[art] material patch failed (${what}): materials.js changed?`); return src; }
  return src.replace(find, repl);
}

export function createArtMaterial(atlas) {
  const m = createDynamicMaterial({ map: atlas, probe: 'volume', color: [1, 1, 1] });
  m.name = 'S9Art';
  m.uniforms.uBelt = { value: new Float32Array(MAX_BELTS) };
  m.onBeforeCompile = (sh) => {
    let v = sh.vertexShader, f = sh.fragmentShader;
    v = patch(v, 'void main() {', `${V_DECL}\nvoid main() {`, 'vertex decl');
    v = patch(v, 'vUv = uv;', `vUv = uv;\n${V_MAIN}`, 'vertex main');
    f = patch(f, 'void main() {', `${F_DECL}\nvoid main() {`, 'fragment decl');
    f = patch(f, 'albedo *= texture(uMap, vUv).rgb;', F_MAP, 'fragment map');
    f = patch(f, '+ uEmissive;', '+ uEmissive + albedo * vEmit * 4.0;', 'fragment emissive');
    sh.vertexShader = v; sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => 'S9Art-v1';
  return m;
}

/** atlas texture from the painted canvas */
export function createAtlasTexture(canvas, renderer) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  t.flipY = true;
  t.name = 'artAtlas';
  return t;
}

/** BufferGeometry from a kit Builder (shared vertex buffer; index filled by the caller) */
export function geometryFromBuilder(b) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.pos.view().slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.nrm.view().slice(), 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(b.uv.view().slice(), 2));
  g.setAttribute('aTile', new THREE.BufferAttribute(b.tile.view().slice(), 4, true));
  g.setAttribute('aArt', new THREE.BufferAttribute(b.art.view().slice(), 4, true));
  if (b.skin) {
    g.setAttribute('skinIndex', new THREE.BufferAttribute(b.skin.view().slice(), 4));
    const n = b.vcount, w = new Uint8Array(n * 4); for (let i = 0; i < n; i++) w[i * 4] = 255;
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4, true));
  }
  return g;
}
