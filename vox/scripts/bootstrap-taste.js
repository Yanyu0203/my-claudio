/**
 * 冷启动：把你的歌单灌进大脑，让它写一份 taste.md
 *
 * 用法:
 *   npm run bootstrap:taste
 *
 * 流程:
 *   1. 拉「这段爱听」+「好歌」两个歌单的全量歌
 *   2. 每个歌单：前 60 + 剩余里随机 60 → 合并去重
 *   3. 拼 prompt 喂给 CodeBuddy CLI
 *   4. 写 data/taste.md
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQQMusic } from '../src/qqmusic.js';
import { callBrain, resolveBrainBin } from '../src/brain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// 想灌给大脑的歌单名（按这个名字匹配你的歌单）
const TARGET_PLAYLIST_NAMES = ['这段爱听', '好歌'];

const SAMPLE_FRONT = 60; // 每歌单取前 N 首
const SAMPLE_RAND = 60;  // 每歌单从剩余里随机 N 首

// ---------- 工具 ----------
const log = (m) => console.log(m);
const ok = (m) => console.log('  ✅ ' + m);
const info = (m) => console.log('  · ' + m);

function pickRandom(arr, n) {
  if (arr.length <= n) return [...arr];
  // Fisher-Yates 部分洗牌
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

// ---------- 拼 prompt ----------
function buildPrompt(samples) {
  const songLines = samples
    .map((s, i) => `${i + 1}. ${s.title} — ${s.artist}${s.album ? ` 《${s.album}》` : ''} [来自:${s.from}]`)
    .join('\n');

  return `你是一位资深音乐策展人和心理观察者。下面是某位用户歌单里挑出的代表曲目（来自 TA 自己创建的两个歌单：「这段爱听」和「好歌」）。

请基于这些歌，深度分析 TA 的音乐口味，并产出一份 Markdown 格式的「我的音乐口味档案」。

【输入歌曲】
${songLines}

【输出要求】
直接输出 Markdown 文本，**不要**用 \`\`\`markdown 包裹，**不要**任何前缀解释。结构必须严格按下面的章节顺序：

# 我的音乐口味

## 风格关键词
列 6-10 个最能概括 TA 偏好的风格 / 流派关键词，每个一行，前面用 \`- \`。允许用中英文混合，如「city pop」「华语女声民谣」「东亚轻爵士」。

## 偏爱的歌手 Top 10
按 TA 听得多的程度排序，每行格式：\`数字. 歌手名 —— 一句话风格点评\`。

## 时段曲风建议
分早 / 午 / 晚 / 深夜 4 段，每段一行用 \`- 时段：风格描述\`，要从输入歌单中**真的能找到对应风格**才写。

## 应当避开
推断 TA 大概率不喜欢的元素（说唱密度、重电子、口水神曲…），3-5 条，每条一行用 \`- \`。

---

## 听歌人格
最后一段：用 200-300 字、第二人称（"你"）写一段 TA 的"听歌人格画像"，像 MBTI 描述那样有人味儿、有洞察、避免空话。可以涉及：TA 大概是什么样的人、什么场景下会打开音乐、用音乐在调节什么情绪。要具体、避免"喜欢安静也喜欢热闹"这种废话。

【风格示范（不要照抄内容，只参考语气和颗粒度）】
> 你是那种把耳机当成第二层皮肤的人。早上通勤时你不要太亮的电子，更愿意让一段柔的城市流行帮你和早晨慢慢握手；写代码时你切去无人声的爵士钢琴，让节奏退到背景里、只留下温度…

现在开始输出。`;
}

// ---------- 主流程 ----------
async function main() {
  const qq = createQQMusic({
    apiBase: process.env.QQMUSIC_API_URL,
    uin: process.env.QQ_UIN,
  });

  log('\n[1/4] 拉你的歌单列表...');
  const all = await qq.getMyPlaylists();
  ok(`共 ${all.length} 个歌单`);

  const targets = all.filter((p) => TARGET_PLAYLIST_NAMES.includes(p.name));
  if (!targets.length) {
    throw new Error(
      `在你的歌单里找不到这些目标：${TARGET_PLAYLIST_NAMES.join('、')}。\n现有歌单：${all.map((p) => p.name).join('、')}`
    );
  }
  targets.forEach((p) => info(`命中：${p.name} (${p.songCount} 首) tid=${p.tid}`));

  log('\n[2/4] 抽样歌曲...');
  const samples = [];
  for (const p of targets) {
    const detail = await qq.getPlaylistSongs(p.tid);
    const total = detail.songs.length;
    const front = detail.songs.slice(0, SAMPLE_FRONT);
    const rest = detail.songs.slice(SAMPLE_FRONT);
    const rand = pickRandom(rest, SAMPLE_RAND);
    const merged = [...front, ...rand].map((s) => ({ ...s, from: p.name }));
    info(`${p.name}: 全量 ${total}, 抽样 ${merged.length}`);
    samples.push(...merged);
  }
  const unique = dedupe(samples);
  ok(`合计 ${samples.length} 首，去重后 ${unique.length} 首`);

  log('\n[3/4] 调大脑（可能要 30-90 秒）...');
  info(`大脑可执行文件: ${resolveBrainBin()}`);
  const prompt = buildPrompt(unique);

  // 把 prompt 也存一份方便排查
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, '.last-prompt.txt'), prompt, 'utf8');
  info(`prompt 长度 ${prompt.length} 字（已存到 data/.last-prompt.txt 备查）`);

  let stdoutBuf = '';
  const t0 = Date.now();
  const raw = await callBrain(prompt, {
    timeoutMs: 5 * 60_000,
    onStream: (s) => {
      stdoutBuf += s;
      // 每收到 200 字打一个进度点
      if (stdoutBuf.length > 200) {
        process.stdout.write('.');
        stdoutBuf = '';
      }
    },
  });
  console.log('');
  ok(`大脑回复完毕，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，长度 ${raw.length} 字`);

  log('\n[4/4] 写 data/taste.md ...');
  const cleaned = raw.trim().replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  const tastePath = path.join(DATA_DIR, 'taste.md');

  // 如果已存在，备份
  try {
    await fs.access(tastePath);
    await fs.copyFile(tastePath, tastePath + '.bak');
    info('已备份原 taste.md → taste.md.bak');
  } catch {
    /* 没有就算了 */
  }

  await fs.writeFile(tastePath, cleaned + '\n', 'utf8');
  ok(`已写入 ${tastePath}`);

  console.log('\n— 完成 —\n打开看看：' + tastePath + '\n');
}

main().catch((e) => {
  console.error('\n❌ 异常:', e.message);
  process.exit(1);
});
