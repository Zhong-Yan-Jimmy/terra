#!/usr/bin/env node
/* ============================================================
   TERRA · 配图联络表

   把 56 张配图排成一张大图，一屏看全，用来肉眼判断
   「这张拍的到底是不是这个地方」。

   ── 为什么不能塞进 shot.mjs ─────────────────────────────
   shot.mjs 审的是产品：给球体摆视角，看它渲染得对不对。
   联络表审的是资产：图本身合不合格。两者要能各自独立地跑——
   index.html 半坏的时候（比如某个 js 报错导致地球起不来），
   照样得能翻图片。所以这里单独一套 puppeteer 启动。

   ── 为什么必须先落 HTML 文件 ────────────────────────────
   page.setContent() 之后页面在 about:blank，那里的 <img src="file://...">
   会被判为跨源直接拒掉，整张表全是破图。落成 tools/out/contact-sheet.html
   再 goto(file://) 就没这问题，顺带还能双击打开看。

   ── 看的是磁盘上已裁好的图 ──────────────────────────────
   不是原始 Commons 文件。所以表里看到的就是用户档案卡里看到的，
   裁切有没有把山顶切掉，在这张表上就能发现。

   用法:
     node tools/contact-sheet.mjs
     node tools/contact-sheet.mjs --only=珠穆朗玛峰,乔戈里峰
     node tools/contact-sheet.mjs --missing          只列有问题的
     node tools/contact-sheet.mjs --cols=4

   产出: tools/out/contact-sheet.html / .png
   ============================================================ */

import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { PHOTOS } from './photos.manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools/out');
const DEST_DIR = join(ROOT, 'assets/photos');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || true] : [a, true];
  })
);

const ONLY = args.only ? String(args.only).split(',').map(s => s.trim()) : null;
const MISSING_ONLY = !!args.missing;
const COLS = Math.max(1, +(args.cols || 7));

const CELL_W = 216;
const CELL_H = 122;          // 16:9
const GAP = 6;
const PAGE_W = COLS * CELL_W + (COLS + 1) * GAP;

function findBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome 或 Edge，请手动指定路径');
}

function loadWindow(file, key) {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(ROOT, file), 'utf8'), sandbox);
  return sandbox.window[key];
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function licenseOK(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/\b(NC|ND|GFDL|fair use|non-free)\b/i.test(t)) return false;
  return /^(public domain|pd|cc0)/i.test(t) || /^cc[ -]by([ -]sa)?([ -]\d(\.\d)?)?/i.test(t);
}

/* ---------------- 汇总 ---------------- */

const credits = loadWindow('assets/photos/credits.js', 'TERRA_PHOTOS') || {};
// 按清单顺序排（已按地貌类别分组，审起来顺），清单里没有的键兜底排在后面
const keys = [...Object.keys(PHOTOS).filter(k => credits[k]), ...Object.keys(credits).filter(k => !PHOTOS[k])];

const items = keys.map(name => {
  const c = credits[name] || {};
  const rel = String(c.src || '');
  const file = rel.split('/').pop();
  const bad = [];

  if (!rel) bad.push('索引里没有这一条');
  let bytes = 0;
  if (rel) {
    try { bytes = statSync(join(ROOT, rel)).size; }
    catch { bad.push('文件不存在'); }
  }
  if (bytes > 400 * 1024) bad.push(`体积 ${(bytes / 1024).toFixed(0)} KB`);
  if (!licenseOK(c.license)) bad.push(`许可：${c.license || '(空)'}`);
  if (!c.author) bad.push('缺作者');
  if (!c.source) bad.push('缺来源');

  return {
    name,
    src: rel ? '../../' + rel : '',
    file: file || (PHOTOS[name]?.slug ? PHOTOS[name].slug + '.jpg' : '—'),
    license: c.license || '—',
    bytes,
    bad,
  };
});

const shown = items.filter(it => {
  if (ONLY && !ONLY.includes(it.name)) return false;
  if (MISSING_ONLY && !it.bad.length) return false;
  return true;
});

if (!shown.length) {
  console.log('没有符合条件的条目。');
  process.exit(0);
}

/* ---------------- 出 HTML ---------------- */

const totalKB = items.reduce((s, it) => s + it.bytes, 0) / 1024;
const badCount = items.filter(it => it.bad.length).length;

