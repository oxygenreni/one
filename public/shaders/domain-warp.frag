// MODE 1 — Domain Warping: a breathing, bioluminescent mushroom environment.
// Pulse  -> warp amplitude (uWarpAmp) + warp speed (integrated uWarpTime) + inhale/exhale zoom.
// Audio  -> palette phase shift (uPaletteShift accumulates band energy) + spore sparkle.

uniform float uWarpTime;
uniform float uWarpAmp;
uniform vec3 uPaletteShift;

void main() {
  vec2 p = aspectUv();
  float breath = uBreath * (0.35 + 0.65 * uStrength);

  // Inhale expands the world toward the viewer, exhale relaxes it.
  p *= 0.95 - 0.14 * breath - 0.04 * uBeat;
  float t = uWarpTime;

  vec2 q = vec2(fbm(p + vec2(0.0, 0.12 * t)), fbm(p + vec2(5.2, 1.3) - 0.09 * t));
  vec2 r = vec2(
    fbm(p + uWarpAmp * q + vec2(1.7, 9.2) + 0.15 * t),
    fbm(p + uWarpAmp * q + vec2(8.3, 2.8) - 0.126 * t)
  );
  float f = fbm(p + uWarpAmp * r);
  float f01 = 0.5 + 0.5 * f;

  // Gill-like ridges radiating from warped mushroom caps.
  vec2 w = p + 0.6 * r;
  float ang = atan(w.y, w.x);
  float gills = pow(0.5 + 0.5 * sin(ang * 38.0 + length(q) * 9.0 + t * 0.3), 6.0);
  gills *= smoothstep(1.4, 0.2, length(w)) * 0.35;

  // Earthy flesh -> bioluminescent glow, phase-shifted by audio.
  vec3 shift = uPaletteShift;
  vec3 earth = palette(f01 * 0.8 + shift.x, vec3(0.32, 0.22, 0.20), vec3(0.28, 0.20, 0.22),
                       vec3(1.0, 1.0, 1.0), vec3(0.02, 0.12, 0.22) + shift * 0.15);
  vec3 glow = palette(length(r) * 0.7 + shift.y + 0.2 * uMid, vec3(0.45, 0.5, 0.55), vec3(0.5, 0.45, 0.5),
                      vec3(1.0, 0.85, 0.7), vec3(0.55, 0.25, 0.05) + shift.zxy * 0.2);

  vec3 col = mix(earth, glow, smoothstep(0.35, 0.95, length(q) + 0.25 * f));
  col *= 0.55 + 0.9 * f01 * f01;
  col += glow * gills * (0.6 + uTreble + 0.8 * uSpark);

  // Veins of light along the warp field's steepest lines.
  float veins = smoothstep(0.03, 0.0, abs(r.x - r.y) - 0.01 * uBass);
  col += veins * glow * (0.4 + 1.2 * uBass) * (0.6 + 0.4 * breath);

  // Floating spores sparkle with high frequencies.
  vec2 sp = p * 9.0 + vec2(0.0, t * 0.35);
  vec2 cell = floor(sp);
  vec2 o = hash22(cell);
  float d = length(fract(sp) - o);
  // Each treble hit lights up extra spores for a moment.
  float spark = smoothstep(0.08, 0.0, d) * step(0.82 - 0.14 * uSpark, hash12(cell + 3.1));
  col += spark * (0.4 + 2.5 * uTreble + 3.0 * uSpark) * vec3(0.7, 1.0, 0.85);

  col *= 1.0 + 0.35 * uPulse * uStrength;
  float vig = smoothstep(1.9, 0.4, length(aspectUv()));
  fragColor = vec4(tonemap(col * vig), 1.0);
}
