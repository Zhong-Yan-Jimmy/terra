#!/usr/bin/env node
/* ============================================================
   TERRA · 截图验证

   用系统里的 Edge（Chromium 内核）以 file:// 协议打开 index.html，
   收集控制台报错，并从若干预设视角截图，便于逐阶段做视觉验收。

   因为走的是 file://，这个脚本同时也在验证「双击 index.html 就能用」。

   用法:
     node tools/shot.mjs              截默认的一组视角
     node tools/shot.mjs --view=all   同上
     node tools/shot.mjs --lat=23 --lon=13 --name=sahara
   ============================================================ */

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools/out');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 预设视角：每个都对着一个 UV 验证点，方便肉眼核对该点是否落在正确位置 */
const VIEWS = [
  // 相机初始位置在 +Z 方向；经度 0° 在 +X 轴上，故 +Z 正对 90°W
  { name: '01-default',  desc: '默认视角（相机 +Z 方向，正对 90°W，应看到美洲）' },
  { name: '02-sahara',   lat: 23,  lon: 13,   desc: '正对撒哈拉沙漠' },
  { name: '03-everest',  lat: 28,  lon: 87,   desc: '正对珠峰 / 青藏高原' },
  { name: '04-amazon',   lat: -3,  lon: -60,  desc: '正对亚马逊雨林' },
  { name: '05-antarctic',lat: -80, lon: 0,    desc: '正对南极洲' },
  { name: '06-pacific',  lat: 0,   lon: 150,  desc: '正对太平洋中部（应全是海）' },

  // 气候图层：对照点选结果的色块，验证栅格与球面严丝合缝
  { name: '07-climate-sahara', lat: 23, lon: 13,  layer: 'climate',
    desc: '气候带 · 撒哈拉应为大片红(BWh)，地中海沿岸转黄(Csa)' },
  { name: '08-climate-amazon', lat: -3, lon: -60, layer: 'climate',
    desc: '气候带 · 亚马逊应为深蓝(Af)，周围渐变出橙(BSh)与绿(Cwb)' },
  { name: '09-climate-europe', lat: 48, lon: 8,   layer: 'climate',
    desc: '气候带 · 西欧应为绿(Cfb)，南欧地中海沿岸转黄(Csa)' },

  // 高程色带：看地形起伏的定性梯度是否落在该在的地方
  { name: '10-relief-tibet',  lat: 33, lon: 88,  layer: 'relief',
    desc: '地形起伏 · 青藏高原应为大片灰白（世界屋脊）' },
  { name: '11-relief-alps',   lat: 46, lon: 10,  layer: 'relief',
    desc: '地形起伏 · 阿尔卑斯应为白色高山带，南侧波河平原转绿' },
  { name: '12-relief-andes',  lat: -20, lon: -68, layer: 'relief',
    desc: '地形起伏 · 安第斯应是一条白色纵带，紧贴太平洋岸' },

  // 矢量层：核对板块边界的位置与接缝处理
  { name: '13-plates-pacific', lat: 5, lon: -130, vectors: ['plates'],
    desc: '板块边界 · 东太平洋海隆应为一条连续纵线，不得有横穿全球的假连线' },
  { name: '14-plates-japan',   lat: 34, lon: 143, vectors: ['plates'],
    desc: '板块边界 · 日本海沟应紧贴日本列岛东侧，琉球海沟在西南' },
  { name: '15-plates-atlantic', lat: 10, lon: -30, vectors: ['plates'],
    desc: '板块边界 · 大西洋中脊应纵贯南北，与两侧海岸线大致平行' },
  { name: '16-coast-rivers',   lat: 8, lon: 105, vectors: ['coastline', 'rivers'],
    desc: '海岸线与河流 · 湄公河、湄南河应注入南海与泰国湾' },
  // 近景：河流只有几像素宽，拉近了才看得出画没画对
  { name: '17-rivers-close',   lat: 26, lon: 108, vectors: ['rivers'], dist: 1.75,
    desc: '河流近景 · 长江与珠江应清晰可辨' },

  // 点选：pick 表示在这个视角的中心打一枪，看弹出的档案卡对不对
  { name: '18-pick-everest', lat: 27.99, lon: 86.93, pick: true, dist: 2.4,
    desc: '点选珠峰 · 应为「珠穆朗玛峰」档案，含 ET 气候与欧亚板块' },
  { name: '19-pick-sahara',  lat: 23, lon: 13, pick: true, dist: 3.0,
    desc: '点选撒哈拉 · 应为「撒哈拉沙漠」档案与 BWh 热带沙漠气候' },
  { name: '20-pick-tokyo',   lat: 35.68, lon: 139.69, pick: true, dist: 2.2,
    desc: '点选东京 · 无具名地貌，应回落到「Cfa 亚热带湿润气候」' },
  { name: '21-pick-ocean',   lat: 0, lon: -150, pick: true, dist: 3.0,
    desc: '点选太平洋中部 · 应给出海洋说明，气候为空、板块为太平洋板块' },

  // 2D 专题图：span 是可视经度跨度（度），控制一屏能看到多大一片
  { name: '22-map2d-climate', map2d: { lat: 32, lon: 108, span: 76, raster: 'climate' },
    desc: '专题图 · 东亚气候带，Cfa/Cwa/Dwa/BWh 的拼接关系应一目了然' },
  { name: '23-map2d-atlantic', map2d: { lat: 5, lon: -28, span: 150, raster: 'relief',
                                        vectors: ['plates', 'coastline'] },
    desc: '专题图 · 大西洋，板块边界（中脊）应与两侧海岸线大致平行' },
  { name: '24-map2d-tibet', map2d: { lat: 34, lon: 88, span: 46, raster: 'relief' },
    desc: '专题图 · 青藏高原高程，白色高地应连成完整一片，南缘紧邻绿色印度河套' },

  // 端到端：3D 摆好位置 → 按钮进 2D → 图上查询 → 返回，3D 视角应原样保持
  { name: '25-map2d-from3d', flow: 'from3d', lat: 34, lon: 116, dist: 2.6,
    desc: '3D→2D 往返 · 进图应聚焦华北，返回后相机位置应分毫不动' },

  // 窄屏：手机竖屏，看控制台与工具条会不会把地球糊住、按钮会不会溢出
  { name: '26-narrow-3d', lat: 30, lon: 110, dist: 4.4,
    viewport: { width: 390, height: 844 },
    desc: '窄屏 · 3D 视图，控制台不得压住地球，提示条应只留常用项' },
  { name: '27-narrow-2d', map2d: { lat: 30, lon: 110, span: 150, raster: 'climate' },
    viewport: { width: 390, height: 844 },
    desc: '窄屏 · 专题图，顶栏按钮应收紧而不是溢出屏幕' },

  // 跨日界线：三段矢量全开，看有没有横穿整张图的假连线
  { name: '28-map2d-dateline', map2d: { lat: 0, lon: 180, span: 130, raster: 'satellite',
                                        vectors: ['plates', 'coastline', 'rivers'] },
    desc: '专题图 · 180° 经线附近，跨日界线的线段应断开而不是横穿全球' },

  // 河流叠在气候底图上：水系与气候带的对应是自然地理的经典读图方式
  { name: '29-map2d-rivers', map2d: { lat: 28, lon: 105, span: 55, raster: 'climate',
                                      vectors: ['rivers', 'coastline'] },
    desc: '专题图 · 长江与珠江，河流应是连续细线，既不横穿也不无故中断' },
];

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || true] : [a, true];
  })
);

function findBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome 或 Edge，请手动指定路径');
}

async function main() {
  const browserPath = findBrowser();
  console.log(`浏览器: ${browserPath}\n`);

  // 默认**不**开 --allow-file-access-from-files：用户双击打开时浏览器没有这个放行，
  // 测试环境必须和用户环境一致，否则会把只在 file:// 下暴露的问题测没。
  // 需要放宽时（例如排查 crossOrigin）用 --lax-file 显式打开。
  const fileArgs = args['lax-file'] ? ['--allow-file-access-from-files'] : [];

  // --gpu：走真实显卡而不是 swiftshader。软件渲染与 D3D11 在纹理上限、
  // 浮点精度、扩展支持上并不等价，排查「headless 正常但用户机器上不对」时用
  const glArgs = args.gpu
    ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    args: [...glArgs, '--no-sandbox', ...fileArgs],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

  // --reduced：模拟「减少动效」偏好。必须在 goto 之前设，
  // 页面脚本是在启动时读一次 matchMedia 的
  if (args.reduced) {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    console.log('已模拟 prefers-reduced-motion: reduce\n');
  }

  const problems = [];
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', e => problems.push(`[异常] ${e.message}`));
  page.on('requestfailed', r => problems.push(`[请求失败] ${r.url().split('/').pop()} — ${r.failure()?.errorText}`));

  const url = pathToFileURL(join(ROOT, 'index.html')).href;
  console.log(`打开: ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  // 等地球真正建好（main.js 在 boot 末尾置位）
  try {
    await page.waitForFunction(() => window.__terraReady === true, { timeout: 90000 });
    console.log('页面就绪 ✓\n');
  } catch {
    console.log('⚠ 等待就绪超时，仍尝试截图\n');
  }

  await new Promise(r => setTimeout(r, 1200));   // 让首帧渲染稳定

  await mkdir(OUT, { recursive: true });

  // 选取要截的视角
  let views;
  if (args.lat !== undefined && args.lon !== undefined) {
    views = [{ name: args.name || 'custom', lat: +args.lat, lon: +args.lon, desc: '自定义视角' }];
  } else {
    views = VIEWS;
    // --only=plates,rivers  只跑名字里含这些片段的视角，省得每次全跑一遍
    if (args.only) {
      const keys = String(args.only).split(',');
      views = views.filter(v => keys.some(k => v.name.indexOf(k) >= 0));
    }
  }

  // 先读一眼自转的初始值——下面就把它冻上了，
  // 冻完再读就分不出「减少动效」有没有生效
  const initSpin = await page.evaluate(() => {
    const t = window.__terra;
    const b = document.getElementById('btn-spin');
    return t ? { spin: t.state.spin, btnOn: !!b && b.classList.contains('is-on') } : null;
  });

  // 先冻结自转，保证所有视角的构图可复现
  await page.evaluate(() => {
    const t = window.__terra;
    if (!t) return;
    t.state.spin = false;
    t.earthGroup.rotation.y = 0;
    t.cloudMesh.rotation.y = 0;
  });

  const report = [];
  for (const v of views) {
    // 窄屏视角要换画布尺寸；量完尺寸再摆相机，否则缩放是按旧视口算的
    if (v.viewport) {
      await page.setViewport({ ...v.viewport, deviceScaleFactor: 1 });
      await new Promise(r => setTimeout(r, 400));
    }

    if (v.lat !== undefined) {
      // 把相机摆到该经纬度的正上方
      await page.evaluate((lat, lon, layer, vectors, dist, pick) => {
        const t = window.__terra;
        if (!t) return;
        const p = Geo.latLonToVec3(lat, lon, t.CONFIG.earthRadius * (dist || 3.2));
        t.camera.position.set(p.x, p.y, p.z);
        t.camera.lookAt(0, 0, 0);
        t.controls.target.set(0, 0, 0);
        t.controls.update();

        t.setRasterLayer(layer || 'satellite');
        // 只在显式指定时才动矢量层，否则沿用上一屏的状态
        if (vectors) {
          for (const n in t.state.vectors) t.setVectorLayer(n, vectors.indexOf(n) >= 0);
        }
        // 看数据层时把验证点收起来——红点会盖住要核对的那片颜色；
        // 点选时也一样，红点会和命中标记抢视线
        if (t.probeGroup) t.probeGroup.visible = pick ? false : (!layer && !vectors);

        // 相机已正对该点，直接按它的经纬度开档案——
        // 走 showAt 而非模拟鼠标，是为了让这个脚本验的是查询链路，
        // 而不是指针事件（后者另有 verify-pick 覆盖）
        if (pick && t.pick) t.pick.showAt(lat, lon, true);
      }, v.lat, v.lon, v.layer || null, v.vectors || null, v.dist || 0, !!v.pick);
      // 档案卡有 0.46s 的滑入过渡，得等它停稳再截
      await new Promise(r => setTimeout(r, v.pick ? 900 : 500));
    }

    /* 2D 专题图：整屏覆盖，单独一套开关 */
    if (v.map2d) {
      await page.evaluate(m => {
        const t = window.__terra;
        if (!t || !t.map2d) return;
        t.map2d.open(m.lat, m.lon, window.innerWidth / (m.span / 360 * 2048));
        if (m.raster) t.map2d.setRaster(m.raster);
        if (m.vectors) {
          for (const n of ['plates', 'coastline', 'rivers']) {
            t.map2d.setVector(n, m.vectors.indexOf(n) >= 0);
          }
        }
      }, v.map2d);
      await new Promise(r => setTimeout(r, 1100));   // 底图解码 + 首帧绘制
    }

    /* 3D → 2D → 3D 的完整往返：这一条才是阶段 5 的验收标准，
       上面几个 map2d 视角只是分别核对了各张底图 */
    if (v.flow === 'from3d') {
      const before = await page.evaluate((lat, lon, dist) => {
        const t = window.__terra;
        const p = Geo.latLonToVec3(lat, lon, t.CONFIG.earthRadius * dist);
        t.camera.position.set(p.x, p.y, p.z);
        t.camera.lookAt(0, 0, 0);
        t.controls.target.set(0, 0, 0);
        t.controls.update();
        t.state.spin = false;
        document.getElementById('btn-map2d').click();   // 走真实入口，不直接调 map2d.open
        return t.camera.position.toArray().map(n => +n.toFixed(3));
      }, v.lat, v.lon, v.dist || 3.2);

      await new Promise(r => setTimeout(r, 1100));

      // 在画布正中央单击——那里应当正是 3D 相机原先对着的那一点
      await page.evaluate(() => {
        const c = document.getElementById('map2d-canvas');
        const opt = { clientX: c.clientWidth / 2, clientY: c.clientHeight / 2,
                      bubbles: true, pointerId: 1 };
        c.dispatchEvent(new PointerEvent('pointerdown', opt));
        c.dispatchEvent(new PointerEvent('pointerup', opt));
      });

      // 迷你档案有滑入过渡。立刻读会读到过渡起点的 opacity 0，
      // 截出来的卡片也只有七成不透明，底下的地图文字会透上来
      await new Promise(r => setTimeout(r, 800));

      const hit = await page.evaluate(() => {
        const el = document.getElementById('map2d-info');
        const st = window.__terra.map2d.state;
        const cs = el ? getComputedStyle(el) : null;
        return {
          bg: cs ? cs.backgroundColor + ' / alpha ' + cs.opacity +
                   ' / backdrop ' + cs.backdropFilter : 'n/a',
          open: el ? el.classList.contains('is-open') : false,
          text: el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 130) : '',
          center: [+st.lat.toFixed(2), +st.lon.toFixed(2)],
          zoom: +st.zoom.toFixed(2),
        };
      });
      console.log(`      ↳ 2D 视中心 ${hit.center.join(', ')}  zoom ${hit.zoom}  档案卡 ${hit.bg}`);
      console.log(hit.open
        ? `      ↳ 画布中央单击 → ${hit.text}`
        : '      ↳ 画布中央单击没有弹出档案 ✗');

      await page.screenshot({ path: join(OUT, `shot-${v.name}a-2d.png`) });
      console.log(`  ✓ shot-${v.name}a-2d.png   返回前的 2D 专题图`);
      report.push(`shot-${v.name}a-2d.png — 返回前的 2D 专题图`);

      await page.evaluate(() => document.getElementById('map2d-back').click());
      await new Promise(r => setTimeout(r, 700));

      const after = await page.evaluate(() => {
        const t = window.__terra;
        return {
          pos: t.camera.position.toArray().map(n => +n.toFixed(3)),
          open: t.map2d ? t.map2d.isOpen() : null,
        };
      });
      const same = before.every((n, i) => Math.abs(n - after.pos[i]) < 1e-3);
      console.log(`      ↳ 返回后相机 ${JSON.stringify(after.pos)}，` +
                  `${same ? '与进入前一致 ✓' : '与进入前不一致 ✗（进入前 ' + JSON.stringify(before) + '）'}`);
      console.log(`      ↳ 2D 覆盖层已收起：${after.open === false ? '是 ✓' : '否 ✗'}`);
    }

    const file = join(OUT, `shot-${v.name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ✓ shot-${v.name}.png   ${v.desc}`);
    report.push(`shot-${v.name}.png — ${v.desc}`);

    // 把卡片文字读回来——不用打开图片就能看出查得对不对
    if (v.pick) {
      const card = await page.evaluate(() => {
        const el = document.getElementById('info');
        if (!el || !el.classList.contains('is-open')) return null;
        const q = s => { const n = el.querySelector(s); return n ? n.textContent.trim() : ''; };
        return {
          kind: q('.info-kind'), title: q('h2'), brief: q('.info-brief'), meta: q('.info-meta'),
          sections: [...el.querySelectorAll('.info-sec-title')].map(n => n.textContent.trim()),
          facts: [...el.querySelectorAll('.info-facts > div')]
            .map(n => n.textContent.replace(/\s+/g, ' ').trim()),
        };
      });

      if (!card) {
        console.log('      ↳ 档案卡没有打开 ✗');
      } else {
        console.log(`      ↳ ${card.kind} · ${card.title} —— ${card.brief}`);
        console.log(`        ${card.meta}`);
        if (card.sections.length) console.log(`        区块：${card.sections.join(' ／ ')}`);
        if (card.facts.length) console.log(`        速查：${card.facts.join('，')}`);
      }
    }

    // 恢复成默认画布，免得窄屏视角后面的视角全被带窄
    if (v.viewport) {
      await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // 从页面里取一些运行时状态，确认数据真的进了场景
  const info = await page.evaluate(() => {
    const t = window.__terra;
    if (!t) return null;
    return {
      camera: t.camera.position.toArray().map(n => +n.toFixed(2)),
      objects: t.scene.children.length,
      probeCount: t.probeGroup ? t.probeGroup.children.length : 0,
      glVersion: (() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl');
        if (!gl) return 'n/a';
        // 显卡型号要问这个被屏蔽的扩展才拿得到。软件渲染会自报 SwiftShader，
        // 一眼就能看出 --gpu 是真上了显卡，还是被静默回退成了软渲染
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
        return gl.getParameter(gl.VERSION) + (renderer ? ' · ' + renderer : '');
      })(),
    };
  });

  console.log('\n运行时状态:');
  if (info) {
    console.log(`  场景对象 ${info.objects} 个，验证点 ${info.probeCount} 个子对象`);
    console.log(`  相机 ${JSON.stringify(info.camera)}`);
    if (initSpin) {
      console.log(`  启动时自转 ${initSpin.spin ? '开' : '关'}` +
                  `（按钮${initSpin.btnOn ? '亮' : '灭'}）` +
                  `${initSpin.spin === initSpin.btnOn ? ' — 一致 ✓' : ' — 不一致 ✗'}`);
    }
    console.log(`  WebGL: ${info.glVersion}`);
  }

  console.log('\n控制台消息:');
  if (problems.length === 0) console.log('  （无报错）✓');
  else [...new Set(problems)].slice(0, 20).forEach(p => console.log('  ' + p));

  await writeFile(join(OUT, 'last-shot-report.txt'),
    report.join('\n') + '\n\n控制台:\n' + (problems.join('\n') || '(无)'), 'utf8');

  await browser.close();
  console.log('\n截图输出目录: tools/out/');
}

main().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
