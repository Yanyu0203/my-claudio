/**
 * 画像冷启动 CLI（备用方案；主流程请在网页上做）
 *
 * 用法:
 *   npm run bootstrap:taste
 *
 * 行为:
 *   - 自动拉你的自建歌单
 *   - 如果找到「这段爱听」和「好歌」，按默认策略（全量 + 随机 100）灌
 *   - 否则列出所有歌单，让你下次用网页 UI 走一遍
 *
 * 想要完全可控的交互（勾选哪些歌单、每个怎么抽）→ 打开 http://localhost:8080，
 * 点顶部 ✦ RESET TASTE 按钮；没有 taste.md 时网页会自动弹窗引导。
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../src/music/index.js';
import { bootstrapTaste } from '../src/bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DATA_DIR = process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR
  ? path.resolve(process.env.VOX_DATA_DIR || process.env.CLAUDIO_DATA_DIR)
  : path.resolve(projectRoot, '..', 'data');

// CLI 默认策略（仅在这两个歌单名都存在时生效）
const DEFAULT_STRATEGY = {
  '这段爱听': { kind: 'all' },
  '好歌':     { kind: 'random', n: 100 },
};

async function main() {
  const music = createProvider(process.env.MUSIC_PROVIDER || 'qq', {
    apiBase: process.env.QQMUSIC_API_URL,
    userId: process.env.QQ_UIN,
  });

  console.log('\n[1/2] 拉你的歌单列表...');
  const all = await music.getMyPlaylists();
  console.log(`  ✅ 共 ${all.length} 个歌单`);

  const picks = [];
  for (const [name, strategy] of Object.entries(DEFAULT_STRATEGY)) {
    const found = all.find((p) => p.name === name);
    if (found) {
      picks.push({ playlistId: found.playlistId, name: found.name, ...strategy });
    }
  }

  if (picks.length !== Object.keys(DEFAULT_STRATEGY).length) {
    console.log('');
    console.log('⚠️  没找齐 CLI 默认需要的两个歌单（「这段爱听」+「好歌」）');
    console.log('   你的歌单列表：');
    all.forEach((p) => console.log(`     - ${p.name} (${p.songCount} 首)`));
    console.log('');
    console.log('💡 CLI 只能按预设名字工作。要自选歌单 + 自定义抽样策略，请：');
    console.log('   1. 启动 Vox：./start.sh');
    console.log('   2. 打开 http://localhost:8080');
    console.log('   3. 首次启动（没有 taste.md）会自动弹出设置向导；');
    console.log('      已有 taste.md 时点顶部的 ✦ RESET TASTE 按钮。');
    process.exit(1);
  }

  console.log('  · 命中：');
  picks.forEach((p) => console.log(`    - ${p.name} → ${JSON.stringify({ kind: p.kind, n: p.n })}`));

  console.log('\n[2/2] 开始抽样 + 调大脑 + 写 taste.md...');
  const result = await bootstrapTaste({
    music,
    dataDir: DATA_DIR,
    picks,
    onProgress: (e) => {
      if (e.stage === 'thinking' && e.detail?.startsWith('大脑已产出')) {
        process.stdout.write('.');
      } else {
        console.log(`  · [${e.stage}] ${e.detail || ''}`);
      }
    },
  });
  console.log('');
  console.log(`  ✅ 完成，耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  ✅ 已写入 ${result.tastePath}`);
  if (result.bakPath) console.log(`  · 原文件已备份 → ${path.basename(result.bakPath)}`);
  console.log('');
}

main().catch((e) => {
  console.error('\n❌ 异常:', e.message);
  process.exit(1);
});
