// FX: final composite to the screen (scene + bloom, soft-clipped so stacked FX don't blow out).
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform float uBloomAmt;
uniform float uHueRotate; // radians, from the shared colour-shift control

// Rotates the colour around the grey axis (keeps luminance roughly constant).
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  if (uBloomAmt > 0.0) {
    c += texture(uBloom, vUv).rgb * uBloomAmt;
    c = 1.0 - exp(-c * 1.25); // soft shoulder instead of a hard clip at white
  }
  if (uHueRotate != 0.0) c = max(hueRotate(c, uHueRotate), vec3(0.0));
  fragColor = vec4(min(c, vec3(1.0)), 1.0);
}
