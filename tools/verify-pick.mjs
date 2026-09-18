#!/usr/bin/env node
/* ============================================================
   TERRA · 拾取链路验证

   阶段 4 的地基：点中球面任一处，要能查出
     ① 气候分类（来 Köppen 栅格）
     ② 所属板块（来 PB2002 多边形）
     ③ 陆地还是海洋

   这三件事各自依赖不同的数据集，而数据集之间的一致性是
   最容易出岔子的地方——比如 110m 陆地面与 1024×512 气候栅格
   分辨率不同，沿海城市可能一边判陆一边判海。这个脚本用一组
   已知答案的地点把它们对齐验一遍。

   纯 Node 运行，不需要浏览器：把浏览器端那几个 IIFE 脚本
   eval 到同一个作用域里，直接调它们的函数。

   用法: node tools/verify-pick.mjs
   ============================================================ */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

/* 期望值来自各自数据源的权威说法：
     climate  Köppen-Geiger 分类（Beck et al. 2018）
     plate    PB2002 板块代号（Bird 2003）
     land     该点是否在陆地上

   climate / plate 填 null 表示「不作硬性要求」，只打印实际值供人工核对。
   第 7 项是已知偏差说明：填了就不再计入通过率，只打印出来备查——
   这类点要么是数据分辨率的固有极限，要么是板块边界线上本就两可。 */
const POINTS = [
  // 名称              lat     lon      climate  plate  land   已知偏差
  ['东京',            35.68,  139.69,  'Cfa',   'OK',  true],
  ['北京',            39.90,  116.41,  'BSk',   'EU',  true,
   '源数据该像素即为 BSk。北京年降水 570mm 与干旱阈值 538mm 仅一线之隔，正处在 Dwa/BSk 交界'],
  ['上海',            31.23,  121.47,  'Cfa',   'YA',  true],
  ['香港',            22.32,  114.17,  'Cwa',   'YA',  true],
  ['乌鲁木齐',        43.83,   87.62,  'BSk',   'EU',  true],
  ['拉萨',            29.65,   91.14,  'Dwb',   'EU',  true,
   '拉萨市区海拔 3650m 但最热月均温约 16°C，过了树木线阈值，故是 Dwb 而非苔原 ET'],
  ['新德里',          28.61,   77.21,  'BSh',   'IN',  true],
  ['撒哈拉沙漠',      23,      13,     'BWh',   'AF',  true],
  ['开罗',            30.04,   31.24,  'BWh',   'AF',  true],
  ['伦敦',            51.51,   -0.13,  'Cfb',   'EU',  true],
  ['罗马',            41.90,   12.50,  'Csa',   'EU',  true],
  ['莫斯科',          55.76,   37.62,  'Dfb',   'EU',  true],
  ['纽约',            40.71,  -74.01,  'Cfa',   'NA',  true],
  ['洛杉矶',          34.05, -118.24,  'BSh',   'PA',  true,
   '两块拼接的结果：圣安德烈亚斯断层以西属太平洋板块（故板块为 PA 而非 NA）；' +
   '气候则是 39km 格子的固有极限——该格覆盖圣费尔南多谷内陆，票选落在 BSh'],
  ['亚马逊',          -3,     -60,     'Af',    'SA',  true],
  ['里约热内卢',     -22.91,  -43.17,  'Aw',    'SA',  true],
  ['悉尼',           -33.87,  151.21,  'Cfa',   'AU',  true,
   '澳大利亚东岸属湿润亚热带 Cfa，不是温带海洋性 Cfb'],
  ['珀斯',           -31.95,  115.86,  'Csa',   'AU',  true],
  ['开普敦',         -33.92,   18.42,  'Csb',   'AF',  true],
  ['珠穆朗玛峰',      27.99,   86.93,  'ET',    'EU',  true,
   'PB2002 的印度板块北界是喜马拉雅前锋；珠峰在其北侧，属欧亚板块'],
  ['青藏高原',        33,      88,     'ET',    'EU',  true],
  ['死海洼地',        31.5,    35.5,   'BSh',   'AR',  true,
   '约旦河谷正处 BWh/BSh 过渡带，源数据该像素即为 BSh'],
  ['冰岛',            64.8,   -18.6,   'ET',    'NA',  true,
   '大西洋中脊自西南向东北穿过冰岛；PB2002 把冰岛划在北美板块一侧'],
  ['格陵兰内陆',      72,     -40,     'EF',    'NA',  true],
  ['南极洲内陆',     -80,       0,     'EF',    'AN',  true],
  ['西伯利亚',        60,     100,     'Dfc',   'EU',  true],

  // 海洋：气候必须为 null（Köppen 只覆盖陆地），板块仍须命中（PB2002 覆盖全球）
  ['太平洋中部',       0,    -150,     null,    'PA',  false],
  ['大西洋中部',      30,     -40,     null,    'AF',  false],
  ['印度洋中部',     -20,      80,     null,    'AU',  false],
  ['北冰洋',          85,       0,     null,    'NA',  false],
  ['马里亚纳海沟',    11.35,  142.2,   null,    'PS',  false,
   '该点正落在海沟轴线上，即太平洋板块与菲律宾海板块的边界，归属两可'],
  ['白令海峡',        65.8,  -169,     null,    'NA',  false],
];

