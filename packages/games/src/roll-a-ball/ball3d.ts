/**
 * A real 3D ball: a lit UV-sphere rendered with WebGL into a small offscreen
 * canvas, which the 2D scene composites wherever the ball is. The spot pattern
 * lives in object space, so rotating the model matrix rolls the pattern.
 */

export type Quat = [number, number, number, number]; // x, y, z, w

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const len = Math.sqrt(ax * ax + ay * ay + az * az);
  if (len < 1e-9) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / len;
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

/** a * b: apply b first, then a. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatToMat4(q: Quat, scale: number): Float32Array {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  const s = scale;
  // Column-major
  return new Float32Array([
    (1 - 2 * (yy + zz)) * s, 2 * (xy + wz) * s, 2 * (xz - wy) * s, 0,
    2 * (xy - wz) * s, (1 - 2 * (xx + zz)) * s, 2 * (yz + wx) * s, 0,
    2 * (xz + wy) * s, 2 * (yz - wx) * s, (1 - 2 * (xx + yy)) * s, 0,
    0, 0, 0, 1,
  ]);
}

const VERT = `
attribute vec3 aPos;
attribute vec3 aNorm;
uniform mat4 uModel;
varying vec3 vNorm;
varying vec3 vObj;
void main() {
  vec4 p = uModel * vec4(aPos, 1.0);
  gl_Position = vec4(p.xy, -p.z * 0.5, 1.0);
  vNorm = mat3(uModel) * aNorm;
  vObj = aPos;
}`;

const FRAG = `
precision mediump float;
uniform vec3 uColor;
uniform vec3 uSpot;
uniform float uDim;
uniform vec3 uDirs[8];
varying vec3 vNorm;
varying vec3 vObj;
void main() {
  vec3 o = normalize(vObj);
  float spot = 0.0;
  for (int i = 0; i < 8; i++) {
    spot = max(spot, smoothstep(0.905, 0.935, dot(o, uDirs[i])));
  }
  vec3 base = mix(uColor, uSpot, spot);
  vec3 N = normalize(vNorm);
  vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 56.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 c = base * (0.34 + 0.76 * diff) + vec3(1.0) * spec * 0.85 + base * rim * 0.3;
  c *= (1.0 - uDim);
  gl_FragColor = vec4(c, 1.0);
}`;

export interface BallRenderer {
  /** Renders the ball and returns a canvas whose full width is `diameterFraction` of the sphere. */
  render(color: [number, number, number], spot: [number, number, number], rotation: Quat, dim: number): HTMLCanvasElement;
  /** Sphere radius as a fraction of the canvas half-size. */
  readonly radiusFraction: number;
  readonly size: number;
}

export function createBallRenderer(size = 160): BallRenderer | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;

  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, FRAG],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('ball shader failed', gl.getShaderInfoLog(sh));
      return null;
    }
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  // UV sphere
  const rings = 28;
  const segs = 40;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(th);
      verts.push(x, y, z, x, y, z);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s;
      const b = a + segs + 1;
      // Counter-clockwise seen from outside, so back-face culling keeps the near hemisphere.
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, 'aPos');
  const aNorm = gl.getAttribLocation(program, 'aNorm');
  gl.enableVertexAttribArray(aPos);
  gl.enableVertexAttribArray(aNorm);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 24, 12);

  const uModel = gl.getUniformLocation(program, 'uModel');
  const uColor = gl.getUniformLocation(program, 'uColor');
  const uSpot = gl.getUniformLocation(program, 'uSpot');
  const uDim = gl.getUniformLocation(program, 'uDim');
  const uDirs = gl.getUniformLocation(program, 'uDirs');
  // Spots at the corners of a cube: evenly spread, none on the poles.
  const dirs: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) dirs.push(sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3));
  gl.uniform3fv(uDirs, new Float32Array(dirs));

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.viewport(0, 0, size, size);
  gl.clearColor(0, 0, 0, 0);

  const radiusFraction = 0.86;

  return {
    size,
    radiusFraction,
    render(color, spot, rotation, dim) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uModel, false, quatToMat4(rotation, radiusFraction));
      gl.uniform3f(uColor, color[0], color[1], color[2]);
      gl.uniform3f(uSpot, spot[0], spot[1], spot[2]);
      gl.uniform1f(uDim, dim);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
      return canvas;
    },
  };
}
