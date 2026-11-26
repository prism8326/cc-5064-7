#!/usr/bin/env node
// 独立区段计数入口：与绘图窗口、自检共用 section.js 的同一份剖面逻辑。
// 用法：
//   node src/section_cli.js                       # 默认：空腔盒 z=0 绕数
//   node src/section_cli.js mirror z 0.2 parity  # 模型id 轴 d 语义
import { buildModels } from './models.js';
import { countSection, lineCoverage, sectionContours } from './section.js';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const [, , modelId = 'cavity', axis = 'z', dArg = '0', semantic = 'winding'] = process.argv;
const n = AXES[axis];
if (!n) { console.error(`未知轴：${axis}（x|y|z）`); process.exit(1); }
const d = Number(dArg);

const models = buildModels();
const model = models.find((m) => m.id === modelId);
if (!model) {
  console.error(`未知模型：${modelId}；可选：${models.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

const result = countSection(model, n, d, semantic, 12);
console.log(JSON.stringify({
  type: result.type,
  model: result.model,
  plane: result.plane,
  semantic: result.semantic,
  contourCount: result.contourCount,
  perShell: result.perShell,
  holeMask: result.mask,
}, null, 2));

// 测量线（与 main.js 同几何）：避腔线 + 穿孔线
const center = n.map((x) => x * -d);
const inPlane = axis === 'z' ? { u: [1, 0, 0], v: [0, 1, 0] }
  : axis === 'y' ? { u: [1, 0, 0], v: [0, 0, 1] }
  : { u: [0, 1, 0], v: [0, 0, 1] };
const add = (a, b) => a.map((x, i) => x + b[i]);
const sc = (a, s) => a.map((x) => x * s);
const pt = (su, sv) => add(center, add(sc(inPlane.u, su), sc(inPlane.v, sv)));
const lines = [
  { id: 'avoid', p: pt(-1.15, 0.75), q: pt(1.15, 0.75) },
  { id: 'pierce', p: pt(-1.15, 0.25), q: pt(1.15, 0.25) },
];
console.log('\n测量线有效覆盖区间：');
for (const ln of lines) {
  const r = lineCoverage(model, n, d, ln.p, ln.q, semantic);
  const desc = r.intervals
    .map((iv) => `${iv.kind === 'solid' ? `实体[${iv.name}]` : '空气'}[${iv.t0.toFixed(2)},${iv.t1.toFixed(2)}](signed=${iv.signed},count=${iv.count})`)
    .join(' ');
  console.log(`  ${ln.id.padEnd(7)}: ${desc}`);
}

const contours = sectionContours(model, n, d);
console.log(`\n轮廓按壳计数：${contours.byShell.map((b) => `壳${b.shell}=${b.count}`).join('，')}`);
