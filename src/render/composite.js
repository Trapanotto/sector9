// THE single full-screen post pass: fisheye resample + lateral chromatic aberration + (tier) mip bloom + sensor
// response (hard highlight clip with a short soft knee, per-channel so clipped light goes white) + neutral grade
// + codec artefacts (macroblock DC drift, banding and chroma quantisation in dark flat areas, motion smear) +
// exposure-gain-dependent sensor noise + vignette + burned-in OSD + output encoding. Owner: B (look).
// Exposure is already applied in the scene shaders.
//
// Cost (low tiers): 2 scene-texture taps per output pixel (R / GB of the chromatic aberration), ~60 ALU ops,
// no dependent branches except the OSD rectangle. mid/high add 2 mip taps for bloom (uniform-gated).
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
      uFish: { value: 0.72 },                             // 0 = rectilinear, 1 = equidistant fisheye
      uCA: { value: 0.0035 },
      uBloom: { value: 0 }, uBloomLod: { value: 3 },
      uNoise: { value: 0.05 }, uGain: { value: 0 },       // gain: stops of sensor gain above a lit interior
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

      // output ndc (-1..1) → source uv (0..1 of the used viewport); rr = radial distance in source units
      vec2 fishUv(vec2 ndc, out float rr) {
        vec2 p = ndc * vec2(uAspect, 1.0);
        float r = length(p);
        float thetaEdge = atan(uTanHalfV * uAspect);
        float theta = r * thetaEdge / uAspect;
        float rs = tan(min(theta, 1.45)) / uTanHalfV;
        float rm = mix(r, rs, uFish);
        vec2 q = p * (rm / max(r, 1e-5));
        rr = rm;
        return (q / vec2(uAspect, 1.0)) * 0.5 + 0.5;
      }
      vec3 src(vec2 uv) { return texture(tScene, clamp(uv, vec2(0.0005), vec2(0.9995)) * uScale).rgb; }

      // small-sensor response: linear up to a short knee, then a hard clip ~3.5 stops above mid grey
      vec3 sensor(vec3 x) {
        x *= 1.15;
        vec3 x2 = x * x;
        return x * inversesqrt(sqrt(1.0 + x2 * x2));   // x / (1 + x^4)^(1/4): monotonic, knee, clips at 1
      }

      void main() {
        vec2 frag = vUv * uRes;
        float s720 = uRes.y / 720.0;
        vec2 ndc = vUv * 2.0 - 1.0;
        float rr;
        vec2 uv = fishUv(ndc, rr);

        // compression: 8×8 (720p-equivalent) macroblocks; some smear along the camera motion
        vec2 blk = floor(frag / (8.0 * s720));
        float bh = hash12(blk + floor(uTime * 7.0));
        uv -= uMotion * (step(0.55, bh) * uCompress * 0.004);

        // lateral chromatic aberration (red outwards, green/blue inwards), grows towards the edge: 2 taps
        vec2 dir = (uv - 0.5) * (uCA * rr * rr);
        vec3 a = src(uv + dir), b = src(uv - dir * 0.6);
        vec3 col = vec3(a.r, b.g, b.b * 0.85 + a.b * 0.15);

        if (uBloom > 0.0) {
          vec2 suv = clamp(uv, vec2(0.002), vec2(0.998)) * uScale;
          vec3 bl = textureLod(tScene, suv, uBloomLod).rgb * 0.6 + textureLod(tScene, suv, uBloomLod + 2.0).rgb * 0.4;
          col += max(bl - 0.9, 0.0) * uBloom;   // halation around blown highlights only
        }

        vec3 t = clamp(sensor(col), 0.0, 1.0);
        t = pow(t, vec3(1.0 / 2.2));
        float Y = dot(t, vec3(0.299, 0.587, 0.114));
        vec2 C = vec2(dot(t, vec3(-0.169, -0.331, 0.5)), dot(t, vec3(0.5, -0.419, -0.081)));

        // codec: per-macroblock DC drift + coarse luma steps + chroma quantisation, only in dark flat areas
        float dark = 1.0 - smoothstep(0.12, 0.45, Y);
        float q = mix(36.0, 90.0, bh);
        Y = mix(Y, floor(Y * q + 0.5) / q, 0.7 * uCompress * dark);
        Y += (bh - 0.5) * 0.018 * uCompress * dark;
        C = mix(C, floor(C * 40.0 + 0.5) / 40.0, 0.6 * uCompress * dark);

        // sensor noise on a 720p-equivalent grid: grows with exposure gain, strongest in the shadows
        vec2 gp = floor(frag / s720);
        float n1 = hash12(gp + fract(uTime * 13.17) * 311.0) - 0.5;
        float n2 = hash12(gp.yx + fract(uTime * 7.31) * 173.0) - 0.5;
        float amt = uNoise * (0.45 + 0.5 * min(uGain, 5.0)) * (0.3 + 0.9 * (1.0 - Y) * (1.0 - Y));
        Y += n1 * amt;
        C += vec2(n2, n1 * 0.6) * (amt * 0.3);

        // grade: neutral, slightly muted colour, firm blacks (no lift, no tint)
        C *= 0.9;
        Y = max(Y - 0.012, 0.0) * 1.013;
        float Yc = clamp(Y, 0.0, 1.0); Y = mix(Y, Yc * Yc * (3.0 - 2.0 * Yc), 0.3);   // gentle S-curve: denser shadows, punchier mids
        vec3 rgb = vec3(Y + 1.402 * C.y, Y - 0.344 * C.x - 0.714 * C.y, Y + 1.772 * C.x);
        rgb = clamp(rgb, 0.0, 1.0);

        // lens vignette + hard black outside the source image
        vec2 su = uv - 0.5;
        float edge = max(abs(su.x), abs(su.y));
        float vig = 1.0 - uVignette * 0.5 * smoothstep(0.5, 1.45, length(ndc * vec2(1.0, 0.9)));
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

        rgb += (hash12(frag + uFrame) - 0.5) / 255.0;   // dither
        gl_FragColor = vec4(rgb, 1.0);
      }`,
  });
}
