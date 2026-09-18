#!/usr/bin/env node
/* ============================================================
   TERRA · 配图核验

   抓完图之后跑这个，确认 assets/photos/ 与 js/data.js 对得上。

   ── 为什么非要有这一步 ──────────────────────────────────
   缺一张图在浏览器里是"静默降级"：档案卡少一块，页面照常打开，
   唯一的痕迹是控制台里一条 ERR_FILE_NOT_FOUND。56 张里漏一张，
   靠肉眼翻档案卡基本发现不了。所以三个方向都要卡死：

     · js/data.js 的 56 个地貌 → 每一条都得有配图
     · credits.js 的每个键 → 都得是真地貌（拼错一个字的键就是幽灵条目）
     · assets/photos/ 的每个 .jpg → 都得被 credits.js 引用（否则白占仓库）

   顺带把 CC 合规也验一遍——署名缺作者、缺许可名、缺来源链接，
   在页面上看不出来，但那是许可条件没履行。

   用法:
     node tools/verify-photos.mjs
     node tools/verify-photos.mjs --quiet    只打问题与结论
   ============================================================ */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import jpeg from 'jpeg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST_DIR = join(ROOT, 'assets/photos');

const QUIET = process.argv.includes('--quiet');

const OUT_W = 800, OUT_H = 450;
const MIN_W = 640;            // 卡片在 dpr=2 下也要够清晰
const MAX_BYTES = 400 * 1024; // 单张上限，超过说明质量参数失控

const problems = [];
let checked = 0;

/** 载入一个浏览器端数据文件（它只做 window.XXX = {...} 这一件事） */
function loadWindow(file, key) {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(ROOT, file), 'utf8'), sandbox);
  return sandbox.window[key];
}

const features = loadWindow('js/data.js', 'TERRA_DATA').features;
const credits = loadWindow('assets/photos/credits.js', 'TERRA_PHOTOS') || {};
const names = features.map(f => f.name);

console.log(`TERRA · 配图核验　地貌 ${names.length} 个，索引 ${Object.keys(credits).length} 条\n`);

/* ---------------- 1 · 键集合双向对照 ---------------- */

const noPhoto = names.filter(n => !credits[n]);
const orphanKey = Object.keys(credits).filter(k => !names.includes(k));

if (noPhoto.length) problems.push(`有地貌没配图（${noPhoto.length}）：${noPhoto.join('、')}`);
if (orphanKey.length) problems.push(`索引里有不存在的地貌（${orphanKey.length}）：${orphanKey.join('、')}`);

if (!QUIET) {
  console.log('[1/4] 键集合');
  console.log(`  ${noPhoto.length ? '✗' : '✓'} 地貌 → 索引　${names.length - noPhoto.length}/${names.length}`);
  console.log(`  ${orphanKey.length ? '✗' : '✓'} 索引 → 地貌　${Object.keys(credits).length - orphanKey.length}/${Object.keys(credits).length}`);
}

/* ---------------- 2 · 逐条核验 ---------------- */

/* 许可白名单，与 tools/fetch-photos.mjs 的 licenseVerdict 保持一致。
   那边是 import 不进来的（顶层直接跑 main），所以这里复写一份；
   改闸门条件时两处要一起改。 */
function licenseOK(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/\b(NC|ND|GFDL|fair use|non-free)\b/i.test(t)) return false;
  return /^(public domain|pd|cc0)/i.test(t) || /^cc[ -]by([ -]sa)?([ -]\d(\.\d)?)?/i.test(t);
}

if (!QUIET) console.log('\n[2/4] 逐条核验');

const seenFiles = new Set();
let totalBytes = 0, largest = { slug: '', bytes: 0 };

