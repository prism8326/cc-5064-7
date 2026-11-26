// WebGL2 剖面渲染管线。三个阶段各自有明确输入/输出（纯 CPU 方案见 section.js / orientation.js）：
//   阶段 A 朝向判定：输入壳元数据 → shellEffSign 有效符号（未定向壳=0），决定计数通道操作
//   阶段 B 截面模板计数：输入方向表+平面+相机绕数 → 逐零件模板掩码（孔洞处计数为 0）
//   阶段 C 填充着色：输入模板掩码+零件颜色 → 平面真实深度上的封口，颜色只在这一阶段生效
// 通道顺序：
//   1) 保留侧几何：颜色+深度（clip 由 fragment discard 实现，源网格不变）
//   2) 平面边框 / 测量线覆盖（测量线的区间身份由 section.lineCoverage 在 CPU 侧求出）
//   3) 逐零件：清模板为“相机绕数”初值 → 仅相机侧壳面做模板计数（前+1/后-1 或 INVERT）
//      → 模板!=0 处画封口全屏三角形（逐像素求平面深度，LEQUAL 写深度）
//   4) 拾取标记
import { V, M4, cameraWinding, shellEffSign, planeBasis, partDepths } from './geom.js';
import { shellIsOriented } from './orientation.js';

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
  // measure: null 或 [{ line:{p,q}, intervals:[{t0,t1,kind,part}] }]（CPU 侧 section.lineCoverage 结果）
  render(cam, plane, semantic, selection, marker, measure) {
    const gl = this.gl, model = this.model;
    this.resize();
    const aspect = this.canvas.width / this.canvas.height;
    const proj = M4.perspective(cam.fov, aspect, cam.near, cam.far);
    const view = M4.lookAt(cam.eye, cam.center, cam.up);
    const vp = M4.mul(proj, view);
    const invVP = M4.invert(vp);
    const fCam = V.dot(plane.n, cam.eye) + plane.d;
    const camSide = fCam >= 0 ? 1 : -1;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.08, 0.09, 0.11, 1);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // 阶段 A/B/C 共用的方向表：朝向判定的唯一来源（未定向壳 countSign=0）
    this.orientation = model.shells.map((s, si) => ({
      shell: si,
      oriented: shellIsOriented(model, si),
      countSign: shellEffSign(model, si),
    }));

    // ---- 阶段 C-几何：保留侧几何写颜色+深度（裁剪只 discard 片元，源网格不变） ----
    this.drawRetainedGeometry(vp, plane, cam);
    this.drawPlaneOutline(vp, plane);
    if (measure) for (const m of measure) this.drawMeasureOverlay(vp, m);

    // ---- 阶段 A→B→C 封口：朝向判定 → 模板计数 → 掩码驱动填充 ----
    const camW = cameraWinding(model, cam.eye, semantic); // 每零件模板初值
    this.lastInfo = { camW: camW.slice(), camSide, fCam };
    const parity = semantic === 'parity';
    for (const pi of this._partOrder)
      this.fillPartCap(pi, vp, invVP, plane, cam, semantic, parity, camSide, camW[pi], selection);
    gl.depthFunc(gl.LESS);

    // ---- 拾取标记 ----
    if (marker) this.drawMarker(vp, marker);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
  }

  // 阶段 C-几何：保留侧（f>0）网格，仅写颜色/深度
  drawRetainedGeometry(vp, plane, cam) {
    const gl = this.gl, model = this.model;
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
    for (const part of model.parts) {
      gl.uniform3fv(this.uMesh.uColor, part.color.map((c) => c * 0.55));
      for (const si of part.shells) {
        const s = model.shells[si];
        gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_INT, s.start * 4);
      }
    }
  }

  // 阶段 A→B：一个零件的模板计数（输入方向表与相机绕数，输出模板掩码，不写颜色/深度）
  countPartStencil(part, vp, plane, parity, camSide, cameraWinding) {
    const gl = this.gl, model = this.model;
    gl.clearStencil(cameraWinding & 0xff);
    gl.stencilMask(0xff);
    gl.clear(gl.STENCIL_BUFFER_BIT);
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
      } else if (eff === 0) {
        // 未定向局部壳：填充器接收几何但绕数语义下不采信方向 → 跳过其符号计数
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.KEEP);
        gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.KEEP);
      } else {
        // w(平面点) = w(相机) − 沿途穿越数 → 正面 DECR / 背面 INCR；壳定向为负时交换
        const opF = eff > 0 ? gl.DECR_WRAP : gl.INCR_WRAP;
        const opB = eff > 0 ? gl.INCR_WRAP : gl.DECR_WRAP;
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, opF);
        gl.stencilOpSeparate(gl.BACK, gl.KEEP,  gl.KEEP, opB);
      }
      gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_INT, s.start * 4);
    }
  }

  // 阶段 C：模板掩码驱动的封口填充（颜色只在此阶段生效，写平面真实深度）
  drawCapFill(pi, vp, invVP, plane, cam, parity, selection) {
    const gl = this.gl, part = this.model.parts[pi];
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

  // 单零件完整封口：B 计数 → C 填充
  fillPartCap(pi, vp, invVP, plane, cam, semantic, parity, camSide, cameraWinding, selection) {
    const part = this.model.parts[pi];
    this.countPartStencil(part, vp, plane, parity, camSide, cameraWinding);
    this.drawCapFill(pi, vp, invVP, plane, cam, parity, selection);
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

  // 测量线覆盖：区间由 section.lineCoverage（CPU）求出，这里只按结果着色绘制。
  // 实体区间用零件 capColor，空气区间用灰色；身份未被拾取器采信的区间不会出现 solid。
  drawMeasureOverlay(vp, measure) {
    const gl = this.gl;
    const { p, q } = measure.line;
    const pts = [];
    const col = (iv) => {
      if (iv.kind !== 'solid') return [0.62, 0.62, 0.66, 0.9];
      const part = this.model.parts[iv.part];
      return [...(part ? part.capColor : [0.8, 0.8, 0.8]), 1];
    };
    for (const iv of measure.intervals) {
      const a = V.mix(p, q, iv.t0), b = V.mix(p, q, iv.t1);
      pts.push({ a, b, c: col(iv) });
    }
    if (!pts.length) return;
    const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
    gl.useProgram(this.pFlat);
    gl.uniformMatrix4fv(this.uFlat.uVP, false, vp);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.lineWidth(2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboDyn);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    for (const seg of pts) {
      gl.uniform4fv(this.uFlat.uColor, seg.c);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...seg.a, ...seg.b]), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, 2);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(prevDepthMask);
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
