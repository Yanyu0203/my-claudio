/**
 * 大脑桥接（编排层）
 * --------------------------------------------------
 * 把 context 拼好的 prompt 喂给 codebuddy，拿回结构化结果
 */
import { buildPrompt } from './context.js';
import { callBrainJSON } from './brain.js';

/**
 * @param {object} args  传给 buildPrompt 的所有参数
 * @returns {Promise<{say:string, play:Array<{title,artist,reason}>, taste_delta?:string}>}
 */
export async function planNextBlock(args) {
  const prompt = buildPrompt(args);

  // 留一份现场 prompt 备查
  if (process.env.CLAUDIO_DEBUG === '1') {
    const fs = await import('node:fs/promises');
    await fs.writeFile('data/.last-block-prompt.txt', prompt, 'utf8');
  }

  let result;
  try {
    result = await callBrainJSON(prompt, { timeoutMs: 5 * 60_000 });
  } catch (e) {
    throw new Error('大脑调用失败: ' + e.message);
  }

  // 校验结构
  if (!result || typeof result !== 'object') {
    throw new Error('大脑返回不是对象');
  }
  if (!result.say || typeof result.say !== 'string') result.say = '';
  if (!Array.isArray(result.play)) {
    throw new Error('大脑返回缺 play 数组');
  }
  result.play = result.play
    .filter((s) => s && s.title && s.artist)
    .map((s) => ({
      title: String(s.title).trim(),
      artist: String(s.artist).trim(),
      reason: String(s.reason || '').trim(),
    }));
  if (!result.play.length) {
    throw new Error('大脑返回的歌单为空');
  }
  if (typeof result.taste_delta !== 'string') {
    result.taste_delta = '';
  }
  return result;
}
