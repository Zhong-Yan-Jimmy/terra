#!/usr/bin/env node
/* ============================================================
   TERRA · 数据获取脚本

   把所有外部数据源抓到 assets/ 下，之后项目完全离线运行。
   数据源实测均可直连（国内网络不需要代理）：
     - cdn.jsdelivr.net       可代理 GitHub 仓库内容
     - naciscdn.org           Natural Earth 官方 CDN

   用法: node tools/fetch-data.mjs [--force]
     --force  已存在的文件也重新下载

   产出：
     assets/earth/     地表色 / 法线 / 高光 / 云层（NASA，公有领域）
     assets/relief/    高程凹凸图
     assets/climate/   Köppen 栅格（原始 COG）+ 气候档案数据
     assets/plates/    板块边界与板块多边形（PB2002）
     assets/vectors/   陆地面 / 海岸线 / 河流 / 湖泊 / 冰川 / 地理线（Natural Earth 110m）
   ============================================================ */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

const JS = 'https://cdn.jsdelivr.net/gh';
const NE = `${JS}/nfarabullini/natural-earth-geojson@master/110m/physical`;

/* ---------------- 下载清单 ----------------
   [本地相对路径, 远程 URL]
   标注 //raw 的条目是原始 JSON，会额外转成 .js 常量（浏览器 file:// 下不能 fetch） */
const SOURCES = [
  // —— 地球基础贴图（NASA Blue Marble，公有领域）——
  ['assets/earth/earth_atmos_2048.jpg',    `${JS}/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg`],
  ['assets/earth/earth_normal_2048.jpg',   `${JS}/mrdoob/three.js@r128/examples/textures/planets/earth_normal_2048.jpg`],
  ['assets/earth/earth_specular_2048.jpg', `${JS}/mrdoob/three.js@r128/examples/textures/planets/earth_specular_2048.jpg`],
  ['assets/earth/earth_clouds_1024.png',   `${JS}/mrdoob/three.js@r128/examples/textures/planets/earth_clouds_1024.png`],

  // —— 高程 ——
  ['assets/relief/elev_bump_4k.jpg',       `${JS}/turban/webgl-earth@master/images/elev_bump_4k.jpg`],

  // —— 气候（Beck et al. 2018，CC BY 4.0）——
  ['assets/climate/koppen_1991_2020.tif',  `${JS}/dropbop/koppen@main/public/data/cogs/1991-2020.tif`],
  ['assets/climate/zones.json',            `${JS}/dropbop/koppen@main/public/data/zones.json`],

  // —— 板块与地质（PB2002, Bird 2003）——
  ['assets/plates/boundaries.json',        `${JS}/fraxen/tectonicplates@master/GeoJSON/PB2002_boundaries.json`],
  ['assets/plates/plates.json',            `${JS}/fraxen/tectonicplates@master/GeoJSON/PB2002_plates.json`],

  // —— 自然地理矢量（Natural Earth 110m，公有领域）——
  ['assets/vectors/land.json',             `${NE}/ne_110m_land.json`],
  ['assets/vectors/coastline.json',        `${NE}/ne_110m_coastline.json`],
  ['assets/vectors/rivers.json',           `${NE}/ne_110m_rivers_lake_centerlines.json`],
  ['assets/vectors/lakes.json',            `${NE}/ne_110m_lakes.json`],
  ['assets/vectors/glaciers.json',         `${NE}/ne_110m_glaciated_areas.json`],
  ['assets/vectors/geographic_lines.json', `${NE}/ne_110m_geographic_lines.json`],
];

/* 需要转成浏览器可直接 <script> 引入的 .js 的 GeoJSON。
   key 是暴露在 window.TERRA_GEO 上的名字。 */
