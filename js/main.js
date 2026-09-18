/* ============================================================
   TERRA · 主场景

   阶段 0：一个能转的真实地球
     - NASA 地表色 / 法线 / 高光贴图
     - 独立云层
     - 星空背景
     - 验证点标记（可关，见 CONFIG.showProbes）
   ============================================================ */

(function () {

  /* ---------------- 配置 ---------------- */

  const CONFIG = {
    earthRadius: 1,
    cloudRadius: 1.006,
    spinSpeed: 0.012,          // 弧度/秒，约 8 分钟一圈
    textureSize: 2048,
    showProbes: false,         // 在球面标出 UV 验证点（阶段 0 的验收手段）
    // 高程色带也要上传成 WebGL 纹理，所以和地表贴图一样必须走内联的 data URI
    reliefColorUrl: window.TERRA_TEX && window.TERRA_TEX.relief,
  };

  /** UV 对齐验证点 —— 与 tools/verify-uv.mjs 中的清单保持一致 */
  const PROBES = [
    ['太平洋中部',      0, -150],
    ['撒哈拉沙漠',     23,   13],
    ['亚马逊雨林',     -3,  -60],
    ['南极洲内陆',    -80,    0],
    ['珠穆朗玛峰',     28,   87],
    ['大西洋中部',     30,  -40],
    ['西伯利亚针叶林', 60,  100],
    ['澳大利亚内陆',  -25,  130],
    ['格陵兰冰盖',     72,  -40],
    ['印度德干高原',   20,   78],
  ];

  /* ---------------- 状态 ---------------- */

  // CSS 里的 prefers-reduced-motion 管不到 three.js 这一侧的动画，
  // 地球的自转得在这里单独关掉——它是最容易引起不适的一处
  const REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    paused: false,
    spin: !REDUCED,
    loaded: false,
    rasterLayer: 'satellite',
    vectors: { plates: false, rivers: false, coastline: false },
  };

  let renderer, scene, camera, controls, clock;
  let earthGroup, earthMesh, cloudMesh, rasterGroup, vectorGroup, probeGroup, starField;
  let sunLight;

  /** 矢量层名 → 按钮 id */
  const VECTOR_BTNS = {
    plates:    'btn-vec-plates',
    rivers:    'btn-vec-rivers',
    coastline: 'btn-vec-coast',
  };

  const dom = {};

  /* ---------------- 工具 ---------------- */

  function nextFrame() {
    return new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      requestAnimationFrame(() => setTimeout(done, 0));
      setTimeout(done, 64);
    });
  }

  const easeInOutCubic = t =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  /* ---------------- 渲染器 / 场景 / 相机 ---------------- */

  function initRenderer() {
    const canvas = dom.scene;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    // r128 用的是 outputEncoding，r152+ 才改名 outputColorSpace
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 2000);
    camera.position.set(0, 1.3, 3.4);

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.85;
    controls.enablePan = false;
    controls.minDistance = 1.15;      // 别让相机钻进球里
    controls.maxDistance = 12;

    clock = new THREE.Clock();

    window.addEventListener('resize', onResize);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /* ---------------- 光照 ---------------- */

  function initLights() {
    // 平行光模拟太阳。放在侧面，明暗分界线能勾出地形起伏
    sunLight = new THREE.DirectionalLight(0xfff6e8, 1.35);
    sunLight.position.set(5, 2.2, 5);
    scene.add(sunLight);

    // 暗面补一点冷色，否则背光面死黑一片，看不见大陆轮廓
    const fill = new THREE.AmbientLight(0x2a3f5c, 0.55);
    scene.add(fill);

    // 南北极方向的补光，让极地不至于压暗
    const rim = new THREE.HemisphereLight(0x4a6b9a, 0x0a0f18, 0.35);
    scene.add(rim);
  }

  /* ---------------- 星空 ---------------- */

  function createStarField() {
    const count = 2600;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const palette = [[1, 1, 1], [0.78, 0.86, 1], [1, 0.92, 0.78], [0.9, 0.94, 1]];

    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const sq = Math.sqrt(1 - u * u);
      const r = 60 + Math.random() * 120;
      pos[i * 3] = sq * Math.cos(theta) * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = sq * Math.sin(theta) * r;

      const c = palette[(Math.random() * palette.length) | 0];
      const b = 0.35 + Math.random() * 0.65;
      col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({
      size: 1.1,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      map: TexGen.makeGlowTexture([255, 255, 255], 2.2),
      blending: THREE.AdditiveBlending,
    });

    starField = new THREE.Points(geo, mat);
    scene.add(starField);
  }

  /* ---------------- 地球 ---------------- */

  /**
   * 载入地表贴图。
   *
   * 走 assets/textures.js 里的 base64 data URI，而不是让 TextureLoader 读文件：
   * file:// 页面里的图片会被判为 cross-origin，<img> 加载得动、也不报错，但
   * WebGL 的 texImage2D 要求图片 origin-clean，四张纹理会一张都传不上去，
   * 地球就成了个没有贴图的球。data: URI 是 origin-clean 的，没这个问题。
   * 完整说明见 tools/inline-textures.mjs。
   */
  function loadTextures(onProgress) {
    const S = window.TERRA_TEX;
    if (!S) throw new Error('贴图未内联：请先运行 node tools/inline-textures.mjs');

    const files = [
      ['map',         'map',         true],
      ['normalMap',   'normalMap',   false],
      ['specularMap', 'specularMap', false],
      ['clouds',      'clouds',      true],
    ];

    const manager = new THREE.LoadingManager();
    const loader = new THREE.TextureLoader(manager);
    manager.onProgress = (url, loaded, total) => onProgress(loaded / total, url);

    const tex = {};
    return new Promise((resolve, reject) => {
      // 有图解码失败也要让 Promise 落地，否则启动流程会永远停在加载屏上
      let failed = null;
      manager.onError = url => {
        failed = new Error('贴图解码失败：' + String(url).slice(0, 40) + '…');
      };
      manager.onLoad = () => {
        onProgress(1, '');
        if (failed) reject(failed); else resolve(tex);
      };

      for (const [key, srcKey, isColor] of files) {
        const t = loader.load(S[srcKey]);
        // 颜色贴图要标 sRGB，法线/高光是数据贴图，标了反而会算错
        if (isColor) t.encoding = THREE.sRGBEncoding;
        t.anisotropy = TexGen.maxAnisotropy;
        tex[key] = t;
      }
    });
  }

  function createEarth(tex) {
    // 地表与所有贴地图层（栅格壳、矢量线）挂同一个组里一起自转，
    // 否则一转视角数据层就和大陆错开了
    earthGroup = new THREE.Group();
    scene.add(earthGroup);

    const geo = new THREE.SphereGeometry(CONFIG.earthRadius, 96, 64);

    // 用 Phong 而不是 Standard：r128 的 Standard 材质没有 specularMap，
    // 而海洋高光是这颗地球最重要的真实感来源
    const mat = new THREE.MeshPhongMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      specularMap: tex.specularMap,
      specular: new THREE.Color(0x2a3a4a),
      shininess: 18,
    });

    earthMesh = new THREE.Mesh(geo, mat);
    earthGroup.add(earthMesh);

    // 云层：比地表略大的同心球，带 alpha 的白色云
    const cloudMat = new THREE.MeshPhongMaterial({
      map: tex.clouds,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,        // 避免云层遮挡地球表面的深度
    });
    cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.cloudRadius, 96, 64), cloudMat);
    scene.add(cloudMesh);
  }

  /* ---------------- UV 验证点标记 ---------------- */

  function createProbes() {
    probeGroup = new THREE.Group();
    const r = CONFIG.earthRadius * 1.002;   // 稍微浮出表面，避免被地球吃掉

    const glowTex = TexGen.makeGlowTexture([255, 90, 90], 2.6);
    const ringGeo = new THREE.RingGeometry(0.016, 0.021, 24);

    for (const [name, lat, lon] of PROBES) {
      const p = Geo.latLonToVec3(lat, lon, r);

      // 小光点：用 Sprite，永远面向相机
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xff5a5a, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      sprite.position.set(p.x, p.y, p.z);
      sprite.scale.setScalar(0.055);
      sprite.userData.probe = { name, lat, lon };
      probeGroup.add(sprite);

      // 细圆环：贴在球面上，能看出标记是否被地形的朝向带偏
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xff6b6b, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      ring.position.set(p.x, p.y, p.z);
      ring.lookAt(0, 0, 0);            // 法线指向球心，环面与球面相切
      probeGroup.add(ring);
    }

    probeGroup.visible = CONFIG.showProbes;
    // 挂在 earthGroup 下：验证点是固定的地理坐标，自转时必须跟着走
    earthGroup.add(probeGroup);
  }

  /* ---------------- 数据图层 ---------------- */

  async function createLayers() {
    rasterGroup = new THREE.Group();
    earthGroup.add(rasterGroup);

    if (!window.TerraLayers) {
      console.warn('layers.js 未加载，数据图层不可用');
      return;
    }

    const opts = {
      outW: CONFIG.textureSize,
      maxAniso: TexGen.maxAnisotropy,
      reliefUrl: CONFIG.reliefColorUrl,
    };

    // 气候层的数据已在内存里，这一步基本是瞬时的
    if (window.TERRA_CLIMATE) {
      try {
        rasterGroup.add(await TerraLayers.build('climate', opts));
      } catch (e) {
        console.warn('气候图层构建失败：' + e.message);
      }
    } else {
      console.warn('气候栅格未加载，跳过气候图层');
    }

    // 高程色带是一张 PNG，得等下载解码
    try {
      rasterGroup.add(await TerraLayers.build('relief', opts));
    } catch (e) {
      console.warn('高程图层构建失败：' + e.message);
    }

    setRasterLayer(state.rasterLayer);      // 恢复当前选择——新加入的壳默认是隐藏的

    /* 矢量层是纯 CPU 的几何活，同步建完即可。
       板块边界约一两万顶点，ribbon 化后十万级，百毫秒量级。 */
    vectorGroup = new THREE.Group();
    earthGroup.add(vectorGroup);

    for (const name of ['plates', 'coastline', 'rivers']) {
      if (!TerraLayers.hasVectorData(name)) {
        console.warn('缺少矢量数据，跳过：' + name);
        continue;
      }
      const mesh = TerraLayers.buildVector(name);
      if (mesh) {
        vectorGroup.add(mesh);
        const st = mesh.userData.stats;
        console.log(`矢量层 ${name}：${st.lines} 条线 / ${st.vertices} 顶点 / ${st.ms}ms`);
      }
    }

    setVectorLayer('plates', true);         // 板块边界是地质主题的主角，默认亮出来
  }

  /**
   * 矢量层开关。
   * 与栅格层不同，矢量层之间互不遮挡，可以任意叠加，所以是独立的多选。
   */
  function setVectorLayer(name, on) {
    state.vectors[name] = !!on;

    const mesh = window.TerraLayers && TerraLayers.vectors[name];
    if (mesh) mesh.visible = !!on;

    const btn = document.getElementById(VECTOR_BTNS[name]);
    if (btn) btn.classList.toggle('is-on', !!on);
  }

  /**
   * 切换底图。
   * 栅格层互斥——它们是同一层的不同画法，同时开只会互相遮挡；
   * 矢量层是叠加的，另有一套开关（见阶段 3）。
   */
  function setRasterLayer(name) {
    state.rasterLayer = name;
    const target = (window.TerraLayers && TerraLayers.shells[name]) || null;
    if (rasterGroup) {
      rasterGroup.children.forEach(m => { m.visible = (m === target); });
    }
    // 'satellite' 不是数据层，它意味着「把数据层全关掉，露出真实影像」
    const map = {
      satellite: dom.btnBaseSat,
      climate:   dom.btnBaseClimate,
      relief:    dom.btnBaseRelief,
    };
    for (const k in map) {
      if (map[k]) map[k].classList.toggle('is-on', k === name);
    }
  }

  /* ---------------- 主循环 ---------------- */

  function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05);   // 钳制切回标签页时的巨帧

    if (state.loaded && state.spin && !state.paused) {
      // 转 earthGroup 而不是 earthMesh：数据图层是它的子节点，
      // 跟着一起转才不会和大陆错位
      earthGroup.rotation.y += CONFIG.spinSpeed * dt;
      cloudMesh.rotation.y += CONFIG.spinSpeed * 1.12 * dt;   // 云走得稍快，有流动感
    }

    if (starField) starField.rotation.y += dt * 0.002;
    if (window.TerraPick) TerraPick.tick(dt);

    // 2D 专题图铺满屏幕时，底下的 3D 没必要继续画
    if (window.TerraMap2D && TerraMap2D.isOpen()) return;

    controls.update();
    renderer.render(scene, camera);
  }

  /* ---------------- UI ---------------- */

  function setLoading(pct, label) {
    if (dom.loadingBar) dom.loadingBar.style.width = Math.round(pct * 100) + '%';
    if (dom.loadingPct) dom.loadingPct.textContent = Math.round(pct * 100) + '%';
    if (label && dom.loadingLabel) dom.loadingLabel.textContent = label;
  }

  function hideLoading() {
    const el = dom.loading;
    if (!el) return;
    el.classList.add('is-done');
    setTimeout(() => { el.style.display = 'none'; }, 800);
  }

  function bindUI() {
    window.addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); state.paused = !state.paused; }
      if (e.key === 'p' || e.key === 'P') probeGroup.visible = !probeGroup.visible;
      if (e.key === 'r' || e.key === 'R') { state.spin = !state.spin; }
      if (e.key === 'c' || e.key === 'C') {
        // 只在「确实建好了的」图层之间轮换，免得跳到一张空壳上
        const order = ['satellite', 'climate', 'relief']
          .filter(k => k === 'satellite' || (window.TerraLayers && TerraLayers.shells[k]));
        const i = order.indexOf(state.rasterLayer);
        setRasterLayer(order[(i + 1) % order.length]);
      }
    });

    const baseBtns = {
      'btn-base-sat': 'satellite',
      'btn-base-climate': 'climate',
      'btn-base-relief': 'relief',
    };
    for (const [id, layer] of Object.entries(baseBtns)) {
      const btn = dom[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      if (btn) btn.addEventListener('click', () => setRasterLayer(layer));
    }

    for (const name in VECTOR_BTNS) {
      const btn = document.getElementById(VECTOR_BTNS[name]);
      if (btn) btn.addEventListener('click', () => setVectorLayer(name, !state.vectors[name]));
    }

    if (dom.btnProbes) {
      dom.btnProbes.addEventListener('click', () => {
        probeGroup.visible = !probeGroup.visible;
        dom.btnProbes.classList.toggle('is-on', probeGroup.visible);
      });
    }
    if (dom.btnSpin) {
      // 用 state 而不是直接点亮，免得动效敏感用户看到按钮亮着、地球却没转
      dom.btnSpin.classList.toggle('is-on', state.spin);
      dom.btnSpin.addEventListener('click', () => {
        state.spin = !state.spin;
        dom.btnSpin.classList.toggle('is-on', state.spin);
      });
    }

    if (dom.btnMap2d && window.TerraMap2D) {
      dom.btnMap2d.addEventListener('click', openMap2D);
    }
  }

  /**
   * 展开 2D 专题图，并聚焦到 3D 当前正对的那一片。
   *
   * 相机永远看向原点，所以它的位置方向就是它正对的地表点；
   * 距离则决定看得多细——把「相机距离」线性映射成「2D 可视
   * 经度跨度」，两边切换时视野才不会突变。
   */
  function openMap2D() {
    if (!window.TerraMap2D) return;

    const dir = camera.position.clone().normalize().multiplyScalar(CONFIG.earthRadius);
    const ll = Geo.vec3ToLatLon(earthGroup.worldToLocal(dir));

    const span3d = controls.maxDistance - controls.minDistance;
    const t = span3d > 0 ? (camera.position.length() - controls.minDistance) / span3d : 0.5;
    const span = 40 + Math.max(0, Math.min(1, t)) * 320;   // 可视经度跨度（度）
    const zoom = window.innerWidth / (span / 360 * 2048);

    TerraMap2D.open(ll.lat, ll.lon, zoom);
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    ['scene', 'loading', 'loading-bar', 'loading-label', 'loading-pct',
     'btn-probes', 'btn-spin', 'btn-map2d',
     'btn-base-sat', 'btn-base-climate', 'btn-base-relief']
      .forEach(id => {
        dom[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
      });

    initRenderer();
    TexGen.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    initLights();
    createStarField();          // 先于贴图，加载期间就有东西可看

    setLoading(0.05, '读取地表贴图');

    const tex = await loadTextures((p, url) => {
      setLoading(0.05 + p * 0.85, p < 1 ? '读取贴图' : '构建地壳');
    });

    await nextFrame();
    createEarth(tex);
    await createLayers();
    createProbes();

    // 点选要拿到 earthMesh 与 earthGroup（自转需要反向抵消），
    // 所以必须等地球建好之后再初始化
    if (window.TerraPick) {
      TerraPick.init({ renderer, camera, earthMesh, earthGroup });
    } else {
      console.warn('pick.js 未加载，点选功能不可用');
    }

    if (window.TerraMap2D) TerraMap2D.init();

    state.loaded = true;
    setLoading(1, '就绪');
    bindUI();
    hideLoading();

    clock.start();
    animate();

    // 供 tools/shot.mjs 等自动化脚本探测与操纵
    window.__terraReady = true;
    window.__terra = {
      scene, camera, controls, state, CONFIG,
      earthGroup, earthMesh, cloudMesh, rasterGroup, vectorGroup, probeGroup,
      setRasterLayer, setVectorLayer,
      pick: window.TerraPick || null,
      map2d: window.TerraMap2D || null,
    };
  }

  boot().catch(err => {
    console.error(err);
    const el = document.getElementById('loading-label');
    if (el) el.textContent = '启动失败：' + err.message;
  });

})();
