// Global lighting patch for every lit three.js material (Standard/Physical, Lambert, Phong), static or dynamic:
//  - indirect diffuse from the baked irradiance volume (L1 SH, 3D textures) instead of the flat sky environment
//  - indirect specular from local, box-projected reflection probes (one PMREM'd cube per zone in a texture array),
//    normalised by the local GI so dark corners do not reflect a bright room
//  - static high-resolution sun shadow (rendered once) multiplied into the sun, on top of three's per-frame
//    shadow map which only contains moving objects
//  - analytic fluorescent tube lights (line lights with room clipping, flicker-driven bounce fill)
//  - fog lit by the irradiance volume, denser in the halls than in the offices
// The patch is installed on the material prototypes, so materials created later by other modules get it too;
// materials with their own onBeforeCompile are wrapped by adoptMaterial()/adoptScene().
import * as THREE from 'three';

export const MAX_TUBES = 16;
export const MAX_REFL = 10;
export const REFL_CUBE = 128;   // per-face size of each reflection probe
const REFL_W = 3 * Math.max(REFL_CUBE, 16 * 7), REFL_H = 4 * REFL_CUBE, REFL_MIP = Math.log2(REFL_CUBE);

const v3 = () => new THREE.Vector3();
export const LP = {
  // irradiance volume
  lpGIR: { value: null }, lpGIG: { value: null }, lpGIB: { value: null },
  lpGIScale: { value: v3() }, lpGIOffset: { value: v3() }, lpGIMin: { value: v3() }, lpGIMax: { value: v3() },
  lpGIOn: { value: 0 }, lpGIBias: { value: 0.32 }, lpGIGain: { value: 1.4 }, lpSkyGain: { value: 1.0 },
  // reflection probes
  lpRefl: { value: null }, lpReflCount: { value: 0 }, lpReflOn: { value: 0 }, lpSpecGain: { value: 1.0 },
  lpReflMin: { value: Array.from({ length: MAX_REFL }, v3) }, lpReflMax: { value: Array.from({ length: MAX_REFL }, v3) },
  lpReflPos: { value: Array.from({ length: MAX_REFL }, v3) }, lpReflNorm: { value: new Array(MAX_REFL).fill(1) },
  lpReflFade: { value: 0.6 },
  // static sun shadow
  lpSunMap: { value: null }, lpSunMatrix: { value: new THREE.Matrix4() }, lpSunTo: { value: v3() }, lpSunOn: { value: 0 },
  lpSunTexel: { value: 1 / 4096 }, lpSunNBias: { value: 0.035 }, lpSunBias: { value: 0.0006 }, lpSunSoft: { value: 1.2 },
  // tube lights
  lpTubeA: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector4()) },
  lpTubeB: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector4()) },
  lpTubeC: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector4()) },
  lpTubeMin: { value: Array.from({ length: MAX_TUBES }, v3) }, lpTubeMax: { value: Array.from({ length: MAX_TUBES }, v3) },
  lpTubeCount: { value: 0 }, lpTubeFill: { value: 0.16 },
  // fog
  lpFogHallMin: { value: new THREE.Vector3(-23.6, -1, -17.6) }, lpFogHallMax: { value: new THREE.Vector3(7.8, 8.0, 15.6) },
  lpFogRoomMin: { value: new THREE.Vector3(8.2, -1, -5.8) }, lpFogRoomMax: { value: new THREE.Vector3(19.6, 3.2, 15.6) },
  lpFogMul: { value: new THREE.Vector3(0.75, 1.5, 0.75) },   // outside, halls, offices
  lpFogAlbedo: { value: 0.9 }, lpFogGI: { value: 1.0 },
};

