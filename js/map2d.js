/* ============================================================
   TERRA · 2D 专题图

   3D 地球负责「这是哪儿」，2D 专题图负责「这一片到底是什么样」——
   球面上每个像素只有不到 2px，看不了一条山脉的走向，也数不清
   一片区域内气候类型的拼接关系。翻到平面就都能看清了。

   ── 为什么底图不用另找 ──────────────────────────────
   assets/earth/earth_atmos_2048.jpg 本身就是**等距圆柱投影**，
   与 3D 用的 SphereGeometry 贴图是同一张。所以 2D 图的底图和
   3D 球面在几何上严格一致，两边的同一经纬度落在同一位置，
   不需要任何配准。图层（气候栅格、高程色带、矢量）也都是
   等距圆柱，全部可以直上。

   ── 跨 180° 的处理 ────────────────────────────────
   等距圆柱图上，一条跨过 180° 的线会从图的右边缘跳到左边缘。
   所以相邻两点经度差超过 180° 时把路径断开——和 3D 那边
   用 NaN 分隔是同一个意思，只是这里用两次 stroke 实现。
   ============================================================ */

(function () {

  /** 世界画布尺寸，与底图一致（等距圆柱，2:1） */
  const W = 2048, H = 1024;

  /* 底图与色带都取 assets/textures.js 里内联的 data URI。
     2D 这侧走的是 canvas drawImage，用文件也能画（不碰 WebGL），
     但同一张图两处用、分两种来源只会让人搞不清哪张是哪张 */
  const SRC = {
    get base()   { return window.TERRA_TEX && window.TERRA_TEX.map; },
    get relief() { return window.TERRA_TEX && window.TERRA_TEX.relief; },
  };

  /**
   * 缩放下限：世界图横向铺满视口。
   *
   * 不用「整图都装得下」那种算法：等距圆柱图是 2:1，竖屏是 1:2，
   * 按 contain 算会缩成屏幕中间窄窄的一条，上下全是空背景。
   * 纵向超出靠拖动即可，露出的一点图外空间由 draw() 描边标出边界。
   */
  const minZoom = () => vw / W;

  const st = {
    open: false,
    lon: 0, lat: 20, zoom: 2,
    raster: 'satellite',
    vectors: { plates: true, coastline: false, rivers: false },
    hover: null,          // 最近一次点选的经纬度，用于画命中标记
  };

  let cv, ctx, dpr = 1;
  let vw = 0, vh = 0;                 // 视口 CSS 尺寸
  let imgBase = null, imgRelief = null, climateCv = null;
  let dirty = true;
  let drag = null;

  /* ---------------- 坐标换算 ---------------- */

  const wx = lon => (lon + 180) / 360 * W;
  const wy = lat => (90 - lat) / 180 * H;

  /** 当前视图：世界坐标下的可视矩形（x0 可以越界，由 draw() 环绕补画） */
  function view() {
    const sx = vw / st.zoom;
    const sy = vh / st.zoom;

    // 经度方向不钳制。钳住的话 180° 一带永远居不了中，
    // 斐济、白令海峡、新西兰这些地方就永远看不全
    const x0 = wx(st.lon) - sx / 2;

    // 纬度方向没有环绕可绕，缩到比世界还小时居中，否则钳在南北界内
    let y0 = wy(st.lat) - sy / 2;
    y0 = sy >= H ? (H - sy) / 2 : Math.max(0, Math.min(H - sy, y0));

    return { x0, y0, sx, sy };
  }

  const toScreenX = (lon, v) => (wx(lon) - v.x0) * st.zoom;
  const toScreenY = (lat, v) => (wy(lat) - v.y0) * st.zoom;

  /* ---------------- 绘制 ---------------- */

  const clamp2 = (v, a, b) => (v < a ? a : v > b ? b : v);

  function draw() {
    dirty = false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 比图内的海洋稍亮一点，纵向放不下时露出的「图外台面」才分得出来
    ctx.fillStyle = '#070d18';
    ctx.fillRect(0, 0, vw, vh);

    const v = view();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 经度环绕：视口越过世界左右边界时，把对面那一截补画上来，
    // 否则 180° 附近会空一块，日界线两侧接不起来。
    // 有效区域恰好互补，不会重叠（缩放下限保证了 sx ≤ W）
    const offs = [0];
    if (v.x0 < 0) offs.push(W);
    if (v.x0 + v.sx > W) offs.push(-W);
    const views = offs.map(d => (d ? { ...v, x0: v.x0 + d } : v));

    // 分层来画：同层的几份之间互不遮挡，跨层才需要顺序。
    // 压暗只能做一次，放进循环里会把上一份也一起压了
    for (const w of views) {
      if (imgBase && imgBase.complete) {
        ctx.drawImage(imgBase, w.x0, w.y0, w.sx, w.sy, 0, 0, vw, vh);
      }
    }
    if (st.raster !== 'satellite') {
      ctx.fillStyle = 'rgba(3, 8, 16, 0.55)';   // 数据层叠上去前先压暗底图
      ctx.fillRect(0, 0, vw, vh);
    }
    for (const w of views) {
      if (st.raster === 'climate' && climateCv) {
        ctx.drawImage(climateCv, w.x0, w.y0, w.sx, w.sy, 0, 0, vw, vh);
      } else if (st.raster === 'relief' && imgRelief && imgRelief.complete) {
        ctx.drawImage(imgRelief, w.x0, w.y0, w.sx, w.sy, 0, 0, vw, vh);
      }
    }
    for (const w of views) {
      drawGraticule(w);
      drawVectors(w);
      drawFeatures(w);
    }

    drawMarker(v);
    drawFrame(v);
  }

  /** 上下边框：标出图外的空间。左右不画——经度是环绕的，没有「图的边缘」 */
  function drawFrame(v) {
    const yTop = toScreenY(90, v) + 0.5;
    const yBot = toScreenY(-90, v) + 0.5;
    if (yTop > vh && yBot > vh) return;
    if (yTop < 0 && yBot < 0) return;

    ctx.strokeStyle = 'rgba(94,231,255,0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yTop); ctx.lineTo(vw, yTop);
    ctx.moveTo(0, yBot); ctx.lineTo(vw, yBot);
    ctx.stroke();
  }

  /** 经纬网：每 30°，赤道与本初子午线加重 */
  function drawGraticule(v) {
    ctx.save();
    ctx.lineWidth = 1;

    for (let lon = -180; lon <= 180; lon += 30) {
      const x = toScreenX(lon, v);
      if (x < -1 || x > vw + 1) continue;
      ctx.strokeStyle = lon === 0 ? 'rgba(94,200,255,0.26)' : 'rgba(94,200,255,0.11)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, vh); ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = toScreenY(lat, v);
      if (y < -1 || y > vh + 1) continue;
      ctx.strokeStyle = lat === 0 ? 'rgba(94,200,255,0.26)' : 'rgba(94,200,255,0.11)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(vw, y); ctx.stroke();
    }

    // 回归线与极圈：与气候带直接相关，单独标出来
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,183,116,0.20)';
    for (const lat of [23.4367, -23.4367, 66.5633, -66.5633]) {
      const y = toScreenY(lat, v);
      if (y < -1 || y > vh + 1) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(vw, y); ctx.stroke();
    }
    ctx.restore();
  }

  /** GeoJSON 的每条线铺成屏幕路径。返回时按跨 180° 自动断开 */
  function eachRing(geo, fn) {
    const feats = (geo && geo.features) || [];
    for (let f = 0; f < feats.length; f++) {
      const g = feats[f].geometry;
      if (!g) continue;
      const push = coords => fn(coords, feats[f].properties);
      if (g.type === 'LineString') push(g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(push);
      else if (g.type === 'Polygon') g.coordinates.forEach(push);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(r => r.forEach(push));
    }
  }

  function tracePath(coords, v) {
    ctx.beginPath();
    let prevLon = null, started = false;
    for (let i = 0; i < coords.length; i++) {
      const lon = coords[i][0], lat = coords[i][1];
      if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
        ctx.stroke();          // 跨了接缝：收笔，另起一段
        ctx.beginPath();
        started = false;
      }
      const x = toScreenX(lon, v), y = toScreenY(lat, v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      prevLon = lon;
    }
    ctx.stroke();
  }

  function drawVectors(v) {
    const G = window.TERRA_GEO || {};
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 线宽跟着缩放走。定死的话，放大到看一条河的时候它还是根细线，
    // 缩到看半球的时候又糊成一片
    const k = clamp2(Math.sqrt(st.zoom / 2.2), 0.8, 2.6);

    if (st.vectors.coastline && G.coastline) {
      ctx.strokeStyle = 'rgba(143,208,255,0.62)';
      ctx.lineWidth = 1.1 * k;
      eachRing(G.coastline, c => tracePath(c, v));
    }
    if (st.vectors.rivers && G.rivers) {
      ctx.strokeStyle = 'rgba(127,228,255,0.75)';
      ctx.lineWidth = 1.25 * k;
      eachRing(G.rivers, c => tracePath(c, v));
    }
    if (st.vectors.plates && G.plateBoundaries) {
      ctx.strokeStyle = 'rgba(255,154,77,0.85)';
      ctx.lineWidth = 1.6 * k;
      eachRing(G.plateBoundaries, c => tracePath(c, v));
    }
    ctx.restore();
  }

  /** 具名地貌：小点常显，名字在放得够大时才出现，免得糊成一片 */
  function drawFeatures(v) {
    const F = (window.TERRA_DATA && window.TERRA_DATA.features) || [];
    const showLabels = st.zoom >= 3.2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '12px "PingFang SC", "Microsoft YaHei", sans-serif';

    for (let i = 0; i < F.length; i++) {
      const f = F[i];
      const x = toScreenX(f.lon, v), y = toScreenY(f.lat, v);
      if (x < -40 || x > vw + 40 || y < -40 || y > vh + 40) continue;

      // 点的角半径换算成屏幕像素：r 度 ≈ r/180*H 世界像素
      const rad = Math.max(2.4, f.r / 180 * H * st.zoom * 0.5);

      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,210,122,0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,210,122,0.42)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe9b8';
      ctx.fill();

      if (showLabels) {
        // 名字底下压一层暗描边——底图可能是雪白的高原，浅色字会直接消失
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(3,6,13,0.82)';
        ctx.lineJoin = 'round';
        ctx.strokeText(f.name, x, y + rad + 3);
        ctx.fillStyle = 'rgba(240,251,255,0.96)';
        ctx.fillText(f.name, x, y + rad + 3);
      }
    }
    ctx.restore();
  }

  function drawMarker(v) {
    if (!st.hover) return;
    const x = toScreenX(st.hover.lon, v), y = toScreenY(st.hover.lat, v);
    ctx.save();
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14);
    ctx.strokeStyle = 'rgba(255,210,122,0.5)';
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- 视口 → 经纬度 ---------------- */

  function screenToLatLon(clientX, clientY) {
    const v = view();
    const x = v.x0 + clientX / st.zoom;
    const y = v.y0 + clientY / st.zoom;
    // 环绕时 x 会跑到 [0, W] 之外，取回来的经度得绕回 ±180
    let lon = x / W * 360 - 180;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    return { lon, lat: 90 - y / H * 180 };
  }

  /* ---------------- 交互 ---------------- */

  function bind() {
    const canvas = cv;

    canvas.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, moved: 0, at: Date.now() };
      // 指针已经抬起时会抛 NotFoundError；抓不到就算了，顶多拖出画布时丢事件
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    });

    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!dx && !dy) return;
      drag.moved += Math.abs(dx) + Math.abs(dy);

      // 拖动方向与地图移动方向一致：鼠标往右拽，地图就往右走，
      // 于是视中心要往西（经度减小）
      st.lon -= dx / st.zoom * 360 / W;
      st.lat += dy / st.zoom * 180 / H;
      st.lat = clamp2(st.lat, -85, 85);
      st.lon = ((st.lon + 180) % 360 + 360) % 360 - 180;
      drag.x = e.clientX; drag.y = e.clientY;
      dirty = true;
    });

    canvas.addEventListener('pointerup', e => {
      if (!drag) return;
      const wasClick = drag.moved < 5 && Date.now() - drag.at < 700;
      canvas.releasePointerCapture(e.pointerId);
      drag = null;
      if (wasClick) queryAt(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointercancel', () => { drag = null; });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;

      // 以光标为锚点缩放：先记下光标下的经纬度，缩放后把它挪回原处
      const before = screenToLatLon(px, py);
      const k = Math.exp(-e.deltaY * 0.0016);
      st.zoom = clamp2(st.zoom * k, minZoom(), 26);

      const after = screenToLatLon(px, py);
      st.lon += before.lon - after.lon;
      st.lat += before.lat - after.lat;
      st.lat = clamp2(st.lat, -85, 85);
      st.lon = ((st.lon + 180) % 360 + 360) % 360 - 180;
      dirty = true;
    }, { passive: false });
  }

  /* ---------------- 点选 ---------------- */

  function queryAt(clientX, clientY) {
    const ll = screenToLatLon(clientX, clientY);
    st.hover = ll;
    dirty = true;

    const d = window.TerraPick && TerraPick.pickAt(ll.lat, ll.lon);
    const panel = document.getElementById('map2d-info');
    if (!panel || !d) return;

    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const title = d.feature ? d.feature.name : d.climate ? d.climate.name : (d.land ? '陆地' : '海洋');
    const brief = d.feature ? d.feature.brief : d.climate ? d.climate.brief : '此处没有陆地气候分类';

    const rows = [];
    if (d.climate) rows.push(['气候', `${d.climate.name}（${d.climate.code}）`]);
    if (d.plate)   rows.push(['板块', `${d.plate.name}（${d.plate.code}）`]);
    rows.push(['坐标', `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'}, ` +
                       `${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}`]);
    rows.push(['下垫面', d.land ? '陆地' : '海洋']);

    const photo = (d.feature && window.TerraPhotos)
      ? TerraPhotos.figureHTML(d.feature.name, 'm2-photo') : '';

    panel.innerHTML =
      `<h4>${esc(title)}</h4>` + photo + `<p class="m2-brief">${esc(brief)}</p>` +
      '<dl class="m2-facts">' + rows.map(([k, val]) =>
        `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('') + '</dl>' +
      (d.feature ? `<p class="m2-desc">${esc(d.feature.desc)}</p>` : '');
    panel.classList.add('is-open');
  }

  /* ---------------- 图层开关 ---------------- */

  function setRaster(name) {
    st.raster = name;
    for (const k of ['satellite', 'climate', 'relief']) {
      const b = document.getElementById('m2-base-' + k);
      if (b) b.classList.toggle('is-on', k === name);
    }
    dirty = true;
  }

  function setVector(name, on) {
    st.vectors[name] = !!on;
    const b = document.getElementById('m2-vec-' + name);
    if (b) b.classList.toggle('is-on', !!on);
    dirty = true;
  }

  /* ---------------- 开合 ---------------- */

  function resize() {
    const r = cv.getBoundingClientRect();
    vw = Math.round(r.width);
    vh = Math.round(r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  /**
   * 打开专题图并聚焦到某处。
   * @param {number} lat/lon 视中心
   * @param {number} zoom   每世界像素占几个屏幕像素
   */
  function open(lat, lon, zoom) {
    const el = document.getElementById('map2d');
    if (!el) return null;

    loadAssets();
    el.classList.add('is-open');
    st.open = true;

    // 尺寸要等元素真正可见才量得准
    requestAnimationFrame(() => {
      resize();
      st.lat = clamp2(lat, -85, 85);
      st.lon = lon;
      // 缩得太小整张图缩成屏幕中央一小块，四周全是空背景，没有意义
      st.zoom = Math.max(minZoom(), zoom || minZoom());
      dirty = true;
      loop();
    });
    return st;
  }

  function close() {
    const el = document.getElementById('map2d');
    if (el) el.classList.remove('is-open');
    st.open = false;
    const panel = document.getElementById('map2d-info');
    if (panel) panel.classList.remove('is-open');
  }

  let raf = 0;
  function loop() {
    if (!st.open) { raf = 0; return; }
    if (dirty) draw();
    raf = requestAnimationFrame(loop);
  }

  function loadAssets() {
    if (!imgBase) {
      imgBase = new Image();
      imgBase.onload = () => { dirty = true; };
      imgBase.src = SRC.base;
    }
    if (!imgRelief) {
      imgRelief = new Image();
      imgRelief.onload = () => { dirty = true; };
      imgRelief.src = SRC.relief;
    }
    // 气候图是从内存栅格烤的，不占网络，但第一次烤约几十毫秒
    if (!climateCv && window.TerraLayers) {
      try { climateCv = TerraLayers.buildClimateCanvas(W); }
      catch (e) { console.warn('2D 气候图构建失败：' + e.message); }
    }
  }

  function init() {
    cv = document.getElementById('map2d-canvas');
    if (!cv) return false;
    ctx = cv.getContext('2d');

    const bases = {
      'm2-base-satellite': 'satellite',
      'm2-base-climate':   'climate',
      'm2-base-relief':    'relief',
    };
    for (const [id, name] of Object.entries(bases)) {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => setRaster(name));
    }

    for (const name of ['plates', 'coastline', 'rivers']) {
      const b = document.getElementById('m2-vec-' + name);
      if (b) b.addEventListener('click', () => setVector(name, !st.vectors[name]));
    }

    const back = document.getElementById('map2d-back');
    if (back) back.addEventListener('click', close);

    window.addEventListener('resize', () => { if (st.open) resize(); });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && st.open) close();
    });

    bind();
    for (const k in st.vectors) setVector(k, st.vectors[k]);
    setRaster(st.raster);
    return true;
  }

  window.TerraMap2D = {
    init, open, close, setRaster, setVector,
    isOpen: () => st.open,
    get state() { return st; },
  };

})();
