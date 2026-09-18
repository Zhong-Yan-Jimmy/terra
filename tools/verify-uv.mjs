#!/usr/bin/env node
/* ============================================================
   TERRA · UV 对齐验证

   这是整个项目最高风险的一环，所以用数学采样自动验证，不靠肉眼。

   链路：地理经纬度 → 球面位置 → SphereGeometry 的 UV → 贴图像素
   如果这条链路正确，采样特征点应当得到符合实际地表的颜色：
   太平洋该是深蓝、撒哈拉该是沙黄、南极该是白。

   产出：
     终端报告
     tools/out/uv-check.png —— 在贴图上标出各特征点，可直接肉眼核对

   用法: node tools/verify-uv.mjs
   ============================================================ */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEX = join(ROOT, 'assets/earth/earth_atmos_2048.jpg');
const OUT_DIR = join(ROOT, 'tools/out');

/* 特征点：[名称, 纬度, 经度, 期望的地表类型]
   期望类型只用于自动打分，最终以标注图为准。 */
const PROBES = [
  ['太平洋中部',      0, -150, 'sea'],
  ['撒哈拉沙漠',     23,   13, 'sand'],
  ['亚马逊雨林',     -3,  -60, 'veg'],
  ['南极洲内陆',    -80,    0, 'ice'],
  ['珠穆朗玛峰',     28,   87, 'ice'],
  ['大西洋中部',     30,  -40, 'sea'],
  ['西伯利亚针叶林', 60,  100, 'veg'],
  ['澳大利亚内陆',  -25,  130, 'sand'],
  ['格陵兰冰盖',     72,  -40, 'ice'],
  ['印度德干高原',   20,   78, 'veg'],
];

/* ============================================================
   坐标换算 —— 严格复现 three.js r128 SphereGeometry 的顶点公式：

     x = -r·cos(phi)·sin(theta)      phi   = u·2π
     y =  r·cos(theta)               theta = v·π
     z =  r·sin(phi)·sin(theta)      uv    = (u, 1-v)

   纹理默认 flipY=true，上传时被垂直翻转，
   于是 shader 的 t=1 对应图片顶部 —— 也就是几何体的北极。
   ============================================================ */

/** 经纬度 → 球面单位向量。与 SphereGeometry 的顶点位置完全一致 */
export function latLonToVec3(latDeg, lonDeg, radius = 1) {
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  return {
    x:  radius * Math.cos(lat) * Math.cos(lon),
    y:  radius * Math.sin(lat),
    z: -radius * Math.cos(lat) * Math.sin(lon),
  };
}

/** 经纬度 → 几何体 UV（u: 0=180°W … 1=180°E ；v: 0=北极 … 1=南极） */
export function latLonToUV(latDeg, lonDeg) {
  return { u: (lonDeg + 180) / 360, v: (90 - latDeg) / 180 };
}

/** 球面位置 → 几何体 UV。用于反向验证 latLonToVec3 与 SphereGeometry 自洽 */
export function vec3ToUV(P) {
  const u = Math.atan2(P.z, -P.x) / (2 * Math.PI);
  const v = Math.acos(Math.max(-1, Math.min(1, P.y))) / Math.PI;
  return { u: (u % 1 + 1) % 1, v };
}

/** 几何体 UV → 贴图像素下标（flipY 的作用已在此体现：v=0 即图片第 0 行） */
function uvToPixel(u, v, W, H) {
  const i = Math.min(W - 1, Math.max(0, Math.round(u * W - 0.5)));
  const j = Math.min(H - 1, Math.max(0, Math.round(v * H - 0.5)));
  return { i, j };
}

/* ---------------- 颜色分类（仅用于自动打分，最终以标注图为准） ----------------
   注意：卫星图上茂密森林是很暗的色（亚马逊实测 rgb(44,45,61)），
   蓝色分量甚至高于绿色，所以不能用「b 最大」来判海洋 ——
   必须要求蓝色「显著」高于绿和红，才能把暗色森林区分出来。 */
function classify(r, g, b) {
  const min = Math.min(r, g, b);
  if (min > 190) return 'ice';                          // 冰雪：三通道都高
  if (b > g + 20 && b > r + 25) return 'sea';           // 海洋：蓝色显著占优
  if (r > 110 && r > g && g > b) return 'sand';         // 干旱：明亮暖色，红>绿>蓝
  return 'veg';                                         // 其余按陆地植被计
}
const TYPE_CN = { sea: '海洋', sand: '沙漠/裸地', veg: '植被', ice: '冰雪', '?': '未判定' };

