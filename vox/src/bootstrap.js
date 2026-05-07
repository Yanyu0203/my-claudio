/**
 * 画像冷启动：抽样歌单 → 调大脑 → 写 taste.md
 * --------------------------------------------------
 * 抽象成一个函数，让 CLI 脚本和 HTTP API 都能用。
 * 通过 onProgress 回调把阶段进度报出去（前端可以实时展示）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { callBrain, resolveBrainBin } from './brain.js';

/**
 * @param {object} args
 * @param {import('./music/index.js').MusicProvider} args.music
 * @param {string} args.dataDir     data/ 目录绝对路径
 * @param {Array<{playlistId, name, kind, n?}>} args.picks
 *        用户选的歌单，每个指明抽样方式：
 *          kind='all'    全量
 *          kind='random' 随机 n 首
 *          kind='front'  前 n 首
 *        playlistId 是统一字段；兼容老版 picks 里的 tid（自动 fallback）
 * @param {(evt: {stage:string, detail?:string, pct?:number}) => void} [args.onProgress]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{
 *   tastePath: string,
 *   bakPath: string | null,
 *   durationMs: number,
 *   sampleCount: number,
 *   uniqueCount: number,
 *   brainDurationMs: number,
 *   rawLength: number,
 * }>}
 */
export async function bootstrapTaste({ music, dataDir, picks, onProgress, timeoutMs = 8 * 60_000 }) {
  const progress = (stage, detail, pct) => {
    try { onProgress?.({ stage, detail, pct }); } catch {}
  };

  const t0 = Date.now();

  if (!Array.isArray(picks) || !picks.length) {
    throw new Error('picks 不能为空');
  }

  // ---- 1. 抽样 ----
  progress('sampling', `从 ${picks.length} 个歌单里抽歌...`, 0);
  const samples = [];
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const pid = p.playlistId || p.tid; // 兼容老版前端字段
    progress('sampling', `拉取：${p.name}`, Math.floor((i / picks.length) * 40));
    const detail = await music.getPlaylistSongs(pid);
    const total = detail.songs.length;
    const picked = sample(detail.songs, p);
    progress('sampling', `${p.name}: ${total} 首 → 采样 ${picked.length} 首 (${describeKind(p)})`);
    samples.push(...picked.map((s) => ({ ...s, from: p.name })));
  }
  const unique = dedupe(samples);
  progress('sampling', `合计 ${samples.length} → 去重 ${unique.length}`, 45);

  if (!unique.length) throw new Error('抽样结果为空，歌单可能都没有歌或接口异常');

  // ---- 2. 拼 prompt ----
  progress('prompting', `拼 prompt（${unique.length} 首）...`, 50);
  const prompt = buildPrompt(unique, picks);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, '.last-prompt.txt'), prompt, 'utf8');

  // ---- 3. 调大脑 ----
  progress('thinking', `调大脑 ${resolveBrainBin()}，这步最慢（60-180s）...`, 55);
  const tBrain = Date.now();
  let streamBuf = '';
  let streamedChars = 0;
  const raw = await callBrain(prompt, {
    timeoutMs,
    onStream: (s) => {
      streamBuf += s;
      streamedChars += s.length;
      // 每收到约 300 字推一次进度
      if (streamBuf.length > 300) {
        const pct = Math.min(90, 55 + Math.floor(streamedChars / 80));
        progress('thinking', `大脑已产出 ${streamedChars} 字...`, pct);
        streamBuf = '';
      }
    },
  });
  const brainDurationMs = Date.now() - tBrain;
  progress('thinking', `大脑回复完毕（${(brainDurationMs / 1000).toFixed(1)}s，${raw.length} 字）`, 92);

  // ---- 4. 写 taste.md（带时间戳备份）----
  progress('writing', '写入 data/taste.md...', 95);
  const cleaned = raw.trim().replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  const tastePath = path.join(dataDir, 'taste.md');

  let bakPath = null;
  try {
    await fs.access(tastePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    bakPath = `${tastePath}.${stamp}.bak`;
    await fs.copyFile(tastePath, bakPath);
  } catch {
    /* 原来没有就不备份 */
  }

  await fs.writeFile(tastePath, cleaned + '\n', 'utf8');

  const durationMs = Date.now() - t0;
  progress('done', `完成，耗时 ${(durationMs / 1000).toFixed(1)}s`, 100);

  return {
    tastePath,
    bakPath,
    durationMs,
    sampleCount: samples.length,
    uniqueCount: unique.length,
    brainDurationMs,
    rawLength: raw.length,
  };
}

