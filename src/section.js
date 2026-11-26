// 截面覆盖求值：只依赖方向判定表与源网格，不依赖 DOM/WebGL。
// 三条独立输出链路：
//   ① 截面轮廓（平面×三角面交线，纯形状，不含归属）
//   ② 覆盖求值（截面模板计数方案 + 采样点实体/孔洞掩码，独立射线核对）
//   ③ 测量线覆盖区间（2D 截线求交定边界，3D 射线独立定身份）
import {
  V, triVertex, rayCrossings, planeBasis, hashMesh, partDepths,
} from './geom.js';
import { shellCountSign, shellIsOriented } from './orientation.js';

// ---------- ① 截面轮廓（从 geom 迁出：只读源网格，不修改） ----------
export function trianglePlaneSegment(a, b, c, n, d) {
  const pts = [a, b, c];
  const f = pts.map((p) => V.dot(n, p) + d);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const fi = f[i], fj = f[j];
    if (fi === 0 && fj === 0) continue; // 共面边：相邻三角形会提供
    if (fi * fj < 0) out.push(V.mix(pts[i], pts[j], fi / (fi - fj)));
    else if (fi === 0) out.push(pts[i]);
  }
  const uniq = [];
  for (const p of out)
    if (!uniq.some((q) => V.len(V.sub(p, q)) < 1e-9)) uniq.push(p);
  return uniq.length === 2 ? uniq : null;
}

// 轮廓按壳分组：翻面只改方向表，不改交线几何，两次结果可逐点对照。
export function sectionContours(model, n, d) {
  const segments = [];
  const shellPart = new Array(model.shells.length).fill(-1);
  model.parts.forEach((p, pi) => p.shells.forEach((si) => (shellPart[si] = pi)));
  const byShell = model.shells.map(() => []);
  model.shells.forEach((s, si) => {
    for (let i = s.start; i < s.start + s.count; i += 3) {
      const a = triVertex(model.positions, model.indices[i]);
      const b = triVertex(model.positions, model.indices[i + 1]);
      const c = triVertex(model.positions, model.indices[i + 2]);
      const seg = trianglePlaneSegment(a, b, c, n, d);
      if (!seg) continue;
      const rec = { shell: si, part: shellPart[si], a: seg[0], b: seg[1] };
      segments.push(rec);
      byShell[si].push(rec);
    }
  });
  return {
    plane: { n: n.slice(), d },
    segments,
    byShell: byShell.map((segs, si) => ({ shell: si, count: segs.length, segments: segs })),
    count: segments.length,
  };
}

// ---------- ② 有向交点：逐壳独立核对 ----------
// 每个壳单独报 { signed(带有效符号), count(无符号), oriented, countSign }，
// 凹入区与空腔的有向交点数量因此互不牵连：局部翻面只改本壳这一行。
export function directedCrossingsAt(model, point) {
  const perShell = model.shells.map((s, si) => {
    const r = rayCrossings(model, [si], point);
    return {
      shell: si,
      name: s.name,
      signed: r.signed,
      count: r.count,
      degenerate: !!r.degenerate,
      oriented: shellIsOriented(model, si),
      countSign: shellCountSign(model, si),
    };
  });
  return {
    point,
    perShell,
    totalSigned: perShell.reduce((a, r) => a + r.signed, 0),
    totalCount: perShell.reduce((a, r) => a + r.count, 0),
  };
}

// 拾取采信：只返回已确定实体归属的零件。
// 绕数语义下未定向壳不计符号；奇偶虽可计数，但候选零件含未定向壳时仍不采信身份。
export function pickSolidAt(model, point, semantic) {
  const depths = model._partDepths || (model._partDepths = partDepths(model));
  let best = null;
  for (let pi = 0; pi < model.parts.length; pi++) {
    const part = model.parts[pi];
    const orientedShells = part.shells.filter((si) => shellIsOriented(model, si));
    if (orientedShells.length !== part.shells.length) continue; // 含未定向壳 → 身份不可采信
    const { signed, count } = rayCrossings(model, part.shells, point);
    const inside = semantic === 'winding' ? signed !== 0 : count % 2 === 1;
    if (inside && (best === null || depths[pi] > depths[best])) best = pi;
  }
  if (best === null) return null;
  return { part: best, name: model.parts[best].name };
}

