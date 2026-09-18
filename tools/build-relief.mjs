#!/usr/bin/env node
/* ============================================================
   TERRA · 高程色带构建

   把 elev_bump_4k.jpg（灰度高程）转成等距圆柱的高程色带 PNG。

   ── 为什么必须在构建期做 ─────────────────────────────
   file:// 下把图片画进 canvas 会污染画布，getImageData() 直接
   抛 SecurityError。所以「读像素→映射色带」这一步不能在浏览器
   里做，只能预先烤成一张现成的彩色贴图，运行时用 TextureLoader
   直接贴——那条路径只上传纹理、不读像素，file:// 下畅通无阻。

   ── 色带的诚实性 ─────────────────────────────────
   elev_bump 是归一化的相对起伏，没有绝对海拔标定，所以色带
   只表达「低 → 高」的定性梯度，界面上不标具体米数。要标米数
   得另找带真实高程值的 DEM，不在本期范围。

   用法: node tools/build-relief.mjs
   产出: assets/relief/elev_color_2048.png
   ============================================================ */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = join(ROOT, 'assets/relief/elev_bump_4k.jpg');
const DEST = join(ROOT, 'assets/relief/elev_color_2048.png');

const OUT_W = 2048;                 // 输出宽，高为其一半

/* 海陆分界灰度。这张图的海面不是黑的，而是被压成一个平台：
   实测灰度 23 占 35.5%、24 占 29.3%，两者合计 64.9%，正好是
   地球的海洋占比；陆地则从 25 起连续爬升到 255。
   所以 25 是分界线，低于它的都当海处理。 */
const SEA = 25;

/* 高程色带。节点是 [归一化灰度, R, G, B]，之间线性插值。
   取色沿用地理学通用习惯：低地绿、高原黄褐、高山灰白，
   与气候层的 Köppen 配色一样，是知识载体而非装饰。

   节点的位置不是拍脑袋均分的，是按下面 ANCHORS 的实测定标摆的：
   这张图的灰度-海拔关系严重非线性，低海拔被挤在 25 附近（华北
   平原 50m 和亚马逊平原 100m 都是灰度 25），高海拔才被拉开
   （4500m → 201、珠峰 → 234）。若按线性高程均分色带，占陆地
   面积最大的低地会全挤进同一档，糊成一片。 */
const RAMP = [
  [0.00,  46,  92,  72],   // 海平面附近：草绿
  [0.10,  96, 140,  70],   // ~800 m：黄绿
  [0.17, 150, 164,  82],   // ~2500 m：土黄
  [0.33, 196, 158,  88],   // ~3800 m：橙棕
  [0.55, 196, 138,  86],   // 高原主体：红棕
  [0.72, 178, 150, 140],   // 雪线附近：灰褐
  [0.82, 216, 218, 222],   // 常年积雪
  [0.92, 246, 248, 252],   // 冰盖
  [1.00, 255, 255, 255],
];

function ramp(t) {
  if (t <= RAMP[0][0]) return [RAMP[0][1], RAMP[0][2], RAMP[0][3]];
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const a = RAMP[i - 1], b = RAMP[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      return [
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
      ];
    }
  }
  const last = RAMP[RAMP.length - 1];
  return [last[1], last[2], last[3]];
}