// ------------------------------------------------------------------------------------------------ GLSL
const PARS = /* glsl */`
#ifndef LP_PARS
#define LP_PARS
#define LP_MAX_TUBES ${MAX_TUBES}
#define LP_MAX_REFL ${MAX_REFL}
#define LPC_TEXEL_W ${(1 / REFL_W).toFixed(10)}
#define LPC_TEXEL_H ${(1 / REFL_H).toFixed(10)}
#define LPC_MAX_MIP ${REFL_MIP.toFixed(1)}
uniform highp sampler3D lpGIR; uniform highp sampler3D lpGIG; uniform highp sampler3D lpGIB;
uniform vec3 lpGIScale; uniform vec3 lpGIOffset; uniform vec3 lpGIMin; uniform vec3 lpGIMax;
uniform float lpGIOn; uniform float lpGIBias; uniform float lpGIGain; uniform float lpSkyGain;
uniform highp sampler2DArray lpRefl; uniform int lpReflCount; uniform float lpReflOn; uniform float lpSpecGain;
uniform vec3 lpReflMin[ LP_MAX_REFL ]; uniform vec3 lpReflMax[ LP_MAX_REFL ]; uniform vec3 lpReflPos[ LP_MAX_REFL ];
uniform float lpReflNorm[ LP_MAX_REFL ]; uniform float lpReflFade;
uniform highp sampler2DShadow lpSunMap; uniform mat4 lpSunMatrix; uniform vec3 lpSunTo; uniform float lpSunOn;
uniform float lpSunTexel; uniform float lpSunNBias; uniform float lpSunBias; uniform float lpSunSoft;
uniform vec4 lpTubeA[ LP_MAX_TUBES ]; uniform vec4 lpTubeB[ LP_MAX_TUBES ]; uniform vec4 lpTubeC[ LP_MAX_TUBES ];
uniform vec3 lpTubeMin[ LP_MAX_TUBES ]; uniform vec3 lpTubeMax[ LP_MAX_TUBES ]; uniform int lpTubeCount; uniform float lpTubeFill;
uniform vec3 lpFogHallMin; uniform vec3 lpFogHallMax; uniform vec3 lpFogRoomMin; uniform vec3 lpFogRoomMax;
uniform vec3 lpFogMul; uniform float lpFogAlbedo; uniform float lpFogGI;

vec3 lpWorldPos() { return ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz + cameraPosition; }
vec3 lpToWorld( vec3 v ) { return ( vec4( v, 0.0 ) * viewMatrix ).xyz; }
float lpLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

float lpGIWeight( vec3 P ) {
	vec3 d = max( lpGIMin - P, P - lpGIMax );
	return lpGIOn * ( 1.0 - smoothstep( 0.0, 1.5, max( d.x, max( d.y, d.z ) ) ) );
}
// Fetch the three channel vectors (c0, c1) of the irradiance volume around P (biased along N).
void lpGIFetch( vec3 P, vec3 N, out vec4 r, out vec4 g, out vec4 b ) {
	vec3 uvw = ( P + N * lpGIBias ) * lpGIScale + lpGIOffset;
	r = texture( lpGIR, uvw ); g = texture( lpGIG, uvw ); b = texture( lpGIB, uvw );
}
vec3 lpSHEval( vec4 r, vec4 g, vec4 b, vec3 N ) {
	vec4 n4 = vec4( 1.0, N );
	return max( vec3( dot( r, n4 ), dot( g, n4 ), dot( b, n4 ) ), vec3( 0.0 ) );
}

// ---- static sun shadow (hardware PCF, 3x3 bilinear taps)
float lpSunShadowAt( vec3 P, vec3 Ng ) {
	if ( lpSunOn < 0.5 ) return 1.0;
	float ndl = dot( Ng, lpSunTo );
	vec3 Pb = P + Ng * lpSunNBias * ( 1.0 + 2.0 * ( 1.0 - abs( ndl ) ) );
	vec4 sc = lpSunMatrix * vec4( Pb, 1.0 );
	if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;
	float z = sc.z - lpSunBias;
	float t = lpSunTexel * lpSunSoft;
	float s = 0.0;
	s += texture( lpSunMap, vec3( sc.xy + vec2( -t, -t ), z ) );
	s += texture( lpSunMap, vec3( sc.xy + vec2( 0.0, -t ), z ) );
	s += texture( lpSunMap, vec3( sc.xy + vec2( t, -t ), z ) );
	s += texture( lpSunMap, vec3( sc.xy + vec2( -t, 0.0 ), z ) );
	s += texture( lpSunMap, vec3( sc.xy, z ) ) * 2.0;
	s += texture( lpSunMap, vec3( sc.xy + vec2( t, 0.0 ), z ) );
	s += texture( lpSunMap, vec3( sc.xy + vec2( -t, t ), z ) );
	s += texture( lpSunMap, vec3( sc.xy + vec2( 0.0, t ), z ) );
	s += texture( lpSunMap, vec3( sc.xy + vec2( t, t ), z ) );
	return s * 0.1;
}
// Applied inside three's directional-light loop; only the light pointing along lpSunTo is the sun.
float lpSunFactor( vec3 dirView, vec3 ngView ) {
	if ( lpSunOn < 0.5 || dot( lpToWorld( dirView ), lpSunTo ) < 0.995 ) return 1.0;
	return lpSunShadowAt( lpWorldPos(), normalize( lpToWorld( ngView ) ) );
}

// ---- reflection probes (PMREM cube-UV layout, one probe per array layer)
float lpFace( vec3 d ) {
	vec3 a = abs( d );
	if ( a.x > a.z ) { if ( a.x > a.y ) return d.x > 0.0 ? 0.0 : 3.0; return d.y > 0.0 ? 1.0 : 4.0; }
	if ( a.z > a.y ) return d.z > 0.0 ? 2.0 : 5.0;
	return d.y > 0.0 ? 1.0 : 4.0;
}
vec2 lpFaceUV( vec3 d, float f ) {
	vec2 uv;
	if ( f == 0.0 ) uv = vec2( d.z, d.y ) / abs( d.x );
	else if ( f == 1.0 ) uv = vec2( - d.x, - d.z ) / abs( d.y );
	else if ( f == 2.0 ) uv = vec2( - d.x, d.y ) / abs( d.z );
	else if ( f == 3.0 ) uv = vec2( - d.z, d.y ) / abs( d.x );
	else if ( f == 4.0 ) uv = vec2( - d.x, d.z ) / abs( d.y );
	else uv = vec2( d.x, d.y ) / abs( d.z );
	return 0.5 * ( uv + 1.0 );
}
vec3 lpBilinear( float layer, vec3 d, float mipInt ) {
	float face = lpFace( d );
	float filterInt = max( 4.0 - mipInt, 0.0 );
	mipInt = max( mipInt, 4.0 );
	float faceSize = exp2( mipInt );
	highp vec2 uv = lpFaceUV( d, face ) * ( faceSize - 2.0 ) + 1.0;
	if ( face > 2.0 ) { uv.y += faceSize; face -= 3.0; }
	uv.x += face * faceSize;
	uv.x += filterInt * 3.0 * 16.0;
	uv.y += 4.0 * ( exp2( LPC_MAX_MIP ) - faceSize );
	uv.x *= LPC_TEXEL_W; uv.y *= LPC_TEXEL_H;
	return textureGrad( lpRefl, vec3( uv, layer ), vec2( 0.0 ), vec2( 0.0 ) ).rgb;
}
float lpRoughToMip( float r ) {
	if ( r >= 0.8 ) return ( 1.0 - r ) * ( 1.0 ) / 0.2 - 2.0;
	if ( r >= 0.4 ) return ( 0.8 - r ) * 3.0 / 0.4 - 1.0;
	if ( r >= 0.305 ) return ( 0.4 - r ) / 0.095 + 2.0;
	if ( r >= 0.21 ) return ( 0.305 - r ) / 0.095 + 3.0;
	return - 2.0 * log2( 1.16 * r );
}
vec3 lpCube( float layer, vec3 d, float rough ) {
	float mip = clamp( lpRoughToMip( rough ), - 2.0, LPC_MAX_MIP );
	float mf = fract( mip ), mi = floor( mip );
	vec3 c0 = lpBilinear( layer, d, mi );
	if ( mf == 0.0 ) return c0;
	return mix( c0, lpBilinear( layer, d, mi + 1.0 ), mf );
}
vec3 lpBoxDir( vec3 P, vec3 R, vec3 bmin, vec3 bmax, vec3 c ) {
	vec3 t1 = ( bmax - P ) / R, t2 = ( bmin - P ) / R;
	vec3 tf = max( t1, t2 );
	float t = min( min( tf.x, tf.y ), tf.z );
	return t > 0.0 ? normalize( P + R * t - c ) : R;
}
// Blend of the zone probes containing P; probe 0 is the outdoor default (fills the remaining weight).
vec3 lpLocalRadiance( vec3 P, vec3 R, float rough, float localLum ) {
	vec3 acc = vec3( 0.0 );
	float wsum = 0.0;
	for ( int i = 1; i < LP_MAX_REFL; i ++ ) {
		if ( i >= lpReflCount ) break;
		vec3 dmin = P - lpReflMin[ i ], dmax = lpReflMax[ i ] - P;
		float inside = min( min( min( dmin.x, dmin.y ), dmin.z ), min( min( dmax.x, dmax.y ), dmax.z ) );
		float w = smoothstep( - lpReflFade, lpReflFade, inside ) * ( 1.0 - wsum );
		if ( w <= 0.001 ) continue;
		vec3 d = lpBoxDir( P, R, lpReflMin[ i ], lpReflMax[ i ], lpReflPos[ i ] );
		float k = clamp( localLum / max( lpReflNorm[ i ], 1e-4 ), 0.04, 1.6 );
		acc += lpCube( float( i ), d, rough ) * ( w * k );
		wsum += w;
		if ( wsum > 0.995 ) break;
	}
	if ( wsum < 0.995 ) {
		vec3 d = lpBoxDir( P, R, lpReflMin[ 0 ], lpReflMax[ 0 ], lpReflPos[ 0 ] );
		float k = clamp( localLum / max( lpReflNorm[ 0 ], 1e-4 ), 0.04, 1.6 );
		acc += lpCube( 0.0, d, rough ) * ( ( 1.0 - wsum ) * k );
	}
	return acc;
}

// ---- fluorescent tubes as line lights (Karis' tube approximation), clipped to their room.
float lpTubeClip( int i, vec3 P ) {
	vec3 dmin = P - lpTubeMin[ i ], dmax = lpTubeMax[ i ] - P;
	float inside = min( min( min( dmin.x, dmin.y ), dmin.z ), min( min( dmax.x, dmax.y ), dmax.z ) );
	return smoothstep( - 0.35, 0.1, inside );
}

// ---- fog density by zone (sampled at the middle of the view ray)
float lpInBox( vec3 P, vec3 a, vec3 b, float soft ) {
	vec3 dmin = P - a, dmax = b - P;
	float inside = min( min( min( dmin.x, dmin.y ), dmin.z ), min( min( dmax.x, dmax.y ), dmax.z ) );
	return smoothstep( - soft, soft, inside );
}
#endif
`;

