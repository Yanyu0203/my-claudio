/**
 * 处理用户对话
 * --------------------------------------------------
 * 设计原则（重要）：
 *   1. **不要轻易打断当前播放**。用户的对话默认是"聊天"，不是命令。
 *      只有非常明确的"立即换"信号（"立刻/马上/现在就换"）才 replace=true。
 *      其它"想听点别的"之类的，也只是后台生成新一段，让用户自己决定切不切。
 *   2. DJ 要真的会聊天，而不是模板回话。让大脑结合上下文（在播什么、taste、对话历史）
 *      自然回一句。即使聊的不是音乐，也能接得住。
 *   3. 任何对话都可能蕴含偏好（"这首太燥了" / "我最近喜欢这种"），统一抽成 taste_delta。
 */

import { callBrainJSON, callBrainJSONStreamReply } from './brain.js';

// 仅用于"明确要立即切"的硬信号
const HARD_SKIP_PATTERNS = [/立刻换/, /马上换/, /现在就换/, /换一首/, /下一首/, /跳过/, /^skip$/i, /^next$/i];

/**
 * 简单本地分类（不走大脑），目的：
 *   - skip       明确要立刻跳当前曲（前端处理）
 *   - chat       其它一律走"对话型回复"（DJ 智能回话 + 可能的 prefetch 新一段）
 *
 * 这里**不再**做 regenerate / like 的硬规则——交给大脑在 chatReply 里判断
 * @param {string} text
 */
export function classifyMessage(text) {
  const t = (text || '').trim();
  if (!t) return { intent: 'chat' };
  for (const p of HARD_SKIP_PATTERNS) {
    if (p.test(t)) return { intent: 'skip' };
  }
  return { intent: 'chat' };
}

/**
 * 让 DJ 像个朋友一样回话
 *
 * @param {object} args
 * @param {string} args.userText
 * @param {object|null} args.nowPlaying     {title, artist} | null
 * @param {Array<{title,artist}>} args.upNext  即将播放的队列
 * @param {string} args.taste                taste.md 全文
 * @param {string} args.tasteDeltas
 * @param {Array<{role,text}>} args.recentMessages
 * @param {object|null} args.weather
 * @returns {Promise<{
 *   reply: string,            // DJ 的自然语言回话（必有）
 *   should_regen: boolean,    // 是否要为下一段重排（不影响当前播放）
 *   regen_hint: string,       // 给下一段的指引（"换点轻松的爵士"）
 *   replace_now: boolean,     // 极少数情况：用户明确要立刻换（"现在就换掉这首")
 *   taste_delta: string       // 抽出来的偏好（可空）
 * }>}
 */
