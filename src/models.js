// 模型构建：全部为闭合三角网格。源网格只被读取，永不被修改。
import { signedVolume } from './geom.js';

// 外定向（CCW）盒：24 顶点（每面独立法线）+ 12 三角形；reverse=true 时逐三角形反转绕序
// mirrorX=true 时仅镜像几何 x 坐标（保持绕序索引不变 → 有符号体积变号），外壳可保持原位
function boxShell(cx, cy, cz, s, reverse = false, mirrorX = false) {
  const h = s / 2;
  const faces = [
    { n: [1, 0, 0],  q: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { n: [-1, 0, 0], q: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
    { n: [0, 1, 0],  q: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { n: [0, -1, 0], q: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [0, 0, 1],  q: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], q: [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]] },
  ];
  const positions = [], normals = [], indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const q of f.q) {
      const gx = mirrorX ? -q[0] : q[0];
      positions.push(cx + gx * h, cy + q[1] * h, cz + q[2] * h);
      normals.push(...(reverse ? f.n.map((x) => -x) : f.n));
    }
    const t = reverse ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of t) indices.push(base + k);
  }
  return { positions, normals, indices };
}

// 把多个壳合并成一个模型缓冲
function combine(id, label, signed, shellDefs, partDefs) {
  const positions = [], normals = [], indices = [];
  const shells = [];
  for (const sd of shellDefs) {
    const mesh = boxShell(sd.box[0], sd.box[1], sd.box[2], sd.box[3], !!sd.flip, !!sd.mirrorX);
    const vBase = positions.length / 3;
    const iBase = indices.length;
    positions.push(...mesh.positions);
    normals.push(...mesh.normals);
    for (const ix of mesh.indices) indices.push(ix + vBase);
    shells.push({
      name: sd.name,
      role: sd.role || null, // 'solid' | 'void'（仅签名模型可信）
      start: iBase,
      count: mesh.indices.length,
      correction: 1,
      oriented: true, // 构建期默认已定向；未签名三角汤在 finalizeOrientation 中按需置 false
      volume: 0,
    });
  }
  const model = {
    id, label, signed,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    shells,
    parts: partDefs
      ? partDefs.map((p) => ({ name: p.name, color: p.color, capColor: p.capColor, shells: p.shells.slice() }))
      : null,
    implicitPart: false,
    ambiguous: false,
    corrections: [],
  };
  for (let i = 0; i < shells.length; i++)
    shells[i].volume = signedVolume(model.positions, model.indices, shells[i].start, shells[i].count);
  finalizeOrientation(model);
  // 快照运行时元数据，便于“重新加载”撤销用户裁决（源网格数组本身永不被修改）
  model._pristine = {
    corrections: shells.map((s) => s.correction),
    oriented: shells.map((s) => s.oriented),
    ambiguous: model.ambiguous,
    parts: model.parts.map((p) => ({ ...p, shells: p.shells.slice() })),
    implicitPart: model.implicitPart,
  };
  return model;
}

// 撤销用户裁决，恢复构建时的壳符号与零件归属
export function resetModel(model) {
  const p = model._pristine;
  model.shells.forEach((s, i) => {
    s.correction = p.corrections[i];
    s.oriented = p.oriented[i];
  });
  model.ambiguous = p.ambiguous;
  model.parts = p.parts.map((x) => ({ ...x, shells: x.shells.slice() }));
  model.implicitPart = p.implicitPart;
  delete model._partDepths;
}

// 方向快照/恢复：翻面更新与撤销交错抵达时逐帧重放用（独立于 resetModel）。
export function snapshotOrientation(model) {
  return {
    shells: model.shells.map((s) => ({ correction: s.correction, oriented: s.oriented })),
    parts: model.parts.map((p) => ({ name: p.name, color: p.color.slice(), capColor: p.capColor.slice(), shells: p.shells.slice() })),
    ambiguous: model.ambiguous,
  };
}
export function restoreOrientation(model, snap) {
  model.shells.forEach((s, i) => {
    s.correction = snap.shells[i].correction;
    s.oriented = snap.shells[i].oriented;
  });
  model.parts = snap.parts.map((p) => ({ name: p.name, color: p.color.slice(), capColor: p.capColor.slice(), shells: p.shells.slice() }));
  model.ambiguous = snap.ambiguous;
  delete model._partDepths;
}

// 翻转一个局部壳的有效定向（只改元数据，源网格不变）。
// 空腔壳翻成实体壳时把它拆为独立零件：轮廓形状不变，内部零件身份改变。
const FLIP_COLOR = { color: [0.25, 0.62, 0.68], capColor: [0.15, 0.85, 0.9] };
export function flipShell(model, shellIndex) {
  const s = model.shells[shellIndex];
  s.correction = -s.correction;
  s.oriented = true;
  const owner = model.parts.find((p) => p.shells.includes(shellIndex));
  if (owner && owner.shells.length > 1) {
    owner.shells = owner.shells.filter((si) => si !== shellIndex);
    model.parts.push({ name: '翻面内件', ...FLIP_COLOR, shells: [shellIndex] });
  }
  model.ambiguous = false;
  delete model._partDepths;
}

