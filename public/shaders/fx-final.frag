// FX: final composite to the screen (scene + bloom, soft-clipped so stacked FX don't blow out),
// then the per-phone heart rings and touch pad bursts on top.
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform float uBloomAmt;
uniform float uHueRotate; // radians, from the shared colour-shift control
uniform vec4 uHearts[32]; // per phone: xy = spot (aspectUv space), z = seconds since its last beat, w = hue
uniform int uHeartCount;
uniform vec4 uBursts[32]; // touch bursts: xy = spot (aspectUv space), z = age (s), w = power
uniform float uBurstHue[32]; // the phone's hue; -1 = combo (rainbow)
uniform int uBurstCount;

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
  if (uBloomAmt > 0.0) {
    c += texture(uBloom, vUv).rgb * uBloomAmt;
    c = 1.0 - exp(-c * 1.25); // soft shoulder instead of a hard clip at white
  }
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
  if (uHeartCount > 0 || uBurstCount > 0) {
    c = 1.0 - (1.0 - min(c, vec3(1.0))) * (1.0 - min(glow, vec3(1.0))); // screen blend
  }
  fragColor = vec4(min(c, vec3(1.0)), 1.0);
}