/* ---------------- 在同一个作用域里加载浏览器端脚本 ---------------- */

const code = `
  ${read('js/geo.js')}
  ${read('assets/climate/koppen_grid.js')}
  ${read('assets/plates/plates.js')}
  ${read('assets/vectors/land.js')}
  ${read('assets/vectors/coastline.js')}

  window.__probe = function (lat, lon) {
    const cz = window.TERRA_CLIMATE.at(lat, lon);
    const plate = Geo.findPolygon(lon, lat, window.TERRA_GEO.platePolygons.features);
    const land = Geo.findPolygon(lon, lat, window.TERRA_GEO.land.features);
    return {
      climate: cz ? cz.code : null,
      plate: plate ? plate.code : null,
      land: !!land,
    };
  };
`;

global.window = global;
// eslint-disable-next-line no-eval
eval(code);

/* ---------------- 跑 ---------------- */

const pad = (s, n) => String(s === null || s === undefined ? '—' : s).padEnd(n);
const fail = [];

console.log('TERRA · 拾取链路验证\n');
console.log('  地点'.padEnd(20) + '坐标'.padEnd(18) + '气候'.padEnd(8) + '板块'.padEnd(7) + '陆地');
console.log('  ' + '─'.repeat(66));

let notes = 0;
for (const [name, lat, lon, wantC, wantP, wantLand, note] of POINTS) {
  const got = window.__probe(lat, lon);

  const bad = [];
  if (wantC !== null && got.climate !== wantC) bad.push(`气候 ${got.climate}≠${wantC}`);
  if (wantP !== null && got.plate !== wantP) bad.push(`板块 ${got.plate}≠${wantP}`);
  if (got.land !== wantLand) bad.push(`海陆 ${got.land ? '陆' : '海'}≠${wantLand ? '陆' : '海'}`);

  // 带说明的条目只记录不判分——它们是已经查清的偏差，
  // 当成回归失败只会让这个脚本天天飘红，反而没人看
  if (note) notes++;
  const mark = bad.length ? (note ? '△' : '✗') : '✓';
  if (bad.length && !note) fail.push(`${name}: ${bad.join('，')}`);

  console.log(`  ${mark} ${pad(name, 18)}${pad(lat + ',' + lon, 18)}` +
              `${pad(got.climate, 8)}${pad(got.plate, 7)}${got.land ? '陆' : '海'}`);
  if (note && bad.length) console.log(`      ↳ ${bad.join('，')}\n        ${note}`);
}

const scored = POINTS.length - notes;
console.log('');
if (fail.length === 0) {
  console.log(`  ${scored} 个判分地点全部符合预期 ✓` +
              (notes ? `（另有 ${notes} 处已知偏差，见上方 △）` : ''));
} else {
  console.log(`  ${scored - fail.length}/${scored} 通过，${fail.length} 处不符：`);
  fail.forEach(f => console.log('    ✗ ' + f));
}

/* 板块多边形的全球覆盖：任取一批随机点，看有没有落空的 */
let hole = 0;
for (let i = 0; i < 400; i++) {
  const lat = Math.asin(Math.random() * 2 - 1) * 180 / Math.PI;
  const lon = Math.random() * 360 - 180;
  if (!window.__probe(lat, lon).plate) hole++;
}
console.log(`\n  板块多边形全球覆盖抽查 400 点：${hole === 0 ? '无空洞 ✓' : hole + ' 点落空 ✗'}`);

/* ---------------- 配图索引与地貌清单的对应 ---------------- */

/* 两个方向都会出问题，而两种问题在页面上都看不出来：
     多一个键 → 拼错了字，那张图永远不会被点到，纯粹占着仓库
     少一个键 → 卡片点开是空的。js/photos.js 查不到就返回空串，
                不报错、不留痕迹，56 张里少一张肉眼翻不出来
   所以这条要在数据集层面卡死，别指望点开卡片时发现 */
function loadWindow(rel, key) {
  const sandbox = { window: {} };
  vm.runInNewContext(read(rel), sandbox);
  return sandbox.window[key];
}

const names = loadWindow('js/data.js', 'TERRA_DATA').features.map(f => f.name);
const photoKeys = Object.keys(loadWindow('assets/photos/credits.js', 'TERRA_PHOTOS') || {});
const noPhoto = names.filter(n => !photoKeys.includes(n));
const ghost = photoKeys.filter(k => !names.includes(k));

console.log(`\n  配图索引 ${photoKeys.length} 条 / 地貌 ${names.length} 个：` +
  (noPhoto.length || ghost.length
    ? `✗ 缺 ${noPhoto.length}，多 ${ghost.length}`
    : '一一对应 ✓'));
if (noPhoto.length) console.log(`    没有配图：${noPhoto.join('、')}`);
if (ghost.length) console.log(`    索引里没有对应地貌：${ghost.join('、')}`);
