/* ============================================================
   把运行时用到的图片内联成 base64 data URI，产出 assets/textures.js

   ── 为什么非这样不可 ──────────────────────────────────
   file:// 页面的 origin 是 opaque，页面里的图片一律被当作
   cross-origin。而 <img> 本身**是能加载的**——同源策略管不到子资源的
   加载——所以不会触发 onerror，控制台也不会先报错，一切看起来都正常。

   但 WebGL 的 texImage2D 要求图片 origin-clean，file:// 下这个条件
   永远不满足，于是纹理一个都传不上去：

     SecurityError: Failed to execute 'texImage2D' ...
     The image element contains cross-origin data, and may not be loaded.

   地表、法线、高光、云层四张全部上传失败，地球就成了一个没有任何贴图
   的球——只剩一坨镜面高光，和浮在虚空里的矢量线。

   给 loader.crossOrigin 置 undefined 反而更隐蔽：不设该属性时图片
   「加载成功但不可上传」，比干脆加载失败更难发现。

   data: URI 被规范认定为 origin-clean，可以正常上传。所以把图片编码
   进 JS，是「双击 index.html 就能用」这个前提下唯一可行的做法。
   代价是 base64 膨胀约 1/3。原始图片文件保留在原处不动，它们仍是
   tools/fetch-data.mjs 的下载产物。

   改了图片或换了图源之后，重跑一次本脚本即可。

   用法：node tools/inline-textures.mjs
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [产出里的键, 源文件, MIME] */
const FILES = [
  ['map',         'assets/earth/earth_atmos_2048.jpg',    'image/jpeg'],
  ['normalMap',   'assets/earth/earth_normal_2048.jpg',   'image/jpeg'],
  ['specularMap', 'assets/earth/earth_specular_2048.jpg', 'image/jpeg'],
  ['clouds',      'assets/earth/earth_clouds_1024.png',   'image/png'],
  ['relief',      'assets/relief/elev_color_2048.png',    'image/png'],
];

/** base64 每行的字符数。整条串写成一行的话，编辑器打开这个文件会卡住 */
const CHUNK = 1024;

let rawTotal = 0, encTotal = 0;
const blocks = [];

for (const [key, rel, mime] of FILES) {
  const abs = join(ROOT, rel);
  const buf = readFileSync(abs);
  const b64 = buf.toString('base64');

  // 切成等长的小段再拼起来。V8 拼字符串是 O(1) 的绳结构，
  // 不用担心几千次 '+=' 的开销
  const lines = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    lines.push(`    '${b64.slice(i, i + CHUNK)}'`);
  }

  blocks.push(`  ${key}: 'data:${mime};base64,' +\n${lines.join(' +\n')},`);

  rawTotal += buf.length;
  encTotal += b64.length;
  console.log(`  ${key.padEnd(12)} ${rel.padEnd(40)} ${(buf.length / 1024).toFixed(0)} KB → ${(b64.length / 1024).toFixed(0)} KB`);
}

const out = `/* ============================================================
   TERRA · 内联贴图   —— 产物文件，不要手改

   由 tools/inline-textures.mjs 生成。要更新就重跑那个脚本。

   为什么贴图是 base64 而不是图片文件：file:// 下外部图片虽然能加载，
   但会被判为 cross-origin，WebGL 上传时一律抛 SecurityError，地球会
   变成一个没有贴图的球。data: URI 是 origin-clean 的，没有这个问题。
   完整说明见 tools/inline-textures.mjs 的抬头。
   ============================================================ */

window.TERRA_TEX = {
${blocks.join('\n\n')}
};
`;

const dest = join(ROOT, 'assets/textures.js');
writeFileSync(dest, out, 'utf8');

console.log(`\n原始 ${(rawTotal / 1048576).toFixed(2)} MB → 内联 ${(encTotal / 1048576).toFixed(2)} MB`);
console.log(`已写出 assets/textures.js（${(out.length / 1048576).toFixed(2)} MB）`);
