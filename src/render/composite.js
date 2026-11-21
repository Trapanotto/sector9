// THE single full-screen post pass: fisheye resample + chromatic aberration + (tier) mip bloom + tone mapping
// with blown highlights + grade + compression artefacts + resolution-independent sensor noise + vignette +
// burned-in OSD + output encoding. Owner: B (look). Exposure is already applied in the scene shaders.
import * as THREE from 'three';

export function createCompositeMaterial() {
  return new THREE.ShaderMaterial({
    name: 'S9Composite',
    depthTest: false, depthWrite: false,
    uniforms: {
      tScene: { value: null }, tOsd: { value: null },
      uScale: { value: new THREE.Vector2(1, 1) },         // used fraction of the scene target (dynamic res)
      uRes: { value: new THREE.Vector2(1280, 720) },      // output pixels
      uSrcRes: { value: new THREE.Vector2(1280, 720) },   // internal pixels
      uAspect: { value: 16 / 9 },
      uTanHalfV: { value: 0.9 },                          // source camera tan(vfov/2)
      uFish: { value: 0.7 },                              // 0 = rectilinear, 1 = equidistant fisheye
      uCA: { value: 0.004 },
      uBloom: { value: 0 }, uBloomLod: { value: 3 },
      uNoise: { value: 0.06 }, uGain: { value: 1 },       // gain: 1 = normal light, higher = darker scene (more grain)
      uCompress: { value: 1 }, uMotion: { value: new THREE.Vector2() },
      uTime: { value: 0 }, uFrame: { value: 0 },
      uVignette: { value: 1 },
      uOsdRect: { value: new THREE.Vector4(0, 0, 0, 0) }, // x, y, w, h in output pixels (from top-left)
      uFlashWhite: { value: 0 },                          // full-frame flash (muzzle / damage) 0..1
      uTint: { value: new THREE.Vector3(0, 0, 0) },       // additive grade tint (damage red etc.)
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tScene, tOsd;
      uniform vec2 uScale, uRes, uSrcRes, uMotion;
      uniform float uAspect, uTanHalfV, uFish, uCA, uBloom, uBloomLod, uNoise, uGain, uCompress, uTime, uFrame, uVignette, uFlashWhite;
      uniform vec4 uOsdRect;
      uniform vec3 uTint;
      varying vec2 vUv;

      float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

      // output ndc (-1..1) → source uv (0..1 of the used viewport); also returns the radial factor
      vec2 fishUv(vec2 ndc, out float rr) {
        vec2 p = ndc * vec2(uAspect, 1.0);
        float r = length(p);
        float thetaEdge = atan(uTanHalfV * uAspect);
        float theta = r * thetaEdge / uAspect;
        float rs = tan(min(theta, 1.45)) / uTanHalfV;
        float rm = mix(r, rs, uFish);
        vec2 q = r > 1e-5 ? p * (rm / r) : p;
        rr = rm;
        return (q / vec2(uAspect, 1.0)) * 0.5 + 0.5;
      }
      vec3 src(vec2 uv) { return texture(tScene, clamp(uv, vec2(0.0005), vec2(0.9995)) * uScale).rgb; }

      vec3 tonemap(vec3 x) {
        // hard-shouldered exponential curve: bright windows and sky clip to white like a small sensor
        vec3 t = 1.0 - exp(-x * 1.35);
        float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
        t = mix(t, vec3(l), smoothstep(0.75, 1.0, l) * 0.6);   // clipped highlights lose colour
        return t;
      }

      void main() {
        vec2 frag = vUv * uRes;
        float s720 = uRes.y / 720.0;
        vec2 ndc = vUv * 2.0 - 1.0;
        float rr;
        vec2 uv = fishUv(ndc, rr);

        // compression: 8x8 (720p-equivalent) macroblocks, smeared during fast camera motion
        vec2 blk = floor(frag / (8.0 * s720));
        float bh = hash12(blk + floor(uTime * 7.0));
        vec2 mo = uMotion * step(0.55, bh) * uCompress;
        uv -= mo * 0.004;

        // chromatic aberration grows towards the edge
        float ca = uCA * rr * rr;
        vec2 dir = uv - 0.5;
        vec3 col;
        col.r = src(uv + dir * ca).r;
        col.g = src(uv).g;
        col.b = src(uv - dir * ca).b;

        if (uBloom > 0.0) {
          vec2 suv = clamp(uv, vec2(0.002), vec2(0.998)) * uScale;
          vec3 b = textureLod(tScene, suv, uBloomLod).rgb * 0.6 + textureLod(tScene, suv, uBloomLod + 2.0).rgb * 0.4;
          col += max(b - 0.9, 0.0) * uBloom;
        }

        // chroma subsampled per block (blocky colour like a low-bitrate stream)
        vec2 bc = (blk + 0.5) * 8.0 * s720 / uRes * 2.0 - 1.0;
        float rb; vec3 cb = src(fishUv(bc, rb) - mo * 0.004);
        vec3 t = tonemap(col), tb = tonemap(cb);
        float Y = dot(t, vec3(0.299, 0.587, 0.114));
        vec2 C = vec2(dot(t, vec3(-0.169, -0.331, 0.5)), dot(t, vec3(0.5, -0.419, -0.081)));
        vec2 Cb = vec2(dot(tb, vec3(-0.169, -0.331, 0.5)), dot(tb, vec3(0.5, -0.419, -0.081)));
        C = mix(C, Cb, 0.55 * uCompress);
        // luma quantisation varies per block (banding in flat dark areas)
        float q = mix(40.0, 110.0, bh);
        Y = mix(Y, floor(Y * q + 0.5) / q, 0.6 * uCompress * (1.0 - smoothstep(0.2, 0.6, Y)));

        // sensor noise: grain on a 720p-equivalent pixel grid, stronger when the camera gains up in the dark
        vec2 gp = floor(frag / s720);
        float n1 = hash12(gp + fract(uTime * 13.17) * 311.0) - 0.5;
        float n2 = hash12(gp.yx + fract(uTime * 7.31) * 173.0) - 0.5;
        float amt = uNoise * (0.7 + 0.5 * min(uGain, 3.0)) * (0.35 + 0.65 * (1.0 - Y));
        Y += n1 * amt;
        C += vec2(n2, n1 * 0.7) * amt * 0.35;

        // grade: slightly desaturated, cool shadows / neutral highlights
        C *= 0.82;
        C += vec2(0.012, -0.006) * (1.0 - Y);
        vec3 rgb = vec3(Y + 1.402 * C.y, Y - 0.344 * C.x - 0.714 * C.y, Y + 1.772 * C.x);
        rgb = clamp(rgb, 0.0, 1.0);
        rgb = rgb * rgb * (3.0 - 2.0 * rgb) * 0.25 + rgb * 0.75;   // gentle S-curve

        // lens vignette + hard black outside the source image
        vec2 su = uv - 0.5;
        float edge = max(abs(su.x), abs(su.y));
        float vig = 1.0 - uVignette * 0.55 * smoothstep(0.55, 1.45, length(ndc * vec2(1.0, 0.9)));
        vig *= 1.0 - smoothstep(0.47, 0.5, edge);
        rgb *= vig;
        rgb = mix(rgb, vec3(1.0), uFlashWhite);
        rgb += uTint;

        // burned-in OSD (white text with dark outline, compressed with the image)
        vec2 op = vec2(frag.x, uRes.y - frag.y) - uOsdRect.xy;
        if (op.x >= 0.0 && op.y >= 0.0 && op.x < uOsdRect.z && op.y < uOsdRect.w) {
          vec4 o = texture(tOsd, vec2(op.x / uOsdRect.z, 1.0 - op.y / uOsdRect.w));
          rgb = mix(rgb * (1.0 - o.a * 0.5), vec3(0.92), o.r);
        }

        // output: gamma + dither
        rgb = pow(rgb, vec3(1.0 / 2.2));
        rgb += (hash12(frag + uFrame) - 0.5) / 255.0;
        gl_FragColor = vec4(rgb, 1.0);
      }`,
  });
}
