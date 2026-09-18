#!/usr/bin/env node
/* ============================================================
   TERRA · 具名地貌的配图获取

   从 Wikimedia Commons 抓地貌照片，处理成统一的 800×450 JPEG，
   连同署名信息一起落到 assets/photos/。

   ── 代理 ──────────────────────────────────────────────
   Wikimedia 在国内直连不通（DNS 污染，报 ERR_TLS_CERT_ALTNAME_INVALID），
   必须走代理。Node 24 用环境变量接管（undici 默认不读代理变量，
   NODE_USE_ENV_PROXY 是 v24 的开关，不必装 undici）：

     HTTPS_PROXY=http://127.0.0.1:7892 NODE_USE_ENV_PROXY=1 \
       node tools/fetch-photos.mjs

   代理端口以代理软件当前监听为准，不一定是 7892。

   ── 为什么图片不内联成 base64 ──────────────────────────
   档案卡是纯 DOM，不碰 WebGL 也不碰 canvas。<img> 在 file:// 下
   加载同目录图片本来就是通的（失败的是 texImage2D 对 origin-clean
   的要求，见 tools/inline-textures.mjs 抬头）。56 张内联要多背
   三分之一体积，不划算。

   ── 为什么必须校验 magic ───────────────────────────────
   Commons 的缩略图只有固定档位（800/960/1280 可用，320/640 返回
   400），且 400 的响应体是一页 2 KB 的 HTML。只看 res.ok 的话，
   会往磁盘写一个后缀为 .jpg 的 HTML 文件，而且"下载成功"。

   用法:
     node tools/fetch-photos.mjs                  抓全部（已存在的跳过）
     node tools/fetch-photos.mjs --only=珠穆朗玛峰  只抓指定几条
     node tools/fetch-photos.mjs --force          重抓
     node tools/fetch-photos.mjs --suggest        只列候选，不下载

   产出:
     assets/photos/<slug>.jpg     56 张
     assets/photos/credits.js     window.TERRA_PHOTOS（索引页加载它）
     tools/out/photos-report.txt
   ============================================================ */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { PHOTOS } from './photos.manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST_DIR = join(ROOT, 'assets/photos');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  return m ? [m[1], m[2] || true] : [a, true];
}));

const FORCE = !!args.force;
const SUGGEST = !!args.suggest;
const ONLY = args.only ? String(args.only).split(',').map(s => s.trim()) : null;

/* HTTP 头必须是 ByteString，中文会直接抛错——这里只能写 ASCII。
   Wikimedia 的 UA 政策要求可识别到人或项目，仓库地址就是那个凭据 */
const UA = 'TerraGeoBot/0.1 (educational offline project; +https://github.com/Zhong-Yan-Jimmy/terra)';

const OUT_W = 800, OUT_H = 450;   // 统一 16:9；为 378px 卡片在 dpr=2 下留足余量
const SRC_W = 1280;               // 下载源宽度，裁完 16:9 还有富余
const QUALITY = 78;               // 实测 MAE 1.7%，肉眼无感

/* 海底地貌用的全球测深图：3600×1800 严格 2:1 等距圆柱，
   恰好 10 px/度，公有领域。裁 80°×45° 的窗口正好 800×450，1:1 不重采样。 */
const BATHY_FILE = 'Blue Marble Next Generation + topography + bathymetry.jpg';
const BATHY_PX_PER_DEG = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 网络 ---------------- */

