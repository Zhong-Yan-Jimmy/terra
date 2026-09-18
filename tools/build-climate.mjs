#!/usr/bin/env node
/* ============================================================
   TERRA · 气候栅格构建

   把 Köppen-Geiger（Beck et al. 1991-2020）的 Cloud Optimized
   GeoTIFF 解码、重投影，存成浏览器可直接 <script> 引入的 .js。

   ── 为什么必须重投影 ───────────────────────────────
   源文件是 Web Mercator（EPSG:3857）的正方形栅格，不是经纬度
   网格：它的 bbox 是 ±20037508.34 米，且 4096×4096 是正方形。
   直接把行列号当经纬度索引会得到一张南北颠倒、纬度非线性
   拉伸的错图。必须按 Mercator 公式反解成等距圆柱（2:1）——
   这也正是 three.js SphereGeometry 贴图所用的投影。

   ── 为什么输出数组而不是 PNG ───────────────────────
   同一份数组既能用 ImageData 烤成球面纹理（供眼睛看），又能
   按 (lat, lon) O(1) 直接索引出气候编码（供点选查询）。只存
   PNG 的话，file:// 下 getImageData 会被 CORS 拦死，查询反
   而要绕一大圈。

   ── 为什么是 1024×512 ──────────────────────────────
   0.35° 网格，约 39 km。气候带本就是大尺度现象，这个精度在
   球面上每个像素占屏幕不到 2px，再多就是浪费。base64 内联
   会膨胀 33%，再大手笔就得按 MB 计了。

   用法: node tools/build-climate.mjs
   产出: assets/climate/koppen_grid.js
   ============================================================ */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';

const ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC   = join(ROOT, 'assets/climate/koppen_1991_2020.tif');
const DEST  = join(ROOT, 'assets/climate/koppen_grid.js');
const ZONES = join(ROOT, 'assets/climate/zones.json');

const OUT_W = 1024;
const OUT_H = 512;

const R = 6378137;                 // Web Mercator 的球体半径
const MAX = Math.PI * R;           // 20037508.342789244，投影半宽

/* 交叉验证点。期望值取自 zones.json 的 examples 字段，
   是这份数据「重投影有没有搞对」的对照表。 */
const CHECKS = [
  ['撒哈拉沙漠',      23,    13, ['BWh']],
  ['亚马逊雨林',      -3,   -60, ['Af']],
  ['刚果盆地',         0,    22, ['Af']],
  ['法国中部',        47,     2, ['Cfb']],
  ['英国伦敦',      51.5,  -0.1, ['Cfb']],
  ['日本东京',      35.7, 139.7, ['Cfa']],
  ['澳大利亚中部',   -25,   130, ['BWh']],
  ['西伯利亚中部',    62,   100, ['Dfc', 'Dfb', 'Dwc']],
  ['印度德干高原',    20,    78, ['BSh', 'Aw']],
  ['南极内陆',       -80,     0, ['EF']],
  ['格陵兰内陆',      72,   -40, ['EF']],
  ['北非利比亚',      25,    20, ['BWh']],
  ['加拿大北部',      60,  -110, ['Dfc', 'Dfb', 'Dwc']],
  ['巴西亚马逊河口',  -1,   -49, ['Af', 'Am']],
];

/* 沿海城市单列：它们考的不是「查得准不准」，而是「查不查得到」。
   0.35° 的格子中心很容易落进海里，最近邻采样时这些点会整片空白。
   允许多个答案，因为海岸本就处在类型交错带上；但绝不允许为空。 */
const COASTAL = [
  ['澳大利亚悉尼',  -33.87,  151.21, ['Cfa', 'Cfb']],
  ['美国洛杉矶',     34.05, -118.24, ['Csa', 'Csb']],
  ['中国上海',       31.23,  121.47, ['Cfa']],
  ['中国香港',       22.32,  114.17, ['Cwa', 'Cfa']],
  ['美国纽约',       40.71,  -74.01, ['Cfa', 'Dfa']],
  ['巴西里约',      -22.91,  -43.17, ['Aw', 'Cfa', 'Am']],
  ['南非开普敦',    -33.92,   18.42, ['Csb', 'Csa']],
  ['澳大利亚珀斯',  -31.95,  115.86, ['Csa', 'Csb', 'BSk']],
  ['印度孟买',       19.08,   72.88, ['Aw', 'Am']],
  ['阿根廷布宜诺斯',-34.60,  -58.38, ['Cfa', 'Dfa', 'BSk']],
  ['西班牙马德里',   40.42,   -3.70, ['Csa', 'BSk']],
  ['土耳其伊斯坦布', 41.01,   28.98, ['Csa', 'Cfa', 'BSk']],
];

/* ---------------- 工具 ---------------- */

