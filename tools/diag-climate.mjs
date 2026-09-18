#!/usr/bin/env node
/* ============================================================
   TERRA · 气候栅格定点诊断

   拾取验证里几个沿海/边界城市查不到或查偏（悉尼→空、
   北京→BSk、洛杉矶→BSh）。这可能是三种原因之一：

     a) 最近邻采样取到了恰好是海（或恰好是另一类）的那一个像素；
     b) 重投影的行列换算有偏差，取的根本不是那个位置；
     c) 源数据在那个 0.35° 格子里本来就是那样。

   分辨方法：把请求点周围一圈源像素的类型分布打出来。
   若窗口里绝大多数是期望类型，而中心像素不是 → (a) 或 (b)；
   若窗口本身就混杂 → (c)，是分辨率的本性问题。

   用法: node tools/diag-climate.mjs
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';

const ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC   = join(ROOT, 'assets/climate/koppen_1991_2020.tif');
const ZONES = join(ROOT, 'assets/climate/zones.json');

const R = 6378137;
const MAX = Math.PI * R;
const latToMercY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

/** 有疑问的地点 + 期望的 Köppen 编码 */
const POINTS = [
  ['悉尼',      -33.87, 151.21, 'Cfb'],
  ['北京',       39.90, 116.41, 'Dwa'],
  ['洛杉矶',     34.05, -118.24, 'Csa'],
  ['死海洼地',   31.5,   35.5,  'BWh'],
  ['东京',       35.68, 139.69, 'Cfa'],
  ['上海',       31.23, 121.47, 'Cfa'],
  ['新德里',     28.61,  77.21, 'BSh'],
];

const WIN = 12;          // 半径（源像素），约 1.05° 经度

const zones = JSON.parse(await readFile(ZONES, 'utf8'));
const codeOf = v => (zones[v] ? zones[v].code : null);

const buf = await readFile(SRC);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const tiff = await fromArrayBuffer(ab);
const image = await tiff.getImage();
const sw = image.getWidth(), sh = image.getHeight();
const rasters = await image.readRasters({ interleave: true });
const nodata = image.getGDALNoData();

const toSrc = (lat, lon) => {
  const sy = latToMercY(Math.max(-85.0511, Math.min(85.0511, lat)));
  const sr = Math.floor((MAX - sy) / (2 * MAX) * sh);
  const sx = R * lon * Math.PI / 180;
  const sc = Math.floor((sx + MAX) / (2 * MAX) * sw);
  return { sc, sr };
};
/** 源像素 → 经纬度（像素中心） */
const toLL = (sc, sr) => {
  const x = (sc + 0.5) / sw * 2 * MAX - MAX;
  const y = MAX - (sr + 0.5) / sh * 2 * MAX;
  return {
    lon: x / R * 180 / Math.PI,
    lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI,
  };
};

console.log(`源栅格 ${sw} × ${sh}，1 像素 ≈ ${(360 / sw).toFixed(4)}° 经度\n`);

for (const [name, lat, lon, want] of POINTS) {
  const { sc, sr } = toSrc(lat, lon);
  const c = toLL(sc, sr);

  console.log(`■ ${name}  请求 ${lat}, ${lon}   期望 ${want}`);
  console.log(`  最近邻取到的源像素 (${sc}, ${sr}) 中心 = ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}` +
              `   偏离 ${(Math.abs(c.lat - lat) * 111).toFixed(1)} km 南北 / ` +
              `${(Math.abs(c.lon - lon) * 111 * Math.cos(lat * Math.PI / 180)).toFixed(1)} km 东西`);

  const v0 = rasters[sr * sw + sc];
  console.log(`  该像素值 = ${v0}  → ${codeOf(v0) || '空/海'}`);

  // 窗口内类别直方图
  const hist = new Map();
  let n = 0;
  for (let r2 = sr - WIN; r2 <= sr + WIN; r2++) {
    if (r2 < 0 || r2 >= sh) continue;
    for (let c2 = sc - WIN; c2 <= sc + WIN; c2++) {
      if (c2 < 0 || c2 >= sw) continue;
      const v = rasters[r2 * sw + c2];
      const k = (v >= 1 && v <= 30 && v !== nodata) ? codeOf(v) : '(海)';
      hist.set(k, (hist.get(k) || 0) + 1);
      n++;
    }
  }
  const rows = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  窗口 ±${WIN}px（约 ±1.05°）内 ${n} 个源像素的构成:`);
  for (const [k, cnt] of rows.slice(0, 6)) {
    const p = cnt / n * 100;
    console.log(`    ${String(k).padEnd(6)} ${'█'.repeat(Math.max(1, Math.round(p / 2)))} ${p.toFixed(1)}%`);
  }
  console.log('');
}
