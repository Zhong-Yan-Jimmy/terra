#!/usr/bin/env node
/* ============================================================
   裁剪放大：把截图的一小块按整数倍放大另存，用来看清细节。

   缩略图会把细线抹平、把摩尔纹看成缺陷，所以核对局部时
   一律回到原分辨率再放大看。

   用法:
     node tools/crop.mjs <源图> <x> <y> <w> <h> [倍数] [输出名]
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

const [src, x, y, w, h, scale, name] = process.argv.slice(2);
if (!src || x === undefined) {
  console.error('用法: node tools/crop.mjs <源图> <x> <y> <w> <h> [倍数] [输出名]');
  process.exit(1);
}

const k = Math.max(1, +(scale || 1));
const X = +x, Y = +y, W = +w, H = +h;

const img = PNG.sync.read(readFileSync(src));
const out = new PNG({ width: W * k, height: H * k });

for (let ry = 0; ry < H * k; ry++) {
  const sy = Y + Math.floor(ry / k);
  for (let rx = 0; rx < W * k; rx++) {
    const sx = X + Math.floor(rx / k);
    const di = (ry * W * k + rx) << 2;
    const si = (sy * img.width + sx) << 2;
    const inX = sx >= 0 && sx < img.width;
    const inY = sy >= 0 && sy < img.height;
    if (inX && inY) {
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    } else {
      out.data[di] = out.data[di + 1] = out.data[di + 2] = 40;   // 越界涂灰，便于看出边界
      out.data[di + 3] = 255;
    }
  }
}

const dst = join(OUT, (name || `${basename(src, '.png')}-crop`) + '.png');
writeFileSync(dst, PNG.sync.write(out));
console.log(`✓ ${dst}   ${W}×${H} @${k}x`);
