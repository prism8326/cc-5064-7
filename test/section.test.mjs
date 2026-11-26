// 截面覆盖/方向判定重构的单元测试：node --test test/section.test.mjs
// 纯 CPU，不依赖 DOM/WebGL；GL 侧的对应验收在 selftest.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModels, flipShell, snapshotOrientation, restoreOrientation, resetModel, markUndetermined } from '../src/models.js';
import {
  sectionContours, lineCoverage, directedCrossingsAt, pickSolidAt,
  sectionHoleMask, countSection, coveragePlan,
  sectionCacheKey, shapeOnlyCacheKey, SectionResultCache,
} from '../src/section.js';
import { orientationTable, shellCountSign, shellLogicalSign, shellIsOriented } from '../src/orientation.js';
import { hashMesh } from '../src/geom.js';

const models = buildModels();
const byId = (id) => models.find((m) => m.id === id);
const Z = [0, 0, 1];
// 测量线（与 main.js / section_cli.js 同几何）
const AVOID = { p: [-1.15, 0.75, 0], q: [1.15, 0.75, 0] }; // 穿两层外壁、避开空腔
const PIERCE = { p: [-1.15, 0.25, 0], q: [1.15, 0.25, 0] }; // 穿过空腔（偏置避开轮廓顶点）

function contourShape(model, n, d) {
  return JSON.stringify(sectionContours(model, n, d).segments.map((s) => [s.a, s.b]));
}

test('方向判定表：局部壳各自成行，镜像内壳被校正回空腔逻辑定向', () => {
  const mir = byId('mirror');
  // 镜像使数据有符号体积变号（外=正，内=负）
  assert.ok(mir.shells[0].volume > 0);
  assert.ok(mir.shells[1].volume < 0);
  const t = orientationTable(mir);
  assert.equal(t[0].logicalSign, 1);   // 外壳：外定向实体
  assert.equal(t[1].dataSign, -1);     // 镜像使内壳数据绕序变号
  assert.equal(t[1].correction, 1);    // 镜像后数据绕序已与签名资料（空腔=内定向）一致，无需校正
  assert.equal(t[1].logicalSign, -1);  // 逻辑定向仍是空腔
  assert.equal(shellCountSign(mir, 1), 1);
  assert.equal(shellIsOriented(mir, 1), true);
});

test('未签名三角汤：不一致内壳为未定向，计数符号为 0 且拾取不采信', () => {
  const soup = byId('soup');
  assert.equal(soup.ambiguous, true);
  assert.equal(shellIsOriented(soup, 1), false);
  assert.equal(shellCountSign(soup, 1), 0);
  assert.equal(shellLogicalSign(soup, 1), 0);
  // 填充器可接收几何（coveragePlan 给出 SKIP），拾取器在中心和壁区都不采信身份
  const plan = coveragePlan(soup, Z, 0, [-2.2, 1.5, -3.5], 'winding');
  const inner = plan.parts[0].shells.find((s) => s.shell === 1);
  assert.equal(inner.frontOp, 'SKIP');
  assert.equal(pickSolidAt(soup, [0, 0, 0], 'winding'), null);
  assert.equal(pickSolidAt(soup, [0, 0, 0], 'parity'), null);
  assert.equal(pickSolidAt(soup, [0.8, 0, 0], 'winding'), null);
});

test('翻面更新与撤销交错：两次截面轮廓完全相同，内部零件身份不同', () => {
  const cav = byId('cavity');
  resetModel(cav);
  const before = contourShape(cav, Z, 0);
  const beforePick = pickSolidAt(cav, [0, 0, 0], 'winding');
  assert.equal(beforePick, null, '翻转前空腔中心是空气');

  const snap = snapshotOrientation(cav);
  flipShell(cav, 1);
  const afterFlipShape = contourShape(cav, Z, 0);
  assert.equal(afterFlipShape, before, '翻面不改任何交线几何');
  const afterPick = pickSolidAt(cav, [0, 0, 0], 'winding');
  assert.ok(afterPick && afterPick.name === '翻面内件', '翻面后中心成为独立内件');
  assert.deepEqual(cav.parts.map((p) => p.shells), [[0], [1]]);

  restoreOrientation(cav, snap); // 撤销交错抵达
  assert.equal(contourShape(cav, Z, 0), before, '撤销后轮廓仍相同');
  assert.equal(pickSolidAt(cav, [0, 0, 0], 'winding'), null, '撤销后中心恢复为空气');
  assert.deepEqual(cav.parts.map((p) => p.shells), [[0, 1]]);
  assert.equal(hashMesh(cav), hashMesh(byId('cavity')), '源网格全程不变');
});

