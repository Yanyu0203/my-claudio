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

import { callBrainJSON } from './brain.js';

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

  const prompt = `你是 Claudio，跑在用户本地的私人 AI 电台 DJ。
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
1. **回话要像聊天，不是机械回应**。可以有自己的看法，可以接梗，可以追问。语气克制、有温度，避免油腻和过度热情。
2. 用户可能：聊正在听的歌、聊心情、问问题、纯粹闲聊、表达偏好、或者要求换风格。**不同情况要不同回法**。
3. **不要轻易打断当前播放**。"想听点别的"≠"立刻换掉当前这首"。除非用户明确说"现在就换/立刻切掉/这首跳了"，否则 replace_now=false。

4. **关键：区分"现在就要"vs"以后这样"——这两件事在 should_regen 上有本质区别**：
   - **"以后多来点 X" / "我最近喜欢 Y" / "下次别给我放 Z"** → 这是**长期偏好**，不是当下要求。
     → 只把它写进 taste_delta，让它影响**未来**的歌单。**should_regen=false**。
     → 千万不要因为用户说"以后多来点 X"就立刻为下一段换风格——他没让你换，他在告诉你他的口味。
   - **"现在/接下来想听 X" / "下一段换 Y" / "给我来点 Z"** → 用户在表达**当下**的需求。
     → should_regen=true，给 regen_hint。
   - **纯聊天/闲聊/聊感受/问问题** → should_regen=false，正常回话。

5. 如果对话里有可记录的长期偏好（"我最近迷上 lo-fi" / "晚上别给我放重的" / "以后少给我放激烈的 Kpop"），抽成 taste_delta（≤30字）。
   **重要：taste_delta 和 should_regen 是独立的两件事**——可以只更新画像而不重排，也可以只重排而不更新画像，也可以两者都做。

# 输出（严格 JSON，不要任何额外文字、不要 markdown 包裹）
{
  "reply": "你给用户的回话，像聊天一样自然。可以是一两句也可以稍长。如果只更新了画像但没换歌，回话里要让用户感受到'我记下了，以后会照做'，而不是'我现在就给你换'。",
  "should_regen": false,
  "regen_hint": "如果 should_regen=true，一句话说明下一段往哪个方向调，例如'换成轻松的 city pop'。否则空字符串。",
  "replace_now": false,
  "taste_delta": "可记录的长期偏好，没有就空字符串。"
}

# 输出硬约束（违反会让程序崩）
- **字符串值内禁止使用半角双引号 "**。要引用别人说的话、歌词、心情台词，用中文引号 「」/『』 或单引号 '
- 所有字段都要给，即使没值也要空字符串/空 false
- 只输出 JSON，不要 markdown 围栏

只输出 JSON。`;

  const result = await callBrainJSON(prompt, { timeoutMs: 3 * 60_000 });

  // 防御性兜底
  return {
    reply: String(result.reply || '').trim() || '嗯。',
    should_regen: !!result.should_regen,
    regen_hint: String(result.regen_hint || '').trim(),
    replace_now: !!result.replace_now,
    taste_delta: String(result.taste_delta || '').trim(),
  };
}