async function api(host, params) {
  const url = new URL(`https://${host}/w/api.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`API ${res.status} — ${url.searchParams.get('titles') || url.searchParams.get('srsearch') || ''}`);
  return res.json();
}

async function fetchBinary(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // 拒收 HTML/JSON 错误页——它们会伪装成下载成功
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E;
    if (!isJpeg && !isPng) {
      throw new Error(`不是图片（前 24 字节: ${buf.slice(0, 24).toString('utf8').replace(/\s+/g, ' ')}）`);
    }
    return buf;
  } catch (err) {
    if (attempt < 3) {
      await sleep(800 * attempt);
      return fetchBinary(url, attempt + 1);
    }
    throw err;
  }
}

/* ---------------- 元数据与许可 ---------------- */

/** Commons 返回的 Artist 是带 HTML 的串，剥标签并解实体 */
function stripHTML(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 派生作品的 Artist 会写成「原图.jpg: 原作者 derivative work: 派生者 (talk)」，
   文件名前缀、下划线和 (talk) 都不该出现在署名里，洗掉。
   只洗这三样：括号里的另一个名字（"Luca Galuzzi (Lucag)"）是原署名的一部分，保留 */
function cleanArtist(s) {
  return String(s == null ? '' : s)
    .replace(/^[^\s:]+\.(jpe?g|png|tiff?|svg|gif)\s*:\s*/i, '')
    .replace(/\s*\(talk\)/gi, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 许可闸门是硬闸：NC/ND 不能用于本项目（不限用途的分发），
   GFDL 单独用起来繁琐，合理使用更不行。CC BY / CC BY-SA / 公有领域 / CC0 放行。 */
function licenseVerdict(short) {
  const s = stripHTML(short);
  if (!s) return { ok: false, why: '未标明许可' };
  if (/\b(NC|ND)\b/i.test(s)) return { ok: false, why: `禁商用/禁改作，不适用：${s}` };
  if (/\b(GFDL|fair use|non-free)\b/i.test(s)) return { ok: false, why: `许可不适用：${s}` };
  if (/^(public domain|pd|cc0)/i.test(s)) return { ok: true, s };
  if (/^cc[ -]by([ -]sa)?([ -]\d(\.\d)?)?/i.test(s)) return { ok: true, s };
  return { ok: false, why: `许可不在白名单：${s}` };
}

/** 批量取元数据。titles 形如 ['File:A.jpg', …]，每次请求最多 50 个 */
async function fetchMeta(titles) {
  const meta = {};
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const j = await api('commons.wikimedia.org', {
      action: 'query', format: 'json', redirects: '1',
      titles: chunk.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiurlwidth: String(SRC_W),
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit|ObjectName|AttributionRequired|Restrictions',
    });

    // 规范化/重定向会把请求名换成实际名，建一张映射才能对回来
    const alias = {};
    for (const n of j.query?.normalized || []) alias[n.from] = n.to;
    for (const r of j.query?.redirects || []) alias[r.from] = r.to;

    const byTitle = {};
    for (const p of Object.values(j.query?.pages || {})) byTitle[p.title] = p;

    for (const want of chunk) {
      const key = alias[alias[want] || want] || want;
      const page = byTitle[key] || byTitle[alias[want] || want];
      if (!page || page.missing !== undefined) {
        meta[want] = { missing: true };
        continue;
      }
      const ii = page.imageinfo?.[0];
      if (!ii) { meta[want] = { missing: true }; continue; }
      const em = ii.extmetadata || {};
      meta[want] = {
        title: page.title,
        thumburl: ii.thumburl || ii.url,
        origW: ii.width, origH: ii.height,
        license: stripHTML(em.LicenseShortName?.value),
        licenseUrl: String(em.LicenseUrl?.value || '').trim(),
        artist: stripHTML(em.Artist?.value) || stripHTML(em.Credit?.value),
        restrictions: stripHTML(em.Restrictions?.value),
        descUrl: ii.descriptionurl,
      };
    }
    if (i + 50 < titles.length) await sleep(250);
  }
  return meta;
}

/* ---------------- 图像处理 ---------------- */

function decode(buf) {
  const isPng = buf[0] === 0x89;
  if (isPng) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const img = jpeg.decode(buf, { useTArray: true });
  // 渐进式 JPEG 等解码失败会抛在这里，交给调用方记进报告
  return img;
}

/** 居中（或按 focus）裁出 16:9 */
function cropTo169(img, focus = [0.5, 0.5]) {
  const { width: w, height: h, data } = img;
  let cw = w, ch = Math.round(w * OUT_H / OUT_W);
  if (ch > h) { ch = h; cw = Math.round(h * OUT_W / OUT_H); }
  const x0 = Math.round((w - cw) * focus[0]);
  const y0 = Math.round((h - ch) * focus[1]);

  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((y0 + y) * w + x0) * 4;
    out.set(data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

/** 块平均降采样到目标尺寸（jpeg-js 只编解码，不带 resize） */
function resizeBox(img, ow, oh) {
  const { width: sw, height: sh, data } = img;
  const out = new Uint8Array(ow * oh * 4);
  const sx = sw / ow, sy = sh / oh;

  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * sy)));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let idx = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, idx += 4) { r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; n++; }
      }
      const o = (y * ow + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: ow, height: oh, data: out };
}

/** 从全球测深图按经纬度裁一块。等距圆柱：x=(lon+180)/360*W、y=(90-lat)/180*H */
function cropGeo(img, lat, lon, spanDeg) {
  const px = img.width / 360;
  const cw = Math.round(spanDeg * px);
  const ch = Math.round(cw * OUT_H / OUT_W);
  let x0 = Math.round((lon + 180) * px - cw / 2);
  let y0 = Math.round((90 - lat) * px - ch / 2);
  x0 = Math.max(0, Math.min(img.width - cw, x0));
  y0 = Math.max(0, Math.min(img.height - ch, y0));

  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

/* ---------------- 数据对照 ---------------- */

/** 从 js/data.js 读出 56 个地貌名。键必须来自这里，不能手打——
    「秘鲁-智利海沟」里那个 `-` 是 U+002D，手打成 en dash 就会静默失配 */
function featureNames() {
  const code = readFileSync(join(ROOT, 'js/data.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.TERRA_DATA.features.map(f => f.name);
}

/** 读回上次生成的 credits.js。--only= 是增量抓取的，
    若不合并，抓一条就会把其余 55 条从索引里抹掉 */
function loadExistingCredits() {
  const p = join(DEST_DIR, 'credits.js');
  if (!existsSync(p)) return {};
  const sandbox = { window: {} };
  try { vm.runInNewContext(readFileSync(p, 'utf8'), sandbox); } catch { return {}; }
  return sandbox.window.TERRA_PHOTOS || {};
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const names = featureNames();
  const entries = Object.entries(PHOTOS).filter(([n]) => !ONLY || ONLY.includes(n));
  console.log(`TERRA · 配图获取　清单 ${Object.keys(PHOTOS).length} 条，本次处理 ${entries.length} 条\n`);

  const listMissing = names.filter(n => !PHOTOS[n]);
  if (listMissing.length) console.log(`⚠ 清单缺少 ${listMissing.length} 条：${listMissing.join('、')}\n`);

  /* ---- 搜 Commons ---- */
  if (args.search) {
    const j = await api('commons.wikimedia.org', {
      action: 'query', format: 'json', list: 'search',
      srsearch: String(args.search) + ' filetype:bitmap',
      srnamespace: '6', srlimit: '12',
    });
    for (const r of j.query?.search || []) console.log(r.title.replace(/^File:/, ''));
    return;
  }

  /* ---- 自动挑候选 ---- */
  if (args.auto) {
    /* 从 Wikipedia 正文用过的图里挑——比盲目搜 Commons 准得多，
       编者已经把相关图放进了条目。代价是旗帜、图标、地图混在里面，
       靠 BAD 词表和"必须横向照片"两条过滤掉。 */
    const BAD = /(flag|coat[_ ]of[_ ]arms|logo|icon|\bmap\b|locat(or|ion)|shackle|projection|diagram|graph|seal|emblem|planisphere|satellite|from[_ ]orbit|landsat|topograph|basemap|blank|chart|_ISS|ISS-|\bSTS\d|animation|timeline|graphy)/i;

    for (const [name, spec] of entries) {
      if (spec.file || spec.bathymetry) continue;
      let cands = [];
      try {
        const r = await api('en.wikipedia.org', {
          action: 'query', format: 'json', redirects: '1',
          titles: spec.en, prop: 'images', imlimit: '80',
        });
        const page = Object.values(r.query?.pages || {})[0];
        cands = (page?.images || [])
          .map(i => i.title.replace(/^File:/, ''))
          .filter(f => /\.(jpe?g)$/i.test(f))       // 照片绝大多数是 JPEG
          .filter(f => !BAD.test(f));
      } catch { /* 条目不存在等情况走下面的兜底 */ }

      if (!cands.length) {
        try {
          const s = await api('commons.wikimedia.org', {
            action: 'query', format: 'json', list: 'search',
            srsearch: `${spec.en} filetype:bitmap`, srnamespace: '6', srlimit: '30',
          });
          cands = (s.query?.search || [])
            .map(r => r.title.replace(/^File:/, ''))
            .filter(f => /\.(jpe?g)$/i.test(f))
            .filter(f => !BAD.test(f));
        } catch { /* 下面统一报无候选 */ }
      }

      if (!cands.length) { console.log(`${name}\t（无候选）`); await sleep(200); continue; }

      const pool = cands.slice(0, 20);
      let meta = {};
      try { meta = await fetchMeta(pool.map(c => 'File:' + c)); } catch { /* 逐条降级 */ }

      let best = null;
      for (const c of pool) {
        const m = meta['File:' + c];
        if (!m || m.missing) continue;
        if (!licenseVerdict(m.license).ok) continue;
        if (m.origW < 1200 || m.origW <= m.origH) continue;   // 竖图裁 16:9 会切掉大半
        const score = Math.abs(Math.log((m.origW / m.origH) / (16 / 9)));
        if (!best || score < best.score) best = { c, m, score };
      }

      if (best) {
        console.log(`${name}\t${best.c}\t${best.m.origW}×${best.m.origH}\t${best.m.license}`);
      } else {
        console.log(`${name}\t（无合格候选）\t前几个: ${pool.slice(0, 3).join(' | ')}`);
      }
      await sleep(200);
    }
    return;
  }

  /* ---- 只列候选 ---- */
  if (SUGGEST) {
    for (const [name, spec] of entries) {
      if (spec.file || spec.bathymetry) { console.log(`${name}　（已指定）`); continue; }
      const q = spec.en || name;
      try {
        const j = await api('en.wikipedia.org', {
          action: 'query', format: 'json', redirects: '1',
          titles: q, prop: 'pageimages', pithumbsize: '640',
        });
        const page = Object.values(j.query?.pages || {})[0];
        const file = page?.pageimage || null;
        console.log(`${name}\t${file || '（无主图）'}`);
      } catch (e) {
        console.log(`${name}\t（查询失败 ${e.message}）`);
      }
      await sleep(120);
    }
    return;
  }

  /* ---- 取元数据 ---- */
  const need = entries.filter(([, s]) => s.file);
  const titles = [...new Set(need.map(([, s]) => 'File:' + s.file))];
  console.log(`[1/4] 取元数据（${titles.length} 个文件）`);
  const meta = titles.length ? await fetchMeta(titles) : {};

  /* ---- 逐条处理 ---- */
  const credits = loadExistingCredits();   // 增量抓取时保留上次的结果
  const report = [];
  let ok = 0, skip = 0, fail = 0;

  let bathy = null;   // 测深图懒加载，全项目只下一次
  console.log('\n[2/4] 下载并处理');

  for (const [name, spec] of entries) {
    const dest = join(DEST_DIR, spec.slug + '.jpg');
    let record = null;

    try {
      if (spec.bathymetry || spec.crop) {
        /* —— 海底：全球测深图按经纬度裁 —— */
        const crop = spec.crop || {};
        if (!bathy) {
          console.log('  下载全球测深图（1.9 MB，只下一次）…');
          // 不能带 ?width=：经纬度对齐依赖 3600px 的原始宽度（恰好 10 px/度）
          const buf = await fetchBinary(
            `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(BATHY_FILE)}`);
          bathy = decode(buf);
          console.log(`  ✓ ${bathy.width} × ${bathy.height}`);
        }
        const spanDeg = crop.spanDeg || 80;
        const img = cropGeo(bathy, crop.lat, crop.lon, spanDeg);
        const scaled = (img.width === OUT_W) ? img : resizeBox(img, OUT_W, OUT_H);
        record = {
          buf: jpeg.encode({ data: Buffer.from(scaled.data), width: scaled.width, height: scaled.height }, QUALITY).data,
          bathymetry: true,
          author: 'Reto Stöckli / NASA Earth Observatory',
          license: 'Public domain',
          licenseUrl: 'https://commons.wikimedia.org/wiki/Template:PD-USGov-NASA',
          source: `https://commons.wikimedia.org/wiki/File:${BATHY_FILE.replace(/ /g, '_')}`,
          title: BATHY_FILE,
          // 从全球图里裁一块出来也是改作，跟实景照一样标上
          modified: true,
        };
      } else {
        /* —— 实景照：Commons 文件 —— */
        const m = meta['File:' + spec.file];
        if (!m || m.missing) throw new Error(`Commons 上找不到：${spec.file}`);

        const verdict = licenseVerdict(m.license);
        if (!verdict.ok) throw new Error(verdict.why);
        if (m.restrictions) throw new Error(`有额外限制声明：${m.restrictions}`);

        const raw = await fetchBinary(m.thumburl);
        const img = decode(raw);
        if (img.width * img.height > 4e7) throw new Error(`源图过大（${img.width}×${img.height}）`);

        const cropped = cropTo169(img, spec.focus || [0.5, 0.5]);
        const scaled = resizeBox(cropped, OUT_W, OUT_H);
        record = {
          buf: jpeg.encode({ data: Buffer.from(scaled.data), width: OUT_W, height: OUT_H }, QUALITY).data,
          bathymetry: false,
          // 清单里的 author 优先：Commons 的 Artist/Credit 偶尔是空的，
          // 而文件页面的 wikitext 里往往写着作者，得手工补
          author: cleanArtist(spec.author) || cleanArtist(m.artist) || 'Wikimedia Commons 贡献者',
          license: m.license,
          licenseUrl: m.licenseUrl,
          source: m.descUrl,
          title: m.title.replace(/^File:/, ''),
        };
        // 每张都裁成 16:9 并重编码过，按 CC 要求一律标出改作
        record.modified = true;
      }

      if (!FORCE && existsSync(dest)) {
        console.log(`  ↷ 已存在  ${spec.slug}.jpg`);
        skip++;
      } else {
        await mkdir(DEST_DIR, { recursive: true });
        await writeFile(dest, record.buf);
        console.log(`  ✓ ${spec.slug}.jpg  (${(record.buf.length / 1024).toFixed(0)} KB)  ${name}`);
        ok++;
      }

      credits[name] = {
        src: `assets/photos/${spec.slug}.jpg`,
        w: OUT_W, h: OUT_H,
        author: record.author,
        license: record.license,
        licenseUrl: record.licenseUrl || '',
        source: record.source || '',
        title: record.title || '',
        modified: !!record.modified,
        bathymetry: !!record.bathymetry,
      };
      await sleep(250);
    } catch (err) {
      fail++;
      console.log(`  ✗ ${name} — ${err.message}`);
      report.push(`${name}\t失败\t${err.message}`);
    }
  }

  /* ---- 写 credits.js ---- */
  console.log('\n[3/4] 写 assets/photos/credits.js');

  // 只为确实落盘的图写条目：缺图会让 <img> 触发 requestfailed，
  // 而那张没被引用的图反而不会——所以宁可少写一条，不写空条
  const lines = [];
  for (const n of names) {
    const c = credits[n];
    if (!c) { report.push(`${n}\t未收录\t清单里没有或抓取失败`); continue; }
    if (!existsSync(join(ROOT, c.src))) { report.push(`${n}\t缺文件\t${c.src}`); continue; }
    lines.push(
      `  ${JSON.stringify(n)}: {\n` +
      `    src: ${JSON.stringify(c.src)}, w: ${c.w}, h: ${c.h},\n` +
      `    author: ${JSON.stringify(c.author)}, license: ${JSON.stringify(c.license)},\n` +
      `    licenseUrl: ${JSON.stringify(c.licenseUrl)},\n` +
      `    source: ${JSON.stringify(c.source)},\n` +
      `    title: ${JSON.stringify(c.title)},\n` +
      `    modified: ${c.modified}, bathymetry: ${c.bathymetry},\n` +
      `  },`);
  }

  const js =
