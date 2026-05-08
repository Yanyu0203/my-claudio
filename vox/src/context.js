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
        .slice(-40) // 最近 40 条，覆盖近 4 个 block；带评分/是否听完
        .map((p) => {
          const tag = p.rating === 'like' ? ' ♥喜欢'
            : p.rating === 'dislike' ? ' ✕不喜欢'
            : '';
          return `- ${p.title} - ${p.artist}  ${p.played ? '✓听完' : '✗跳过'}${tag}`;
        })
        .join('\n')
    : '（无）';

  // ---------- 硬黑名单 ----------
  // 用 Set 去重（同一首歌在 play_history 可能有多条：先"占位"再"played"事件）
  // 窗口：最近 60 首 ≈ 6 个 block（之前给 30 首不够，实测 6 个 block 里同一首歌被推 3 次）
  const blacklistSet = new Set();
  const blacklistItems = [];
  for (const p of recentPlays.slice(-60)) {
    const key = `${p.title.trim()} - ${p.artist.trim()}`;
    if (blacklistSet.has(key)) continue;
    blacklistSet.add(key);
    blacklistItems.push(`- ${key}`);
  }
  const segBlacklist = blacklistItems.length ? blacklistItems.join('\n') : '（无）';

  // 最近 "听完且喜欢" 的（软黑名单 —— 给 AI 更强烈的信号，这些歌虽然用户爱但别重复喂）
  const favoriteRecent = recentPlays
    .slice(-100)
    .filter((p) => p.played && (p.rating === 'like' || !p.rating)) // 听完了 + 没打差评
    .map((p) => `${p.title.trim()} - ${p.artist.trim()}`);
  // 去重
  const favoriteUnique = [...new Set(favoriteRecent)];
  const segFavoriteCooldown = favoriteUnique.length
    ? favoriteUnique.slice(-40).map((s) => `- ${s}`).join('\n')
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
  return `你是 Vox —— 一个跑在用户本地的 AI 电台播客主持人（不是冷冰冰的推荐系统，是有人设、有品味、有温度的主持人）。
你的任务：基于用户画像、当下情境，编排一段 ${songsPerBlock} 首歌的播放队列，并写一句简短的开场白（像电台节目之间的过渡口播）。

# 用户的口味画像（taste.md）
${taste}

# 画像演化记录（taste-deltas，越新越靠下；权重高于上面的画像）
${segDeltas}

# 当下环境
${segEnv}

# 最近播过的歌（参考用户反应：听完/跳过/评分）
${segHistory}

# 🚫 硬禁止清单（最近 6 个 block，约 60 首，**绝对不能再出现**）
这是你最近已经推给这个用户的歌。哪怕画像 / 对话 / 你自己的音乐感觉告诉你它多合适，也**必须全部排除**。用户体验：再好的歌连续听也会腻。
${segBlacklist}

# ⏱ 冷却期推荐（最近 40 首"听完没差评"的歌，本段尽量避开）
这些是用户最近听完的/标过喜欢的。**即使它们已经滑出硬禁止清单，也请至少再隔 2-3 个 block 才考虑重推**。优先去推 TA 没听过的、风格匹配的**新**歌。
${segFavoriteCooldown}

# 最近对话
${segMessages}
${segIntent}
# 选歌指南
- **主持人的价值是发现新歌**：不要被画像里提过的歌手歌曲限死，大量推荐画像里没出现但风格匹配的歌
- **严禁重复**：硬禁止清单里的歌这段**一首都不能出现**；冷却期清单里的歌尽量不出现
- 如果想致敬画像里提到的歌手 → 推 TA 的**别的歌**（不同专辑 / 不同年代 / 不同语种）
- ${songsPerBlock} 首歌之间要有"流"——不要大跳，想象力体现在曲序上
- 优先音乐源（QQ / 网易云）能找到的曲目（华语 / 日语 / 韩语 / 英语主流都可以）
- 如果"最近对话"里用户表达了反馈/偏好，下一段必须体现

# 关于 say 字段（开场白）

这是你作为播客主持人在这段歌单开头说的一句话。写法：
- ≤ 40 字，像真人说话，**不用"DJ"称呼自己**（你叫 Vox，但开场白里一般不用自报家门）
- 可以带时间/天气感（"凌晨快一点了"/"雨下了一晚上"），但不硬要每次都提
- 语气克制有温度，不是客服也不是推销
- 避免"给你准备了..."/"为你精选..."这种功能性口吻

# 输出格式（严格 JSON，不要任何额外文字、不要 markdown 代码块包裹）
{
  "say": "一句开场白，不超过 40 字，像真人说话。",
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
