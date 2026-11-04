// Seamless mode transition: organic noise dissolve between two rendered modes.
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;

void main() {
  vec3 a = texture(uFrom, vUv).rgb;
  vec3 b = texture(uTo, vUv).rgb;
  float n = 0.5 + 0.5 * fbm(aspectUv() * 1.6 + uTime * 0.2);
  float t = smoothstep(n - 0.2, n + 0.2, uMix * 1.4 - 0.2);
  vec3 edge = vec3(1.0, 0.7, 1.0) * smoothstep(0.2, 0.0, abs(t - 0.5)) * 0.25 * (1.0 - abs(uMix * 2.0 - 1.0));
  fragColor = vec4(mix(a, b, t) + edge, 1.0);
}