// Indirect lighting (replaces three's lights_fragment_maps) + tube lights.
const INDIRECT = /* glsl */`
vec3 lpP = lpWorldPos();
vec3 lpN = normalize( lpToWorld( geometryNormal ) );
vec3 lpV = normalize( cameraPosition - lpP );
float lpW = lpGIWeight( lpP );
vec4 lpSr = vec4( 0.0 ), lpSg = vec4( 0.0 ), lpSb = vec4( 0.0 );
if ( lpW > 0.0 ) lpGIFetch( lpP, lpN, lpSr, lpSg, lpSb );
float lpLocalLum = lpLum( vec3( lpSr.x, lpSg.x, lpSb.x ) );

#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		irradiance += lightMapTexel.rgb * lightMapIntensity;
	#endif
	vec3 lpE = lpSHEval( lpSr, lpSg, lpSb, lpN ) * lpGIGain;
	vec3 lpEnvE = vec3( 0.0 );
	#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
		if ( lpW < 0.999 ) lpEnvE = getIBLIrradiance( geometryNormal ) * lpSkyGain;
	#endif
	#ifdef STANDARD
		iblIrradiance += mix( lpEnvE, lpE, lpW );
	#else
		irradiance += mix( lpEnvE, lpE, lpW );
	#endif
#endif

#if defined( RE_Direct )
	for ( int i = 0; i < LP_MAX_TUBES; i ++ ) {
		if ( i >= lpTubeCount ) break;
		vec4 ta = lpTubeA[ i ], tb = lpTubeB[ i ], tc = lpTubeC[ i ];
		vec3 tcen = ta.xyz - lpP;
		float dc = length( tcen );
		if ( dc > tb.w + ta.w ) continue;
		float clip = lpTubeClip( i, lpP );
		if ( clip <= 0.0 ) continue;
		float win = saturate( 1.0 - pow4( dc / tb.w ) ); win *= win;
		vec3 L0 = tcen - tb.xyz * ta.w, L1 = tcen + tb.xyz * ta.w;
		float d0 = length( L0 ), d1 = length( L1 );
		// housing: fixtures emit mostly downwards (tc.w = fraction emitted upwards)
		float below = smoothstep( - 0.3, 0.25, tcen.y / max( dc, 1e-3 ) );
		vec3 pw = tc.rgb * win * clip * mix( tc.w, 1.0, below );
		#if defined( RE_IndirectDiffuse )
			irradiance += pw * lpTubeFill / ( dc * dc + 4.0 );
		#endif
		float nl = saturate( 0.5 * dot( lpN, L0 ) / d0 + 0.5 * dot( lpN, L1 ) / d1 );
		float E = 2.0 * nl / ( d0 * d1 + dot( L0, L1 ) + 0.05 );
		#ifdef STANDARD
			reflectedLight.directDiffuse += pw * E * BRDF_Lambert( material.diffuseColor );
			vec3 lpRr = reflect( - lpV, lpN );
			vec3 Ld = L1 - L0;
			float RoLd = dot( lpRr, Ld );
			float tt = saturate( ( dot( lpRr, L0 ) * RoLd - dot( L0, Ld ) ) / max( dot( Ld, Ld ) - RoLd * RoLd, 1e-4 ) );
			vec3 Lr = L0 + tt * Ld;
			float dr = length( Lr );
			vec3 Lrn = Lr / dr;
			float nlr = saturate( dot( lpN, Lrn ) );
			float a = max( material.roughness * material.roughness, 0.02 );
			float a2 = saturate( a + ta.w / ( 2.0 * dr ) );
			vec3 lv = normalize( ( viewMatrix * vec4( Lrn, 0.0 ) ).xyz );
			reflectedLight.directSpecular += pw * ( nlr / ( dr * dr + 0.05 ) ) * ( a / a2 ) * BRDF_GGX( lv, geometryViewDir, geometryNormal, material );
		#else
			IncidentLight lpTl;
			vec3 lpCp = L0 + saturate( dot( - L0, tb.xyz ) / ( 2.0 * ta.w ) ) * ( L1 - L0 );
			lpTl.direction = normalize( ( viewMatrix * vec4( lpCp, 0.0 ) ).xyz );
			lpTl.color = pw * E / max( nl, 1e-3 ) * saturate( dot( lpN, normalize( lpCp ) ) );
			lpTl.visible = true;
			RE_Direct( lpTl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif
	}
#endif

#if defined( RE_IndirectSpecular )
	{
		float lpRough = material.roughness;
		vec3 lpRv = reflect( - lpV, lpN );
		lpRv = normalize( mix( lpRv, lpN, lpRough * lpRough ) );
		vec3 lpSpec = vec3( 0.0 );
		if ( lpReflOn > 0.5 && lpReflCount > 0 ) {
			lpSpec = lpLocalRadiance( lpP, lpRv, lpRough, lpLocalLum ) * lpSpecGain;
		} else {
			lpSpec = lpSHEval( lpSr, lpSg, lpSb, lpRv ) * ( RECIPROCAL_PI * lpGIGain );
		}
		vec3 lpEnvR = vec3( 0.0 );
		#if defined( USE_ENVMAP )
			if ( lpW < 0.999 ) {
				#ifdef USE_ANISOTROPY
					lpEnvR = getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
				#else
					lpEnvR = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
				#endif
			}
		#endif
		radiance += mix( lpEnvR, lpSpec, lpW );
		#if defined( USE_ENVMAP ) && defined( USE_CLEARCOAT )
			clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
		#endif
	}
#endif
`;

