// Semi-Lagrangian advection (stable fluids). Velocity is in grid cells / second.
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform float uDissipation;

void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  fragColor = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}
