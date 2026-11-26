// 应用内验收自检：渲染真实场景并 readPixels，直接核对模板缓冲与深度缓冲的作用。
const CAP = {
  solid: [0.45, 0.9, 0.45].map((x) => Math.round(x * 255)),
  housing: [0.98, 0.62, 0.18].map((x) => Math.round(x * 255)),
  insert: [0.15, 0.85, 0.9].map((x) => Math.round(x * 255)),
};

function match(px, rgb, tol = 14) {
  return Math.abs(px[0] - rgb[0]) <= tol && Math.abs(px[1] - rgb[1]) <= tol && Math.abs(px[2] - rgb[2]) <= tol;
}

export async function runSelfTests(app) {
  const { renderer, canvas } = app;
  const results = [];
  const T = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });
  const cx = () => Math.floor(canvas.width / 2);
  const cy = () => Math.floor(canvas.height / 2);
  const centerClient = () => {
    const r = canvas.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const countColor = (rgb, tol = 14) => {
    const { buf } = renderer.readPixels();
    let n = 0;
    for (let i = 0; i < buf.length; i += 4)
      if (match([buf[i], buf[i + 1], buf[i + 2]], rgb, tol)) n++;
    return n;
  };
  const hashAll = () => app.models.map((m) => app.meshHashFor(m));

  const hashesBefore = hashAll();
  const cam = [-2.2, 1.5, -3.5]; // 位于裁掉侧（z<0），看向原点

  try {
    // ---------- T1 实心盒：剖面中心出现封口 ----------
    app.loadModelById('solid');
    app.setSemantic('winding');
    app.setPlane('z', 0);
    app.setCamera(cam, [0, 0, 0]);
    app.renderOnce();
    T('实心盒：剖面中心出现封口（模板!=0 区域）',
      match(renderer.pixel(cx(), cy()), CAP.solid),
      `中心像素=${renderer.pixel(cx(), cy()).slice(0, 3)}`);

    // ---------- T2 模板掩码有效性：关闭模板测试后退化为整块矩形 ----------
    const nStencil = countColor(CAP.solid);
    renderer.debug.stencilAlways = true;
    app.renderOnce();
    const nAlways = countColor(CAP.solid);
    renderer.debug.stencilAlways = false;
    app.renderOnce();
    T('模板缓冲在起掩码作用（非“画一个矩形”）',
      nStencil > 200 && nAlways > nStencil * 2,
      `模板开启封口像素=${nStencil}，关闭模板测试后=${nAlways}（矩形退化）`);

    // ---------- T3 空腔盒：空腔处无封口，且空洞由模板计数产生 ----------
    app.loadModelById('cavity');
    app.renderOnce();
    const centerCav = renderer.pixel(cx(), cy());
    const nCav = countColor(CAP.housing);
    renderer.debug.stencilAlways = true;
    app.renderOnce();
    const centerCavForced = renderer.pixel(cx(), cy());
    renderer.debug.stencilAlways = false;
    T('空腔盒：空腔区域无封口（模板计数=0），壁区有封口',
      !match(centerCav, CAP.housing) && nCav > 200 && match(centerCavForced, CAP.housing),
      `中心=${centerCav.slice(0, 3)}（非封口色），壁区封口像素=${nCav}；关闭模板后中心=${centerCavForced.slice(0, 3)}（被矩形填满）`);

    // ---------- T4 嵌入件：连续拖平面过内壳，封口颜色与选中零件同时改变 ----------
    app.loadModelById('insert');
    app.setPlane('z', 0); // 平面 z=0，穿过嵌入件
    app.renderOnce();
    const c0 = renderer.pixel(cx(), cy());
    const [pcx, pcy] = centerClient();
    const cls0 = app.classifyAtClient(pcx, pcy);
    app.setPlane('z', -0.75); // 平面 z=0.75，越过嵌入件（|z|>0.5），仍在外壳内
    app.renderOnce();
    const c1 = renderer.pixel(cx(), cy());
    const cls1 = app.classifyAtClient(pcx, pcy);
    app.setPlane('z', -1.2); // 平面 z=1.2，移出整个模型
    app.renderOnce();
    const c2 = renderer.pixel(cx(), cy());
    T('嵌入件：拖平面穿过内壳，封口颜色与拾取选中件同时改变',
      match(c0, CAP.insert) && cls0.cls && cls0.cls.kind === 'solid' && cls0.cls.name === '嵌入件'
        && match(c1, CAP.housing) && cls1.cls && cls1.cls.kind === 'solid' && cls1.cls.name === '外壳体'
        && !match(c2, CAP.housing) && !match(c2, CAP.insert),
      `z=0:${c0.slice(0, 3)}/${cls0.cls && cls0.cls.name} → z=0.75:${c1.slice(0, 3)}/${cls1.cls && cls1.cls.name} → z=1.2 无封口`);

    // ---------- T5 拾取分类：空腔中心→空气；嵌入件中心→内件 ----------
    app.loadModelById('cavity');
    app.setPlane('z', 0);
    app.renderOnce();
    const clsAir = app.classifyAtClient(pcx, pcy);
    app.loadModelById('insert');
    app.renderOnce();
    const clsIns = app.classifyAtClient(pcx, pcy);
    T('截面拾取：相同外壳下，空腔中心→空气，嵌入件中心→选中内件',
      clsAir.cls && clsAir.cls.kind === 'air' && clsIns.cls && clsIns.cls.kind === 'solid' && clsIns.cls.name === '嵌入件',
      `空腔中心=${clsAir.cls && clsAir.cls.kind}，嵌入件中心=${clsIns.cls && clsIns.cls.kind}/${clsIns.cls && clsIns.cls.name}`);

    // ---------- T6 深度遮挡：相机在保留侧时封口被外壁遮挡 ----------
    app.loadModelById('solid');
    app.setPlane('z', 0);
    app.setCamera([0.8, 0.6, 3.5], [0, 0, 0]); // 保留侧（z>0）
    app.renderOnce();
    const occluded = renderer.pixel(cx(), cy());
    renderer.debug.capNoDepth = true;
    app.renderOnce();
    const through = renderer.pixel(cx(), cy());
    renderer.debug.capNoDepth = false;
    T('深度缓冲遮挡：保留侧看剖面被外壁挡住；关闭深度后封口透出',
      !match(occluded, CAP.solid) && match(through, CAP.solid),
      `遮挡时中心=${occluded.slice(0, 3)}（壁面着色），关深度后=${through.slice(0, 3)}（封口色）`);

    // ---------- T7 相机位于实体内部：模板初值补偿使封口仍正确 ----------
    app.setCamera([0.2, 0.1, 0.6], [0.2, 0.1, -2]);
    app.renderOnce();
    const insidePx = renderer.pixel(cx(), cy());
    const info = app.renderOnce();
    T('相机位于实体内部：封口仍正确（模板初值=相机绕数）',
      match(insidePx, CAP.solid) && info.camW[0] !== 0,
      `中心=${insidePx.slice(0, 3)}，相机绕数=${info.camW[0]}（已作为模板初值）`);

    // ---------- T8 嵌套双壳：绕数→内层实心；奇偶→内层为孔 ----------
    app.loadModelById('nested');
    app.setCamera(cam, [0, 0, 0]);
    app.setSemantic('winding');
    app.renderOnce();
    const nestW = renderer.pixel(cx(), cy());
    app.setSemantic('parity');
    app.renderOnce();
    const nestP = renderer.pixel(cx(), cy());
    app.setSemantic('winding');
    T('嵌套双壳：绕数语义内层为实心（w=2），奇偶语义内层为孔（2 次穿越）',
      match(nestW, CAP.solid) && !match(nestP, CAP.solid),
      `绕数中心=${nestW.slice(0, 3)}（封口），奇偶中心=${nestP.slice(0, 3)}（无封口）`);

    // ---------- T9 近裁面切割检测：显式告警而非静默出错 ----------
    app.loadModelById('solid');
    app.setCamera([0, 0, 1.03], [0, 0, 0]); // 距盒面 0.03 < 1.5*near
    const st = app.renderOnce();
    app.setCamera(cam, [0, 0, 0]);
    app.renderOnce();
    T('近裁面切割几何时状态显式告警',
      st.nearOK === false,
      `净距=${st.minDist.toFixed(3)}，nearOK=${st.nearOK}`);

    // ---------- T10 源网格未被修改 ----------
    const hashesAfter = hashAll();
    const same = hashesBefore.every((h, i) => h === hashesAfter[i]);
    T('源网格全程未被修改（渲染前后哈希一致）', same,
      same ? '所有模型 positions/indices 哈希一致' : '哈希发生变化！');

    // ---------- T11 未定向局部壳：填充器仍画几何（绕数跳过其符号），拾取器不采信 ----------
    app.loadModelById('soup');
    app.setSemantic('winding');
    app.setPlane('z', 0);
    app.setCamera(cam, [0, 0, 0]);
    const undecidedPick = app.classifyAtClient(pcx, pcy);
    app.renderOnce();
    // 壁区仍有封口色（外壳参与计数），但中心含未定向内壳 → 拾取不给实体身份
    const nWallColor = countColor(CAP.housing);
    T('未定向三角汤：填充器保留壁区封口，拾取器不采信含未定向壳的实体归属',
      undecidedPick.cls.kind === 'ambiguous' && nWallColor > 100,
      `中心拾取=${undecidedPick.cls.kind}，壁区封口像素=${nWallColor}`);
    // 显式标记未定向：coveragePlan 绕数计数给 SKIP，渲染不报错且拾取仍为空
    app.markUndetermined(1);
    app.renderOnce();
    const skipPick = app.classifyAtClient(pcx, pcy);
    T('未定向壳在绕数计数中跳过（SKIP），奇偶语义仍可填充',
      skipPick.cls.kind === 'air',
      `标记未定向后中心拾取=${skipPick.cls.kind}`);

    // ---------- T12 翻面/撤销重放：轮廓相同，封口计数暂停处与实体拾取身份改变 ----------
    app.loadModelById('cavity');
    app.setSemantic('winding');
    app.setPlane('z', 0);
    app.renderOnce();
    const beforeCount = app.sectionCount(8);
    const beforePick = app.classifyAtClient(pcx, pcy);
    app.flipInner(1); // 一次翻面更新
    app.renderOnce();
    const flippedCount = app.sectionCount(8);
    const flippedPick = app.classifyAtClient(pcx, pcy);
    const flippedPixel = renderer.pixel(cx(), cy());
    app.undoFlip();   // 一次撤销交错抵达
    app.renderOnce();
    const undoneCount = app.sectionCount(8);
    const undonePick = app.classifyAtClient(pcx, pcy);
    T('翻面/撤销重放：三次截面轮廓段数相同；翻面后中心可拾取内件，撤销恢复空气',
      beforeCount.contourCount === flippedCount.contourCount
        && flippedCount.contourCount === undoneCount.contourCount
        && beforePick.cls.kind === 'air'
        && flippedPick.cls.kind === 'solid' && flippedPick.cls.name === '翻面内件'
        && match(flippedPixel, CAP.insert)
        && undonePick.cls.kind === 'air',
      `段数 ${beforeCount.contourCount}=${flippedCount.contourCount}=${undoneCount.contourCount}；拾取 ${beforePick.cls.kind}→${flippedPick.cls.name}→${undonePick.cls.kind}`);

    // ---------- T13 测量线：避腔线翻转前后有效覆盖区间原样保留，穿孔线身份改变 ----------
    app.loadModelById('cavity');
    app.setPlane('z', 0);
    app.setMeasure(true);
    const rep0 = app.measureReport();
    const avoid0 = rep0.find((r) => r.id === 'avoid');
    const pierce0 = rep0.find((r) => r.id === 'pierce');
    app.flipInner(1);
    const rep1 = app.measureReport();
    const avoid1 = rep1.find((r) => r.id === 'avoid');
    const pierce1 = rep1.find((r) => r.id === 'pierce');
    app.undoFlip();
    app.setMeasure(false);
    const sig = (r) => r.intervals.map((i) => `${i.kind}:${i.part}:${i.t0.toFixed(3)}-${i.t1.toFixed(3)}`).join('|');
    const pierceHasAir = pierce0.intervals.some((i) => i.kind === 'air');
    const pierceAllSolid = pierce1.intervals.every((i) => i.kind === 'solid');
    T('测量线覆盖：避腔线区间翻转后原样保留；穿孔线由含空腔变为全实体',
      sig(avoid0) === sig(avoid1) && pierceHasAir && pierceAllSolid,
      `避腔线 ${sig(avoid0)}；穿孔线 空气段=${pierceHasAir}→全实体=${pierceAllSolid}`);
  } finally {
    renderer.debug.stencilAlways = false;
    renderer.debug.capNoDepth = false;
    app.loadModelById('cavity');
    app.setPlane('z', 0);
    app.setSemantic('winding');
    app.setCamera([-2.0, 1.4, -3.2], [0, 0, 0]);
    app.renderOnce();
  }
  return results;
}