`/* 由 tools/fetch-photos.mjs 生成，请勿手工编辑。
   键取自 js/data.js 的 features[].name；改图源后重跑：
     HTTPS_PROXY=http://127.0.0.1:7892 NODE_USE_ENV_PROXY=1 node tools/fetch-photos.mjs
   modified 表示已裁切为 16:9 并重编码——CC 许可要求标出改作，见 js/photos.js。 */
window.TERRA_PHOTOS = {
${lines.join('\n')}
};
`;
  await writeFile(join(DEST_DIR, 'credits.js'), js);

  /* ---- 报告 ---- */
  console.log('\n[4/4] 报告');
  console.log(`  收录 ${lines.length} 条　新抓 ${ok}　跳过 ${skip}　失败 ${fail}`);
  if (report.length) {
    console.log('  问题：');
    for (const r of report) console.log('    ' + r.replace(/\t/g, '　'));
  }

  await mkdir(join(ROOT, 'tools/out'), { recursive: true });
  await writeFile(join(ROOT, 'tools/out/photos-report.txt'),
    `收录 ${lines.length} / ${names.length}\n\n` +
    report.map(r => r.replace(/\t/g, '　')).join('\n') + '\n', 'utf8');

  if (lines.length < names.length) {
    console.log(`\n⚠ 还有 ${names.length - lines.length} 条没有配图——清单里补上再跑一次。`);
  }
}

main().catch(err => {
  console.error('\n✗ ' + err.message);
  process.exit(1);
});
