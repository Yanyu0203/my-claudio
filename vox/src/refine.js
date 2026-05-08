/**
 * 画像压实 (refine taste)
 * --------------------------------------------------
 * 把 taste-deltas.md 里的新信号 + play_history 的新反馈，合并进 taste.md。
 *
 * 游标机制（存在 kv_state）：
 *   refine:last_delta_offset  taste-deltas.md 上次读到的字节偏移
 *   refine:last_play_id       play_history 上次看过的最大 id
 *   refine:threshold          触发阈值（新增 delta 行数），默认 30
 *   refine:last_run_at        上次压实时间（ISO 字符串）
 *
 * 流程：
 *   1. 按游标读 deltas 的增量段 + play_history 的增量（带 rating/played）
 *   2. 拼 prompt 把 taste.md（基准）+ 增量信号 丢给大脑
 *   3. 大脑改写 taste.md + 产出一条 CHANGELOG（"本次合并了 X，新增观察：..."）
 *   4. 写入 taste.md（带 .bak 备份）
 *   5. 归档处理过的 deltas 段到 data/taste-deltas/archive-YYYY-MM.md
 *   6. 更新游标
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { kvGet, kvSet, getDB } from './db.js';
import { callBrain, resolveBrainBin } from './brain.js';

export const DEFAULT_THRESHOLD = 30;
const MIN_THRESHOLD = 5;
const MAX_THRESHOLD = 500;

// ---------- 游标 / 阈值 读写 ----------

export function getRefineThreshold() {
  const v = Number(kvGet('refine:threshold'));
  if (!Number.isFinite(v) || v < MIN_THRESHOLD) return DEFAULT_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.floor(v));
}

export function setRefineThreshold(n) {
  const v = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Math.floor(Number(n) || 0)));
  kvSet('refine:threshold', v);
  return v;
}

export function getLastDeltaOffset() {
  const v = Number(kvGet('refine:last_delta_offset'));
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

export function getLastPlayId() {
  const v = Number(kvGet('refine:last_play_id'));
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

export function getLastRunAt() {
  return kvGet('refine:last_run_at') || null;
}

// ---------- 统计增量（用于判断是否该触发） ----------

/**
 * 统计游标之后新增了多少条 delta 记录（按 `\n## ` 开头的 block 数算）
 * 和多少条 play_history 新增（id > last_play_id）
 */
