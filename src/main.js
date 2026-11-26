// 交互主控：相机、平面拖动、拾取分类、状态分析、导出。
// 模块分工：orientation.js 出方向表 → section.js 做截面计数/覆盖/拾取采信 → gl.js 只按方案填充。
import { V, M4, rayPlane, planeBasis, minDistanceToMesh, cameraWinding, hashMesh } from './geom.js';
import {
  sectionContours, countSection, lineCoverage, pickSolidAt,
  coveragePlan, SectionResultCache,
} from './section.js';
import { orientationTable } from './orientation.js';
import { buildModels, resetModel, flipShell, snapshotOrientation, restoreOrientation, markUndetermined } from './models.js';
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
  showMeasure: false,     // 测量线覆盖：避开空腔线 + 穿孔线同屏
  measureReport: null,    // 最近一次覆盖区间报告（含有效覆盖区间）
  flipSnapshots: [],      // 翻面更新与撤销交错抵达的重放栈
  cam: { theta: -2.0, phi: 0.35, dist: 5.2, target: [0, 0, 0], fov: (50 * Math.PI) / 180, near: 0.05, far: 60, up: [0, 1, 0] },
  soupOverride: null,     // 未签名模型的用户裁决
};

// 截面结果缓存：键含方向表与零件归属（见 section.sectionCacheKey），轮廓形状命中不算命中。
const sectionCache = new SectionResultCache();

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

// ---------- 测量线：一条穿过两层外壁却避开空腔，一条穿孔，两条共用画面 ----------
function planeInPlaneBasis() {
  const n = AXIS[state.axis];
  // 轴对齐剖切平面的两个画面内方向
  if (state.axis === 'z') return { u: [1, 0, 0], v: [0, 1, 0] };
  if (state.axis === 'y') return { u: [1, 0, 0], v: [0, 0, 1] };
  return { u: [0, 1, 0], v: [0, 0, 1] };
}
function planePoint(u, v, su, sv) {
  const n = AXIS[state.axis];
  const c = V.scale(n, -state.planeD);
  return V.add(c, V.add(V.scale(u, su), V.scale(v, sv)));
}
// L1 避开空腔：贴外壁内壁之间走（外盒半宽 1，空腔半宽 0.5，取 0.75 通道）；
// L2 穿孔：穿过原点，必入空腔。
function measureLines() {
  const { u, v } = planeInPlaneBasis();
  const off = 0.75, span = 1.15;
  // 穿孔线取小幅 y 偏置，避免正好穿过盒轮廓的共享顶点（截线求交的退化情形）
  return [
    { id: 'avoid', label: '避腔线（穿两层外壁，避开空腔）', p: planePoint(u, v, -span, off), q: planePoint(u, v, span, off) },
    { id: 'pierce', label: '穿孔线（穿过空腔）', p: planePoint(u, v, -span, 0.25), q: planePoint(u, v, span, 0.25) },
  ];
}

function computeMeasure() {
  const { n, d } = plane();
  const m = state.model;
  const lines = measureLines();
  const reports = lines.map((ln) => {
    const r = lineCoverage(m, n, d, ln.p, ln.q, state.semantic);
    return { ...ln, ...r };
  });
  state.measureReport = reports;
  return reports.map((r) => ({
    line: r.line,
    intervals: r.intervals.map((iv) => ({ t0: iv.t0, t1: iv.t1, kind: iv.kind, part: iv.part })),
  }));
}

