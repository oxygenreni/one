// FX: bloom bright-pass (rendered at quarter resolution).
uniform sampler2D uSrc;
uniform float uThreshold;

void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  fragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}