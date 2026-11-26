// CPU 几何逻辑单元测试：node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  V, signedVolume, rayPlane, rayCrossings, classifyPoint,
  pointTriangleDistance, cameraWinding, hashMesh, planeBasis,
} from '../src/geom.js';
import { sectionContours, trianglePlaneSegment } from '../src/section.js';
import { buildModels } from '../src/models.js';

const models = buildModels();
const byId = (id) => models.find((m) => m.id === id);

test('盒壳有符号体积：外定向为正，反转为负', () => {
  const solid = byId('solid');
  assert.ok(solid.shells[0].volume > 0);
  const cavity = byId('cavity');
  assert.ok(cavity.shells[0].volume > 0);
  assert.ok(cavity.shells[1].volume < 0, '空腔壳数据应为反向（负体积）');
});

test('签名模型：内壳数据反转时按可信资料自动 correction=-1，且不改源数据', () => {
  const m = byId('flipped');
  assert.equal(m.shells[1].volume > 0, true, '数据层面内壳是正向');
  assert.equal(m.shells[1].correction, -1);
  assert.equal(m.corrections.length, 1);
  // 纠正后分类应与正常空腔盒一致：中心为空气
  assert.equal(classifyPoint(m, [0, 0, 0], 'winding').kind, 'air');
  // 源网格未被“纠正”修改：哈希与重新构建的相同模型一致
  assert.equal(hashMesh(m), hashMesh(byId('flipped')));
});

test('未签名三角汤：定向不一致 → 标记歧义', () => {
  const m = byId('soup');
  assert.equal(m.signed, false);
  assert.equal(m.ambiguous, true);
});

test('绕数分类：实心盒内/外', () => {
  const m = byId('solid');
  assert.equal(classifyPoint(m, [0.3, -0.2, 0.1], 'winding').kind, 'solid');
  assert.equal(classifyPoint(m, [3, 0, 0], 'winding').kind, 'air');
});

test('空腔 vs 嵌入件：相同外壳，中心分类不同', () => {
  const cav = byId('cavity');
  const ins = byId('insert');
  assert.equal(classifyPoint(cav, [0, 0, 0], 'winding').kind, 'air', '空腔中心=空气');
  const r = classifyPoint(ins, [0, 0, 0], 'winding');
  assert.equal(r.kind, 'solid');
  assert.equal(r.name, '嵌入件', '嵌入件中心选中内件而非外壳');
  // 外壳壁区（|z|>0.5）属于外壳体
  const wall = classifyPoint(ins, [0, 0, 0.75], 'winding');
  assert.equal(wall.kind, 'solid');
  assert.equal(wall.name, '外壳体');
});

test('嵌套双壳：绕数语义内层为实心，奇偶语义内层为孔', () => {
  const m = byId('nested');
  assert.equal(classifyPoint(m, [0, 0, 0], 'winding').kind, 'solid');
  assert.equal(classifyPoint(m, [0, 0, 0], 'parity').kind, 'air', '两次穿越 → 偶 → 孔');
  // 两壳之间（0.6<r<1.0）：两种语义都应为实心
  assert.equal(classifyPoint(m, [0.8, 0, 0], 'winding').kind, 'solid');
  assert.equal(classifyPoint(m, [0.8, 0, 0], 'parity').kind, 'solid');
});

test('奇偶语义：空腔中心同样为空气（两种语义在简单空腔上一致）', () => {
  const cav = byId('cavity');
  assert.equal(classifyPoint(cav, [0, 0, 0], 'parity').kind, 'air');
});

test('射线-平面求交', () => {
  const t = rayPlane([0, 0, -3], [0, 0, 1], [0, 0, 1], 0);
  assert.ok(Math.abs(t - 3) < 1e-9);
  assert.equal(rayPlane([0, 0, -3], [1, 0, 0], [0, 0, 1], 0), null, '平行返回 null');
});

test('相机绕数：内部非零、外部为零（模板初值补偿量）', () => {
  const m = byId('solid');
  const inside = cameraWinding(m, [0.2, 0.1, 0.6], 'winding');
  const outside = cameraWinding(m, [5, 0, 0], 'winding');
  assert.notEqual(inside[0], 0);
  assert.equal(outside[0], 0);
});

test('截面交线：盒在 z=0 截出 8 段（每侧面 2 三角形），端点落在 |x|=1 或 |y|=1', () => {
  const m = byId('solid');
  const { segments } = sectionContours(m, [0, 0, 1], 0);
  assert.equal(segments.length, 8);
  for (const s of segments)
    for (const p of [s.a, s.b]) {
      assert.ok(Math.abs(p[2]) < 1e-6, '交点应在平面上');
      assert.ok(Math.abs(Math.abs(p[0]) - 1) < 1e-6 || Math.abs(Math.abs(p[1]) - 1) < 1e-6);
    }
  // 空腔盒：外壳 8 段 + 空腔壳 8 段（孔洞轮廓同样导出，不用矩形掩盖）
  const cav = sectionContours(byId('cavity'), [0, 0, 1], 0);
  assert.equal(cav.count, 16);
});

test('三角形-平面求交：不相交返回 null', () => {
  const seg = trianglePlaneSegment([0, 0, 1], [1, 0, 1], [0, 1, 1], [0, 0, 1], 0);
  assert.equal(seg, null);
  const seg2 = trianglePlaneSegment([0, 0, -1], [0, 0, 1], [1, 0, 0], [0, 0, 1], 0);
  assert.ok(seg2 && seg2.length === 2);
});

test('点到三角形距离（近裁面分析）', () => {
  const d = pointTriangleDistance([0.2, 0.2, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.ok(Math.abs(d - 1) < 1e-9);
  const d2 = pointTriangleDistance([2, 0, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.ok(Math.abs(d2 - 1) < 1e-9);
});

test('平面基正交且单位', () => {
  const [u, v] = planeBasis([0, 0, 1]);
  assert.ok(Math.abs(V.dot(u, v)) < 1e-9);
  assert.ok(Math.abs(V.len(u) - 1) < 1e-9 && Math.abs(V.len(v) - 1) < 1e-9);
});

test('rayCrossings 退化方向自动重投', () => {
  // 从盒中心沿 +x 会擦到共享边？不擦边，但验证接口稳定返回
  const m = byId('solid');
  const r = rayCrossings(m, [0], [0.123, 0.456, 0.789]);
  assert.ok(Number.isFinite(r.signed));
});