function measureOverlay() {
  if (!state.showMeasure) return null;
  const reports = state.measureReport || computeMeasure();
  // 渲染器一次画一条测量线；这里叠加两条（避腔线 + 穿孔线）
  return reports.map((r) => ({ line: r.line, intervals: r.intervals }));
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
  // 拾取器只采信已确定的实体归属：含未定向局部壳的候选零件不会被返回。
  const pick = pickSolidAt(m, P, state.semantic);
  if (!pick) return { point: P, cls: { kind: 'air' } };
  return { point: P, cls: { kind: 'solid', part: pick.part, name: pick.name } };
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

// ---------- 状态分析（方向判定表/深度/模板顺序） ----------
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
  // 阶段 A 输出：逐壳方向判定表（局部翻面只改对应行）
  const orient = orientationTable(m);
  const orientLines = orient.map((o) => {
    const tag = !o.oriented ? '未定向（填充器接收几何，拾取不采信）'
      : `逻辑定向=${o.logicalSign > 0 ? '外(实体)' : '内(空腔)'}（数据${o.dataSign > 0 ? '外' : '内'}×校正${o.correction}）`;
    return `  壳${o.shell}「${o.name}」计数符号=${o.countSign}：${tag}`;
  });
  // 阶段 B 输出：截面模板计数方案（纯 CPU，与 GL 计数通道同输入）
  const plan = coveragePlan(m, n, d, cam.eye, state.semantic);
  const planLines = plan.parts.map((pp) =>
    `  零件「${pp.name}」相机初值=${pp.cameraWinding}，计数壳=[${pp.shells.map((s) => `壳${s.shell}:${s.oriented ? s.frontOp : 'SKIP'}`).join(', ')}]，封口测试=${pp.capTest.func}`);
  // 独立区段计数入口：轮廓段数 + 孔洞掩码两链路对照
  const cnt = countSection(m, n, d, state.semantic, 8);
  const mask = cnt.mask;
  const lines = [
    `语义：${state.semantic === 'winding' ? '绕数（正面-1/背面+1，从相机绕数中减去穿越，测试 !=0）' : '奇偶（INVERT，测试 bit0）'}`,
    `相机：f(eye)=${fCam.toFixed(3)} → 计数侧=${fCam >= 0 ? '保留侧' : '裁掉侧'}；${inside.length ? '位于实体内部 ' + inside.join(' ') : '位于实体外部'}`,
    `逐零件模板初值（相机绕数补偿）：[${camW.join(', ')}]`,
    `近裁面：相机到网格净距 ${minDist.toFixed(3)}，near=${cam.near} → ${nearOK ? '安全（near 未切割几何）' : '警告：近裁面可能切割几何，模板计数不可信，请拉远相机'}`,
    '阶段A 朝向判定表：', ...orientLines,
    '阶段B 截面模板计数方案：', ...planLines,
    `独立区段计数：轮廓段=${cnt.contourCount}（${cnt.perShell.map((b) => `壳${b.shell}=${b.count}`).join('，')}）；孔洞掩码 ${mask.n} 采样：绕数实体=${mask.solidWinding}，奇偶实体=${mask.solidParity}，两链路一致=${mask.agree}${mask.disagree ? `，分歧=${mask.disagree}` : ''}`,
  ];
  if (state.showMeasure && state.measureReport) {
    lines.push('测量线有效覆盖区间：');
    for (const r of state.measureReport) {
      const iv = r.intervals.map((x) =>
        `${x.kind === 'solid' ? `实体[${x.name}]` : '空气'} t∈[${x.t0.toFixed(2)},${x.t1.toFixed(2)}]`).join('；');
      lines.push(`  ${r.label}：${iv}`);
    }
  }
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
  const overlay = state.showMeasure ? computeMeasure() : null;
  renderer.render(camera(), { n, d }, state.semantic, state.selection, marker, overlay);
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
  $('flipInner').onclick = () => flipInnerShell(1);
  $('undoFlip').onclick = undoFlip;
  $('measureToggle').onchange = (e) => { state.showMeasure = e.target.checked; };
  $('countNow').onclick = () => updateStatus();
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
    '三段式重构：阶段A 朝向判定（orientation.js：逐壳数据绕序×裁决→有效符号，未定向壳符号为0）→ 阶段B 截面模板计数（section.js 出纯CPU方案，gl.js 同输入执行：仅相机侧壳面，绕数正面-1/背面+1，奇偶 INVERT，模板初值=相机绕数）→ 阶段C 填充着色（模板!=0 处把全屏三角形钉在平面真实深度，颜色只在这一阶段生效）。',
    '局部翻转只改该壳的方向表行与零件归属，不改源网格：截面轮廓（纯几何）两次完全相同，内部零件身份不同。填充器可接收未定向局部壳（绕数语义跳过其符号计数，奇偶照常 INVERT），拾取器只采信已定向零件的实体归属。',
    '截面缓存键含网格哈希、平面、语义、方向表签名与零件归属；仅按轮廓形状命中的缓存会在翻面例上失败（见 Node 测试 section.test.mjs）。',
    '封口不是画在剖面上的矩形：它逐像素由模板计数驱动，空腔/孔洞处计数为 0 自然留空（自检第 2、3 项直接对比关闭模板测试后的退化行为）。',
    '遮挡由深度缓冲保证：封口写在平面真实深度上，相机位于保留侧时外壁深度更近，封口被正确遮挡（自检第 6 项）。',
    '测量线：避腔线穿两层外壁但避开空腔，穿孔线穿过空腔，两线共用画面；覆盖区间由截线交点切边界、3D 射线独立定身份。翻转内层后避腔线的有效覆盖区间原样保留。',
    '限制：模型须闭合；绕数语义要求定向一致（签名模型自动校正，未签名三角汤提示歧义，未裁决壳不参与符号归属）；near 切割几何时状态栏显式告警。',
    '导出范围：仅截面交线轮廓；封口为实时渲染效果，未生成可制造的闭合几何；源网格始终保持未切割。独立区段计数入口：node src/section_cli.js。',
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
  state.flipSnapshots = [];
  $('pick').textContent = '尚未拾取。单击剖切面。';
  renderer.setModel(m);
  updateAmbiguityUI();
  updateFlipUI();
}