/** 经纬度 → Web Mercator 的 y（米） */
const latToMercY = lat =>
  R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('TERRA · 气候栅格构建\n');

  const zones = JSON.parse(await readFile(ZONES, 'utf8'));

  /* --- 1. 读源栅格 --- */
  const buf = await readFile(SRC);
  // geotiff 要 ArrayBuffer；Buffer 底层可能是共享池，必须按视图切片
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();

  const sw = image.getWidth();
  const sh = image.getHeight();
  const nodata = image.getGDALNoData();

  console.log('[1/4] 读取源栅格');
  console.log(`  尺寸    ${sw} × ${sh}（Web Mercator，非经纬度网格）`);
  console.log(`  NoData  ${nodata === null ? '(未声明)' : nodata}`);

  const rasters = await image.readRasters({ interleave: true });

  /* --- 2. 重投影到等距圆柱 --- */
  console.log(`\n[2/4] 重投影 → ${OUT_W} × ${OUT_H} 等距圆柱`);

  const grid = new Uint8Array(OUT_W * OUT_H);
  const nd = nodata === null ? -1 : Number(nodata);

  /* 每个输出格子取源像素的**多数票**，而不是中心那一个像素。

     类别是离散的，绝不能插值——插值会造出「半沙漠半雨林」这种
     根本不存在的类型。但纯最近邻又太脆：0.35° 的格子只要中心那
     一个像素落在海上，整格就成了海（悉尼点出空白）；落在相邻类型
     上，整格就串味（洛杉矶中心像素取到的是内陆的半干旱 BSh，而
     该格子里最多的其实是沿海的 Csa）。

     多数票把两个问题一起解决，代价只是海岸线向外胖最多半格。 */
  const MIN_LAND = 0.35;   // 非海像素占比低于此值仍判为海，免得近海格子被陆地类型染上

  const counts = new Int32Array(31);   // 复用，免得五十万次分配
  let clamped = 0;

  for (let row = 0; row < OUT_H; row++) {
    const latTop = 90 - row / OUT_H * 180;
    const latBot = 90 - (row + 1) / OUT_H * 180;

    // Mercator 覆盖不到 ±85.0511° 以外。极冠在源图里本就不存在，
    // 钳到最近的有效行——那里的类别（EF 冰盖）正是极冠的真实情况。
    const clampLat = v => Math.max(-85.0511, Math.min(85.0511, v));
    let sr0 = Math.floor((MAX - latToMercY(clampLat(latTop))) / (2 * MAX) * sh);
    let sr1 = Math.floor((MAX - latToMercY(clampLat(latBot))) / (2 * MAX) * sh);
    if (sr1 <= sr0) { sr1 = sr0 + 1; clamped++; }     // 极冠两行钳成了同一行
    if (sr0 < 0) { sr0 = 0; clamped++; }
    if (sr1 > sh) { sr1 = sh; clamped++; }

    for (let col = 0; col < OUT_W; col++) {
      // 经度方向 Mercator 的 x 与经度成正比，线性换算即可
      const sc0 = Math.max(0, Math.floor(
        (R * (-180 + col / OUT_W * 360) * Math.PI / 180 + MAX) / (2 * MAX) * sw));
      const sc1 = Math.min(sw, Math.max(sc0 + 1, Math.floor(
        (R * (-180 + (col + 1) / OUT_W * 360) * Math.PI / 180 + MAX) / (2 * MAX) * sw)));

      counts.fill(0);
      let seen = 0, land = 0;

      for (let sr = sr0; sr < sr1; sr++) {
        const base = sr * sw;
        for (let sc = sc0; sc < sc1; sc++) {
          const v = rasters[base + sc];
          seen++;
          if (v >= 1 && v <= 30 && v !== nd) { counts[v]++; land++; }
        }
      }

      // 海（或陆地占比太低）：grid 保持 0，贴图上透出底下的真实海面
      if (!seen || land / seen < MIN_LAND) continue;

      let bestV = 0, bestN = 0;
      for (let v = 1; v <= 30; v++) if (counts[v] > bestN) { bestN = counts[v]; bestV = v; }
      grid[row * OUT_W + col] = bestV;
    }
  }

  console.log(`  多数票重采样；极冠钳制 ${clamped} 处（源投影不含 ±85° 以外）`);
  console.log(`  海陆阈值 ${MIN_LAND}：非海像素不足此比例的格子判为海`);

  /* --- 统计 --- */
  const hist = new Map();
  for (let i = 0; i < grid.length; i++) hist.set(grid[i], (hist.get(grid[i]) || 0) + 1);

  const total = grid.length;
  const landPct = ((total - (hist.get(0) || 0)) / total * 100).toFixed(1);
  const present = [...hist.keys()].filter(v => v !== 0).sort((a, b) => hist.get(b) - hist.get(a));

  console.log(`  有数据 ${landPct}%（等距圆柱下极区被拉伸，故比例高于实际陆海比）`);
  console.log(`  出现 ${present.length}/30 类气候`);

  const absent = Object.values(zones).filter(z => !hist.has(z.value)).map(z => z.code);
  if (absent.length) console.log(`  未出现：${absent.join(' ')}`);

  /* --- 3. 交叉验证 --- */
  console.log('\n[3/4] 交叉验证');

  const at = (lat, lon) => {
    let col = Math.floor((lon + 180) / 360 * OUT_W);
    let row = Math.floor((90 - lat) / 180 * OUT_H);
    if (col < 0) col += OUT_W;
    if (col >= OUT_W) col -= OUT_W;
    if (row < 0 || row >= OUT_H) return 0;
    return grid[row * OUT_W + col];
  };

  let pass = 0;
  for (const [name, lat, lon, expect] of CHECKS) {
    const v = at(lat, lon);
    const z = zones[v];
    const got = z ? z.code : '空';
    const ok = expect.includes(got);
    if (ok) pass++;
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(16)} ${String(lat).padStart(5)},${String(lon).padStart(6)}` +
                `  → ${got.padEnd(5)} ${z ? z.name : '(无数据)'}` +
                (ok ? '' : `   期望 ${expect.join('/')}`));
  }
  console.log(`  ${pass}/${CHECKS.length} 通过`);

  let cpass = 0;
  const cbad = [];
  for (const [name, lat, lon, expect] of COASTAL) {
    const v = at(lat, lon);
    const z = zones[v];
    const got = z ? z.code : '空';
    // 空是硬失败；类型落在期望集合之外只算存疑，海岸线上本就交错
    const ok = z && expect.includes(got);
    if (ok) cpass++;
    else if (!z) cbad.push(`${name} 查不到（格子被判为海）`);
    else cbad.push(`${name} → ${got}，期望 ${expect.join('/')}`);
    console.log(`  ${ok ? '✓' : (z ? '·' : '✗')} ${name.padEnd(16)} ${String(lat).padStart(5)},${String(lon).padStart(6)}` +
                `  → ${got.padEnd(5)} ${z ? z.name : '(查询落空)'}`);
  }
  console.log(`  沿海城市 ${cpass}/${COASTAL.length} 落在期望集合内`);

  if (pass < CHECKS.length || cbad.some(s => s.includes('查不到'))) {
    console.log('\n  ⚠ 有验证点未通过。气候带边界附近本就存在漂移，');
    console.log('    但若大面积不符、或沿海城市整片查不到，说明重投影仍有问题。');
  }

  /* --- 4. 输出 --- */
  console.log('\n[4/4] 写出');
  const b64 = Buffer.from(grid).toString('base64');

  // 渲染只需要 code / rgb / 分组；中文描述属于教育内容层，写在 js/data.js
  const render = {};
  for (const z of Object.values(zones)) {
    render[z.value] = { code: z.code, rgb: z.rgb, group: z.groupCode, groupName: z.group };
  }

  const body =
`/* 由 tools/build-climate.mjs 生成，请勿手工编辑。
   数据源: Beck et al. 2018, "Present and future Köppen-Geiger climate
           classification maps at 1-km resolution", Scientific Data 5:180214.
           CC BY 4.0 —— 使用时必须署名。
   投影:   等距圆柱（equirectangular），与 three.js SphereGeometry 贴图一致
   栅格:   ${OUT_W} × ${OUT_H}，像素值 1..30 对应 ZONES，0 表示海洋或无数据
   索引:   col = floor((lon + 180) / 360 * ${OUT_W})
           row = floor((90 - lat) / 180 * ${OUT_H})     // 北在上，图片顶部是北极 */
window.TERRA_CLIMATE = (function () {
  var B64 = "${b64}";
  var bin = atob(B64);
  var grid = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) grid[i] = bin.charCodeAt(i);

  return {
    width: ${OUT_W},
    height: ${OUT_H},
    grid: grid,
    zones: ${JSON.stringify(render)},

    /** 经纬度 → 气候档案条目；海洋或缺失返回 null */
    at: function (lat, lon) {
      var col = Math.floor((lon + 180) / 360 * ${OUT_W});
      var row = Math.floor((90 - lat) / 180 * ${OUT_H});
      if (row < 0 || row >= ${OUT_H}) return null;
      col = ((col % ${OUT_W}) + ${OUT_W}) % ${OUT_W};
      return this.zones[grid[row * ${OUT_W} + col]] || null;
    }
  };
})();
`;

  await writeFile(DEST, body, 'utf8');
  console.log(`  ✓ assets/climate/koppen_grid.js  (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB)`);
  console.log('\n完成。');
}

main().catch(err => {
  console.error('\n✗ ' + err.message);
  process.exit(1);
});
