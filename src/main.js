// 交互主控：相机、平面拖动、拾取分类、状态分析、导出。
import { V, M4, rayPlane, classifyPoint, sectionSegments, planeBasis, minDistanceToMesh, cameraWinding, hashMesh } from './geom.js';
import { buildModels, resetModel } from './models.js';
import { Renderer } from './gl.js';
import { runSelfTests } from './selftest.js';

const canvas = document.getElementById('gl');
const renderer = new Renderer(canvas);
const models = buildModels();

const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const state = {
  model: models[1], // 默认空腔盒
  axis: 'z',
  planeD: 0,
  semantic: 'winding',
  selection: -1,          // 拾取选中的零件（高亮封口）
  pickNDC: null,          // 拾取点的屏幕坐标（拖平面时持续重分类）
  pickInfo: null,
  cam: { theta: -2.0, phi: 0.35, dist: 5.2, target: [0, 0, 0], fov: (50 * Math.PI) / 180, near: 0.05, far: 60, up: [0, 1, 0] },
  soupOverride: null,     // 未签名模型的用户裁决
};

const $ = (id) => document.getElementById(id);

// ---------- 相机 ----------
function camera() {
  const c = state.cam;
  const cp = Math.cos(c.phi), sp = Math.sin(c.phi);
  const eye = [
    c.target[0] + c.dist * cp * Math.cos(c.theta),
    c.target[1] + c.dist * sp,
    c.target[2] + c.dist * cp * Math.sin(c.theta),
  ];
  return { eye, center: c.target, up: c.up, fov: c.fov, near: c.near, far: c.far };
}
function cameraMatrices() {
  const c = camera();
  const aspect = canvas.width / Math.max(1, canvas.height);
  const proj = M4.perspective(c.fov, aspect, c.near, c.far);
  const view = M4.lookAt(c.eye, c.center, c.up);
  const vp = M4.mul(proj, view);
  return { cam: c, vp, invVP: M4.invert(vp) };
}
function plane() {
  return { n: AXIS[state.axis], d: state.planeD };
}

// 屏幕坐标（CSS 像素）→ 世界射线
function screenRay(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const nx = ((clientX - r.left) / r.width) * 2 - 1;
  const ny = 1 - ((clientY - r.top) / r.height) * 2;
  const { cam, invVP } = cameraMatrices();
  const p0 = M4.transformPoint(invVP, [nx, ny, -1]);
  const p1 = M4.transformPoint(invVP, [nx, ny, 1]);
  return { eye: cam.eye, dir: V.norm(V.sub(p1, p0)), ndc: [nx, ny] };
}

// ---------- 拾取分类 ----------
function classifyAtNDC(ndc) {
  const { cam, invVP } = cameraMatrices();
  const p0 = M4.transformPoint(invVP, [ndc[0], ndc[1], -1]);
  const p1 = M4.transformPoint(invVP, [ndc[0], ndc[1], 1]);
  const dir = V.norm(V.sub(p1, p0));
  const { n, d } = plane();
  const t = rayPlane(cam.eye, dir, n, d);
  if (t === null || t < 0) return { error: '射线与剖面平行或平面在身后' };
  const P = V.add(cam.eye, V.scale(dir, t));
  const m = state.model;
  if (m.ambiguous && !state.soupOverride)
    return { point: P, cls: { kind: 'ambiguous' } };
  const cls = classifyPoint(m, P, state.semantic);
  return { point: P, cls };
}

function updatePick() {
  if (!state.pickNDC) return;
  const r = classifyAtNDC(state.pickNDC);
  state.pickInfo = r;
  if (r.cls && r.cls.kind === 'solid') state.selection = r.cls.part;
  else state.selection = -1;
  const el = $('pick');
  if (r.error) { el.textContent = '拾取：' + r.error; return; }
  const p = r.point.map((x) => x.toFixed(3)).join(', ');
  if (r.cls.kind === 'ambiguous') {
    el.textContent = `拾取点 (${p})\n结果：模型未签名且定向不一致 → 歧义，请先在上方裁决。`;
  } else if (r.cls.kind === 'air') {
    el.textContent = `拾取点 (${p})\n分类：空气（空腔/零件之外）→ 未选中任何零件`;
  } else {
    el.textContent = `拾取点 (${p})\n分类：实体 → 选中零件「${r.cls.name}」（封口已高亮）`;
  }
}

