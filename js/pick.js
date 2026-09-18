/* ============================================================
   TERRA · 拾取与档案

   点中球面任一点，反解出经纬度，再向三份数据各问一句：
     这里是什么气候（Köppen 栅格）
     这里属于哪个板块（PB2002 多边形）
     这里是陆地还是海洋（Natural Earth 陆地面）

   再加上一层手写的具名地貌（js/data.js 的 features），它在
   命中时优先于上面三者——点了珠峰就该看见珠峰的档案，而不是
   「ET 苔原气候 · 欧亚板块」。

   ── 为什么具名地貌不用 hit mesh ──────────────────────
   star 的做法是给每个可点对象塞一个隐形网格，靠 raycast 命中。
   这里改用**球面角距离**：反解出经纬度后，按命中半径 r 升序
   依次比对，第一个落在半径内的胜出。好处是优先级完全可控——
   珠峰(r=1.4) 必然盖过喜马拉雅(r=3.5)，喜马拉雅又盖过青藏高原
   (r=5)，不会因为两个网格的深度顺序或相机角度而变。也省掉了
   五十多个隐形网格的射线求交。
   ============================================================ */

(function () {

  const DEG = Math.PI / 180;

  // CSS 的 prefers-reduced-motion 管不到这里的缩放动画，单独判一次
  const REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** 命中标记浮在矢量层之上、云层之下 */
  const MARK_R = 1.004;

  /** 按下与抬起的像素距离超过这个值就当成拖拽旋转，不触发点选 */
  const CLICK_SLOP = 5;

  /* ---------------- 几何 ---------------- */

  /** 两个经纬度之间的球面角距离（度） */
  function angularDistance(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
    const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
  }

  /** 具名地貌按命中半径升序——越具体的越先被匹配到 */
  let sorted = null;
  function sortedFeatures() {
    if (!sorted) {
      const F = (window.TERRA_DATA && window.TERRA_DATA.features) || [];
      sorted = F.slice().sort((a, b) => a.r - b.r);
    }
    return sorted;
  }

  /* ---------------- 查询 ---------------- */

  /**
   * 给定经纬度，汇齐该点的全部档案。
   * 纯函数，不碰 DOM——tools/verify-pick.mjs 与 2D 专题图都复用它。
   */
  function pickAt(lat, lon) {
    const D = window.TERRA_DATA || {};
    const G = window.TERRA_GEO || {};

    /* 具名地貌：半径小的优先 */
    let feature = null;
    const F = sortedFeatures();
    for (let i = 0; i < F.length; i++) {
      if (angularDistance(lat, lon, F[i].lat, F[i].lon) <= F[i].r) { feature = F[i]; break; }
    }

    /* 气候：栅格只覆盖陆地，海洋与数据缺失处返回 null */
    let climate = null;
    if (window.TerraLayers && TerraLayers.climateAt) {
      const cz = TerraLayers.climateAt(lat, lon);
      if (cz) climate = Object.assign({ code: cz.code }, cz.info || {});
    }

    /* 板块：PB2002 覆盖全球，理论上任何一点都能查到 */
    let plate = null;
    if (G.platePolygons) {
      const p = Geo.findPolygon(lon, lat, G.platePolygons.features);
      if (p && p.code) {
        const info = (D.plates && D.plates[p.code]) || null;
        plate = info ? Object.assign({ code: p.code }, info)
                      : { code: p.code, name: p.code, brief: '' };
      }
    }

    /* 海陆以陆地面多边形为准。气候栅格不能用——多数票重采样时
       给海岸线留了最多半格的余量，拿它判海陆会把近海一圈染成陆地 */
    const land = !!(G.land && Geo.findPolygon(lon, lat, G.land.features));

    return { lat, lon, feature, climate, plate, land };
  }

  /* ---------------- 3D 拾取 ---------------- */

  let ctx = null;          // { renderer, camera, earthMesh, earthGroup }
  let marker = null;
  let pulse = 0;

  /** 反解射线打中的球面点 → 经纬度 */
  function raycastLatLon(clientX, clientY) {
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );

    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const hits = ray.intersectObject(ctx.earthMesh, false);
    if (!hits.length) return null;

    // 交点是世界坐标；地球组在自转，先换回局部坐标再反解，
    // 否则算出来的经度会随着自转一起漂
    const local = ctx.earthGroup.worldToLocal(hits[0].point.clone());
    const ll = Geo.vec3ToLatLon(local);
    return { lat: ll.lat, lon: ll.lon };
  }

  /* ---------------- 命中标记 ---------------- */

  function makeMarker() {
    const g = new THREE.Group();

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.020, 0.026, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a, transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    g.add(ring);

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.009, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffe9b8, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    g.add(dot);

    g.renderOrder = 4;
    g.visible = false;
    g.userData.ring = ring;
    return g;
  }

  function placeMarker(lat, lon) {
    if (!marker) return;
    const p = Geo.latLonToVec3(lat, lon, MARK_R);
    marker.position.set(p.x, p.y, p.z);
    marker.lookAt(0, 0, 0);       // 环面与球面相切
    marker.visible = true;
    pulse = 0;
  }

  /* ---------------- 档案卡 ---------------- */

  const fmt = (lat, lon) =>
    `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ` +
    `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function factsTable(facts) {
    if (!facts || !facts.length) return '';
    return '<dl class="info-facts">' + facts.map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('') + '</dl>';
  }

  function section(title, inner) {
    return `<section class="info-sec">` +
           (title ? `<h3 class="info-sec-title">${title}</h3>` : '') +
           inner + `</section>`;
  }

  function renderCard(d) {
    const card = document.getElementById('info');
    if (!card) return;

    const title = d.feature ? d.feature.name
                : d.climate ? d.climate.name
                : d.land ? '陆地' : '海洋';

    // 标签：具名地貌用它自己的类别，否则退回「气候」「海域」
    const kind = d.feature ? d.feature.kind
               : d.climate ? '气候'
               : d.land ? '陆域' : '海域';

    const brief = d.feature ? d.feature.brief
                : d.climate ? d.climate.brief
                : '此处没有陆地气候分类';

    const meta = [
      fmt(d.lat, d.lon),
      d.plate ? `${d.plate.name}（${d.plate.code}）` : null,
      d.land ? '陆地' : '海洋',
    ].filter(Boolean).join(' · ');

    let body = '';

    if (d.feature) {
      body += section('', `<p class="info-desc">${esc(d.feature.desc)}</p>` +
                          factsTable(d.feature.facts));
    }

    if (d.climate) {
      body += section(
        `<span class="info-tag">气候</span>${esc(d.climate.name)}`,
        `<p class="info-desc">${esc(d.climate.desc)}</p>` +
        (d.climate.where
          ? `<p class="info-where"><i>典型分布</i>${esc(d.climate.where)}</p>` : '')
      );
    }

    if (d.plate) {
      body += section(
        `<span class="info-tag">板块</span>${esc(d.plate.name)}` +
        `<code class="info-code">${esc(d.plate.code)}</code>`,
        d.plate.desc || d.plate.brief
          ? `<p class="info-desc">${esc(d.plate.desc || d.plate.brief)}</p>` : ''
      );
    }

    if (!d.land && !d.feature) {
      body += section('', `<p class="info-desc">这一点位于海面。` +
        `气候分类只覆盖陆地——海洋的热量与水汽输送给大气，本身就是` +
        `大陆气候的成因之一。</p>`);
    }

    card.innerHTML =
      `<button class="info-close" id="info-close" aria-label="关闭">×</button>` +
      `<header class="info-head">` +
        `<span class="info-kind">${esc(kind)}</span>` +
        `<h2>${esc(title)}</h2>` +
        `<p class="info-brief">${esc(brief)}</p>` +
        `<p class="info-meta">${esc(meta)}</p>` +
      `</header>` +
      `<div class="info-body">${body}</div>`;

    card.classList.add('is-open');
    card.scrollTop = 0;

    const btn = document.getElementById('info-close');
    if (btn) btn.addEventListener('click', closeCard);
  }

  function closeCard() {
    const card = document.getElementById('info');
    if (card) card.classList.remove('is-open');
    if (marker) marker.visible = false;
  }

  /* ---------------- 事件 ---------------- */

  /**
   * 打开某点的档案。供点击、以及外部（例如 2D 专题图）调用。
   * @param {boolean} withMarker 是否在球面上打标记
   */
  function showAt(lat, lon, withMarker) {
    const d = pickAt(lat, lon);
    renderCard(d);
    if (withMarker !== false) placeMarker(lat, lon);
    return d;
  }

  function init(opts) {
    ctx = opts;
    marker = makeMarker();
    ctx.earthGroup.add(marker);     // 跟着地球一起转

    const canvas = ctx.renderer.domElement;
    let downX = 0, downY = 0, downAt = 0;

    canvas.addEventListener('pointerdown', e => {
      downX = e.clientX; downY = e.clientY; downAt = Date.now();
    });

    canvas.addEventListener('pointerup', e => {
      // 拖拽旋转、或长按之后松手，都不算点选
      if (Math.abs(e.clientX - downX) > CLICK_SLOP) return;
      if (Math.abs(e.clientY - downY) > CLICK_SLOP) return;
      if (Date.now() - downAt > 700) return;

      const ll = raycastLatLon(e.clientX, e.clientY);
      if (!ll) { closeCard(); return; }   // 点到星空上：收起卡片
      showAt(ll.lat, ll.lon, true);
    });

    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeCard();
    });
  }

  /** 由主循环驱动，做一点呼吸感，免得标记看着像贴纸 */
  function tick(dt) {
    if (!marker || !marker.visible) return;
    if (REDUCED) { marker.userData.ring.scale.setScalar(1); return; }   // 不做呼吸
    pulse += dt;
    const k = 1 + Math.sin(pulse * 3.2) * 0.12;
    marker.userData.ring.scale.setScalar(k);
  }

  window.TerraPick = {
    init, pickAt, showAt, closeCard, tick, angularDistance,
    get marker() { return marker; },
  };

})();