test('截面缓存：完整键区分翻面，纯轮廓形状键会错误命中（旧缓存应失败）', () => {
  const cav = byId('cavity');
  resetModel(cav);
  const key0 = sectionCacheKey(cav, Z, 0, 'winding');
  const shape0 = shapeOnlyCacheKey(cav, Z, 0);
  const snap = snapshotOrientation(cav);
  flipShell(cav, 1);
  const key1 = sectionCacheKey(cav, Z, 0, 'winding');
  const shape1 = shapeOnlyCacheKey(cav, Z, 0);
  restoreOrientation(cav, snap);

  assert.notEqual(key0, key1, '方向/归属进入缓存键');
  assert.equal(shape0, shape1, '只看轮廓形状无法区分两次结果 → 这种缓存设计在本例失败');

  // 正确缓存：翻面后不得命中翻面前置入的结果
  const cache = new SectionResultCache();
  resetModel(cav);
  cache.set(cav, Z, 0, 'winding', { owner: 'air-center' });
  flipShell(cav, 1);
  assert.equal(cache.get(cav, Z, 0, 'winding'), undefined, '完整键下翻面后必须重算');
  restoreOrientation(cav, snap);
  assert.ok(cache.get(cav, Z, 0, 'winding'), '撤销回原状态后缓存可复用');
});

test('镜像内壳：剖面从相切拖到相交，孔边段数独立核对', () => {
  const mir = byId('mirror');
  const outside = sectionContours(mir, Z, 0.6); // 平面完全在空腔之外
  const tangent = sectionContours(mir, Z, 0.5); // 与内壳面相切
  const intersect = sectionContours(mir, Z, 0.2); // 与内壳相交
  // 外壳在三种位置都贡献 8 段
  assert.equal(outside.byShell[0].count, 8);
  assert.equal(tangent.byShell[0].count, 8);
  assert.equal(intersect.byShell[0].count, 8);
  // 相切时内壳无横切交线，相交时内壳出现完整孔洞轮廓（8 段）
  assert.equal(tangent.byShell[1].count, 0);
  assert.equal(intersect.byShell[1].count, 8);
  assert.ok(tangent.byShell[1].count < intersect.byShell[1].count);
});

test('凹入区与空腔的有向交点逐壳独立：翻面只改本壳计数', () => {
  const cav = byId('cavity');
  resetModel(cav);
  const center = directedCrossingsAt(cav, [0, 0, 0]);
  assert.equal(center.perShell[0].signed, -1, '外壳在中心贡献带符号穿越 -1');
  assert.equal(center.perShell[1].signed, 1, '空腔壳贡献 +1（反向壳抵消）');
  assert.equal(center.totalSigned, 0, '空腔中心总绕数为 0');
  assert.equal(center.totalCount, 2, '无符号穿越为 2（奇偶=孔）');

  const wall = directedCrossingsAt(cav, [0.8, 0, 0]);
  assert.equal(wall.perShell[0].count, 1, '壁区只穿外壳一次');
  assert.equal(wall.perShell[1].count, 0, '壁区不碰内壳');
  assert.equal(wall.totalSigned, -1);

  const snap = snapshotOrientation(cav);
  flipShell(cav, 1);
  const centerFlipped = directedCrossingsAt(cav, [0, 0, 0]);
  assert.equal(centerFlipped.perShell[0].signed, -1, '外壳计数不受内壳翻面影响');
  assert.equal(centerFlipped.perShell[1].signed, -1, '内壳翻面后符号反转（只影响自身行）');
  assert.equal(centerFlipped.totalSigned, -2, '中心成为绕数非零的实体区');
  restoreOrientation(cav, snap);
});

test('测量线：避腔线全段实体；穿孔线中心为空气，区间身份独立核对', () => {
  const cav = byId('cavity');
  resetModel(cav);
  const avoid = lineCoverage(cav, Z, 0, AVOID.p, AVOID.q, 'winding');
  const pierce = lineCoverage(cav, Z, 0, PIERCE.p, PIERCE.q, 'winding');
  assert.equal(avoid.intervals.length, 1);
  assert.equal(avoid.intervals[0].kind, 'solid');
  assert.equal(avoid.intervals[0].t0, 0);
  assert.equal(avoid.intervals[0].t1, 1);
  // 穿孔线：外空气 → 壁实体 → 空腔空气 → 壁实体 → 外空气（端点外的空气段被截线范围裁掉）
  const kinds = pierce.intervals.map((i) => i.kind);
  assert.ok(kinds.includes('air') && kinds.includes('solid'));
  const centerIv = pierce.intervals.find((i) => i.kind === 'air');
  assert.ok(centerIv, '穿孔线存在空气（空腔）区间');
  assert.deepEqual(kinds, ['solid', 'air', 'solid']);
  // 每个区间都带逐壳有向交点，可独立核对
  assert.ok(pierce.intervals.every((i) => Array.isArray(i.perShell) && i.perShell.length === 2));
});

