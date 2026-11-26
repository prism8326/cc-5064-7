// 纯几何/数学：不依赖 DOM 与 WebGL，可在 Node 中直接测试。

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  mix: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

// ---------- mat4（列主序，与 WebGL 一致） ----------
export const M4 = {
  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) / (near - far); m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  },
  lookAt(eye, center, up) {
    const z = V.norm(V.sub(eye, center));
    const x = V.norm(V.cross(up, z));
    const y = V.cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -V.dot(x, eye), -V.dot(y, eye), -V.dot(z, eye), 1,
    ]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  },
  invert(m) {
    // 经典伴随矩阵法（gl-matrix 同款）
    const a = m; const inv = new Float32Array(16);
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7],
          a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10,
          b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12,
          b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30,
          b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
    if (!det) return null;
    det = 1.0 / det;
    inv[0]=(a11*b11-a12*b10+a13*b09)*det; inv[1]=(a02*b10-a01*b11-a03*b09)*det;
    inv[2]=(a31*b05-a32*b04+a33*b03)*det; inv[3]=(a22*b04-a21*b05-a23*b03)*det;
    inv[4]=(a12*b08-a10*b11-a13*b07)*det; inv[5]=(a00*b11-a02*b08+a03*b07)*det;
    inv[6]=(a32*b02-a30*b05-a33*b01)*det; inv[7]=(a20*b05-a22*b02+a23*b01)*det;
    inv[8]=(a10*b10-a11*b08+a13*b06)*det; inv[9]=(a01*b08-a00*b10-a03*b06)*det;
    inv[10]=(a30*b04-a31*b02+a33*b00)*det; inv[11]=(a21*b02-a20*b04-a23*b00)*det;
    inv[12]=(a11*b07-a10*b09-a12*b06)*det; inv[13]=(a00*b09-a01*b07+a02*b06)*det;
    inv[14]=(a31*b01-a30*b03-a32*b00)*det; inv[15]=(a20*b03-a21*b01+a22*b00)*det;
    return inv;
  },
  transformPoint(m, p) {
    const [x, y, z] = p;
    const w = m[3]*x + m[7]*y + m[11]*z + m[15];
    return [
      (m[0]*x + m[4]*y + m[8]*z + m[12]) / w,
      (m[1]*x + m[5]*y + m[9]*z + m[13]) / w,
      (m[2]*x + m[6]*y + m[10]*z + m[14]) / w,
    ];
  },
};

// ---------- 平面 ----------
// 平面：f(x) = dot(n, x) + d ；保留侧为 f > 0。
export function planeSignedDistance(n, d, p) {
  return V.dot(n, p) + d;
}

// 射线与平面：orig + t*dir，返回 t 或 null（平行）
export function rayPlane(orig, dir, n, d) {
  const denom = V.dot(n, dir);
  if (Math.abs(denom) < 1e-12) return null;
  return -(V.dot(n, orig) + d) / denom;
}

// ---------- 网格度量 ----------
export function triVertex(pos, i) {
  return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
}

// 有符号体积：闭合且外定向的壳为正。
export function signedVolume(positions, indices, start, count) {
  let v = 0;
  for (let i = start; i < start + count; i += 3) {
    const a = triVertex(positions, indices[i]);
    const b = triVertex(positions, indices[i + 1]);
    const c = triVertex(positions, indices[i + 2]);
    v += V.dot(a, V.cross(b, c)) / 6;
  }
  return v;
}

// Möller–Trumbore。命中返回 {t, front}；front 表示射线打在正面（法线·dir < 0）。
export function rayTriangle(orig, dir, a, b, c, eps = 1e-9) {
  const e1 = V.sub(b, a), e2 = V.sub(c, a);
  const p = V.cross(dir, e2);
  const det = V.dot(e1, p);
  if (Math.abs(det) < eps) return null;
  const inv = 1 / det;
  const s = V.sub(orig, a);
  const u = V.dot(s, p) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return null;
  const q = V.cross(s, e1);
  const v = V.dot(dir, q) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return null;
  const t = V.dot(e2, q) * inv;
  if (t < 1e-7) return null;
  return { t, u, v, front: det > 0 };
}

