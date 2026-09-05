/**
 * A small WebGL scene renderer for the phone views: flat-coloured lit meshes
 * built once, a UV sphere for balls with the same spotted look as `ball3d`,
 * blob shadows, and the matrix helpers to place a camera and to map touches
 * back onto the table. No textures, no dependencies.
 */
import type { Quat } from './ball3d';

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

// ---- vectors ---------------------------------------------------------------
export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  normalize(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

// ---- matrices (column-major, like WebGL) ---------------------------------
export function mat4Identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = v3.normalize(v3.sub(eye, target));
  const x = v3.normalize(v3.cross(up, z));
  const y = v3.cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1,
  ]);
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function mat4Transform(m: Mat4, x: number, y: number, z: number, w = 1): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
  ];
}

export function mat4Invert(m: Mat4): Mat4 | null {
  const a = m;
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]);
}

/** Translation · rotation (quaternion) · uniform scale. */
export function mat4Compose(t: Vec3, q: Quat, s: number): Mat4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return new Float32Array([
    (1 - 2 * (yy + zz)) * s, 2 * (xy + wz) * s, 2 * (xz - wy) * s, 0,
    2 * (xy - wz) * s, (1 - 2 * (xx + zz)) * s, 2 * (yz + wx) * s, 0,
    2 * (xz + wy) * s, 2 * (yz - wx) * s, (1 - 2 * (xx + yy)) * s, 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** A matrix whose columns are the given axes (scaled) and origin: places a unit shape into a frame. */
export function mat4FromAxes(ex: Vec3, ey: Vec3, ez: Vec3, o: Vec3): Mat4 {
  return new Float32Array([ex[0], ex[1], ex[2], 0, ey[0], ey[1], ey[2], 0, ez[0], ez[1], ez[2], 0, o[0], o[1], o[2], 1]);
}

// ---- meshes ----------------------------------------------------------------
/** A local surface frame: origin, across, along, and up. */
export interface Frame {
  o: Vec3;
  ex: Vec3;
  eu: Vec3;
  en: Vec3;
}

export const GROUND: Frame = { o: [0, 0, 0], ex: [1, 0, 0], eu: [0, 1, 0], en: [0, 0, 1] };

export function framePoint(f: Frame, x: number, u: number, h: number): Vec3 {
  return [
    f.o[0] + f.ex[0] * x + f.eu[0] * u + f.en[0] * h,
    f.o[1] + f.ex[1] * x + f.eu[1] * u + f.en[1] * h,
    f.o[2] + f.ex[2] * x + f.eu[2] * u + f.en[2] * h,
  ];
}

export function hexToRgbTuple(hex: string): Vec3 {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  private rgb: Vec3 = [1, 1, 1];

  color(hex: string | Vec3): this {
    this.rgb = typeof hex === 'string' ? hexToRgbTuple(hex) : hex;
    return this;
  }

  private vertex(p: Vec3, n: Vec3): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.colors.push(this.rgb[0], this.rgb[1], this.rgb[2]);
    return this.positions.length / 3 - 1;
  }

  /** Triangle a, b, c, counter-clockwise seen from the outside. */
  tri(a: Vec3, b: Vec3, c: Vec3, normal?: Vec3): this {
    const n = normal ?? v3.normalize(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    const i = this.vertex(a, n);
    this.vertex(b, n);
    this.vertex(c, n);
    this.indices.push(i, i + 1, i + 2);
    return this;
  }

  /** Quad a, b, c, d counter-clockwise seen from the outside. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal?: Vec3): this {
    const n = normal ?? v3.normalize(v3.cross(v3.sub(b, a), v3.sub(d, a)));
    const i = this.vertex(a, n);
    this.vertex(b, n);
    this.vertex(c, n);
    this.vertex(d, n);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }

  /** A flat rectangle on a frame at height h, facing +n. */
  rect(f: Frame, x0: number, u0: number, x1: number, u1: number, h: number): this {
    return this.quad(framePoint(f, x0, u0, h), framePoint(f, x1, u0, h), framePoint(f, x1, u1, h), framePoint(f, x0, u1, h), f.en);
  }

  /** A box on a frame: x0..x1 across, u0..u1 along, h0..h1 up. All six faces. */
  box(f: Frame, x0: number, u0: number, x1: number, u1: number, h0: number, h1: number): this {
    const p = (x: number, u: number, h: number) => framePoint(f, x, u, h);
    const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
    this.quad(p(x0, u0, h1), p(x1, u0, h1), p(x1, u1, h1), p(x0, u1, h1), f.en); // top
    this.quad(p(x0, u1, h0), p(x1, u1, h0), p(x1, u0, h0), p(x0, u0, h0), neg(f.en)); // bottom
    this.quad(p(x0, u0, h0), p(x1, u0, h0), p(x1, u0, h1), p(x0, u0, h1), neg(f.eu)); // front (near)
    this.quad(p(x1, u1, h0), p(x0, u1, h0), p(x0, u1, h1), p(x1, u1, h1), f.eu); // back
    this.quad(p(x0, u1, h0), p(x0, u0, h0), p(x0, u0, h1), p(x0, u1, h1), neg(f.ex)); // left
    this.quad(p(x1, u0, h0), p(x1, u1, h0), p(x1, u1, h1), p(x1, u0, h1), f.ex); // right
    return this;
  }

  /** A flat ring (or disc when rIn = 0) on a frame at height h, facing +n. */
  ring(f: Frame, cx: number, cu: number, rIn: number, rOut: number, h: number, segs = 40): this {
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      const o0 = framePoint(f, cx + Math.cos(a0) * rOut, cu + Math.sin(a0) * rOut, h);
      const o1 = framePoint(f, cx + Math.cos(a1) * rOut, cu + Math.sin(a1) * rOut, h);
      if (rIn <= 0) {
        this.tri(framePoint(f, cx, cu, h), o0, o1, f.en);
      } else {
        const i0 = framePoint(f, cx + Math.cos(a0) * rIn, cu + Math.sin(a0) * rIn, h);
        const i1 = framePoint(f, cx + Math.cos(a1) * rIn, cu + Math.sin(a1) * rIn, h);
        this.quad(i0, o0, o1, i1, f.en);
      }
    }
    return this;
  }

  /** A cylinder wall on a frame between heights h0 and h1, facing outwards (or inwards). */
  wall(f: Frame, cx: number, cu: number, r: number, h0: number, h1: number, inward = false, segs = 40): this {
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      const p00 = framePoint(f, cx + Math.cos(a0) * r, cu + Math.sin(a0) * r, h0);
      const p10 = framePoint(f, cx + Math.cos(a1) * r, cu + Math.sin(a1) * r, h0);
      const p01 = framePoint(f, cx + Math.cos(a0) * r, cu + Math.sin(a0) * r, h1);
      const p11 = framePoint(f, cx + Math.cos(a1) * r, cu + Math.sin(a1) * r, h1);
      const am = (a0 + a1) / 2;
      const n: Vec3 = v3.normalize(v3.add(v3.scale(f.ex, Math.cos(am)), v3.scale(f.eu, Math.sin(am))));
      if (inward) this.quad(p10, p00, p01, p11, [-n[0], -n[1], -n[2]]);
      else this.quad(p00, p10, p11, p01, n);
    }
    return this;
  }

  /** A unit UV sphere, normals = positions. */
  sphere(rings = 24, segs = 36): this {
    const base = this.positions.length / 3;
    for (let r = 0; r <= rings; r++) {
      const phi = (r / rings) * Math.PI;
      for (let s = 0; s <= segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        const p: Vec3 = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
        this.vertex(p, p);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = base + r * (segs + 1) + s;
        const b = a + segs + 1;
        this.indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    return this;
  }
}

export interface GpuMesh {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
  /** 32-bit indices (more than 65535 vertices). */
  wide: boolean;
}

export interface DrawOptions {
  alpha?: number;
  /** No lighting: flat colour (shadows, glows). */
  unlit?: boolean;
  /** Spotted ball look: base colour, spot colour, darkening. */
  ball?: { color: Vec3; spot: Vec3; dim: number };
  /** Skip writing depth (translucent things). */
  noDepthWrite?: boolean;
}

export interface Scene3D {
  gl: WebGLRenderingContext;
  upload(b: MeshBuilder): GpuMesh;
  /** Unit sphere and a unit disc in its xy plane facing +z. */
  sphere: GpuMesh;
  disc: GpuMesh;
  resize(width: number, height: number, dpr: number): void;
  /** Clear and set the camera for a frame. */
  begin(viewProj: Mat4, eye: Vec3, light: Vec3): void;
  draw(mesh: GpuMesh, model: Mat4, opts?: DrawOptions): void;
}

const VERT = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
varying vec3 vNorm;
varying vec3 vColor;
varying vec3 vObj;
varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  gl_Position = uViewProj * w;
  vWorld = w.xyz;
  vNorm = mat3(uModel) * aNorm;
  vColor = aColor;
  vObj = aPos;
}`;

const FRAG = `
precision mediump float;
uniform vec3 uLight;
uniform vec3 uEye;
uniform float uAlpha;
uniform float uUnlit;
uniform float uBall;
uniform vec3 uColor;
uniform vec3 uSpotColor;
uniform vec3 uDirs[8];
uniform float uDim;
varying vec3 vNorm;
varying vec3 vColor;
varying vec3 vObj;
varying vec3 vWorld;
void main() {
  vec3 base = vColor;
  if (uBall > 0.5) {
    vec3 o = normalize(vObj);
    float spot = 0.0;
    for (int i = 0; i < 8; i++) spot = max(spot, smoothstep(0.905, 0.935, dot(o, uDirs[i])));
    base = mix(uColor, uSpotColor, spot);
  }
  vec3 N = normalize(vNorm);
  vec3 L = normalize(uLight);
  vec3 V = normalize(uEye - vWorld);
  vec3 H = normalize(L + V);
  float diff = max(dot(N, L), 0.0);
  float shine = uBall > 0.5 ? 56.0 : 20.0;
  float spec = pow(max(dot(N, H), 0.0), shine) * (uBall > 0.5 ? 0.85 : 0.10);
  float rim = uBall > 0.5 ? pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.3 : 0.0;
  vec3 c = base * (0.40 + 0.66 * diff) + vec3(1.0) * spec + base * rim;
  if (uUnlit > 0.5) c = base;
  c *= (1.0 - uDim);
  gl_FragColor = vec4(c * uAlpha, uAlpha);
}`;

export function createScene(canvas: HTMLCanvasElement): Scene3D | null {
  const ctx = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, depth: true });
  if (!ctx) return null;
  const gl: WebGLRenderingContext = ctx;
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, FRAG],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('scene shader failed', gl.getShaderInfoLog(sh));
      return null;
    }
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const aPos = gl.getAttribLocation(program, 'aPos');
  const aNorm = gl.getAttribLocation(program, 'aNorm');
  const aColor = gl.getAttribLocation(program, 'aColor');
  const u = (name: string) => gl.getUniformLocation(program, name);
  const uViewProj = u('uViewProj');
  const uModel = u('uModel');
  const uLight = u('uLight');
  const uEye = u('uEye');
  const uAlpha = u('uAlpha');
  const uUnlit = u('uUnlit');
  const uBall = u('uBall');
  const uColor = u('uColor');
  const uSpotColor = u('uSpotColor');
  const uDim = u('uDim');
  const dirs: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) dirs.push(sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3));
  gl.uniform3fv(u('uDirs'), new Float32Array(dirs));

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function upload(b: MeshBuilder): GpuMesh {
    const data = new Float32Array(b.positions.length * 3);
    const n = b.positions.length / 3;
    for (let i = 0; i < n; i++) {
      data.set([b.positions[i * 3]!, b.positions[i * 3 + 1]!, b.positions[i * 3 + 2]!, b.normals[i * 3]!, b.normals[i * 3 + 1]!, b.normals[i * 3 + 2]!, b.colors[i * 3]!, b.colors[i * 3 + 1]!, b.colors[i * 3 + 2]!], i * 9);
    }
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const wide = n > 65535;
    if (wide) gl.getExtension('OES_element_index_uint');
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wide ? new Uint32Array(b.indices) : new Uint16Array(b.indices), gl.STATIC_DRAW);
    return { vbo, ibo, count: b.indices.length, wide };
  }

  const sphere = upload(new MeshBuilder().sphere());
  const disc = upload(new MeshBuilder().color('#000000').ring(GROUND, 0, 0, 0, 1, 0, 32));

  return {
    gl,
    upload,
    sphere,
    disc,
    resize(width, height, dpr) {
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    begin(viewProj, eye, light) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uViewProj, false, viewProj);
      gl.uniform3f(uEye, eye[0], eye[1], eye[2]);
      gl.uniform3f(uLight, light[0], light[1], light[2]);
    },
    draw(mesh, model, opts = {}) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aNorm);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 36, 0);
      gl.vertexAttribPointer(aNorm, 3, gl.FLOAT, false, 36, 12);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 36, 24);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform1f(uAlpha, opts.alpha ?? 1);
      gl.uniform1f(uUnlit, opts.unlit ? 1 : 0);
      gl.uniform1f(uBall, opts.ball ? 1 : 0);
      if (opts.ball) {
        gl.uniform3f(uColor, opts.ball.color[0], opts.ball.color[1], opts.ball.color[2]);
        gl.uniform3f(uSpotColor, opts.ball.spot[0], opts.ball.spot[1], opts.ball.spot[2]);
      }
      gl.uniform1f(uDim, opts.ball?.dim ?? 0);
      if (opts.noDepthWrite) gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
      if (opts.noDepthWrite) gl.depthMask(true);
    },
  };
}