const FOG = /* glsl */`
#ifdef USE_FOG
	{
		vec3 lpFp = lpWorldPos();
		vec3 lpFd = lpFp - cameraPosition;
		float lpFl = length( lpFd );
		vec3 lpMid = cameraPosition + lpFd * ( min( lpFl * 0.5, 9.0 ) / max( lpFl, 1e-3 ) );
		float hall = lpInBox( lpMid, lpFogHallMin, lpFogHallMax, 0.6 );
		float room = lpInBox( lpMid, lpFogRoomMin, lpFogRoomMax, 0.6 );
		float mul = mix( mix( lpFogMul.x, lpFogMul.y, hall ), lpFogMul.z, room );
		#ifdef FOG_EXP2
			float dens = fogDensity * mul;
			float fogFactor = 1.0 - exp( - dens * dens * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		vec3 lpFc = fogColor;
		float lpFw = lpGIWeight( lpMid ) * lpFogGI;
		if ( lpFw > 0.0 ) {
			vec3 uvw = lpMid * lpGIScale + lpGIOffset;
			vec3 c0 = vec3( texture( lpGIR, uvw ).x, texture( lpGIG, uvw ).x, texture( lpGIB, uvw ).x );
			lpFc = mix( fogColor, c0 * ( RECIPROCAL_PI * lpFogAlbedo * lpGIGain ), lpFw );
		}
		gl_FragColor.rgb = mix( gl_FragColor.rgb, lpFc, fogFactor );
	}
#endif
`;

