/**
 * 拼 prompt 给大脑
 * --------------------------------------------------
 * 6 个片段（系统 + 画像 + 演化 + 环境 + 历史 + 对话 + 任务）
 */

/**
 * @param {object} args
 * @param {string} args.taste                  data/taste.md 全文
 * @param {string} args.tasteDeltas            最近的画像 deltas（追加日志）
 * @param {Array}  args.recentPlays            [{title,artist,played,reason}]
 * @param {Array}  args.recentMessages         [{role,text,ts}]
 * @param {object|null} args.weather           {text,temp,feelsLike,...} | null
 * @param {string} [args.userIntent]           本次用户的额外意图（"想听点轻松的"），可空
 * @param {number} [args.songsPerBlock=5]      要几首
 * @returns {string}
 */
export function buildPrompt({
  taste,
  tasteDeltas,
  recentPlays,
  recentMessages,
  weather,
  userIntent,
  songsPerBlock = 5,
}) {
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes().toString().padStart(2, '0');
  const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const period =
    hh < 6 ? '深夜' :
    hh < 11 ? '早上' :
    hh < 14 ? '中午' :
    hh < 18 ? '下午' :
    hh < 22 ? '晚上' : '深夜';

  // ---------- 各片段 ----------
  const segEnv = [
    `当前时间: ${hh}:${mm}（周${dayOfWeek}，${period}）`,
    weather ? `天气: ${weather.summary}` : '天气: 未启用',
  ].join('\n');

  const segHistory = recentPlays.length
    ? recentPlays
        .slice(-15)
        .map((p) =>
          `- ${p.title} - ${p.artist}  ${p.played ? '✓听完' : '✗跳过'}`
        )
        .join('\n')
    : '（无）';

  const segMessages = recentMessages.length
    ? recentMessages
        .slice(-6)
        .map((m) => `${m.role === 'user' ? '用户' : 'DJ'}: ${m.text}`)
        .join('\n')
    : '（无）';

  const segDeltas = (tasteDeltas || '').trim() || '（无）';

  const segIntent = userIntent
    ? `\n【用户本次额外要求】\n${userIntent}\n`
    : '';

  // ---------- 完整 prompt ----------
  return `你是 Claudio，一个跑在用户本地的私人 AI 电台 DJ。
你的任务：基于用户画像、当下情境，编排一段 ${songsPerBlock} 首歌的播放队列，并写一句简短的 DJ 开场白。

# 用户的口味画像（taste.md）
${taste}

# 画像演化记录（taste-deltas，越新越靠下；权重高于上面的画像）
${segDeltas}

# 当下环境
${segEnv}

# 最近播过的歌（避免重复，且参考用户跳过的）
${segHistory}

# 最近对话
${segMessages}
${segIntent}
# 选歌指南
- **不要被画像里提过的歌手歌曲限死**，可以推荐画像里没出现但风格匹配的新歌（这才是 DJ 的价值）
- 5 首歌之间要有"流"——不要五首风格大跳，DJ 想象力体现在曲序上
- 优先 QQ 音乐能找到的曲目（华语/日语/韩语/英语主流都可以）
- 避免和"最近播过的歌"重复
- 如果"最近对话"里用户表达了反馈/偏好，下一段必须体现

# 输出格式（严格 JSON，不要任何额外文字、不要 markdown 代码块包裹）
{
  "say": "一句 DJ 开场白，不超过 40 字。提及当前时间或情境，自然不做作。",
  "play": [
    { "title": "歌名", "artist": "歌手", "reason": "为什么选这首，不超过 25 字" }
  ],
  "taste_delta": "可选字段。如果本次用户对话表达了新偏好/反偏好，简短一句话总结（≤30字）；没有就给空字符串。"
}

# 输出硬约束（违反会让程序崩，必须严格遵守）
- **字符串值内禁止使用半角双引号 "**。如果想表达引用、歌词片段、心情台词，请用中文引号 「」 / 『』 / 单引号 '。例如 reason 写："给自己说『我挺好』时放的"，不要写："给自己说"我挺好"时放的"
- 所有字段都要给（say / play / taste_delta），即使 taste_delta 没东西也要给空字符串 ""
- 只输出 JSON，不要 markdown 围栏，不要前后任何解释文字

只输出 JSON。`;
}
