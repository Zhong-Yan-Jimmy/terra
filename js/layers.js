/* ============================================================
   TERRA · 图层

   分两类：
     栅格层  烤成等距圆柱纹理的独立球壳，叠在真实地球之上
     矢量层  球面线段，见阶段 3

   ── 为什么栅格层是「叠加球壳」而不是「换底图」──
   换底图要把 2048×1024 整张重烤一遍，切一次黑一下；而且
   科学配色一旦盖住海洋，海面就成了一块死色。做成叠加壳后，
   陆地带纯正的科学配色（alpha=1，完全不透明，不受底图干扰），
   海洋留透明，真实卫星影像的海洋照样透出来。

   ── file:// 下的像素约束（重要）──
   从 file:// 加载的图片画进 canvas 会污染画布，getImageData()
   直接抛 SecurityError。所以这里的栅格数据一律以 base64 内联
   的 Uint8Array 形式随 <script> 进来，全程只用 putImageData
   写入、从不读回像素。
   ============================================================ */

(function () {

  /** 栅格叠加壳的半径。必须小于云层(1.006)、大于地表(1) */
  const SHELL_R = 1.0015;

  /** 矢量层半径。必须压在栅格壳之上，否则会被色块盖住 */
  const VEC_R = 1.0035;

  /* ---------------- 气候层 ---------------- */

  /**
   * 把 Köppen 类别栅格画成一张等距圆柱纹理。
   * 返回的是 canvas 而非纹理，方便多个图层共用同一套上传逻辑。
   */
  function buildClimateCanvas(outWidth) {
    const C = window.TERRA_CLIMATE;
    if (!C) throw new Error('气候栅格未加载：请检查 assets/climate/koppen_grid.js');

    /* 1. 在源分辨率上逐像素填色 */
    const src = document.createElement('canvas');
    src.width = C.width;
    src.height = C.height;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(C.width, C.height);
    const d = img.data;

    // 30 个类别的 RGB 摊平成查表，省掉内层循环里的对象访问
    const lut = new Uint8Array(31 * 3);
    for (let v = 1; v <= 30; v++) {
      const z = C.zones[v];
      if (!z) continue;
      lut[v * 3]     = z.rgb[0];
      lut[v * 3 + 1] = z.rgb[1];
      lut[v * 3 + 2] = z.rgb[2];
    }

    const grid = C.grid;
    for (let i = 0, n = grid.length; i < n; i++) {
      const v = grid[i];
      if (v === 0) continue;                 // 海洋/缺失：alpha 保持 0，透出底图
      const o = i * 4;
      const l = v * 3;
      d[o]     = lut[l];
      d[o + 1] = lut[l + 1];
      d[o + 2] = lut[l + 2];
      d[o + 3] = 255;                        // 陆地完全不透明，确保配色不被底图染色
    }
    sctx.putImageData(img, 0, 0);

    /* 2. 放大到纹理尺寸。
       源栅格是 0.35° 网格，直接贴上去边界会有硬锯齿；重采样后
       带过渡，更接近纸质气候图的观感。查询走的仍是原始数组，
       所以这点柔化不会影响点选结果的准确度。 */
    const out = document.createElement('canvas');
    out.width = outWidth;
    out.height = outWidth >> 1;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(src, 0, 0, out.width, out.height);

    return out;
  }

  /* ---------------- 矢量：球面 ribbon ---------------- */

  /**
   * 把一条球面折线扩成有宽度的三角带。
   *
   * ── 为什么不能用 THREE.Line ──────────────────────────
   * LineBasicMaterial.linewidth 在 Windows/ANGLE（Chrome 与 Edge
   * 的默认后端）上被**静默忽略**，不管设多少都只画 1 像素。板块
   * 边界是本项目的核心内容，一条放大就消失的细线不可接受。
   *
   * ── 怎么扩 ───────────────────────────────────────
   * 每个顶点取前后邻点的差分作为切向，减去法向分量投到切平面，
   * 再与法向叉乘得到侧向；沿侧向左右各偏半个带宽。偏移走的是
   * 「旋转」而非「平移」，这样两条边缘也严格落在球面上，不会
   * 因为弦切而陷进球体里。
   *
   * @param {number[]} flat    [x,y,z, x,y,z, ...] 球面点列
   * @param {number} radius
   * @param {number} widthRad  带宽（弧度）
   */
  function ribbonFromPath(flat, radius, widthRad) {
    const n = flat.length / 3;
    if (n < 2) return null;

    const pos = new Float32Array(n * 6);
    const idx = new Uint32Array((n - 1) * 6);

    const cur = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const next = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();
    const edge = new THREE.Vector3();

    const half = widthRad * 0.5;

    for (let i = 0; i < n; i++) {
      cur.set(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]).normalize();

      // 端点退化成单侧差分，正好是正确的外推方向
      const i0 = Math.max(0, i - 1) * 3;
      const i1 = Math.min(n - 1, i + 1) * 3;
      prev.set(flat[i0], flat[i0 + 1], flat[i0 + 2]).normalize();
      next.set(flat[i1], flat[i1 + 1], flat[i1 + 2]).normalize();

      tan.subVectors(next, prev);
      tan.addScaledVector(cur, -tan.dot(cur));      // 投到切平面
      if (tan.lengthSq() < 1e-12) tan.set(0, 1, 0); // 折返点兜底
      tan.normalize();
      side.crossVectors(tan, cur).normalize();

      edge.copy(cur).addScaledVector(side, half).normalize().multiplyScalar(radius);
      pos[i * 6]     = edge.x; pos[i * 6 + 1] = edge.y; pos[i * 6 + 2] = edge.z;
      edge.copy(cur).addScaledVector(side, -half).normalize().multiplyScalar(radius);
      pos[i * 6 + 3] = edge.x; pos[i * 6 + 4] = edge.y; pos[i * 6 + 5] = edge.z;
    }

    for (let i = 0; i < n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      const o = i * 6;
      idx[o] = a; idx[o + 1] = b; idx[o + 2] = c;
      idx[o + 3] = b; idx[o + 4] = d; idx[o + 5] = c;
    }

    return { pos, idx };
  }

  /**
   * 把一个 GeoJSON 的所有线条压成**单个** BufferGeometry。
   * 逐条建 Mesh 的话，光板块边界就是 241 个 draw call。
   */
  function buildVectorGeometry(geo, opts) {
    const radius = opts.radius || VEC_R;
    const widthRad = opts.width || 0.0032;
    const stepDeg = opts.stepDeg || 1.5;

    const features = (geo && geo.features) || [];
    const positions = [];
    const indices = [];
    let base = 0;
    let lineCount = 0;

    for (let f = 0; f < features.length; f++) {
      const g = features[f].geometry;
      if (!g) continue;

      const segs = Geo.geometryToSegments(g, radius, stepDeg);
      for (let s = 0; s < segs.length; s++) {
        const rb = ribbonFromPath(segs[s], radius, widthRad);
        if (!rb) continue;

        for (let i = 0; i < rb.pos.length; i++) positions.push(rb.pos[i]);
        for (let i = 0; i < rb.idx.length; i++) indices.push(rb.idx[i] + base);
        base += rb.pos.length / 3;
        lineCount++;
      }
    }

    if (!positions.length) return { geometry: null, lineCount: 0 };

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(indices);
    return { geometry, lineCount };
  }

  /* ---------------- 图层壳 ---------------- */

  /**
   * 用一张纹理建出可叠加的球壳。
   * transparent + depthWrite:false —— 海洋区域是透明的，
   * 不能让它写入深度，否则会把底下的地球挡掉。
   */
  function makeShell(tex, maxAniso) {
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = maxAniso;

    const mat = new THREE.MeshPhongMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      // 数据层要的是「颜色准确」，所以压掉高光、补一点自发光，
      // 免得暗面的气候带/等高线颜色被光照吃到认不出来
      specular: new THREE.Color(0x000000),
      shininess: 0,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: tex,
      emissiveIntensity: 0.45,
    });

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SHELL_R, 96, 64), mat);
    mesh.visible = false;
    mesh.renderOrder = 2;              // 画在云层之前
    return mesh;
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 矢量层样式表。src 是 window.TERRA_GEO 上的键名。
   *
   * width 的单位是弧度，看着小，但乘上半径 1 之后就是球面角宽度：
   * 0.004 rad ≈ 25 km，比真实板块边界粗得多——可这是要在一颗
   * 直径几百像素的球上看得见，不放大就等于没画。
   */
  const VECTOR_DEFS = {
    plates: {
      src: 'plateBoundaries',
      color: 0xff9a4d,          // 暖橙，与 HUD 的 --earth 同族
      width: 0.0042,
      opacity: 0.95,
      stepDeg: 1.2,
      label: '板块边界',
    },
    coastline: {
      src: 'coastline',
      color: 0x8fd0ff,
      width: 0.0024,
      opacity: 0.58,
      stepDeg: 2,
      label: '海岸线',
    },
    rivers: {
      src: 'rivers',
      color: 0x7fe4ff,          // 比海岸线更亮，才能从深色陆地上跳出来
      width: 0.0030,
      opacity: 0.9,
      stepDeg: 2,
      label: '河流',
    },
  };

  const cache = {};

  const Layers = {

    /** 栅格壳，按名字缓存，切换时不重复烤 */
    shells: {},

    /** 矢量层，按名字缓存 */
    vectors: {},

    /**
     * 构建栅格层。首次调用才真正烤纹理/加载图片，之后走缓存。
     * 一律返回 Promise —— 气候层在内存里烤是同步的，高程层要
     * 异步加载 PNG，外层不必关心这个差别。
     *
     * @param {string} name      'climate' | 'relief'
     * @param {object} opts      { outW, maxAniso, reliefUrl }
     */
    build(name, opts) {
      if (this.shells[name]) return Promise.resolve(this.shells[name]);
      const o = opts || {};

      if (name === 'climate') {
        if (!window.TERRA_CLIMATE) {
          return Promise.reject(new Error('气候栅格未加载'));
        }
        const canvas = cache.climate ||
          (cache.climate = buildClimateCanvas(o.outW || 2048));
        const shell = makeShell(new THREE.CanvasTexture(canvas), o.maxAniso);
        this.shells[name] = shell;
        return Promise.resolve(shell);
      }

      if (name === 'relief') {
        // 同 main.js：file:// 下的图片传不上 WebGL 纹理，色带走内联的 data URI
        if (!o.reliefUrl) {
          return Promise.reject(new Error('高程色带未内联：请先运行 node tools/inline-textures.mjs'));
        }
        return new Promise((resolve, reject) => {
          new THREE.TextureLoader().load(o.reliefUrl, tex => {
            const shell = makeShell(tex, o.maxAniso);
            this.shells[name] = shell;
            resolve(shell);
          }, undefined, () => reject(new Error('高程色带解码失败')));
        });
      }

      return Promise.reject(new Error('未知的栅格图层: ' + name));
    },

    /**
     * 构建矢量层。与栅格层不同，这一步是纯 CPU 的几何活，
     * 板块边界在几百毫秒量级，所以返回构建好的 Mesh 而非 Promise。
     * 数据缺失时返回 null，由调用方决定是否提示。
     */
    buildVector(name) {
      if (this.vectors[name]) return this.vectors[name];

      const def = VECTOR_DEFS[name];
      if (!def) return null;

      const geo = window.TERRA_GEO && window.TERRA_GEO[def.src];
      if (!geo) return null;

      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const built = buildVectorGeometry(geo, {
        radius: VEC_R,
        width: def.width,
        stepDeg: def.stepDeg,
      });
      if (!built.geometry) return null;

      const mesh = new THREE.Mesh(built.geometry, new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: def.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,     // ribbon 是单层薄片，背面也要能看见
      }));
      mesh.renderOrder = 3;
      mesh.visible = false;
      mesh.userData.stats = {
        lines: built.lineCount,
        vertices: built.geometry.attributes.position.count,
        ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
      };

      this.vectors[name] = mesh;
      return mesh;
    },

    /** 矢量层的构建统计，供构建期自检与调试用 */
    vectorStats() {
      const out = {};
      for (const k in this.vectors) out[k] = this.vectors[k].userData.stats;
      return out;
    },

    hasVectorData(name) {
      const def = VECTOR_DEFS[name];
      return !!(def && window.TERRA_GEO && window.TERRA_GEO[def.src]);
    },

    /** 2D 专题图也要这张气候图，但不需要球壳，所以单独放出来 */
    buildClimateCanvas,

    /** 给信息卡用：查某点的气候档案（含中文名） */
    climateAt(lat, lon) {
      const C = window.TERRA_CLIMATE;
      if (!C) return null;
      const z = C.at(lat, lon);
      if (!z) return null;
      const info = (window.TERRA_DATA && window.TERRA_DATA.climate[z.code]) || null;
      return Object.assign({}, z, { info });
    },

    SHELL_R,
  };

  window.TerraLayers = Layers;

})();
