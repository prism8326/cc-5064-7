// 壳体方向判定：独立于截面计数与填充着色的纯函数模块。
// 输入：模型壳元数据（数据绕序体积、可信裁决 correction、是否已定向）。
// 输出：每个壳一行的方向判定表；未定向壳 effSign=0，不产生带符号归属。
// 局部翻转只改该壳的 correction / oriented，不触碰源网格，也不影响其它壳的判定。
import { signedVolume } from './geom.js';

// 数据绕序符号：闭合壳外定向为正（signedVolume>0），内定向为负。
export function shellDataSign(model, shellIndex) {
  return model.shells[shellIndex].volume >= 0 ? 1 : -1;
}

// 裁决系数：仅在可信资料/用户裁决与数据绕序不符时为 -1，源网格永不修改。
export function shellCorrection(model, shellIndex) {
  return model.shells[shellIndex].correction;
}

// 壳是否已定向。未定向（三角汤未裁决）时返回 false。
export function shellIsOriented(model, shellIndex) {
  return model.shells[shellIndex].oriented !== false;
}

// 计数用有效符号：未定向壳返回 0（填充器可接收但不带符号），已定向壳返回 correction。
// 数据绕序本身由 GL 正背面 / CPU 射线 front 标志表达，不并入此系数。
export function shellCountSign(model, shellIndex) {
  const s = model.shells[shellIndex];
  return s.oriented === false ? 0 : s.correction;
}

// 整壳逻辑定向：数据绕序 × 裁决；未定向壳为 0。
// +1 等效外定向（实体边界），-1 等效内定向（空腔边界）。
export function shellLogicalSign(model, shellIndex) {
  const s = model.shells[shellIndex];
  if (s.oriented === false) return 0;
  return shellDataSign(model, shellIndex) * s.correction;
}

// 全模型方向判定表：方向判定的唯一出口，计数/填充/拾取都读这张表。
export function orientationTable(model) {
  return model.shells.map((s, si) => ({
    shell: si,
    name: s.name,
    role: s.role || null,
    dataSign: shellDataSign(model, si),
    correction: s.correction,
    oriented: shellIsOriented(model, si),
    countSign: shellCountSign(model, si),
    logicalSign: shellLogicalSign(model, si),
  }));
}

// 裁决某个壳的有效定向（correction ∈ {1,-1}），并标记为已定向。
export function markShellOrientation(model, shellIndex, correction) {
  const s = model.shells[shellIndex];
  s.correction = correction < 0 ? -1 : 1;
  s.oriented = true;
}

// 标记为未定向局部壳：填充器可接收（绕数语义下跳过其符号计数），拾取器不采信。
export function markShellUndetermined(model, shellIndex) {
  model.shells[shellIndex].oriented = false;
}

// 重新计算数据体积（镜像/重建后调用；常规路径在构建时已算好）。
export function recomputeVolume(model, shellIndex) {
  const s = model.shells[shellIndex];
  s.volume = signedVolume(model.positions, model.indices, s.start, s.count);
}
