/* ============================================================
   TERRA · 具名地貌的配图清单

   键必须与 js/data.js 的 features[].name 逐字相同（tools/verify-photos.mjs
   会双向核对，对不上就报错）。值里：

     slug        产出文件名 assets/photos/<slug>.jpg，一律 ASCII
     en          英文词条名，--suggest / --auto 用它去查候选，也用于溯源
     file        Commons 上的文件名（不带 File: 前缀）
     author      署名覆盖。只在 Commons 的 Artist/Credit 都空时才需要，
                 值抄自文件页面 wikitext 的 author 参数
     focus       裁 16:9 时的归一化焦点，缺省 [0.5,0.5] 居中。
                 竖构图或主体偏一侧时必填，否则会把主体切掉
     bathymetry  海底地貌：不走 Commons 图片，改用全球测深图按经纬度裁
     crop        配 bathymetry 的裁切窗口 { lat, lon, spanDeg }

   ── 这些图是怎么挑出来的 ──────────────────────────────
   自动流程（--auto 从 Wikipedia 正文取图）只可信一半：它把德纳利
   挑成了惠特尼山、安第斯挑成了一幅油画、四川盆地挑成了辣子鸡。
   所以每一条都过了联络表（tools/contact-sheet.mjs）目视复核。

   注意事项：文件名中的逗号、括号、撇号都是标题的一部分，改一个字
   就会查不到（表现为 missing）。宁可整串复制，不要手打。

   改完重抓某条：
     HTTPS_PROXY=http://127.0.0.1:7892 NODE_USE_ENV_PROXY=1 \
       node tools/fetch-photos.mjs --only=珠穆朗玛峰 --force
   ============================================================ */