const BEGIN = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= lpSunFactor( directionalLight.direction, nonPerturbedNormal );',
);
THREE.ShaderChunk.lp_pars = PARS;
THREE.ShaderChunk.lp_lights_fragment_begin = BEGIN;
THREE.ShaderChunk.lp_indirect = INDIRECT;
THREE.ShaderChunk.lp_fog_fragment = FOG;

// ------------------------------------------------------------------------------------------------ patching
export function patchShader(shader) {
  let fs = shader.fragmentShader;
  if (fs.includes('LP_PARS') || !fs.includes('vViewPosition') || !fs.includes('void main()')) return;
  Object.assign(shader.uniforms, LP);
  fs = fs.replace(/void\s+main\s*\(\s*\)\s*\{/, '#include <lp_pars>\nvoid main() {');
  fs = fs.replace('#include <lights_fragment_begin>', '#include <lp_lights_fragment_begin>');
  if (fs.includes('#include <lights_fragment_maps>')) fs = fs.replace('#include <lights_fragment_maps>', '#include <lp_indirect>');
  else fs = fs.replace('#include <lights_fragment_end>', '#include <lp_indirect>\n#include <lights_fragment_end>');
  fs = fs.replace('#include <fog_fragment>', '#include <lp_fog_fragment>');
  shader.fragmentShader = fs;
}

function lpOnBeforeCompile(shader) { patchShader(shader); }
lpOnBeforeCompile.__lp = true;
let installed = false;
export function installLightPatch() {
  if (installed) return;
  installed = true;
  for (const T of [THREE.MeshStandardMaterial, THREE.MeshLambertMaterial, THREE.MeshPhongMaterial]) T.prototype.onBeforeCompile = lpOnBeforeCompile;
}

const isLit = (m) => m && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial);
// Wraps a material-specific onBeforeCompile so it still receives the lighting patch.
export function adoptMaterial(m) {
  if (!isLit(m)) return false;
  const own = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
  if (!own || m.onBeforeCompile.__lp) return false;
  const orig = m.onBeforeCompile;
  const ownKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey') ? m.customProgramCacheKey : null;
  const f = function (shader, renderer) { orig.call(this, shader, renderer); patchShader(shader); };
  f.__lp = true;
  m.onBeforeCompile = f;
  m.customProgramCacheKey = function () { return 'lp|' + orig.toString() + (ownKey ? '|' + ownKey.call(this) : ''); };
  m.needsUpdate = true;
  return true;
}
export function adoptScene(root) {
  let n = 0;
  root.traverse((o) => {
    const m = o.material;
    if (Array.isArray(m)) { for (const x of m) if (adoptMaterial(x)) n++; } else if (adoptMaterial(m)) n++;
  });
  return n;
}

export function setVolume(gi) {
  const P = gi.grid;
  LP.lpGIR.value = gi.textures[0]; LP.lpGIG.value = gi.textures[1]; LP.lpGIB.value = gi.textures[2];
  const size = [P.nx * P.s, P.ny * P.s, P.nz * P.s];
  LP.lpGIScale.value.set(1 / size[0], 1 / size[1], 1 / size[2]);
  LP.lpGIOffset.value.set((-P.x0 / P.s + 0.5) / P.nx, (-P.y0 / P.s + 0.5) / P.ny, (-P.z0 / P.s + 0.5) / P.nz);
  LP.lpGIMin.value.set(P.x0, P.y0, P.z0);
  LP.lpGIMax.value.set(P.x0 + (P.nx - 1) * P.s, P.y0 + (P.ny - 1) * P.s, P.z0 + (P.nz - 1) * P.s);
  LP.lpGIOn.value = 1;
}
export const REFL_SIZE = { w: REFL_W, h: REFL_H, cube: REFL_CUBE };