// ============================================================
// 内部工具
// ============================================================

function sample(songs, strategy) {
  switch (strategy.kind) {
    case 'all':    return [...songs];
    case 'random': return pickRandom(songs, Math.max(1, Number(strategy.n) || 50));
    case 'front':  return songs.slice(0, Math.max(1, Number(strategy.n) || 50));
    default:       throw new Error(`unknown sampling kind: ${strategy.kind}`);
  }
}

function describeKind(s) {
  if (s.kind === 'all') return '全量';
  if (s.kind === 'random') return `随机 ${s.n}`;
  if (s.kind === 'front') return `前 ${s.n}`;
  return s.kind;
}

function pickRandom(arr, n) {
  if (arr.length <= n) return [...arr];
  const a = [...arr];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function dedupe(songs) {
  const seen = new Set();
  const out = [];
  for (const s of songs) {
    const key = `${s.title}|${s.artist}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function buildPrompt(samples, picks) {
  const songLines = samples
    .map((s, i) => `${i + 1}. ${s.title} — ${s.artist}${s.album ? ` 《${s.album}》` : ''} [来自:${s.from}]`)
    .join('\n');

  // 让大脑知道每个歌单的"角色"
  const playlistBrief = picks.map((p) => `- 「${p.name}」（${describeKind(p)}）`).join('\n');

  return `你是一位资深音乐策展人和心理观察者。下面是某位用户歌单里的代表曲目。

用户选择了以下歌单进行灌样：
${playlistBrief}

不同的歌单在用户心里通常承担不同角色（"最近在听的" vs "长期沉淀的" vs "特定场景用的"），请在分析时注意歌曲的 [来自:xxx] 标签——来自不同歌单的歌权重和含义可能不同。

请基于这些歌，深度分析 TA 的音乐口味，并产出一份 Markdown 格式的「我的音乐口味档案」。

# 输入歌曲
${songLines}

# 输出要求
直接输出 Markdown 文本，**不要**用 \`\`\`markdown 包裹，**不要**任何前缀解释。结构必须严格按下面的章节顺序：

# 我的音乐口味

## 风格关键词
列 6-10 个最能概括 TA 偏好的风格 / 流派关键词，每个一行，前面用 \`- \`。允许用中英文混合。

## 偏爱的歌手 Top 10
按 TA 听得多的程度排序，每行格式：\`数字. 歌手名 —— 一句话风格点评\`。

## 时段曲风建议
分早 / 午 / 晚 / 深夜 4 段，每段一行用 \`- 时段：风格描述\`，要从输入歌单中**真的能找到对应风格**才写。

## 应当避开
推断 TA 大概率不喜欢的元素，3-5 条，每条一行用 \`- \`。

---

## 听歌人格
用 200-300 字、第二人称（"你"）写一段 TA 的"听歌人格画像"，像 MBTI 描述那样有人味儿、有洞察、避免空话。

**重要：如果不同歌单的风格有明显对比，要点出来**——因为不同歌单反映 TA 的不同面向（最近心境 vs 长期口味 vs 特定场景），这种差异或一致往往最有洞察价值。

避免"喜欢安静也喜欢热闹"这种废话。要具体，要有颗粒度。

# 风格示范（不要照抄内容，只参考语气和颗粒度）
> 你是那种把耳机当成第二层皮肤的人。早上通勤时你不要太亮的电子，更愿意让一段柔的城市流行帮你和早晨慢慢握手...

现在开始输出。`;
}