// ---------- 截面模板计数方案（GL 计数通道的纯 CPU 描述） ----------
// 输入：模型、平面、相机位置、语义；输出：逐零件的计数输入与封口判定，不含任何 GL 调用。
export function coveragePlan(model, n, d, eye, semantic) {
  const parity = semantic === 'parity';
  const fCam = V.dot(n, eye) + d;
  const camSide = fCam >= 0 ? 1 : -1;
  const parts = model.parts.map((part, pi) => {
    const cam = rayCrossings(model, part.shells, eye);
    const cameraWinding = parity ? cam.count % 2 : cam.signed;
    return {
      part: pi,
      name: part.name,
      camSide,
      cameraWinding,
      parity,
      // 计数通道逐壳输入：未定向壳 countSign=0，绕数语义下不写模板（填充器可接收但跳过符号）
      shells: part.shells.map((si) => ({
        shell: si,
        oriented: shellIsOriented(model, si),
        countSign: shellCountSign(model, si),
        frontOp: parity ? 'INVERT' : shellCountSign(model, si) > 0 ? 'DECR_WRAP' : shellCountSign(model, si) < 0 ? 'INCR_WRAP' : 'SKIP',
        backOp: parity ? 'INVERT' : shellCountSign(model, si) > 0 ? 'INCR_WRAP' : shellCountSign(model, si) < 0 ? 'DECR_WRAP' : 'SKIP',
      })),
      capTest: parity ? { func: 'NOTEQUAL', ref: 0, mask: 0x01 } : { func: 'NOTEQUAL', ref: 0, mask: 0xff },
    };
  });
  return { plane: { n: n.slice(), d }, semantic, camSide: fCam >= 0 ? 1 : -1, parts };
}

// ---------- 孔洞掩码：绕数（已定向）与奇偶（无向）两条独立链路对照 ----------
export function sectionHoleMask(model, n, d, samples = 12) {
  const { segments } = sectionContours(model, n, d);
  const [u, v] = planeBasis(n);
  let x0 = -2, x1 = 2, y0 = -2, y1 = 2;
  if (segments.length) {
    const pts = segments.flatMap((s) => [s.a, s.b]);
    const xs = pts.map((p) => V.dot(p, u)), ys = pts.map((p) => V.dot(p, v));
    x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys); y1 = Math.max(...ys);
  }
  const center = V.scale(n, -d);
  const grid = [];
  let solidW = 0, solidP = 0, agree = 0;
  const disagree = [];
  for (let i = 0; i < samples; i++)
    for (let j = 0; j < samples; j++) {
      const tu = (i + 0.5) / samples, tv = (j + 0.5) / samples;
      const w = V.add(center, V.add(
        V.scale(u, x0 + tu * (x1 - x0)),
        V.scale(v, y0 + tv * (y1 - y0)),
      ));
      const dir = directedCrossingsAt(model, w);
      const windingInside = dir.totalSigned !== 0;
      const parityInside = dir.totalCount % 2 === 1;
      const pick = pickSolidAt(model, w, 'winding');
      const same = windingInside === parityInside;
      if (windingInside) solidW++;
      if (parityInside) solidP++;
      if (same) agree++; else disagree.push(w);
      grid.push({ point: w, windingInside, parityInside, part: pick ? pick.part : -1, signed: dir.totalSigned, count: dir.totalCount });
    }
  return {
    samples: grid,
    totals: { n: grid.length, solidWinding: solidW, solidParity: solidP, agree, disagree: disagree.length },
    disagree,
  };
}