export const PHOTOS = {
  /* —— 山峰 —— */
  '珠穆朗玛峰':        { slug: 'everest',              en: 'Mount Everest',
                         file: 'Mount Everest as seen from Drukair2 PLW edit.jpg' },
  '乔戈里峰':          { slug: 'k2',                   en: 'K2',
                         // 西北壁那张更出名，但画面上叠了彩色的登山路线标记
                         file: 'K2 Mountain.jpg' },
  '阿空加瓜山':        { slug: 'aconcagua',            en: 'Aconcagua',
                         file: 'Aconcagua2016.jpg' },
  '德纳利山':          { slug: 'denali',               en: 'Denali',
                         file: 'Wonder Lake and Denali.jpg' },
  '乞力马扎罗山':      { slug: 'kilimanjaro',          en: 'Mount Kilimanjaro',
                         file: 'Kilimanjaro from Amboseli.jpg' },
  '厄尔布鲁士山':      { slug: 'elbrus',               en: 'Mount Elbrus',
                         file: 'Mount Elbrus (cropped).jpg' },
  '文森山':            { slug: 'vinson-massif',        en: 'Vinson Massif',
                         file: 'Mount Vinson from NW at Vinson Plateau by Christian Stangl (flickr).jpg' },
  '查亚峰':            { slug: 'puncak-jaya',          en: 'Puncak Jaya',
                         file: 'Carstenzs Piramida Mountain.jpg' },

  /* —— 高原 —— */
  '青藏高原':          { slug: 'tibetan-plateau',      en: 'Tibetan Plateau',
                         file: 'Tibet Midui Glacier,Autumn colour.jpg' },
  '巴西高原':          { slug: 'brazilian-highlands',  en: 'Brazilian Highlands',
                         // Itatiaia 的高海拔草甸，比步道照片更像"高原"
                         file: 'Campos de altitude, Itatiaia parte alta.jpg' },
  '东非高原':          { slug: 'east-african-plateau', en: 'East African Plateau',
                         file: 'Kenya scrubland.jpg' },
  '德干高原':          { slug: 'deccan-plateau',       en: 'Deccan Plateau',
                         // 原来那张是一座南印神庙，看不出"高原"；换成 Hampi 的巨石丘陵
                         file: 'Anjanadri Hill in Hampi (02).jpg' },
  '黄土高原':          { slug: 'loess-plateau',        en: 'Loess Plateau',
                         file: 'Loess landscape china.jpg' },
  '阿尔蒂普拉诺高原':  { slug: 'altiplano',            en: 'Altiplano',
                         file: 'SajamaPark.jpg',
                         author: 'Claire Pouteau (Clairette)' },
  '埃塞俄比亚高原':    { slug: 'ethiopian-highlands',  en: 'Ethiopian Highlands',
                         file: 'Semien Mountains 13.jpg' },

  /* —— 平原与低地 —— */
  '亚马逊平原':        { slug: 'amazon-basin',         en: 'Amazon basin',
                         file: 'Aerial view of the Amazon Rainforest.jpg' },
  '西西伯利亚平原':    { slug: 'west-siberian-plain',  en: 'West Siberian Plain',
                         file: 'Vasyugan.jpg' },
  '恒河平原':          { slug: 'indo-gangetic-plain',  en: 'Indo-Gangetic Plain',
                         file: 'Indo-Gangetic Plain.jpg',
                         author: 'NASA Earth Observatory' },
  '华北平原':          { slug: 'north-china-plain',    en: 'North China Plain',
                         file: 'Jinanfromqianfoshan.jpg' },
  '东欧平原':          { slug: 'east-european-plain',  en: 'East European Plain',
                         // 原来是一张纯树林照，看不出"平原"；换成雅罗斯拉夫尔的开阔河岸
                         file: 'Left Bank Of It River Yaroslavl region Russian Federation.jpg' },
  '死海洼地':          { slug: 'dead-sea',             en: 'Dead Sea',
                         file: 'Dead Sea salt incrusted stones.jpg' },
  '吐鲁番盆地':        { slug: 'turpan-depression',    en: 'Turpan Depression',
                         // 撇号是 U+2019 不是 ASCII '，抄错一个字符就查不到
                         file: 'Turpan Depression, nestled at the foot of China’s Bogda Mountains.jpg' },

  /* —— 沙漠 —— */
  '撒哈拉沙漠':        { slug: 'sahara',               en: 'Sahara',
                         file: 'Algeria Sahara Desert Photo From Drone 5.jpg' },
  '阿拉伯沙漠':        { slug: 'arabian-desert',       en: 'Arabian Desert',
                         file: 'Arabian Desert - panoramio.jpg' },
  '戈壁沙漠':          { slug: 'gobi-desert',          en: 'Gobi Desert',
                         file: 'Camel in Gobi Desert 01.jpg' },
  '塔克拉玛干沙漠':    { slug: 'taklamakan-desert',    en: 'Taklamakan Desert',
                         file: 'Taklamakan desert.jpg' },
  '阿塔卡马沙漠':      { slug: 'atacama-desert',       en: 'Atacama Desert',
                         file: 'Miscanti Lagoon near San Pedro de Atacama Chile Luca Galuzzi 2006.jpg' },
  '卡拉哈里沙漠':      { slug: 'kalahari-desert',      en: 'Kalahari Desert',
                         file: 'Kalahari Lehmpfanne.jpg' },
  '大维多利亚沙漠':    { slug: 'great-victoria-desert', en: 'Great Victoria Desert',
                         file: 'Red Earth Desert.jpg' },
  '巴塔哥尼亚高原':    { slug: 'patagonia',            en: 'Patagonia',
                         file: 'Perito Moreno Glacier Patagonia Argentina Luca Galuzzi 2005.JPG' },

  /* —— 海底地貌：全球测深图按经纬度裁切 ——
     这张图恰好 10 px/度，裁 80°×45° 正好 800×450，1:1 不重采样 */
  '马里亚纳海沟':      { slug: 'mariana-trench',       en: 'Mariana Trench',
                         bathymetry: true, crop: { lat: 11.35, lon: 142.2, spanDeg: 80 } },
  '秘鲁-智利海沟':     { slug: 'peru-chile-trench',    en: 'Peru–Chile Trench',
                         bathymetry: true, crop: { lat: -21, lon: -71, spanDeg: 80 } },
  '大西洋中脊':        { slug: 'mid-atlantic-ridge',   en: 'Mid-Atlantic Ridge',
                         bathymetry: true, crop: { lat: 30, lon: -42, spanDeg: 80 } },
  '东太平洋海隆':      { slug: 'east-pacific-rise',    en: 'East Pacific Rise',
                         bathymetry: true, crop: { lat: -15, lon: -110, spanDeg: 80 } },
  '日本海沟':          { slug: 'japan-trench',         en: 'Japan Trench',
                         bathymetry: true, crop: { lat: 38, lon: 144, spanDeg: 80 } },

  /* —— 构造地貌 —— */
  '东非大裂谷':        { slug: 'east-african-rift',    en: 'East African Rift',
                         file: 'Great Rift Valley in Kenya by Renvoy (2).jpg' },
  '圣安德烈亚斯断层':  { slug: 'san-andreas-fault',    en: 'San Andreas Fault',
                         file: 'Kluft-photo-Carrizo-Plain-Nov-2007-Img 0327.jpg' },

  /* —— 盆地 —— */
  '刚果盆地':          { slug: 'congo-basin',          en: 'Congo Basin',
                         file: 'Isangi people living off the river.jpg' },
  '四川盆地':          { slug: 'sichuan-basin',        en: 'Sichuan Basin',
                         file: 'Farmhouse in Chengdu Plain.jpg' },
  '大自流盆地':        { slug: 'great-artesian-basin', en: 'Great Artesian Basin',
                         // 原来拍的是镇上的水厂；盆地的地表其实是这种一望无际的干旱平原
                         file: 'Diamantina Developmental Road Boulia Shire Queensland P1030140m.jpg' },

  /* —— 湖泊与内海 —— */
  '贝加尔湖':          { slug: 'lake-baikal',          en: 'Lake Baikal',
                         file: 'Lake Baikal in winter.jpg' },
  '里海':              { slug: 'caspian-sea',          en: 'Caspian Sea',
                         // 原本选的 Nour 那张构图更好，但许可只写了 "Attribution"，不在白名单
                         file: 'Mazandarán (2000) 02.jpg' },
  '的的喀喀湖':        { slug: 'lake-titicaca',        en: 'Lake Titicaca',
                         file: 'Isla de Sol, Lago Titicaca 3.jpg' },
  '坦噶尼喀湖':        { slug: 'lake-tanganyika',      en: 'Lake Tanganyika',
                         file: 'Lake Tanganyika shores.jpg' },

  /* —— 岛屿 —— */
  '格陵兰岛':          { slug: 'greenland',            en: 'Greenland',
                         file: 'Greenland, iceberg, Kong Oscar Fjord (js)1.jpg' },
  '马达加斯加岛':      { slug: 'madagascar',           en: 'Madagascar',
                         file: 'The baobab, Mahajanga.jpg' },
  '新几内亚岛':        { slug: 'new-guinea',           en: 'New Guinea',
                         file: '(Landscape of Mount Piora, Papua New Guinea) - DPLA - f3db1b289344c67b6f0d7335ac20c952.jpg' },
  '婆罗洲':            { slug: 'borneo',               en: 'Borneo',
                         file: 'Rainforest cloud forming Kinabalu Sabah Borneo Kampong Kundasang 4.jpg' },
  '冰岛':              { slug: 'iceland',              en: 'Iceland',
                         file: 'Geleira Sólheimajökull.jpg' },
  '夏威夷群岛':        { slug: 'hawaii',               en: 'Hawaii',
                         file: 'Pāhoehoe lava meets Pacific.jpg' },

  /* —— 山脉 —— */
  '安第斯山脉':        { slug: 'andes',                en: 'Andes',
                         // 库斯科那张构图漂亮，但主体是城市；雪山才是"山脉"
                         file: 'Laguna Parón (Cordillera Blanca) - panoramio.jpg' },
  '落基山脉':          { slug: 'rocky-mountains',      en: 'Rocky Mountains',
                         file: 'Moraine Park Valley, Rocky Mountain National Park.jpg' },
  '阿尔卑斯山脉':      { slug: 'alps',                 en: 'Alps',
                         file: 'Schilthorn with Bernese Alps, 2012 August.jpg' },
  '喜马拉雅山脉':      { slug: 'himalayas',            en: 'Himalayas',
                         file: 'Ama Dablam, Nepal.jpg' },

  /* —— 其他 —— */
  '大堡礁':            { slug: 'great-barrier-reef',   en: 'Great Barrier Reef',
                         file: 'Acanthurus lineatus Flynn Reef.jpg' },
  '南极冰盖':          { slug: 'antarctic-ice-sheet',  en: 'Antarctic ice sheet',
                         file: 'Cavern carved by the sea in an ice wall near Commonwealth Bay.jpg' },
};