const GEO_TO_JS = [
  ['assets/vectors/land.json',             'land'],
  ['assets/vectors/coastline.json',        'coastline'],
  ['assets/vectors/rivers.json',           'rivers'],
  ['assets/vectors/lakes.json',            'lakes'],
  ['assets/vectors/glaciers.json',         'glaciers'],
  ['assets/vectors/geographic_lines.json', 'geoLines'],
  ['assets/plates/boundaries.json',        'plateBoundaries'],
  ['assets/plates/plates.json',            'platePolygons'],
];

/* ---------------- 工具 ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function download(url, dest, attempt = 1) {
  const full = join(ROOT, dest);
  if (!FORCE && existsSync(full)) {
    const kb = ((await readFile(full)).length / 1024).toFixed(0);
    console.log(`  ↷ 已存在  ${dest}  (${kb} KB)`);
    return;
  }

  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buf);
    console.log(`  ✓ ${dest}  (${(buf.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    if (attempt < 3) {
      console.log(`  … 重试 (${attempt}/3) ${dest} — ${err.message}`);
      await sleep(800 * attempt);
      return download(url, dest, attempt + 1);
    }
    throw new Error(`下载失败: ${dest}\n  ${url}\n  ${err.message}`);
  }
}

/** 坐标抽稀到指定小数位，去掉 Natural Earth 的一长串无用属性 */
function simplifyGeoJSON(geo, decimals) {
  const f = Math.pow(10, decimals);
  const round = c => (Array.isArray(c[0]) ? c.map(round) : [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f]);

  return {
    type: 'FeatureCollection',
    features: geo.features.map(feat => ({
      type: 'Feature',
      properties: {
        name: feat.properties.name || feat.properties.NAME || '',
        ...(feat.properties.PlateA ? { plateA: feat.properties.PlateA, plateB: feat.properties.PlateB } : {}),
        ...(feat.properties.Code ? { code: feat.properties.Code } : {}),
      },
      geometry: {
        type: feat.geometry.type,
        coordinates: feat.geometry.type === 'MultiLineString' || feat.geometry.type === 'MultiPolygon'
          ? feat.geometry.coordinates.map(round)
          : round(feat.geometry.coordinates),
      },
    })),
  };
}

/** 把 GeoJSON 写成浏览器可直接 <script> 引入的 .js */
async function geoToScript(jsonPath, key) {
  const full = join(ROOT, jsonPath);
  const geo = JSON.parse(await readFile(full, 'utf8'));

  // 线条类抽稀到 3 位（约 100m 精度），多边形 2 位即可
  const isPoly = geo.features.some(f => f.geometry.type.includes('Polygon'));
  const slim = simplifyGeoJSON(geo, isPoly ? 2 : 3);

  const dest = jsonPath.replace(/\.json$/, '.js');
  const body =
    `/* 由 tools/fetch-data.mjs 生成，请勿手工编辑。\n` +
    `   源: ${jsonPath} — 要素 ${geo.features.length} 个 */\n` +
    `window.TERRA_GEO = window.TERRA_GEO || {};\n` +
    `TERRA_GEO.${key} = ${JSON.stringify(slim)};\n`;

  await writeFile(join(ROOT, dest), body, 'utf8');
  console.log(`  ✓ ${dest}  (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB, ${geo.features.length} 要素)`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('TERRA · 数据获取\n');

  console.log('[1/3] 下载原始资源');
  for (const [dest, url] of SOURCES) {
    await download(url, dest);
  }

  console.log('\n[2/3] 转换矢量为浏览器可用的 .js 常量');
  for (const [path, key] of GEO_TO_JS) {
    await geoToScript(path, key);
  }

  console.log('\n[3/3] 下一步');
  console.log('  气候栅格解码:  node tools/build-climate.mjs');
  console.log('  贴图内联:      node tools/inline-textures.mjs   ← 换过图源就必须重跑');
  console.log('  UV 对齐验证:   node tools/verify-uv.mjs');
  console.log('\n完成。');
}

main().catch(err => {
  console.error('\n✗ ' + err.message);
  process.exit(1);
});
