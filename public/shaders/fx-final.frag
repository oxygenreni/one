// FX: final composite to the screen (scene + bloom, soft-clipped so stacked FX don't blow out),
// then the per-phone heart rings, touch pad bursts, paint strokes and game tints on top.
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform float uBloomAmt;
uniform float uHueRotate; // radians, from the shared colour-shift control
uniform float uExposure;  // Glow slider
uniform float uSaturation;
uniform vec4 uHearts[32]; // per phone: xy = spot (aspectUv space), z = seconds since its last beat, w = hue
uniform int uHeartCount;
uniform vec4 uBursts[32]; // touch bursts: xy = spot (aspectUv space), z = age (s), w = power
uniform float uBurstHue[32]; // the phone's hue; -1 = combo (rainbow)
uniform int uBurstCount;
uniform sampler2D uPaint; // paint strokes from phones (fades on its own)
uniform float uPaintOn;
uniform float uCharge;    // hold together: 0..1
uniform vec4 uRace;       // tap race: x = strength, y = red share of the screen, zw = team hues
uniform vec2 uPass;       // pass the colour: x = strength, y = holder's hue
uniform float uInvert;    // Invert FX: 1 = negative picture

// Rotates the colour around the grey axis (keeps luminance roughly constant).
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

vec3 hueToRgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  // Glow: brightness and saturation (both 1 at the slider's default), then bloom.
  c *= uExposure;
  c = max(mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, uSaturation), vec3(0.0));
  if (uBloomAmt > 0.0) c += texture(uBloom, vUv).rgb * uBloomAmt;
  // Soft shoulder instead of a hard clip at white, eased in as things get brighter.
  float shoulder = uBloomAmt > 0.0 ? 1.0 : clamp((uExposure - 1.0) * 2.0, 0.0, 1.0);
  c = mix(c, 1.0 - exp(-c * 1.25), shoulder);
  if (uHueRotate != 0.0) c = max(hueRotate(c, uHueRotate), vec3(0.0));

  // Hearts and bursts are drawn after the colour shift so each keeps the colour shown on its phone.
  vec3 glow = vec3(0.0);
  vec2 p = aspectUv();
  for (int i = 0; i < 32; i++) {
    if (i >= uHeartCount) break;
    vec4 h = uHearts[i];
    vec3 col = mix(vec3(1.0), hueToRgb(h.w), 0.8);
    float d = length(p - h.xy);
    float age = h.z;
    float r = 0.03 + age * 0.38;                                  // ring expands after each beat
    float w = 0.01 + age * 0.025;
    float ring = exp(-pow((d - r) / w, 2.0)) * exp(-age * 2.4);
    float core = exp(-d * d / 0.0005) * (0.3 + 1.1 * exp(-age * 6.0)); // dot that flares on the beat
    glow += col * (0.8 * ring + core);
  }
  for (int i = 0; i < 32; i++) {
    if (i >= uBurstCount) break;
    vec4 b = uBursts[i];
    vec2 dv = p - b.xy;
    float d = length(dv);
    float age = b.z;
    float hue = uBurstHue[i];
    // Combos are rainbow, spinning around their centre; taps keep the phone's colour.
    vec3 col = hue < 0.0 ? hueToRgb(atan(dv.y, dv.x) / TAU + age * 0.4) : mix(vec3(1.0), hueToRgb(hue), 0.75);
    float r = age * (0.55 + 0.3 * b.w);                           // matches the wavefront in fx-pre.frag
    float w = 0.012 + age * 0.03 * sqrt(b.w);
    float fade = exp(-age * 2.0 / (0.6 + 0.4 * b.w));
    float ring = exp(-pow((d - r) / w, 2.0)) * fade * min(b.w, 2.0) * 0.7;
    float core = exp(-d * d / (0.0015 * b.w)) * exp(-age * 7.0) * min(b.w, 1.5);
    glow += col * (ring + core);
  }
  if (uPaintOn > 0.0) glow += texture(uPaint, vUv).rgb;
  float edge = smoothstep(0.55, 1.6, length(p));
  if (uCharge > 0.0) {
    c *= 1.0 + 0.5 * uCharge;
    // A rainbow aura closes in from the edges, flickering faster as the charge builds.
    vec3 aura = hueToRgb(atan(p.y, p.x) / TAU + uTime * 0.3);
    glow += aura * uCharge * edge * (0.3 + 0.15 * sin(uTime * (10.0 + 20.0 * uCharge)));
  }
  if (uPass.x > 0.0) glow += hueToRgb(uPass.y) * uPass.x * edge * edge * (0.25 + 0.25 * uBeat);
  // Tap race: red floods in from the left, blue from the right; the line moves with the score.
  if (uRace.x > 0.0) {
    float line = uRace.y + 0.015 * sin(vUv.y * 18.0 + uTime * 3.0);
    vec3 team = hueToRgb(vUv.x < line ? uRace.z : uRace.w);
    c = mix(c, 1.0 - (1.0 - min(c, vec3(1.0))) * (1.0 - team * 0.55), uRace.x * 0.85);
    glow += vec3(1.0) * exp(-abs(vUv.x - line) * 140.0) * uRace.x * 0.8;
  }
  if (uHeartCount > 0 || uBurstCount > 0 || uPaintOn > 0.0 || uCharge > 0.0 || uPass.x > 0.0 || uRace.x > 0.0) {
    c = 1.0 - (1.0 - min(c, vec3(1.0))) * (1.0 - min(glow, vec3(1.0))); // screen blend
  }
  c = min(c, vec3(1.0));
  if (uInvert > 0.0) c = 1.0 - c;
  fragColor = vec4(c, 1.0);
}
