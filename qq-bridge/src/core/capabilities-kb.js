/* ══════════════════════════════════════════════════════════════════════════
 * 功能知识库（2026-10-27，"自解释"工程）
 *
 * 目标：玲結美咲对自己的每一个功能都能讲清楚——能做什么、谁能用、参数怎么填
 * （给默认值）、走一遍实例、效果不对该动哪个旋钮。她答不上来不是她笨，
 * 是这里少了一张卡——所以铁律：**新功能上线必须同一次改动里加卡**。
 *
 * 结构：每张卡 id / name / aliases / summary / who（额度，标注"暂定"的等主人拍板）/
 * how（用户视角 1-2-3）/ params（参数+默认值）/ example（用户说 X → 我做 Y → 结果 Z）/
 * tips（调参指南）/ demo（能现场生成演示的，标出生成方式）。
 * qq_help 工具消费这里：无 topic → 目录；有 topic → 整卡。
 * ══════════════════════════════════════════════════════════════════════════ */

const KB = [
  {
    id: 'image-watermark',
    name: '图片加水印',
    aliases: ['水印', '防盗图', '全页水印', '全屏水印', 'watermark'],
    summary: '给图片加上文字或图片水印：可以只盖一个角，也可以倾斜平铺满全图防盗用；文字、颜色、角度、密度都能调。',
    who: '只限私聊。主人不限次数；普通用户与文件转换共用 10 次/天（北京 0 点刷新，暂定值）。',
    how: [
      '把图片直接发给我（私聊），说"加个水印，写×××"；',
      '不清楚参数就用我的默认配方：右下角 + 白字 + 65% 不透明度 + 字号占图宽 4%；',
      '要防盗全页就说"铺满全图"，我会按 防盗配方（平铺 + 角度 -20° + 密度 5）来做，做完发回一个文件。',
    ],
    params: [
      { name: 'text 水印文字', default: '© 你的名字（问我）', desc: '支持 \\n 多行；中文需要服务器有中文字体，没有我会明说' },
      { name: 'position 位置', default: 'bottom-right（右下角）', desc: '九宫格：左上/上/右上/左/中/右/左下/下/右下；tile=平铺全图' },
      { name: 'color 颜色', default: '#FFFFFF 白', desc: '直接说"红色/金色/灰色"我就翻译成色号；也收 #RRGGBB' },
      { name: 'opacity 透明度', default: '0.65', desc: '0.01~1；角标常用 0.5~0.8，全页防盗 0.3~0.6' },
      { name: 'fontSizePct 字号', default: '4（占图宽 4%，和网页版一致）', desc: '比写死像素更稳；大图小图都不会失比例' },
      { name: 'rotation 角度', default: '0（不正）', desc: '±180，正值顺时针；-20 是"字往右上翘"的经典水印角度' },
      { name: 'density 平铺密度', default: '5（仅 tile 生效）', desc: '1~20 越大越密；5 稀疏优雅，10+ 防盗更强' },
      { name: 'scale（图片水印）', default: '0.25', desc: '用另一张图当水印时，水印宽度占底图宽度的比例' },
    ],
    example: {
      ask: '“帮我加个水印，写 玲結美咲，斜着铺满，淡一点”',
      do: '我按 tile + rotation=-20 + density=5 + opacity=0.45 + fontSizePct=4 处理你的图',
      get: '原图上斜向平铺着半透明的"玲結美咲"，盖不住主体但能明显防盗；结果以文件发回（避免 QQ 二次压缩）。',
    },
    tips: [
      '水印太抢眼 → opacity 降到 0.3~0.5，或 fontSizePct 降到 3；',
      '防盗不够 → density 提到 8~12；还想更狠 → opacity 提到 0.6；',
      '字看不清 → 换 color（深色图用白字，浅色图用 #333333 或加 margin 避开亮部）；',
      '位置挡了主体 → position 换一个角，或改 tile；',
      '不确定效果 → 让我先生成一张演示图（不用发图给我，我自己画样例背景），满意再处理原图。',
    ],
    demo: 'watermark',
  },
  {
    id: 'image-edit',
    name: '图片编辑（压缩/改尺寸/裁剪/圆形头像）',
    aliases: ['图片编辑', '压缩图片', '改尺寸', '裁剪', '圆形头像', '抠圆'],
    summary: '单张图片的四种基础手术：压缩体积、改尺寸、按区域或比例裁剪、圆形/圆角/椭圆遮罩。',
    who: '只限私聊；额度与转换/水印共用 10 次/天（主人不限，暂定值）。',
    how: [
      '发图片给我 + 说需求："压到 500KB 以内"、"改成 1080×1080"、"裁成 1:1 头像，圆形"；',
      '裁剪没说尺寸时我会反问一句（要多大/什么比例），不会替你瞎裁；',
      '结果以文件发回，并报实际尺寸和体积。',
    ],
    params: [
      { name: 'compress 压缩', default: 'png / 质量 85', desc: 'targetKB=目标体积（我迭代降质量降尺寸直到达标）；maxDim=最长边压到多少' },
      { name: 'resize 改尺寸', default: 'mode=fit（等比+补边）', desc: 'fit 不变形留白边；crop 等比铺满再居中裁；stretch 直接拉伸（会变形）' },
      { name: 'crop 裁剪', default: '居中', desc: 'crop=[x,y,宽,高] 精确区域，或 aspect="1:1"/"16:9" 按比例居中裁' },
      { name: 'shape 图形裁剪', default: '圆角半径=短边 1/8', desc: 'circle/rounded/ellipse；只能输出 png/webp（jpg 没透明通道）' },
    ],
    example: {
      ask: '“这张 3MB，帮我压到 300KB，最长边 1280”',
      do: 'compress + targetKB=300 + maxDim=1280',
      get: '文件 ≤300KB、最长边 ≤1280 的成品文件 + 一行实测数据（实际多少 KB、多少像素）。',
    },
    tips: [
      '压完还超 → 我会自动继续降质量和尺寸到极限并如实报最终值；',
      '圆形头像四角要透明 → 别指定 jpg；',
      '改尺寸后想不留白边 → 用 mode=crop。',
    ],
    demo: 'watermark',
  },
  {
    id: 'image-gif',
    name: '多图合成 GIF',
    aliases: ['gif', '动图', '表情包动图'],
    summary: '把 2~60 张图按发送顺序合成一张动图（GIF），可调播放速度和宽度。',
    who: '只限私聊；共用媒体额度 10 次/天（主人不限，暂定值）。',
    how: [
      '按想要的帧顺序把图一张张发给我，记住顺序；',
      '告诉我速度：每张停 0.5 秒，或"每秒 5 帧"；',
      '我合成 GIF 文件发回，帧序=你发的顺序。',
    ],
    params: [
      { name: 'delay 每帧延时', default: '500ms', desc: '20~10000ms' },
      { name: 'fps 帧率', default: '（给了就优先于 delay）', desc: '0.5~30；fps=5 等于每张 200ms' },
      { name: 'width 宽度', default: '首页宽（上限 800）', desc: '16~1280；表情包常用 240~480，越小文件越小' },
      { name: 'loop 循环', default: '0 = 无限循环', desc: '也可指定播放次数' },
    ],
    example: {
      ask: '“这三张做成表情包，一秒两帧”',
      do: 'fps=2（每张 500ms）+ width=360',
      get: '循环播放的 GIF 文件，三帧按顺序轮播。',
    },
    tips: [
      '文件太大 → 减帧数、降 width；超 50MB 我会直接拒绝并告诉你怎么砍；',
      '尺寸不一样的图 → 自动等比居中到白底画布，不会拉伸变形。',
    ],
  },
  {
    id: 'image-batch',
    name: '批量图片处理',
    aliases: ['批量', '批量压缩', '批量加水印', 'batch'],
    summary: '2~12 张图用同一组参数一次处理完（压缩/缩放/裁剪/水印都行），打包成一个 ZIP 发回。',
    who: '只限私聊；一次批量算 1 次媒体额度（主人不限，暂定值）。',
    how: [
      '把图都发给我，说"这些全部压缩到 200KB"或"全部加同一个水印"；',
      '我用同一组参数逐张处理，打包 ZIP；第几张失败我会明说是哪张、为什么。',
    ],
    params: [
      { name: '数量', default: '2~12 张', desc: '超过 12 张分两批' },
      { name: '动作+参数', default: '与单张编辑相同', desc: 'watermark / compress / resize / crop / shape 任选其一' },
    ],
    example: {
      ask: '“这 5 张全部压到 200KB 以内”',
      do: 'batch compress + targetKB=200',
      get: '一个 ZIP（内含 5 张处理后的图，文件名带序号），一次额度。',
    },
    tips: [
      '一张图坏 → 整批停下并指明第几张，不会悄悄跳过；',
      '批量不做 GIF——动图请用"多图合成 GIF"。',
    ],
  },
  {
    id: 'file-convert',
    name: '文件格式转换',
    aliases: ['转换', '转格式', 'docx转pdf', 'xlsm', 'ico', '图标'],
    summary: '音频/视频/图片/Office/PDF/Markdown 互转。能转什么取决于服务器装了什么工具，我会先查能力表再承诺。',
    who: '只限私聊；10 次/天（主人不限，暂定值）；输入 ≤50MB。',
    how: [
      '发文件给我 + 说目标格式："转成 PDF"、"转成 mp3"、"做成 ICO 图标"；',
      '我按能力表转换，结果以文件发回；做不到的格式我会直接说缺什么，不硬试。',
    ],
    params: [
      { name: 'Office 宏', default: '禁用并丢弃', desc: 'xlsm→xlsx 保公式/值/格式，宏必丢（这是预期，会提前说）' },
      { name: '视频压缩', default: 'crf 23', desc: 'level low/medium/high = 更小/均衡/更清晰；maxHeight 限高；mute 去音轨' },
      { name: '视频转 GIF', default: 'fps=10 宽 480', desc: '可带 start/duration（≤60 秒）' },
      { name: 'ICO 图标', default: '256/128/64/48/32/16 多尺寸', desc: '给电脑软件用；透明图保透明，JPG 补白底' },
    ],
    example: {
      ask: '“这份 docx 转 PDF”',
      do: 'LibreOffice 转换（中文字体已装的话不会出方框）',
      get: '同名 PDF 文件；如果中文变方框说明服务器缺字体，我会明说而不是装没事。',
    },
    tips: [
      'PDF→Word 不提供（版式必丢），要文字我给 pdf→txt，要页面给 pdf→png；',
      '视频压得更小 → "用 low 档压"（crf 32）或"限高 720"。',
    ],
  },
  {
    id: 'video-tools',
    name: '视频处理（压缩/转GIF/提取音频）',
    aliases: ['视频压缩', '视频转gif', '提取音频', '视频转mp3'],
    summary: '视频的三件常用事：压体积、截一段转 GIF、把音频抽成 mp3/m4a/wav 等。',
    who: '只限私聊；共用媒体额度 10 次/天（主人不限，暂定值）；处理超时上限 5 分钟。',
    how: [
      '发视频 + 说需求："压缩一半画质"（level=medium）、"前 10 秒做成 GIF"、"把音频抽成 m4a"；',
      'GIF 转完我会报帧率/宽度，文件过大时建议你砍时长或宽度。',
    ],
    params: [
      { name: 'level 压缩档', default: 'medium（crf 26）', desc: 'low=最小 crf32 / high=最清晰 crf20；也可直接指定 crf 14~40' },
      { name: 'maxHeight 限高', default: '不限制', desc: '720/1080 等，缩分辨率最有效' },
      { name: 'GIF 截段', default: '从头开始', desc: 'start=起始秒，duration≤60 秒；fps 1~30、width 64~1280' },
    ],
    example: {
      ask: '“这个视频 300MB 太大了，帮我压小点”',
      do: 'mp4→mp4 + level=low + maxHeight=1080',
      get: '压完的 mp4 + 实际体积；还嫌大我会建议限高 720 或 mute。',
    },
    tips: [
      '压不动 → 分辨率才是大头，限高 720 最立竿见影；',
      'GIF 超 60 秒不行（文件会爆炸），长的请保持视频格式。',
    ],
  },
  {
    id: 'pdf-tools',
    name: 'PDF 工具（合并/拆分/加水印）',
    aliases: ['pdf合并', 'pdf拆分', 'pdf水印', '合并pdf'],
    summary: '多份 PDF 合成一份；按页码抽取或每 N 页一拆；整份 PDF 铺文字/图片水印。',
    who: '只限私聊；共用媒体额度 10 次/天（主人不限，暂定值）。需要服务器装 pypdf（水印另需 reportlab），没装我会明说。',
    how: [
      '合并：把要合并的 PDF 按顺序发给我，说"按这个顺序合并"；',
      '拆分：发 PDF + 说"抽出 1,3-5 页"或"每 2 页拆一份"；每 N 页一拆会打包成 ZIP；',
      '水印：发 PDF + 说水印内容，可指定"斜着铺满每一页"。',
    ],
    params: [
      { name: 'merge 合并', default: '按发送顺序，2~20 份', desc: '加密的 PDF 拒绝处理，请先解密' },
      { name: 'split 拆分', default: '—', desc: 'pages="1-3,5" 抽页成一个 PDF；every=N 每 N 页一拆成 ZIP，二选一' },
      { name: 'watermark 水印', default: '右下角、灰字、50%', desc: '全页防盗配方：平铺 + 角度 -20 + 密度 5 + 透明度 0.12 + 字号占页宽 5%（网页版同款）' },
    ],
    example: {
      ask: '“这三份合同合成一个 PDF，再每页加上「内部资料」水印”',
      do: '先 merge 3 份，再 watermark text=内部资料 + tile + rotation=-20 + opacity=0.12',
      get: '两个文件：合并版、带斜向平铺水印的版本；页数我都会报出来。',
    },
    tips: [
      '拆出的页码超了总页数 → 我会报"共 N 页"并让你改范围；',
      '中文水印要服务器有中文字体，缺了我会建议先出英文版。',
    ],
  },
  {
    id: 'text-tools',
    name: '文本 / JSON 工具',
    aliases: ['json', '格式化', '文本处理', 'base64', 'md5', '去重'],
    summary: '纯文字的活儿：JSON 格式化/校验（报错到行列）、base64/URL 编解码、MD5/SHA 哈希、字数统计、行去重/排序、查找替换（支持正则）。',
    who: '只限私聊；普通用户 50 次/天（主人不限，暂定值）——比媒体额度宽松。',
    how: [
      '短文本直接粘贴给我说要做什么；文件就发文件（UTF-8，≤2MB）；',
      '结果 ≤5000 字直接发给你，太长自动落成 txt 文件。',
    ],
    params: [
      { name: 'json-format', default: '2 空格缩进', desc: 'indent 可选 2/4/tab/0；sortKeys=true 深度按键排序' },
      { name: 'json-validate', default: '—', desc: '坏了会告诉你第几行第几列，不是只说"不合法"' },
      { name: 'hash', default: 'sha256', desc: 'md5/sha1/sha256/sha512' },
      { name: 'replace', default: '全部替换', desc: '默认字面替换；regex=true 用正则' },
    ],
    example: {
      ask: '“这段 JSON 为什么解析失败？{...}"',
      do: 'json-validate',
      get: '“不合法：...（第 3 行第 2 列附近）”——精确到位置，不让你自己找。',
    },
    tips: [
      '统计稿子字数 → count（按码点数，emoji 不算两个，中日韩分开统计）。',
    ],
  },
  {
    id: 'qrcode',
    name: '二维码生成',
    aliases: ['二维码', 'qr', '扫码'],
    summary: '把链接/文字/WiFi 信息/名片做成二维码 PNG，可以调大小、纠错等级、颜色。',
    who: '只限私聊；共用媒体额度 10 次/天（主人不限，暂定值）。',
    how: [
      '把要编码的内容原样发我（链接不要自己缩短，WiFi 按 WIFI:T:WPA;S:名字;P:密码;; 格式）；',
      '说要求（比如"要打印用，纠错开最高"），不说就用默认。',
    ],
    params: [
      { name: 'level 纠错', default: 'M', desc: 'L/M/Q/H；要打印或可能被遮挡用 H' },
      { name: 'scale 模块像素', default: '6', desc: '1~20；屏幕看 6 够了，打印建议 10+' },
      { name: 'margin 留白', default: '4', desc: '0~16' },
      { name: 'dark/light 颜色', default: '黑底白边', desc: '#RRGGBB；对比度别太低，不然扫不出来' },
    ],
    example: {
      ask: '“帮我做个二维码，内容是这个链接 …，要打印”',
      do: 'level=H + scale=10',
      get: '高清 PNG 文件（打印友好）；我不假装"扫过验证"——只能保证按你给的内容编码。',
    },
    tips: [
      '扫不出来 → 提高 scale、换回黑白色、确认内容没有中文引号混入。',
    ],
  },
  {
    id: 'tts-clone',
    name: '音色复刻（语音文件交付）',
    aliases: ['tts', '语音合成', '复刻音色', '声音克隆', '克隆声音'],
    summary: '你发几段真人语音样本 + 要读的文字，我复刻出这个音色，交付一个音频文件（mp3/wav/m4a/ogg/flac）。这是"交付工作"，不是聊天语音。',
    who: '只限私聊。主人不限；普通用户暂定 10 条/天、2000 字/天、3 个音色档案（额度还没最终定）。**必须授权**：只能复刻本人或已获明确授权的声音，拒绝公众人物和冒充用途。',
    how: [
      '发 1~5 段**音频文件**（不是语音气泡！气泡是有损压缩的，复刻效果差），每段 10~30 秒、干净单人说话、无背景音乐；',
      '我会问一句"这是你本人的声音吗/有授权吗"，确认后建音色；',
      '把要读的文字发给我（单次 ≤3000 字），选格式（默认 mp3），我合成后发文件。',
    ],
    params: [
      { name: '样本', default: '选最佳的一段入库', desc: '多段只当候选，我质检打分挑最好的；不同房间/麦克风混录反而变差' },
      { name: 'format 格式', default: 'mp3', desc: 'wav/flac 无损但大很多；m4a/ogg 折中' },
      { name: '音色档案', default: '3 个（暂定）', desc: '只能看到/使用/删除自己的音色，别人的看不见' },
    ],
    example: {
      ask: '“这是我的三段录音，用这个声音读这段话，要 mp3”',
      do: '质检选最佳段 → 建音色 → 分块合成 → 拼接响度归一',
      get: '一个 mp3 文件（带 AI 生成标记，这个不会摘掉）+ 报告用了哪段样本、时长多少。',
    },
    tips: [
      '不像 → 样本质量问题居多：换更干净更长（20~30 秒）的单人录音重录一版；',
      '读错字 → 在文字里改用同音字，或告诉我停顿位置（标点会停顿）；',
      '额度不够 → 等北京 0 点刷新（额度数是暂定的，以我报价为准）。',
    ],
  },
  {
    id: 'voice-bubble',
    name: '聊天语音气泡',
    aliases: ['语音', '发语音', '说给我听'],
    summary: '聊天时我可以发一条真正的 QQ 语音气泡（用 MiMo 音色），和上面"复刻交付"是两套系统——气泡是聊天氛围，复刻是干活的交付。',
    who: '聊天内置，按聊天节奏出现；你明确说"用语音说"我就会发。',
    how: [
      '正常聊天里偶尔出现（有概率控制，不会刷屏）；',
      '想要语音就说"语音说"或"唱一个"，我发一条短的语音气泡；',
      '我发的语音你听不清内容也没关系，我会配文字（语音从不单独承载答案）。',
    ],
    params: [
      { name: '音色', default: '主人配置的默认音色', desc: '不会自作主张换音色，除非你点名要某个' },
    ],
    example: {
      ask: '“用语音跟我说晚安”',
      do: '发一条短语音气泡 + 文字一句',
      get: '语音气泡（说的就是那句话，不重复两遍）。',
    },
    tips: [
      '你发来的语音气泡我可以转文字理解内容，但**不会**拿它当复刻样本（音质有损）。',
    ],
  },
  {
    id: 'pixiv',
    name: 'Pixiv 找图 / 发图',
    aliases: ['生图', '找图', 'pixiv', '插画', '太太'],
    summary: '按关键词/画师搜 Pixiv 插画并把原图发给你（自动过滤 R-18/R-18G）。',
    who: '聊天内置；一次默认发 1 张，说"多来几张"最多 3 张（一张一张来）。',
    how: [
      '说关键词就行："来一张米山舞的图"；不用给我 id 或链接，我自己查画师；',
      '我搜+发是一次调用完成，不会先搜一遍再发一遍；',
      'R-18 内容我不发，别问了。',
    ],
    params: [
      { name: 'size 清晰度', default: 'original 原图', desc: '只有原图超限才退 master；绝不发缩略图' },
      { name: 'index 第几张', default: '最新第一张', desc: '搜索结果里挑第几张' },
    ],
    example: {
      ask: '“来张美咲风格的图，要原图”',
      do: '按关键词搜 → 发原图',
      get: '一张原图 + 画师名和作品名（我会注明出处）。',
    },
    tips: [
      '搜不到 → 换关键词（日文通常比中文命中率高）；想指定画师直接说画师名。',
    ],
  },
];

/* ── 查询接口 ── */
export function helpIndex() {
  return {
    count: KB.length,
    features: KB.map(({ id, name, summary, demo }) => ({ id, name, summary, demo: demo || null })),
    note: '问某个功能就报名字（如"水印怎么用"）；标了 demo 的功能我可以现场生成演示效果。',
  };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

export function helpTopic(query) {
  const q = norm(query);
  if (!q) return { miss: true, ...helpIndex() };
  const hit = KB.find((e) => norm(e.id) === q || norm(e.name) === q || (e.aliases || []).some((a) => norm(a) === q))
    || KB.find((e) => norm(e.name).includes(q) || q.includes(norm(e.id)) || (e.aliases || []).some((a) => norm(a) && (norm(a).includes(q) || q.includes(norm(a)))));
  if (!hit) {
    return {
      miss: true,
      tried: String(query).slice(0, 30),
      suggestions: KB.map((e) => e.name),
      note: '没有这个主题的卡；把下面这些名字给用户挑。',
    };
  }
  const { ...entry } = hit;
  return { entry };
}

export function kbSize() {
  return KB.length;
}
