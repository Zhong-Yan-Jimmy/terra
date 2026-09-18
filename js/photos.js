/* 具名地貌的配图 —— 档案卡里那张照片的渲染层。

   数据在 assets/photos/credits.js（由 tools/fetch-photos.mjs 生成），
   以中文地貌名为键。这里只做两件事：查表、拼 HTML。

   为什么单独成一个文件：3D 档案卡（js/pick.js）与 2D 专题图的迷你档案
   （js/map2d.js）是两套独立模板，但照片区连同署名文案必须一字不差——
   署名是 CC 许可的条件，不能两边各写一遍然后慢慢走样。

   为什么 src 指向 assets/photos/*.jpg 而不是 base64 data URI：
   档案卡是纯 DOM，不碰 WebGL 也不碰 canvas。file:// 下失败的是
   texImage2D 对 origin-clean 的要求（见 tools/inline-textures.mjs 抬头），
   <img> 本身加载同目录图片一直是通的；56 张内联要多背三分之一体积。 */

(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* 属性值不能只靠 esc：它不转义引号，而署名行要往 href 里插值。
     值来自 Wikimedia API 响应，虽是自己抓的也不当可信输入 */
  const escAttr = s => esc(s).replace(/"/g, '&quot;');

  function of(name) {
    const P = window.TERRA_PHOTOS;
    return (P && Object.prototype.hasOwnProperty.call(P, name)) ? P[name] : null;
  }

  /* 拼出照片区。没有配图就返回空串，调用方直接拼进模板，不必自己判空。
     cls 由调用方给（info-photo / m2-photo），两张卡片的尺寸差异走 CSS */
  function figureHTML(name, cls) {
    const p = of(name);
    if (!p) return '';

    const isBathy = !!p.bathymetry;
    const credit = p.author || 'Wikimedia Commons 贡献者';

    const creditHTML = p.source
      ? `<a href="${escAttr(p.source)}" target="_blank" rel="noopener">${esc(credit)}</a>`
      : esc(credit);

    const licenseHTML = !p.license ? ''
      : p.licenseUrl
        ? `<a href="${escAttr(p.licenseUrl)}" target="_blank" rel="noopener">${esc(p.license)}</a>`
        : esc(p.license);

    return `<figure class="${escAttr(cls || 'info-photo')}">` +
      `<img src="${escAttr(p.src)}" width="${+p.w || 800}" height="${+p.h || 450}"` +
      ` alt="${escAttr(name + ' · ' + (isBathy ? '海底地形图' : '实景照片'))}" decoding="async">` +
      `<figcaption>${isBathy ? '影像' : '照片'}：${creditHTML}` +
      (licenseHTML ? ' · ' + licenseHTML : '') +
      (p.modified ? ' · 已裁切' : '') +
      `</figcaption></figure>`;
  }

  window.TerraPhotos = { of, figureHTML };
})();