for (const name of names) {
  const c = credits[name];
  if (!c) continue;   // 已在第 1 节记过
  checked++;
  const bad = [];

  // —— 文件 ——
  const rel = String(c.src || '');
  if (!rel.startsWith('assets/photos/')) bad.push(`src 路径异常：${rel}`);
  const abs = join(ROOT, rel);
  let bytes = 0;
  try {
    bytes = statSync(abs).size;
  } catch {
    bad.push('文件不存在');
  }
  if (bytes) {
    seenFiles.add(rel.split('/').pop());
    totalBytes += bytes;
    if (bytes > largest.bytes) largest = { slug: rel.split('/').pop(), bytes };
    if (bytes > MAX_BYTES) bad.push(`体积过大 ${(bytes / 1024).toFixed(0)} KB`);

    // —— 可解码 + 尺寸 ——
    try {
      const img = jpeg.decode(readFileSync(abs), { useTArray: true });
      if (img.width !== OUT_W || img.height !== OUT_H) {
        bad.push(`尺寸 ${img.width}×${img.height}，应为 ${OUT_W}×${OUT_H}`);
      }
      if (img.width < MIN_W) bad.push(`宽度不足 ${MIN_W}`);
      if (Math.abs(img.width / img.height - 16 / 9) > 0.01) bad.push('不是 16:9');
    } catch (err) {
      bad.push(`解码失败：${err.message}`);
    }
  }

  // —— 索引字段 ——
  if (c.w !== OUT_W || c.h !== OUT_H) bad.push(`索引里的 w/h 是 ${c.w}×${c.h}`);
  if (!c.author) bad.push('缺作者');
  if (!licenseOK(c.license)) bad.push(`许可不合规：${c.license || '(空)'}`);
  if (!c.source) bad.push('缺来源链接');
  if (!c.title) bad.push('缺原始文件名');
  // 公有领域不强制署名，但 CC 系必须给许可链接
  if (!c.licenseUrl && !/^(public domain|pd)/i.test(String(c.license))) bad.push('缺许可链接');
  // 海底那 5 张走测深图，其余一律实景照
  if (c.bathymetry && !/blue marble/i.test(String(c.title))) {
    bad.push(`标了 bathymetry 但来源不是测深图：${c.title}`);
  }

  if (bad.length) {
    problems.push(`${name}（${rel}）：${bad.join('；')}`);
    console.log(`  ✗ ${name}　${bad.join('；')}`);
  } else if (!QUIET) {
    console.log(`  ✓ ${name}　${rel.split('/').pop()}　${(bytes / 1024).toFixed(0)} KB　${c.license}`);
  }
}

/* ---------------- 3 · 目录里的孤儿文件 ---------------- */

const onDisk = readdirSync(DEST_DIR).filter(f => /\.jpe?g$/i.test(f));
const unreferenced = onDisk.filter(f => !seenFiles.has(f));
if (unreferenced.length) {
  problems.push(`目录里有没被引用的图（${unreferenced.length}）：${unreferenced.join('、')}`);
}

if (!QUIET) {
  console.log('\n[3/4] 目录');
  console.log(`  ${unreferenced.length ? '✗' : '✓'} 磁盘 ${onDisk.length} 个 .jpg，被引用 ${seenFiles.size} 个`);
  if (unreferenced.length) console.log(`    多余：${unreferenced.join('、')}`);
}

/* ---------------- 4 · 体积 ---------------- */

const mb = totalBytes / 1024 / 1024;
const budgetOK = mb <= 6;
if (!budgetOK) problems.push(`assets/photos 共 ${mb.toFixed(1)} MB，超出 6 MB 预算`);

console.log('\n[4/4] 体积');
console.log(`  共 ${checked} 张　${mb.toFixed(1)} MB　平均 ${(totalBytes / Math.max(1, checked) / 1024).toFixed(0)} KB`);
if (largest.slug) console.log(`  最大 ${largest.slug}　${(largest.bytes / 1024).toFixed(0)} KB　${budgetOK ? '' : '（超预算）'}`);

/* ---------------- 结论 ---------------- */

if (problems.length) {
  console.log(`\n✗ ${problems.length} 项问题：`);
  for (const p of problems) console.log('  · ' + p);
  process.exit(1);
}
console.log(`\n✓ ${checked}/${names.length} 就绪，键集合双向一致，许可齐全。`);