// ---------- 局部翻面与撤销（交错抵达的更新栈） ----------
// 翻面：快照当前方向/归属 → 只翻目标壳；撤销：弹栈恢复。
// 两次之间截面轮廓（纯几何）不变，方向表与零件身份改变。
function flipInnerShell(shellIndex = 1) {
  const m = state.model;
  if (!m.shells[shellIndex]) return;
  state.flipSnapshots.push(snapshotOrientation(m));
  flipShell(m, shellIndex);
  renderer.setModel(m); // 零件归属变化，重建绘制顺序；源缓冲不变
  updateFlipUI();
}
function undoFlip() {
  const m = state.model;
  const snap = state.flipSnapshots.pop();
  if (!snap) return;
  restoreOrientation(m, snap);
  renderer.setModel(m);
  updateFlipUI();
}
function updateFlipUI() {
  const box = $('flipbox');
  if (!box) return;
  box.style.display = state.model.shells.length >= 2 ? 'block' : 'none';
  $('undoFlip').disabled = state.flipSnapshots.length === 0;
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
    m.shells[1].oriented = true; // 裁决即定向：此后拾取可采信
    m.ambiguous = false;
    renderer.setModel(m);
    updateAmbiguityUI();
  });
  mk('裁决：内壳是独立实心件', () => {
    state.soupOverride = '内壳=独立实心件';
    m.shells[1].oriented = true;
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
  const { segments } = sectionContours(m, n, d);
  const json = {
    type: 'section-contours',
    note: '源网格未被切割；以下仅为平面与三角面的交线轮廓，不是封闭实体。剖面封口为模板缓冲实时渲染效果，未生成可制造几何。',
    model: m.label,
    plane: { n, d },
    segments: segments.map((s) => ({ part: s.part, shell: s.shell, a: s.a, b: s.b })),
  };
  download('section.json', JSON.stringify(json, null, 2), 'application/json');

  const [u, v] = planeBasis(n);
  const pts = segments.flatMap((s) => [s.a, s.b]);
  if (pts.length) {
    const xs = pts.map((p) => V.dot(p, u)), ys = pts.map((p) => V.dot(p, v));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const S = 400 / Math.max(x1 - x0, y1 - y0, 1e-6);
    const lines = segments.map((s) => {
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
    const overlay = state.showMeasure ? computeMeasure() : null;
    renderer.render(camera(), plane(), state.semantic, state.selection, null, overlay);
    return updateStatus();
  },
  // 局部翻面/撤销重放（供自检交错调用）
  flipInner(shellIndex = 1) { flipInnerShell(shellIndex); },
  undoFlip() { undoFlip(); },
  setMeasure(on) { state.showMeasure = on; },
  measureReport() { return computeMeasure(); },
  // 纯 CPU 截面接口（自检与 CLI 共用，不经 GL）
  sectionCount(samples = 8) { const { n, d } = plane(); return countSection(state.model, n, d, state.semantic, samples); },
  sectionPlan() { const { n, d } = plane(); return coveragePlan(state.model, n, d, camera().eye, state.semantic); },
  markUndetermined(si) { markUndetermined(state.model, si); renderer.setModel(state.model); },
  cache: sectionCache,
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