// ---------- 状态分析（深度/模板顺序） ----------
function updateStatus() {
  const m = state.model;
  const { cam } = cameraMatrices();
  const { n, d } = plane();
  const fCam = V.dot(n, cam.eye) + d;
  const camW = cameraWinding(m, cam.eye, state.semantic);
  const inside = m.parts
    .map((p, i) => (camW[i] !== 0 ? `「${p.name}」(w=${camW[i]})` : null))
    .filter(Boolean);
  const minDist = minDistanceToMesh(m, cam.eye);
  const nearOK = minDist > cam.near * 1.5;
  const lines = [
    `语义：${state.semantic === 'winding' ? '绕数（正面-1/背面+1，从相机绕数中减去穿越，测试 !=0）' : '奇偶（INVERT，测试 bit0）'}`,
    `相机：f(eye)=${fCam.toFixed(3)} → 计数侧=${fCam >= 0 ? '保留侧' : '裁掉侧'}；${inside.length ? '位于实体内部 ' + inside.join(' ') : '位于实体外部'}`,
    `逐零件模板初值（相机绕数补偿）：[${camW.join(', ')}]`,
    `近裁面：相机到网格净距 ${minDist.toFixed(3)}，near=${cam.near} → ${nearOK ? '安全（near 未切割几何）' : '警告：近裁面可能切割几何，模板计数不可信，请拉远相机'}`,
  ];
  if (m.corrections.length) lines.push(...m.corrections);
  if (m.ambiguous && !state.soupOverride) lines.push('未签名三角汤：定向歧义未裁决');
  if (state.soupOverride) lines.push(`三角汤裁决：${state.soupOverride}`);
  const el = $('status');
  el.textContent = lines.join('\n');
  el.classList.toggle('warn', !nearOK || (m.ambiguous && !state.soupOverride));
  return { nearOK, inside: inside.length > 0, camW, minDist };
}

// ---------- 渲染循环 ----------
function frame() {
  updatePick();
  const { n, d } = plane();
  let marker = null;
  if (state.pickInfo && state.pickInfo.point) {
    const solid = state.pickInfo.cls.kind === 'solid';
    marker = {
      pos: state.pickInfo.point,
      color: solid ? [1, 0.95, 0.3, 1] : [0.75, 0.75, 0.78, 1],
    };
  }
  renderer.render(camera(), { n, d }, state.semantic, state.selection, marker);
  updateStatus();
  requestAnimationFrame(frame);
}

// ---------- 交互 ----------
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false, plane: e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.plane || e.shiftKey) {
    state.planeD = Math.max(-1.6, Math.min(1.6, state.planeD - dy * 0.008));
    $('planeD').value = state.planeD;
  } else {
    state.cam.theta += dx * 0.008;
    state.cam.phi = Math.max(-1.5, Math.min(1.5, state.cam.phi + dy * 0.008));
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    // 单击：在剖面上拾取
    const ray = screenRay(e.clientX, e.clientY);
    state.pickNDC = ray.ndc;
    updatePick();
  }
  drag = null;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.cam.dist = Math.max(1.2, Math.min(20, state.cam.dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });

// ---------- UI ----------
function initUI() {
  const sel = $('model');
  models.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = m.label;
    sel.appendChild(o);
  });
  sel.value = String(models.indexOf(state.model));
  sel.onchange = () => loadModel(models[+sel.value]);
  $('planeD').oninput = (e) => { state.planeD = +e.target.value; };
  document.querySelectorAll('input[name=axis]').forEach((r) => {
    r.onchange = () => { state.axis = r.value; };
  });
  document.querySelectorAll('input[name=sem]').forEach((r) => {
    r.onchange = () => { state.semantic = r.value; };
  });
  $('export').onclick = exportSection;
  $('runTests').onclick = async () => {
    const ul = $('selftest');
    ul.innerHTML = '';
    const results = await runSelfTests(app);
    for (const r of results) {
      const li = document.createElement('li');
      li.className = r.pass ? 'pass' : 'fail';
      li.textContent = `${r.pass ? '通过' : '失败'} — ${r.name}${r.detail ? '：' + r.detail : ''}`;
      ul.appendChild(li);
    }
  };
  $('implnote').textContent = [
    '通道顺序：① 保留侧几何（颜色+深度，fragment discard 实现裁剪，源网格不变）→ ② 逐零件模板计数（仅相机侧壳面：绕数语义正面-1/背面+1，即从相机绕数中减去沿途穿越数；奇偶语义 INVERT；模板初值=相机对该零件的绕数，补偿相机位于实体内部的情形）→ ③ 模板 !=0 处绘制封口（全屏三角形逐像素求平面交点并写入真实深度，LEQUAL）。',
    '封口不是画在剖面上的矩形：它逐像素由模板计数驱动，空腔/孔洞处计数为 0 自然留空（自检第 2、3 项直接对比关闭模板测试后的退化行为）。',
    '遮挡由深度缓冲保证：封口写在平面真实深度上，相机位于保留侧时外壁深度更近，封口被正确遮挡（自检第 6 项）。',
    '限制（初版）：模型须闭合；绕数语义要求定向一致（签名模型自动校正，未签名三角汤提示歧义）；near 切割几何时状态栏显式告警而非静默出错。',
    '导出范围：仅截面交线轮廓；封口为实时渲染效果，未生成可制造的闭合几何；源网格始终保持未切割。',
  ].join('\n\n');
  updateAmbiguityUI();
}