// 把局部壳标记为未定向（填充器仍可接收其几何；拾取器不采信归属）。
export function markUndetermined(model, shellIndex) {
  model.shells[shellIndex].oriented = false;
  delete model._partDepths;
}

// 定向分析：
// - 签名模型：按可信资料（role）校正；数据绕序与资料不符时置 correction=-1（逻辑符号，不改源数据）。
// - 未签名模型：与“按 |体积| 降序实心/空腔交替”的期望比对；不一致 → ambiguous，交由用户裁决。
function finalizeOrientation(model) {
  if (!model.parts) {
    // 三角汤：全部壳归入一个隐式零件以便渲染；分类语义由用户裁决
    model.parts = [{
      name: '（未分组三角汤）',
      color: [0.6, 0.6, 0.62], capColor: [0.72, 0.72, 0.75],
      shells: model.shells.map((_, i) => i),
    }];
    model.implicitPart = true;
  }
  const order = model.shells
    .map((s, i) => ({ i, a: Math.abs(s.volume) }))
    .sort((a, b) => b.a - a.a)
    .map((e) => e.i);
  model.shells.forEach((s, i) => {
    const rank = order.indexOf(i);
    const expected = s.role ? (s.role === 'solid' ? 1 : -1) : rank % 2 === 0 ? 1 : -1;
    const actual = s.volume >= 0 ? 1 : -1;
    if (model.signed) {
      if (actual !== expected) {
        s.correction = -1;
        model.corrections.push(
          `壳「${s.name}」数据绕序与签名资料不符，已按可信资料校正（correction=-1，源网格未改）`
        );
      }
    } else if (actual !== expected) {
      // 未签名且与期望定向不符：无法区分空腔与嵌入实心件 → 未定向局部壳。
      // 填充器可接收该几何（绕数语义下跳过其符号计数），拾取器不采信其归属，等待用户裁决。
      s.oriented = false;
      model.ambiguous = true;
    }
  });
}

const C = {
  housing: [0.82, 0.55, 0.28], housingCap: [0.98, 0.62, 0.18],
  insert: [0.25, 0.62, 0.68],  insertCap: [0.15, 0.85, 0.9],
  solid: [0.5, 0.72, 0.45],    solidCap: [0.45, 0.9, 0.45],
};

export function buildModels() {
  return [
    combine(
      'solid', '实心盒（单壳）', true,
      [{ box: [0, 0, 0, 2], name: '外壳', role: 'solid' }],
      [{ name: '实体', color: C.solid, capColor: C.solidCap, shells: [0] }]
    ),
    combine(
      'cavity', '空腔盒（外壳 + 反向空腔壳）', true,
      [
        { box: [0, 0, 0, 2], name: '外壳', role: 'solid' },
        { box: [0, 0, 0, 1], name: '空腔壳', role: 'void', flip: true },
      ],
      [{ name: '外壳体', color: C.housing, capColor: C.housingCap, shells: [0, 1] }]
    ),
    combine(
      'insert', '嵌入件盒（外壳相同，内为独立实心件）', true,
      [
        { box: [0, 0, 0, 2], name: '外壳', role: 'solid' },
        { box: [0, 0, 0, 1], name: '嵌入件', role: 'solid' },
      ],
      [
        { name: '外壳体', color: C.housing, capColor: C.housingCap, shells: [0] },
        { name: '嵌入件', color: C.insert, capColor: C.insertCap, shells: [1] },
      ]
    ),
    combine(
      'nested', '嵌套双壳（同向，绕数=2 区）', true,
      [
        { box: [0, 0, 0, 2], name: '外壳', role: 'solid' },
        { box: [0, 0, 0, 1.2], name: '内壳', role: 'solid' },
      ],
      [{ name: '双层实体', color: C.solid, capColor: C.solidCap, shells: [0, 1] }]
    ),
    combine(
      'flipped', '空腔盒·内壳数据被反转（签名资料可纠正）', true,
      [
        { box: [0, 0, 0, 2], name: '外壳', role: 'solid' },
        // 数据层面未反转（体积为正），但签名资料声明它是空腔 → 自动 correction=-1
        { box: [0, 0, 0, 1], name: '空腔壳（数据绕序错误）', role: 'void' },
      ],
      [{ name: '外壳体', color: C.housing, capColor: C.housingCap, shells: [0, 1] }]
    ),
    combine(
      'mirror', '镜像内壳（仅内壳镜像，外壳原位；截面可从相切拖到相交）', true,
      [
        { box: [0, 0, 0, 2], name: '外壳', role: 'solid' },
        // 镜像几何使有符号体积变号；签名资料仍声明为空腔，correction 把逻辑定向校正回空腔
        { box: [0, 0, 0, 1], name: '镜像内壳', role: 'void', mirrorX: true },
      ],
      [{ name: '外壳体', color: C.housing, capColor: C.housingCap, shells: [0, 1] }]
    ),
    combine(
      'soup', '未签名三角汤（外壳相同，内壳正向，无零件归属）', false,
      [
        { box: [0, 0, 0, 2], name: '壳 A' },
        { box: [0, 0, 0, 1], name: '壳 B' },
      ],
      null
    ),
  ];
}
