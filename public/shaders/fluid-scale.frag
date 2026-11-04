uniform sampler2D uSource;
uniform float uValue;

void main() {
  fragColor = texture(uSource, vUv) * uValue;
}