// 点到三角形距离（用于近裁面分析的显式检测）
export function pointTriangleDistance(p, a, b, c) {
  // Real-Time Collision Detection, Christer Ericson, 5.1.5
  const ab = V.sub(b, a), ac = V.sub(c, a), ap = V.sub(p, a);
  const d1 = V.dot(ab, ap), d2 = V.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return V.len(ap);
  const bp = V.sub(p, b);
  const d3 = V.dot(ab, bp), d4 = V.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return V.len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0)
    return V.len(V.sub(p, V.mix(a, b, d1 / (d1 - d3))));
  const cp = V.sub(p, c);
  const d5 = V.dot(ab, cp), d6 = V.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return V.len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0)
    return V.len(V.sub(p, V.mix(a, c, d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return V.len(V.sub(p, V.mix(b, c, (d4 - d3) / (d4 - d3 + d5 - d6))));
  const n = V.cross(ab, ac);
  return Math.abs(V.dot(ap, n) / V.len(n));
}

// ---------- 绕数 / 奇偶 ----------
// 从 point 出发投射射线，对给定壳列表统计穿越。
// 返回 { signed, count }：signed 为带壳有效符号的绕数，count 为无符号穿越次数（奇偶用）。
// 射线退化（擦边/擦顶点）时自动更换确定性备用方向。
const CAST_DIRS = [
  [1, 0, 0],
  V.norm([0.317, 0.906, 0.271]),
  V.norm([0.577, 0.289, 0.762]),
];
export function rayCrossings(model, shellIndices, point, dirIndex = 0) {
  const { positions, indices, shells } = model;
  for (let attempt = dirIndex; attempt < CAST_DIRS.length; attempt++) {
    const dir = CAST_DIRS[attempt];
    let signed = 0, count = 0, degenerate = false;
    for (const si of shellIndices) {
      const shell = model.shells[si];
      const eff = shellEffSign(model, si);
      for (let i = shell.start; i < shell.start + shell.count; i += 3) {
        const a = triVertex(positions, indices[i]);
        const b = triVertex(positions, indices[i + 1]);
        const c = triVertex(positions, indices[i + 2]);
        const hit = rayTriangle(point, dir, a, b, c);
        if (!hit) continue;
        // 命中过近或擦边/擦顶点 → 换方向重投，避免边/顶点二义性
        const edge = Math.min(hit.u, hit.v, 1 - hit.u - hit.v);
        if (hit.t < 1e-6 || edge < 1e-6) { degenerate = true; break; }
        signed += (hit.front ? 1 : -1) * eff;
        count += 1;
      }
      if (degenerate) break;
    }
    if (!degenerate) return { signed, count };
  }
  // 三个方向都退化（概率极低）：按不在内部处理并标记
  return { signed: 0, count: 0, degenerate: true };
}

// 壳的有效定向符号 = 元数据校正系数。
// 数据绕序本身已由 GL 正背面 / CPU 行列式表达；correction 仅在校验发现数据与可信资料不符时为 -1。
// 未定向壳（oriented===false）返回 0：填充器可接收该壳的几何，但绕数计数跳过其符号，
// 拾取器不会据此采信任何实体归属（方向判定表见 orientation.js）。
export function shellEffSign(model, shellIndex) {
  const s = model.shells[shellIndex];
  return s.oriented === false ? 0 : s.correction;
}

// 每个零件在指定点的绕数（相机补偿、拾取共用）
export function partWindingAt(model, partIndex, point) {
  return rayCrossings(model, model.parts[partIndex].shells, point).signed;
}

// 零件嵌套深度：零件表面采样点被多少其它零件包含（绕数语义，结构属性，与显示语义无关）
export function partDepths(model) {
  const depths = new Array(model.parts.length).fill(0);
  // 取各零件首个壳的第一个顶点：它在该零件表面上，中空零件不会被误判为被内部零件包含
  const samples = model.parts.map((p) => {
    const s = model.shells[p.shells[0]];
    return triVertex(model.positions, model.indices[s.start]);
  });
  for (let i = 0; i < model.parts.length; i++)
    for (let j = 0; j < model.parts.length; j++) {
      if (i === j) continue;
      if (rayCrossings(model, model.parts[j].shells, samples[i]).signed !== 0) depths[i]++;
    }
  return depths;
}

// 点分类：返回 { kind:'solid', part } | { kind:'air' }
// semantic: 'winding' | 'parity'
export function classifyPoint(model, point, semantic) {
  const depths = model._partDepths || (model._partDepths = partDepths(model));
  let best = null;
  for (let pi = 0; pi < model.parts.length; pi++) {
    const { signed, count } = rayCrossings(model, model.parts[pi].shells, point);
    const inside = semantic === 'winding' ? signed !== 0 : count % 2 === 1;
    if (inside && (best === null || depths[pi] > depths[best])) best = pi;
  }
  if (best === null) return { kind: 'air' };
  return { kind: 'solid', part: best, name: model.parts[best].name };
}

// 平面正交基（SVG 投影、平面边框显示用）
export function planeBasis(n) {
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = V.norm(V.cross(n, ref));
  return [u, V.cross(n, u)];
}

// ---------- 相机与几何的显式关系（深度/模板顺序分析用） ----------
export function minDistanceToMesh(model, p) {
  let min = Infinity;
  for (const s of model.shells)
    for (let i = s.start; i < s.start + s.count; i += 3) {
      const dist = pointTriangleDistance(
        p,
        triVertex(model.positions, model.indices[i]),
        triVertex(model.positions, model.indices[i + 1]),
        triVertex(model.positions, model.indices[i + 2])
      );
      if (dist < min) min = dist;
    }
  return min;
}

// 相机相对每个零件的绕数（模板初值补偿量）；parity 语义时取 count 奇偶
export function cameraWinding(model, eye, semantic) {
  return model.parts.map((p) => {
    const { signed, count } = rayCrossings(model, p.shells, eye);
    return semantic === 'winding' ? signed : count % 2;
  });
}

// FNV-1a：自检用，验证源网格未被渲染管线修改
export function hashMesh(model) {
  let h = 0x811c9dc5;
  const mix = (x) => { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; };
  for (let i = 0; i < model.positions.length; i++)
    mix(Math.round(model.positions[i] * 1e6) & 0xffff);
  for (let i = 0; i < model.indices.length; i++) mix(model.indices[i]);
  return h >>> 0;
}
