// FX: separable 9-tap Gaussian blur using linear-filtered taps.
uniform sampler2D uSrc;
uniform vec2 uDir;

void main() {
  vec3 s = texture(uSrc, vUv).rgb * 0.2270270270;
  s += (texture(uSrc, vUv + uDir * 1.3846153846).rgb + texture(uSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  s += (texture(uSrc, vUv + uDir * 3.2307692308).rgb + texture(uSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  fragColor = vec4(s, 1.0);
}