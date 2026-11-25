// WebGL2 剖面渲染管线。
// 每帧明确的通道顺序（深度/模板顺序分析见 UI 实现说明）：
//   1) 保留侧几何：颜色+深度（clip 由 fragment discard 实现，源网格不变）
//   2) 平面边框线
//   3) 逐零件：清模板为“相机绕数”初值 → 仅相机侧壳面做模板计数（前+1/后-1 或 INVERT）
//      → 模板!=0 处画封口全屏三角形（逐像素求平面深度，LEQUAL 写深度）
//   4) 拾取标记
import { V, M4, cameraWinding, shellEffSign, planeBasis, partDepths } from './geom.js';

const VS_MESH = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uVP;
uniform vec3 uPlaneN;
uniform float uPlaneD;
out vec3 vN; out vec3 vW; out float vF;
void main(){
  vW = aPos; vN = aNormal;
  vF = dot(uPlaneN, aPos) + uPlaneD;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS_MESH = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in float vF;
uniform float uSide;      // 保留 f*uSide>0 的片元
uniform vec3 uColor;
uniform vec3 uCamPos;
out vec4 o;
void main(){
  if (vF * uSide < 0.0) discard;
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;                 // 双面着色（反转壳也能正确显示）
  vec3 L = normalize(vec3(0.5, 0.8, 0.6));
  vec3 Vv = normalize(uCamPos - vW);
  vec3 H = normalize(Vv + L);
  float dif = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 32.0);
  o = vec4(uColor * (0.28 + 0.72 * dif) + 0.18 * spec, 1.0);
}`;

const VS_COUNT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uPlaneN;
uniform float uPlaneD;
out float vF;
void main(){
  vF = dot(uPlaneN, aPos) + uPlaneD;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS_COUNT = `#version 300 es
precision highp float;
in float vF;
uniform float uSide;      // = sign(f(camera))：只保留相机侧片元参与计数
out vec4 o;
void main(){
  if (vF * uSide < 0.0) discard;
  o = vec4(0.0);          // colorMask 全关，仅模板计数
}`;

const VS_FULL = `#version 300 es
layout(location=0) in vec2 aXY;
out vec2 vNDC;
void main(){ vNDC = aXY; gl_Position = vec4(aXY, 0.0, 1.0); }`;

const FS_CAP = `#version 300 es
precision highp float;
in vec2 vNDC;
uniform mat4 uVP, uInvVP;
uniform vec3 uCamPos, uPlaneN, uColor;
uniform float uPlaneD;
out vec4 o;
void main(){
  vec4 p0 = uInvVP * vec4(vNDC, -1.0, 1.0);
  vec4 p1 = uInvVP * vec4(vNDC,  1.0, 1.0);
  vec3 w0 = p0.xyz / p0.w, w1 = p1.xyz / p1.w;
  vec3 dir = w1 - w0;
  float denom = dot(uPlaneN, dir);
  if (abs(denom) < 1e-12) discard;
  float t = -(dot(uPlaneN, w0) + uPlaneD) / denom;
  if (t < 0.0 || t > 1.0) discard;          // 平面不在近远裁面之间
  vec3 w = w0 + t * dir;
  vec4 c = uVP * vec4(w, 1.0);
  gl_FragDepth = (c.z / c.w) * 0.5 + 0.5;   // 封口写在平面真实深度上
  o = vec4(uColor, 1.0);
}`;

const VS_FLAT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
void main(){ gl_Position = uVP * vec4(aPos, 1.0); }`;