const cells = shown.map((it, i) => `
    <figure class="cell${it.bad.length ? ' bad' : ''}">
      <span class="idx">${i + 1}</span>
      <img src="${esc(it.src)}" alt="${esc(it.name)}">
      <figcaption>
        <b>${esc(it.name)}</b>
        <span class="file">${esc(it.file)}</span>
        <span class="lic">${esc(it.license)}</span>
        ${it.bad.length ? `<span class="warn">${esc(it.bad.join('；'))}</span>` : ''}
      </figcaption>
    </figure>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>TERRA · 配图联络表</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0a1420; color: #dfe9f5;
    font: 12px/1.4 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  }
  header {
    padding: 9px 12px; border-bottom: 1px solid #1e3550;
    display: flex; gap: 18px; align-items: baseline;
  }
  header b { font-size: 14px; letter-spacing: .5px; }
  header span { color: #7d93aa; font-size: 11px; }
  header .bad { color: #ff8080; }
  .grid {
    display: grid; grid-template-columns: repeat(${COLS}, ${CELL_W}px);
    gap: ${GAP}px; padding: ${GAP}px;
  }
  .cell {
    margin: 0; position: relative; background: #101d2c;
    border: 1px solid #1e3550; border-radius: 4px; overflow: hidden;
  }
  .cell.bad { border-color: #ff5a5a; box-shadow: 0 0 0 1px #ff5a5a; }
  .cell img {
    display: block; width: ${CELL_W}px; height: ${CELL_H}px;
    object-fit: cover; background: #06111d;
  }
  .idx {
    position: absolute; top: 3px; left: 3px; padding: 0 4px;
    background: rgba(0, 0, 0, .66); border-radius: 2px;
    font-size: 10px; color: #cfe3f5;
  }
  figcaption { padding: 4px 6px 6px; }
  figcaption b { display: block; font-size: 12.5px; font-weight: 600; }
  .file {
    display: block; font-size: 9px; color: #7d93aa;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .lic { display: block; font-size: 9px; color: #5ec8ff; }
  .warn { display: block; font-size: 9px; color: #ff8080; }
</style>
</head>
<body>
<header>
  <b>TERRA · 配图联络表</b>
  <span>${shown.length} / ${items.length} 格</span>
  <span>共 ${totalKB.toFixed(0)} KB</span>
  <span class="${badCount ? 'bad' : ''}">异常 ${badCount}</span>
</header>
<div class="grid">${cells}
</div>
</body>
</html>
`;

/* ---------------- 截图 ---------------- */

async function main() {
  await mkdir(OUT, { recursive: true });
  const htmlPath = join(OUT, 'contact-sheet.html');
  await writeFile(htmlPath, html, 'utf8');

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: PAGE_W, height: 900, deviceScaleFactor: 1 });

    const failed = [];
    page.on('requestfailed', r => failed.push(r.url().split('/').pop()));
    page.on('pageerror', e => failed.push('异常 ' + e.message));

    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 });

    // 等图全部解码完，否则会截到一半空白
    await page.waitForFunction(
      () => [...document.images].every(i => i.complete),
      { timeout: 30000 }
    );

    // 顺便把浏览器量到的实际尺寸读回来，跟索引里写的对不对得上
    const sizes = await page.evaluate(() =>
      [...document.images].map(i => [i.naturalWidth, i.naturalHeight]));
    const wrong = sizes.filter(([w, h]) => w !== 800 || h !== 450).length;

    const file = join(OUT, 'contact-sheet.png');
    await page.screenshot({ path: file, fullPage: true });

    const box = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));

    console.log(`联络表 ${shown.length} 格　${COLS} 列　${box.w}×${box.h}`);
    console.log(`  → ${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
    console.log(`  → ${htmlPath.replace(ROOT + '\\', '').replace(ROOT + '/', '')}（可直接双击打开）`);
    if (wrong) console.log(`  ⚠ ${wrong} 张尺寸不是 800×450`);
    if (failed.length) console.log(`  ⚠ 加载失败：${[...new Set(failed)].join('、')}`);
    if (badCount) {
      console.log(`  ⚠ ${badCount} 条有问题（红框标出）：`);
      for (const it of items.filter(x => x.bad.length)) {
        console.log(`    ${it.name}　${it.bad.join('；')}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\n✗ ' + err.message);
  process.exit(1);
});