export async function countPendingSignals(dataDir) {
  const deltaPath = path.join(dataDir, 'taste-deltas.md');
  const lastOffset = getLastDeltaOffset();

  let newDeltaText = '';
  try {
    const buf = await fs.readFile(deltaPath);
    // offset 越界（文件被手动清理过）→ 从头重算
    const actualOffset = lastOffset <= buf.length ? lastOffset : 0;
    newDeltaText = buf.slice(actualOffset).toString('utf8');
  } catch {
    // 文件不存在 → 0
  }
  const newDeltaCount = (newDeltaText.match(/\n## /g) || []).length;

  const lastPlayId = getLastPlayId();
  const row = getDB()
    .prepare('SELECT COUNT(*) AS n FROM play_history WHERE id > ?')
    .get(lastPlayId);
  const newPlayCount = row?.n || 0;

  return {
    newDeltaCount,
    newPlayCount,
    threshold: getRefineThreshold(),
    lastRunAt: getLastRunAt(),
  };
}

/** 是否应该触发（deltas 增量 ≥ 阈值） */
export async function shouldAutoTrigger(dataDir) {
  const s = await countPendingSignals(dataDir);
  return s.newDeltaCount >= s.threshold;
}

// ---------- 核心：压实 ----------

/**
 * 执行压实
 * @param {object} args
 * @param {string} args.dataDir           data/ 目录
 * @param {(evt:{stage:string,detail?:string,pct?:number})=>void} [args.onProgress]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,       // 没增量可压实
 *   changelog?: string,
 *   tastePath?: string,
 *   bakPath?: string|null,
 *   archivePath?: string|null,
 *   consumedDeltaCount?: number,
 *   consumedPlayCount?: number,
 *   durationMs?: number,
 *   rawLength?: number,
 * }>}
 */
export async function refineTaste({ dataDir, onProgress, timeoutMs = 8 * 60_000 }) {
  const progress = (stage, detail, pct) => {
    try { onProgress?.({ stage, detail, pct }); } catch {}
  };

  const t0 = Date.now();
  const tastePath = path.join(dataDir, 'taste.md');
  const deltaPath = path.join(dataDir, 'taste-deltas.md');

  // ---- 1. 读基准 taste.md ----
  progress('reading', '读取当前画像和增量信号...', 2);
  let baseTaste = '';
  try {
    baseTaste = await fs.readFile(tastePath, 'utf8');
  } catch {
    throw new Error('taste.md 还不存在，请先做画像冷启动（点顶部 ♻ RESET TASTE）');
  }
  if (!baseTaste.trim()) {
    throw new Error('taste.md 为空，请先做画像冷启动');
  }

  // ---- 2. 读 deltas 增量段 ----
  const lastOffset = getLastDeltaOffset();
  let newDeltaBuf = Buffer.alloc(0);
  let deltaFileSize = 0;
  try {
    const buf = await fs.readFile(deltaPath);
    deltaFileSize = buf.length;
    const actualOffset = lastOffset <= buf.length ? lastOffset : 0;
    newDeltaBuf = buf.slice(actualOffset);
  } catch {
    // deltas 文件还不存在 → 零增量
  }
  const newDeltaText = newDeltaBuf.toString('utf8').trim();
  const newDeltaCount = (newDeltaText.match(/\n## |^## /g) || []).length;

  // ---- 3. 读 play_history 增量 ----
  const lastPlayId = getLastPlayId();
  const playRows = getDB()
    .prepare(
      'SELECT id, ts, title, artist, played, reason, rating FROM play_history ' +
      'WHERE id > ? ORDER BY id ASC'
    )
    .all(lastPlayId);
  const newPlayCount = playRows.length;
  const maxPlayId = playRows.length ? playRows[playRows.length - 1].id : lastPlayId;

  progress('reading', `增量：${newDeltaCount} 条 delta + ${newPlayCount} 条播放记录`, 8);

  // 彻底没增量 → 直接跳过
  if (!newDeltaText && !newPlayCount) {
    progress('done', '没有新增量，无需压实', 100);
    return {
      ok: true,
      skipped: true,
      consumedDeltaCount: 0,
      consumedPlayCount: 0,
      durationMs: Date.now() - t0,
    };
  }

  // ---- 4. 拼 prompt ----
  progress('prompting', '组织上下文...', 12);
  const prompt = buildRefinePrompt({
    baseTaste,
    newDeltaText,
    playRows,
    newDeltaCount,
    newPlayCount,
  });
  await fs.writeFile(path.join(dataDir, '.last-refine-prompt.txt'), prompt, 'utf8');

  // ---- 5. 调大脑 ----
  progress('thinking', `调大脑 ${resolveBrainBin()}...`, 15);
  const tBrain = Date.now();
  let streamedChars = 0;
  let streamBuf = '';
  const raw = await callBrain(prompt, {
    timeoutMs,
    onStream: (s) => {
      streamedChars += s.length;
      streamBuf += s;
      if (streamBuf.length > 300) {
        const pct = Math.min(88, 15 + Math.floor(streamedChars / 60));
        progress('thinking', `大脑已产出 ${streamedChars} 字...`, pct);
        streamBuf = '';
      }
    },
  });
  const brainMs = Date.now() - tBrain;
  progress('thinking', `大脑完毕（${(brainMs / 1000).toFixed(1)}s, ${raw.length} 字）`, 90);

  // ---- 6. 解析：分离 CHANGELOG 与 taste.md 主体 ----
  const { changelog, newTaste } = parseRefineOutput(raw);
  if (!newTaste || newTaste.length < 100) {
    throw new Error('大脑返回的画像内容过短，放弃写入（防止搞坏 taste.md）');
  }

  // ---- 7. 写 taste.md（带 .bak）----
  progress('writing', '写入新画像...', 93);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bakPath = `${tastePath}.${stamp}.bak`;
  await fs.copyFile(tastePath, bakPath);
  await fs.writeFile(tastePath, newTaste + '\n', 'utf8');

  // ---- 8. 归档已处理的 deltas 段 ----
  let archivePath = null;
  if (newDeltaText) {
    progress('writing', '归档已处理的 deltas...', 96);
    const archiveDir = path.join(dataDir, 'taste-deltas');
    await fs.mkdir(archiveDir, { recursive: true });
    const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
    archivePath = path.join(archiveDir, `archive-${ym}.md`);
    const header =
      `\n<!-- merged at ${new Date().toISOString()} -->\n` +
      `<!-- ${newDeltaCount} deltas, ${newPlayCount} plays -->\n`;
    await fs.appendFile(archivePath, header + newDeltaText + '\n', 'utf8');
  }

  // ---- 9. 更新游标 ----
  // delta offset: 指向本次读到的末尾（= 归档时的 deltaFileSize）
  // 归档之后主文件内容不动，下次如果还在追加，offset 之后就是纯增量
  if (deltaFileSize > 0) {
    kvSet('refine:last_delta_offset', deltaFileSize);
  }
  kvSet('refine:last_play_id', maxPlayId);
  kvSet('refine:last_run_at', new Date().toISOString());

  const durationMs = Date.now() - t0;
  progress('done', `完成，耗时 ${(durationMs / 1000).toFixed(1)}s`, 100);

  return {
    ok: true,
    changelog: changelog || '（本次无 CHANGELOG）',
    tastePath,
    bakPath,
    archivePath,
    consumedDeltaCount: newDeltaCount,
    consumedPlayCount: newPlayCount,
    durationMs,
    rawLength: raw.length,
  };
}

// ---------- prompt 构造 ----------

function buildRefinePrompt({ baseTaste, newDeltaText, playRows, newDeltaCount, newPlayCount }) {
  // 把 play_history 折成"喜欢/不喜欢/听完/跳过"的信号块（控制 prompt 体积）
  const likes = playRows.filter((r) => r.rating === 'like').map((r) => `${r.title} - ${r.artist}`);
  const dislikes = playRows.filter((r) => r.rating === 'dislike').map((r) => `${r.title} - ${r.artist}`);
  const skipped = playRows.filter((r) => !r.played && !r.rating).map((r) => `${r.title} - ${r.artist}`);
  const played = playRows.filter((r) => r.played && !r.rating).map((r) => `${r.title} - ${r.artist}`);

  // 去重（同一首歌可能因 rating + played 出现多条）
  const uniq = (arr) => [...new Set(arr)];
  const likeList = uniq(likes);
  const dislikeList = uniq(dislikes);
  // 听完/跳过太多，只展示出现频次 top 若干；简单用出现次数排
  const count = (arr) => {
    const m = new Map();
    for (const s of arr) m.set(s, (m.get(s) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const playedTop = count(played).slice(0, 30).map(([s, n]) => `${s} ×${n}`);
  const skippedTop = count(skipped).slice(0, 30).map(([s, n]) => `${s} ×${n}`);

  const playSummary =
    (likeList.length ? `\n【♥ 明确喜欢】\n- ${likeList.join('\n- ')}\n` : '') +
    (dislikeList.length ? `\n【✕ 明确不喜欢】\n- ${dislikeList.join('\n- ')}\n` : '') +
    (playedTop.length ? `\n【✓ 听完过的 (top 30)】\n- ${playedTop.join('\n- ')}\n` : '') +
    (skippedTop.length ? `\n【✗ 被跳过的 (top 30)】\n- ${skippedTop.join('\n- ')}\n` : '');

  return `你是这位用户的长期音乐策展人。你之前已经给 TA 写过一份「音乐口味档案」（taste.md），现在要根据 TA 最近的使用反馈，**压实更新**这份档案。

# 任务
把"新增信号"融入"基准画像"，产出一份**更新后的 taste.md**。要求：
1. **保留结构**：章节顺序、格式与基准版一致（风格关键词 / 偏爱歌手 Top 10 / 时段曲风建议 / 应当避开 / 听歌人格）。
2. **合并冲突信号**：如果新增信号与旧画像矛盾（例："避开老港式情歌"出现多次 → 老画像里"粤语流行"该补充限定条件），就改写；一致的就保留。
3. **歌手 Top 10 可以变动**：如果某些新歌手反复出现在【♥ 喜欢】或【✓ 听完】且在老 Top 10 里没有，可以替换/加入。被多次【✕ 不喜欢】/【✗ 跳过】的，从推荐倾向里淡化。
4. **时段偏好要吸收**：新增信号里如果多次提到"下午喜欢律动""晚上要舒缓"，这种时段指引要写进去。
5. **「应当避开」要精确化**：不要空泛，把具体点出来的不爱听的风格/歌手加进去。
6. **「听歌人格」是长叙述**：不要整段重写，要**润色而非推翻**——只在信号明显指向新面向时微调措辞。
7. **不要追加章节或改变章节名**。不要写总结段。

# 基准画像（现有 taste.md 全文）
\`\`\`
${baseTaste}
\`\`\`

# 新增信号（自上次压实到现在）

## taste-deltas.md 新增的 ${newDeltaCount} 条记录
${newDeltaText || '（无）'}

## play_history 新增 ${newPlayCount} 条
${playSummary || '（无）'}

# 输出格式（严格遵守）

先输出一段 CHANGELOG，然后是分隔符，然后是**完整的**新 taste.md。格式：

<<<CHANGELOG>>>
- 一行话说明本次主要合并了什么信号（≤40字）
- 具体变更 1（例："Top 10 歌手里把 X 换成 Y，因为..."）
- 具体变更 2
- ...最多列 5 条
<<<END_CHANGELOG>>>

<<<TASTE_MD>>>
# 我的音乐口味

（完整的新版 taste.md，结构与基准一致）
<<<END_TASTE_MD>>>

# 硬约束
- 两段都要有围栏标记，格式严格匹配 \`<<<CHANGELOG>>>\` / \`<<<END_CHANGELOG>>>\` / \`<<<TASTE_MD>>>\` / \`<<<END_TASTE_MD>>>\`
- TASTE_MD 段必须包含完整的 5 个章节，长度不能比基准画像短超过 30%
- 不要输出任何围栏外的解释文字
- 不要用 markdown 代码块 \`\`\` 包裹整个输出

现在开始输出。`;
}

function parseRefineOutput(raw) {
  const clog = /<<<CHANGELOG>>>([\s\S]*?)<<<END_CHANGELOG>>>/.exec(raw);
  const taste = /<<<TASTE_MD>>>([\s\S]*?)<<<END_TASTE_MD>>>/.exec(raw);
  return {
    changelog: clog ? clog[1].trim() : '',
    newTaste: taste ? taste[1].trim() : '',
  };
}