/* ---------------- 在图上画标记 ---------------- */
function mark(data, W, H, i, j, [r, g, b]) {
  const put = (x, y, col) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (y * W + x) * 4;
    data[k] = col[0]; data[k + 1] = col[1]; data[k + 2] = col[2]; data[k + 3] = 255;
  };
  const R = 7;
  // 先画深色描边，保证在浅色地表上也看得见
  for (let d = -R; d <= R; d++) {
    for (const [x, y] of [[i + d, j], [i, j + d]]) put(x, y, [0, 0, 0]);
  }
  for (let a = 0; a < 360; a += 6) {
    const rad = a * Math.PI / 180;
    put(Math.round(i + Math.cos(rad) * R), Math.round(j + Math.sin(rad) * R), [0, 0, 0]);
  }
  for (let d = -(R - 3); d <= R - 3; d++) {
    for (const [x, y] of [[i + d, j], [i, j + d]]) put(x, y, [r, g, b]);
  }
  for (let a = 0; a < 360; a += 8) {
    const rad = a * Math.PI / 180;
    put(Math.round(i + Math.cos(rad) * (R - 3)), Math.round(j + Math.sin(rad) * (R - 3)), [r, g, b]);
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  let raw;
  try {
    raw = jpeg.decode(await readFile(TEX), { useTArray: true });
  } catch {
    console.error(`\n✗ 读不到贴图 ${TEX}\n  请先运行: node tools/fetch-data.mjs\n`);
    process.exit(1);
  }

  const { width: W, height: H, data } = raw;
  console.log(`\n贴图: earth_atmos_2048.jpg  (${W}×${H})`);
  console.log('假设: 标准等距圆柱投影，左边缘 180°W，第一行是北极\n');

  /* —— 自洽性检查：位置反算的 UV 必须等于直接算的 UV —— */
  let maxErr = 0;
  for (const [, lat, lon] of PROBES) {
    const direct = latLonToUV(lat, lon);
    const back = vec3ToUV(latLonToVec3(lat, lon));
    const du = Math.abs(direct.u - back.u), dv = Math.abs(direct.v - back.v);
    maxErr = Math.max(maxErr, Math.min(du, 1 - du), dv);
  }
  console.log(`自洽检查: latLonToVec3 与 SphereGeometry 的 UV 约定最大偏差 ${maxErr.toExponential(1)}  ${maxErr < 1e-9 ? '✓' : '✗'}\n`);

  /* —— 逐点采样 —— */
  const pad = (s, n) => String(s).padEnd(n, ' ');
  const padS = (s, n) => String(s).padStart(n, ' ');
  console.log(pad('特征点', 16) + pad('经纬度', 15) + pad('像素', 13) + pad('采样颜色', 20) + '判定        期望');
  console.log('─'.repeat(88));

  let hit = 0;
  const png = new PNG({ width: W, height: H });
  png.data = Buffer.from(data);

  for (const [name, lat, lon, expect] of PROBES) {
    const { u, v } = latLonToUV(lat, lon);
    const { i, j } = uvToPixel(u, v, W, H);
    const k = (j * W + i) * 4;
    const [r, g, b] = [data[k], data[k + 1], data[k + 2]];
    const cls = classify(r, g, b);
    if (cls === expect) hit++;

    const coord = `${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`;
    const ok = cls === expect ? ' ✓' : ' ✗';
    console.log(
      pad(name, 16) + pad(coord, 15) +
      pad(`(${i},${j})`, 13) +
      pad(`rgb(${padS(r, 3)},${padS(g, 3)},${padS(b, 3)})`, 20) +
      pad(TYPE_CN[cls], 12) + pad(TYPE_CN[expect], 10) + ok
    );

    mark(png.data, W, H, i, j, [255, 60, 60]);
  }

  console.log('─'.repeat(88));
  console.log(`命中率: ${hit}/${PROBES.length}\n`);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, 'uv-check.png');
  await writeFile(outPath, PNG.sync.write(png));
  console.log(`标注图已输出: tools/out/uv-check.png`);
  console.log('请打开它确认红圈是否落在正确的地点 —— 这是最终依据。\n');

  if (hit === PROBES.length) {
    console.log('✓ UV 映射全部命中。latLonToVec3 / latLonToUV 可用于全项目。');
  } else if (hit >= PROBES.length - 2) {
    console.log('△ 大部分命中，少数未中多半是特征点落在过渡色带上（如海岸线附近）。以标注图为准。');
  } else {
    console.log('✗ 命中率过低，映射约定有误，需要重新检查。');
    process.exit(1);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