async function main() {
  console.log('TERRA · 高程色带构建\n');

  console.log('[1/3] 解码源图');
  const buf = await readFile(SRC);
  const img = jpeg.decode(buf, { useTArray: true });
  const { width: sw, height: sh, data } = img;
  console.log(`  elev_bump_4k.jpg  ${sw} × ${sh}`);

  /* --- 采样统计：确认海陆分界到底落在哪个灰度上 ---
     低段逐值打印，因为海陆分界就藏在这一小段里；
     JPEG 会把本应是常数的海面抖成一小簇值，必须看清簇心。 */
  const total = sw * sh;
  const lo = new Array(64).fill(0);
  const hi = new Array(16).fill(0);
  for (let i = 0; i < total; i++) {
    const v = data[i * 4];                       // 灰度图，取 R 通道即可
    if (v < 64) lo[v]++; else hi[v >> 4]++;
  }
  console.log('  灰度 0..63（逐值，占比 >0.05% 才列出）:');
  for (let v = 0; v < 64; v++) {
    const p = lo[v] / total * 100;
    if (p < 0.05) continue;
    console.log(`    ${String(v).padStart(3)}  ${'█'.repeat(Math.round(p * 1.2))} ${p.toFixed(2)}%`);
  }
  console.log('  灰度 64..255（每格 16 级）:');
  for (let i = 4; i < 16; i++) {
    const p = hi[i] / total * 100;
    if (p < 0.01) continue;
    console.log(`    ${String(i * 16).padStart(3)}  ${'█'.repeat(Math.round(p * 1.2))} ${p.toFixed(2)}%`);
  }

  /* --- 定标：拿已知海拔的地标反查灰度，看清高低映射 ---
     这张图没有附标定说明，与其猜色带节点，不如直接量。
     量出来的关系决定色带怎么摆，也决定界面上敢不敢标米数。 */
  console.log('\n  定标（已知地标的灰度值）:');
  const probe = (lat, lon) => {
    const x = Math.min(sw - 1, Math.max(0, Math.floor((lon + 180) / 360 * sw)));
    const y = Math.min(sh - 1, Math.max(0, Math.floor((90 - lat) / 180 * sh)));
    return data[(y * sw + x) * 4];
  };
  const ANCHORS = [
    ['珠穆朗玛峰',    27.99,  86.93,  8848],
    ['青藏高原',      33,     88,     4500],
    ['安第斯(玻利维亚)', -16,  -68,    3800],
    ['埃塞俄比亚高原',  9,     40,     2500],
    ['美国大平原',     40,   -100,     800],
    ['华北平原',       35,    116,      50],
    ['亚马逊平原',     -3,    -60,     100],
    ['死海洼地',       31.5,   35.5,  -430],
  ];
  for (const [name, lat, lon, alt] of ANCHORS) {
    const v = probe(lat, lon);
    // 顺便预览它会被涂成什么颜色——色带设计得对不对，看这行最直接
    const c = v < SEA ? null : ramp((v - SEA) / (255 - SEA));
    const swatch = c
      ? `\x1b[48;2;${c[0] | 0};${c[1] | 0};${c[2] | 0}m      \x1b[0m rgb(${c.map(n => n | 0).join(',')})`
      : '\x1b[2m  海洋/透明\x1b[0m';
    console.log(`    ${name.padEnd(20)} ${String(lat).padStart(6)},${String(lon).padStart(7)}` +
                `  灰度 ${String(v).padStart(3)}  ${swatch}   (实际约 ${alt} m)`);
  }

  /* --- 2. 重采样到输出尺寸并上色 --- */
  console.log(`\n[2/3] 重采样 → ${OUT_W} × ${OUT_W / 2} 并上色`);

  const ow = OUT_W;
  const oh = OUT_W >> 1;
  const sx = sw / ow;                            // 每个输出像素覆盖的源像素数
  const sy = sh / oh;

  const png = new PNG({ width: ow, height: oh });

  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(sh, Math.floor((y + 1) * sy));

    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(sw, Math.floor((x + 1) * sx));

      // 先做块平均降采样，抑制 JPEG 噪声和混叠
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let idx = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, idx += 4) { sum += data[idx]; n++; }
      }
      const v = n ? sum / n : 0;

      const o = (y * ow + x) * 4;
      if (v < SEA) {
        png.data[o + 3] = 0;                     // 海洋留透明，露出底下的真实海面
        continue;
      }

      // 把 [SEA,255] 重新拉伸到 [0,1]，免得陆地色带从最暗那档起步
      const t = (v - SEA) / (255 - SEA);
      const c = ramp(t);
      png.data[o]     = c[0];
      png.data[o + 1] = c[1];
      png.data[o + 2] = c[2];
      png.data[o + 3] = 255;
    }
  }

  /* --- 3. 输出 --- */
  console.log('\n[3/3] 写出');
  const out = PNG.sync.write(png, { colorType: 6 });
  await writeFile(DEST, out);
  console.log(`  ✓ assets/relief/elev_color_2048.png  (${(out.length / 1024).toFixed(0)} KB)`);
  console.log('\n完成。');
}

main().catch(err => {
  console.error('\n✗ ' + err.message);
  process.exit(1);
});