test('翻转内层后：避腔线有效覆盖区间原样保留，穿孔线由空腔变为实体', () => {
  const cav = byId('cavity');
  resetModel(cav);
  const before = lineCoverage(cav, Z, 0, AVOID.p, AVOID.q, 'winding');
  const pierceBefore = lineCoverage(cav, Z, 0, PIERCE.p, PIERCE.q, 'winding');
  const snap = snapshotOrientation(cav);
  flipShell(cav, 1);
  const after = lineCoverage(cav, Z, 0, AVOID.p, AVOID.q, 'winding');
  const pierceAfter = lineCoverage(cav, Z, 0, PIERCE.p, PIERCE.q, 'winding');

  assert.deepEqual(
    after.intervals.map((i) => [i.kind, i.part, i.t0, i.t1]),
    before.intervals.map((i) => [i.kind, i.part, i.t0, i.t1]),
    '避腔线覆盖区间原样保留'
  );
  const pbCenter = pierceBefore.intervals.find((i) => i.kind === 'air');
  const paCenter = pierceAfter.intervals.find((i) => i.t0 < 0.5 && i.t1 > 0.5) || pierceAfter.intervals[Math.floor(pierceAfter.intervals.length / 2)];
  assert.ok(pbCenter, '翻转前穿孔线含空气区间');
  assert.equal(paCenter.kind, 'solid');
  assert.equal(paCenter.name, '翻面内件');
  restoreOrientation(cav, snap);
});

test('孔洞掩码：绕数与奇偶两条独立链路在空腔盒上逐采样一致', () => {
  const cav = byId('cavity');
  resetModel(cav);
  const mask = sectionHoleMask(cav, Z, 0, 10);
  assert.equal(mask.totals.n, 100);
  assert.equal(mask.totals.agree, 100, '两条链路对每个采样点判定一致');
  assert.equal(mask.totals.disagree, 0);
  assert.ok(mask.totals.solidWinding < 100, '存在空腔采样（非整块填满）');
});

test('countSection 独立入口：轮廓段数与掩码计数同时输出', () => {
  const mir = byId('mirror');
  const r = countSection(mir, Z, 0.2, 'winding', 6);
  assert.equal(r.contourCount, 16, '外壳 8 + 内壳 8');
  assert.deepEqual(r.perShell, [{ shell: 0, count: 8 }, { shell: 1, count: 8 }]);
  assert.equal(r.mask.n, 36);
  assert.equal(r.mask.agree, 36);
});

test('coveragePlan：相机绕数初值与逐壳计数操作，未定向壳在绕数下 SKIP', () => {
  const cav = byId('cavity');
  const eye = [0.2, 0.1, 0.6]; // 相机位于外壳实体内部
  const plan = coveragePlan(cav, Z, 0, eye, 'winding');
  assert.notEqual(plan.parts[0].cameraWinding, 0, '相机在实体内 → 模板初值非零');
  assert.equal(plan.parts[0].capTest.func, 'NOTEQUAL');
  const parityPlan = coveragePlan(cav, Z, 0, eye, 'parity');
  assert.ok(parityPlan.parts[0].shells.every((s) => s.frontOp === 'INVERT'));

  const soup = byId('soup');
  markUndetermined(soup, 1);
  const sp = coveragePlan(soup, Z, 0, eye, 'winding');
  assert.equal(sp.parts[0].shells.find((s) => s.shell === 1).frontOp, 'SKIP');
  resetModel(soup);
});

test('嵌入件 vs 空腔：同轮廓下拾取身份不同（重构不改变既有分类语义）', () => {
  const ins = byId('insert');
  const cav = byId('cavity');
  resetModel(ins);
  resetModel(cav);
  assert.equal(sectionContours(ins, Z, 0).count, sectionContours(cav, Z, 0).count);
  const pick = pickSolidAt(ins, [0, 0, 0], 'winding');
  assert.ok(pick && pick.name === '嵌入件');
  assert.equal(pickSolidAt(cav, [0, 0, 0], 'winding'), null);
  const wall = pickSolidAt(ins, [0, 0, 0.75], 'winding');
  assert.ok(wall && wall.name === '外壳体');
});