// 可独立执行的区段计数入口：绘图窗口与 Node CLI 共用同一份剖面逻辑。
export function countSection(model, n, d, semantic = 'winding', samples = 12) {
  const contours = sectionContours(model, n, d);
  const mask = sectionHoleMask(model, n, d, samples);
  return {
    type: 'section-count',
    model: model.label,
    plane: { n: n.slice(), d },
    semantic,
    contourCount: contours.count,
    perShell: contours.byShell.map((b) => ({ shell: b.shell, count: b.count })),
    mask: mask.totals,
    samples: mask.samples,
  };
}

// ---------- ③ 测量线覆盖区间 ----------
function segCross2D(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null; // 共线/平行：不在测量线设计中出现
  const s = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const t = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  const eps = 1e-9;
  if (s < -eps || s > 1 + eps || t < -eps || t > 1 + eps) return null;
  return Math.min(1, Math.max(0, t));
}

// 测量线 p→q（须落在平面 n·x+d=0 上）：截线交点切出参数边界，
// 每个子区间中点用独立 3D 射线判定实体/空气与零件身份，并附带逐壳有向交点。
export function lineCoverage(model, n, d, p, q, semantic = 'winding') {
  const [u, v] = planeBasis(n);
  const to2 = (p3) => [V.dot(p3, u), V.dot(p3, v)];
  const L0 = to2(p), L1 = to2(q);
  const { segments } = sectionContours(model, n, d);
  const ts = new Set([0, 1]);
  for (const s of segments) {
    const t = segCross2D(L0, L1, to2(s.a), to2(s.b));
    if (t !== null) ts.add(Math.round(t * 1e9) / 1e9);
  }
  const sorted = [...ts].sort((a, b) => a - b);
  const raw = [];
  for (let k = 0; k < sorted.length - 1; k++) {
    const t0 = sorted[k], t1 = sorted[k + 1];
    if (t1 - t0 < 1e-9) continue;
    const w = V.mix(p, q, (t0 + t1) / 2);
    const pick = pickSolidAt(model, w, semantic);
    const crossings = directedCrossingsAt(model, w);
    raw.push({
      t0, t1,
      kind: pick ? 'solid' : 'air',
      part: pick ? pick.part : -1,
      name: pick ? pick.name : null,
      signed: crossings.totalSigned,
      count: crossings.totalCount,
      perShell: crossings.perShell,
    });
  }
  // 合并相邻同身份区间
  const intervals = [];
  for (const iv of raw) {
    const last = intervals[intervals.length - 1];
    if (last && last.kind === iv.kind && last.part === iv.part) last.t1 = iv.t1;
    else intervals.push({ ...iv });
  }
  return { line: { p, q }, semantic, intervals, contourCount: segments.length };
}

// ---------- 截面结果缓存：键必须含方向/归属，轮廓形状命中不算命中 ----------
function partsSignature(model) {
  return model.parts.map((p) => p.shells.join('>')).join('|');
}
function orientationSignature(model) {
  return model.shells.map((s) => `${s.oriented === false ? 'u' : 'o'}:${s.correction}`).join('|');
}
export function sectionCacheKey(model, n, d, semantic) {
  return [
    hashMesh(model),
    n.map((x) => x.toFixed(6)).join(','),
    d.toFixed(6),
    semantic,
    orientationSignature(model),
    partsSignature(model),
  ].join('#');
}
// 仅按几何轮廓形状构造的键（故意忽略归属）：测试用，证明它会在翻面例上错误命中。
export function shapeOnlyCacheKey(model, n, d) {
  return [hashMesh(model), n.map((x) => x.toFixed(6)).join(','), d.toFixed(6)].join('#');
}
export class SectionResultCache {
  constructor() { this.map = new Map(); }
  get(model, n, d, semantic) { return this.map.get(sectionCacheKey(model, n, d, semantic)); }
  set(model, n, d, semantic, result) { this.map.set(sectionCacheKey(model, n, d, semantic), result); }
  get shapeHits() { return this.map.size; }
}
