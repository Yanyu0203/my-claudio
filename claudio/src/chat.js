/**
 * 处理用户对话
 * --------------------------------------------------
 * 简化策略（不调大脑也能跑）：
 *   - 关键词意图判断：换歌 / 跳过 / 喜欢 / 一般聊天
 *   - 任何用户消息都会写入 messages，让下次 planNextBlock 时大脑能感知到
 *   - 强意图（换风格、不想听XX）会立即触发 regenerate
 */

const SKIP_PATTERNS = [/换一首/, /下一首/, /跳过/, /skip/i, /next/i];
const REGEN_PATTERNS = [
  /换.*风格/, /换.*类型/, /换一段/, /重选/, /重新/,
  /想听/, /给.*来点/, /换.*的/,
  /不要.*再/, /别.*放/, /讨厌/, /腻了/,
];
const LIKE_PATTERNS = [/喜欢这首/, /这首不错/, /这首牛/, /loop/i, /单曲循环/];

/**
 * @param {string} text 用户输入
 * @returns {{intent:'skip'|'regenerate'|'like'|'chat', regenerateHint?:string, isFeedback:boolean}}
 */
export function classifyMessage(text) {
  const t = (text || '').trim();
  if (!t) return { intent: 'chat', isFeedback: false };

  for (const p of SKIP_PATTERNS) {
    if (p.test(t)) return { intent: 'skip', isFeedback: false };
  }
  for (const p of LIKE_PATTERNS) {
    if (p.test(t)) return { intent: 'like', isFeedback: true };
  }
  for (const p of REGEN_PATTERNS) {
    if (p.test(t)) {
      return { intent: 'regenerate', regenerateHint: t, isFeedback: true };
    }
  }
  return { intent: 'chat', isFeedback: false };
}

/**
 * 给一条用户消息一句简短的本地回应（不调大脑，零延迟）
 * 真正"换歌"由调用方根据 intent 处理
 */
export function quickReply(text, intent) {
  switch (intent) {
    case 'skip':
      return '好，下一首。';
    case 'like':
      return '记下了，这种风格的多给你来点。';
    case 'regenerate':
      return '收到，下一段就调。';
    case 'chat':
    default:
      // 太多花式回复反而尴尬，DJ 风格保持克制
      return null; // null 表示这条不需要快回，下一次 block 的 say 会自然带过去
  }
}