function loadModel(m) {
  resetModel(m); // 撤销上次可能存在的用户裁决
  state.model = m;
  state.selection = -1;
  state.pickNDC = null;
  state.pickInfo = null;
  state.soupOverride = null;
  $('pick').textContent = '尚未拾取。单击剖切面。';
  renderer.setModel(m);
  updateAmbiguityUI();
}

function updateAmbiguityUI() {
  const m = state.model;
  const box = $('ambiguity');
  if (!(m.ambiguous && !state.soupOverride)) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '';
  const msg = document.createElement('div');
  msg.textContent = '警告：未签名三角汤，内壳为正向（不像空腔）。无法区分「空腔」与「嵌入实心件」，请裁决：';
  box.appendChild(msg);
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    box.appendChild(b);
  };
  mk('按奇偶规则继续（方向无关）', () => {
    state.soupOverride = '奇偶规则';
    state.semantic = 'parity';
    document.querySelector('input[name=sem][value=parity]').checked = true;
    updateAmbiguityUI();
  });
  mk('裁决：内壳是空腔（逻辑反转，不改源数据）', () => {
    state.soupOverride = '内壳=空腔';
    m.shells[1].correction = -1;
    m.ambiguous = false;
    updateAmbiguityUI();
  });
  mk('裁决：内壳是独立实心件', () => {
    state.soupOverride = '内壳=独立实心件';
    m.parts = [
      { name: '外壳体', color: [0.82, 0.55, 0.28], capColor: [0.98, 0.62, 0.18], shells: [0] },
      { name: '内件', color: [0.25, 0.62, 0.68], capColor: [0.15, 0.85, 0.9], shells: [1] },
    ];
    m.ambiguous = false;
    renderer.setModel(m); // 零件结构变化，重建绘制顺序（源缓冲不变）
    updateAmbiguityUI();
  });
}

// ---------- 导出（仅轮廓；明确不是封闭实体） ----------
function exportSection() {
  const m = state.model;
  const { n, d } = plane();
  const segs = sectionSegments(m, n, d);
  const json = {
    type: 'section-contours',
    note: '源网格未被切割；以下仅为平面与三角面的交线轮廓，不是封闭实体。剖面封口为模板缓冲实时渲染效果，未生成可制造几何。',
    model: m.label,
    plane: { n, d },
    segments: segs,
  };
  download('section.json', JSON.stringify(json, null, 2), 'application/json');

  const [u, v] = planeBasis(n);
  const pts = segs.flatMap((s) => [s.a, s.b]);
  if (pts.length) {
    const xs = pts.map((p) => V.dot(p, u)), ys = pts.map((p) => V.dot(p, v));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const S = 400 / Math.max(x1 - x0, y1 - y0, 1e-6);
    const lines = segs.map((s) => {
      const ax = (V.dot(s.a, u) - x0) * S, ay = (V.dot(s.a, v) - y0) * S;
      const bx = (V.dot(s.b, u) - x0) * S, by = (V.dot(s.b, v) - y0) * S;
      const col = s.part >= 0 ? '#e8912d' : '#888';
      return `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${col}" stroke-width="1.5"/>`;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${((x1 - x0) * S).toFixed(0)}" height="${((y1 - y0) * S).toFixed(0)}"><rect width="100%" height="100%" fill="#16181c"/>${lines.join('')}</svg>`;
    download('section.svg', svg, 'image/svg+xml');
  }
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 暴露给自检的控制器 ----------
const app = {
  renderer,
  state,
  models,
  loadModelById(id) {
    const m = models.find((x) => x.id === id);
    loadModel(m);
    document.getElementById('model').value = String(models.indexOf(m));
  },
  setPlane(axis, d) { state.axis = axis; state.planeD = d; },
  setSemantic(s) { state.semantic = s; },
  setCamera(eye, center, dist) {
    const d = V.norm(V.sub(eye, center));
    state.cam.target = center;
    state.cam.dist = dist !== undefined ? dist : V.len(V.sub(eye, center));
    state.cam.phi = Math.asin(Math.max(-1, Math.min(1, d[1])));
    state.cam.theta = Math.atan2(d[2], d[0]);
  },
  renderOnce() {
    updatePick();
    renderer.render(camera(), plane(), state.semantic, state.selection, null);
    return updateStatus();
  },
  classifyAtClient(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const ndc = [((cx - r.left) / r.width) * 2 - 1, 1 - ((cy - r.top) / r.height) * 2];
    return classifyAtNDC(ndc);
  },
  meshHash: () => hashMesh(state.model),
  meshHashFor: (m) => hashMesh(m),
  canvas,
};
window.__app = app;

initUI();
renderer.setModel(state.model);
requestAnimationFrame(frame);