const FS_FLAT = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 o;
void main(){ o = uColor; }`;

const VS_POINT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
void main(){ gl_Position = uVP * vec4(aPos, 1.0); gl_PointSize = 12.0; }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function uniforms(gl, prog, names) {
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(prog, n);
  return u;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      stencil: true, depth: true, antialias: true,
      preserveDrawingBuffer: true, // 自检 readPixels 用
    });
    if (!gl) throw new Error('需要 WebGL2（含模板缓冲）');
    this.canvas = canvas;
    this.gl = gl;
    this.pMesh = program(gl, VS_MESH, FS_MESH);
    this.uMesh = uniforms(gl, this.pMesh, ['uVP', 'uPlaneN', 'uPlaneD', 'uSide', 'uColor', 'uCamPos']);
    this.pCount = program(gl, VS_COUNT, FS_COUNT);
    this.uCount = uniforms(gl, this.pCount, ['uVP', 'uPlaneN', 'uPlaneD', 'uSide']);
    this.pCap = program(gl, VS_FULL, FS_CAP);
    this.uCap = uniforms(gl, this.pCap, ['uVP', 'uInvVP', 'uCamPos', 'uPlaneN', 'uPlaneD', 'uColor']);
    this.pFlat = program(gl, VS_FLAT, FS_FLAT);
    this.uFlat = uniforms(gl, this.pFlat, ['uVP', 'uColor']);
    this.pPoint = program(gl, VS_POINT, FS_FLAT);
    this.uPoint = uniforms(gl, this.pPoint, ['uVP', 'uColor']);

    // 全屏三角形
    this.vboFull = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboFull);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    // 动态线/点缓冲
    this.vboDyn = gl.createBuffer();
    this.model = null;
    this.debug = { stencilAlways: false, capNoDepth: false };
    this.lastInfo = null;
  }

  setModel(model) {
    const gl = this.gl;
    this.model = model;
    if (this.vbo) { gl.deleteBuffer(this.vbo); gl.deleteBuffer(this.nbo); gl.deleteBuffer(this.ibo); }
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, model.positions, gl.STATIC_DRAW);
    this.nbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nbo);
    gl.bufferData(gl.ARRAY_BUFFER, model.normals, gl.STATIC_DRAW);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.indices, gl.STATIC_DRAW);
    this._depths = partDepths(model);
    this._partOrder = model.parts.map((_, i) => i).sort((a, b) => this._depths[a] - this._depths[b]);
  }

  resize() {
    const c = this.canvas;
    const w = Math.max(1, Math.floor(c.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(c.clientHeight * devicePixelRatio));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  bindMeshBuffers(withNormal) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (withNormal) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nbo);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    } else gl.disableVertexAttribArray(1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
  }

  // cam: {eye, center, up, fov, near, far}
  // plane: {n, d}; semantic: 'winding'|'parity'; selection: 零件索引或 -1
  render(cam, plane, semantic, selection, marker) {
    const gl = this.gl, model = this.model;
    this.resize();
    const aspect = this.canvas.width / this.canvas.height;
    const proj = M4.perspective(cam.fov, aspect, cam.near, cam.far);
    const view = M4.lookAt(cam.eye, cam.center, cam.up);
    const vp = M4.mul(proj, view);
    const invVP = M4.invert(vp);
    const fCam = V.dot(plane.n, cam.eye) + plane.d;
    const camSide = fCam >= 0 ? 1 : -1;
    const camW = cameraWinding(model, cam.eye, semantic); // 每零件模板初值
    this.lastInfo = { camW: camW.slice(), camSide, fCam };

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.08, 0.09, 0.11, 1);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // ---- 1) 保留侧几何：颜色+深度 ----
    gl.useProgram(this.pMesh);
    gl.uniformMatrix4fv(this.uMesh.uVP, false, vp);
    gl.uniform3fv(this.uMesh.uPlaneN, plane.n);
    gl.uniform1f(this.uMesh.uPlaneD, plane.d);
    gl.uniform1f(this.uMesh.uSide, 1); // 保留 f>0 侧
    gl.uniform3fv(this.uMesh.uCamPos, cam.eye);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.STENCIL_TEST);
    this.bindMeshBuffers(true);
    for (const [pi, part] of model.parts.entries()) {
      const dim = 0.55;
      gl.uniform3fv(this.uMesh.uColor, part.color.map((c) => c * dim));
      for (const si of part.shells) {
        const s = model.shells[si];
        gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_INT, s.start * 4);
      }
    }

    // ---- 2) 平面边框 ----
    this.drawPlaneOutline(vp, plane);

    // ---- 3) 逐零件：模板计数 + 封口 ----
    const parity = semantic === 'parity';
    for (const pi of this._partOrder) {
      const part = model.parts[pi];
      // 3a) 模板初值 = 相机对该零件的绕数（相机在实体内的显式补偿）
      gl.clearStencil(camW[pi] & 0xff);
      gl.stencilMask(0xff);
      gl.clear(gl.STENCIL_BUFFER_BIT);

      // 3b) 计数：只统计相机侧（被裁掉一侧）的壳面；关闭深度——计数与遮挡无关
      gl.useProgram(this.pCount);
      gl.uniformMatrix4fv(this.uCount.uVP, false, vp);
      gl.uniform3fv(this.uCount.uPlaneN, plane.n);
      gl.uniform1f(this.uCount.uPlaneD, plane.d);
      gl.uniform1f(this.uCount.uSide, camSide);
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      this.bindMeshBuffers(false);
      for (const si of part.shells) {
        const s = model.shells[si];
        const eff = shellEffSign(model, si);
        if (parity) {
          gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INVERT);
          gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.INVERT);
        } else {
          // 绕数：w(平面点) = w(相机) − 沿途穿越数 → 正面 DECR / 背面 INCR；
          // 壳有效定向为负（correction=-1）时交换
          const opF = eff > 0 ? gl.DECR_WRAP : gl.INCR_WRAP;
          const opB = eff > 0 ? gl.INCR_WRAP : gl.DECR_WRAP;
          gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, opF);
          gl.stencilOpSeparate(gl.BACK, gl.KEEP,  gl.KEEP, opB);
        }
        gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_INT, s.start * 4);
      }

      // 3c) 封口：模板 != 0（奇偶语义看 bit0）处，把全屏三角形钉在平面深度上
      gl.useProgram(this.pCap);
      gl.uniformMatrix4fv(this.uCap.uVP, false, vp);
      gl.uniformMatrix4fv(this.uCap.uInvVP, false, invVP);
      gl.uniform3fv(this.uCap.uCamPos, cam.eye);
      gl.uniform3fv(this.uCap.uPlaneN, plane.n);
      gl.uniform1f(this.uCap.uPlaneD, plane.d);
      const capColor = pi === selection
        ? part.capColor.map((c) => Math.min(1, c * 1.25 + 0.15))
        : part.capColor;
      gl.uniform3fv(this.uCap.uColor, capColor);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      if (this.debug.capNoDepth) gl.disable(gl.DEPTH_TEST);
      else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); }
      if (this.debug.stencilAlways) gl.stencilFunc(gl.ALWAYS, 0, 0xff); // 自检：退化为整块矩形
      else gl.stencilFunc(gl.NOTEQUAL, 0, parity ? 0x01 : 0xff);
      gl.stencilMask(0x00);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboFull);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.STENCIL_TEST);
    }
    gl.depthFunc(gl.LESS);

    // ---- 4) 拾取标记 ----
    if (marker) this.drawMarker(vp, marker);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
  }

  drawPlaneOutline(vp, plane) {
    const gl = this.gl;
    const [u, v] = planeBasis(plane.n);
    const c = V.scale(plane.n, -plane.d);
    const S = 2.6;
    const pts = [];
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = V.add(c, V.add(V.scale(u, su * S), V.scale(v, sv * S)));
      pts.push(...p);
    }
    gl.useProgram(this.pFlat);
    gl.uniformMatrix4fv(this.uFlat.uVP, false, vp);
    gl.uniform4f(this.uFlat.uColor, 0.55, 0.65, 0.8, 0.9);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboDyn);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.drawArrays(gl.LINE_LOOP, 0, 4);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  drawMarker(vp, marker) {
    const gl = this.gl;
    gl.useProgram(this.pPoint);
    gl.uniformMatrix4fv(this.uPoint.uVP, false, vp);
    gl.uniform4fv(this.uPoint.uColor, marker.color);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboDyn);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(marker.pos), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.drawArrays(gl.POINTS, 0, 1);
  }

  readPixels() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { w, h, buf };
  }

  pixel(x, y) {
    const gl = this.gl;
    const b = new Uint8Array(4);
    // readPixels 原点在左下
    gl.readPixels(x, this.canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return [b[0], b[1], b[2], b[3]];
  }
}