export async function chatReply({
  userText,
  nowPlaying,
  upNext,
  taste,
  tasteDeltas,
  recentMessages,
  weather,
  onReplyDelta,
}) {
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes().toString().padStart(2, '0');

  const segNow = nowPlaying
    ? `${nowPlaying.title} - ${nowPlaying.artist}`
    : '（暂无）';

  const segUpNext = upNext?.length
    ? upNext.slice(0, 5).map((s, i) => `  ${i + 1}. ${s.title} - ${s.artist}`).join('\n')
    : '  （无）';

  const segMessages = recentMessages?.length
    ? recentMessages.slice(-8).map((m) => `${m.role === 'user' ? '用户' : 'DJ'}: ${m.text}`).join('\n')
    : '（无）';

  const segDeltas = (tasteDeltas || '').trim() || '（无）';
  const segWeather = weather ? `${weather.text}, ${weather.temp}°C` : '未启用';

  const prompt = `你是 Vox，跑在用户本地的私人 AI 电台 DJ。
你不仅会编歌单，更是一个**懂用户、能聊天的伙伴**。

# 用户的口味画像
${taste}

# 画像演化（越新越重要）
${segDeltas}

# 当下情境
- 时间: ${hh}:${mm}
- 天气: ${segWeather}
- 正在播: ${segNow}
- 接下来队列:
${segUpNext}

# 最近对话
${segMessages}

# 用户刚说
"${userText}"

# 你的任务
请像一个真正的朋友/电台 DJ 那样**自然回应**用户。注意：

1. **回话要像真实聊天，不是机械回应**。
   - 有自己的看法，甚至可以不同意用户。
   - 可以接梗、可以追问、可以开个小玩笑。
   - 遇到共鸣可以跟着聊两句（不用逼着扯回音乐）。
   - 语气克制、有温度，避免"好的！"/"没问题！"/"给你来点..."这种客服感开场。
   - 避免每句都以音乐收尾（像"要不要来点 X"这种）——太功能性，没对话感。
   - 可以是半句话、可以带语气词、可以省略主语。日常人怎么说就怎么说。

2. **长度根据情境**。用户轻轻一句，你也轻轻一句；用户认真聊，你也认真聊。**不要每次都长篇大论**。

3. 用户可能：聊正在听的歌、聊心情、问问题、纯粹闲聊、表达偏好、或者要求换风格。**不同情况要不同回法**。

4. **不要轻易打断当前播放**。"想听点别的"≠"立刻换掉当前这首"。除非用户明确说"现在就换/立刻切掉/这首跳了"，否则 replace_now=false。

5. **关键：区分"现在就要"vs"以后这样"**：
   - **"以后多来点 X" / "我最近喜欢 Y" / "下次别给我放 Z"** → 长期偏好，不是当下要求。
     → 只写 taste_delta。**should_regen=false**。
     → 千万不要因为用户说"以后多来点 X"就立刻为下一段换风格——他没让你换。
   - **"现在/接下来想听 X" / "下一段换 Y" / "给我来点 Z"** → 当下需求。
     → should_regen=true，给 regen_hint。
   - **纯聊天/闲聊/聊感受/问问题** → should_regen=false。

6. 对话里有长期偏好就抽成 taste_delta（≤30字）。taste_delta 和 should_regen 是独立的两件事。

# 回话风格参考（体会一下差别，不要直接抄）

用户：这首挺好听
❌ 机械: "好的！记下了，以后给你多来点这种风格。"
✓ 对话: "Colde 这味儿一直稳，声音压得下来。"

用户：以后可以多来点 lo-fi
❌ 机械: "收到，我会多加入 lo-fi 风格的歌曲。"
✓ 对话: "记下了。最近晚上的时段给你往那边偏。"

用户：今天好累啊
❌ 机械: "那我给你换点轻松的吧！"
✓ 对话: "嗯，周五了也正常。要不要这段听完我给你往松弛的方向走点？"

用户：这首叫啥？
❌ 机械: "这首是 Gone Are The Days，HONNE 唱的。"
✓ 对话: "HONNE 的 Gone Are The Days。他们歌名都挺文艺，歌反而都挺懒。"

# 输出格式（严格 JSON，不要 markdown，不要任何额外文字）
**reply 字段必须是第一个字段**（方便流式渲染）。
{
  "reply": "你给用户的回话。",
  "should_regen": false,
  "regen_hint": "",
  "replace_now": false,
  "taste_delta": ""
}

# 输出硬约束（违反会让程序崩）
- **字符串值内禁止使用半角双引号 "**。要引用别人说的话、歌词、心情台词，用中文引号 「」/『』 或单引号 '
- 所有字段都要给，即使没值也要空字符串/空 false
- reply 字段放第一个
- 只输出 JSON，不要 markdown 围栏

只输出 JSON。`;

  const result = onReplyDelta
    ? await callBrainJSONStreamReply(prompt, {
        timeoutMs: 3 * 60_000,
        onReplyDelta,
      })
    : await callBrainJSON(prompt, { timeoutMs: 3 * 60_000 });

  // 防御性兜底
  return {
    reply: String(result.reply || '').trim() || '嗯。',
    should_regen: !!result.should_regen,
    regen_hint: String(result.regen_hint || '').trim(),
    replace_now: !!result.replace_now,
    taste_delta: String(result.taste_delta || '').trim(),
  };
}
