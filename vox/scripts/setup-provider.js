/**
 * 交互式选择音乐源（写到 vox/.env 的 MUSIC_PROVIDER）
 *
 * 用法:
 *   npm run setup:provider
 *
 * 也会在首次启动（.env 里没 MUSIC_PROVIDER 这一行）时被 start.sh / start.ps1 自动调用
 *
 * 注意：我们只把用户选过的结果写进 .env，不重复打扰。
 *       想重新选 → 编辑 .env 删掉 MUSIC_PROVIDER=... 那行，下次启动就会再弹。
 */
import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { upsertEnv } from './_lib/env-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const ENV_PATH = path.join(projectRoot, '.env');

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

/**
 * 交互式问并写入 MUSIC_PROVIDER
 * @returns {Promise<'qq' | 'netease' | null>} 写入的值，跳过返回 null
 */
export async function promptAndWriteMusicProvider() {
  if (!process.stdin.isTTY) {
    console.log('');
    console.log(`${c.yellow}⚠ MUSIC_PROVIDER 未配置，且当前不在交互式终端，无法弹问。${c.reset}`);
    console.log(`${c.dim}  请手动跑：${c.bold}npm run setup:provider${c.reset}`);
    console.log(`${c.dim}  或编辑 vox/.env，加一行：MUSIC_PROVIDER=qq  或  MUSIC_PROVIDER=netease${c.reset}`);
    return null;
  }

  console.log('');
  console.log(`${c.bold}${c.cyan}═══ 选择音乐源 ═══${c.reset}`);
  console.log(`${c.dim}  Vox 可以从 QQ 音乐或网易云音乐拉歌单、搜歌、放歌，二选一。${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}1) QQ 音乐${c.reset}`);
  console.log(`     ${c.dim}· 需要本地起 QQMusicApi 服务（start.sh 会自动起）${c.reset}`);
  console.log(`     ${c.dim}· 要知道你的 QQ 号，首次用需要手动从浏览器复制 cookie${c.reset}`);
  console.log(`     ${c.dim}· 适合：QQ 音乐里已有大量歌单${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}2) 网易云音乐${c.reset} ${c.green}(推荐)${c.reset}`);
  console.log(`     ${c.dim}· 不用额外服务${c.reset}`);
  console.log(`     ${c.dim}· ${c.bold}扫码登录${c.reset}${c.dim}（手机 App 扫一下就好，30 秒）${c.reset}`);
  console.log(`     ${c.dim}· 适合：网易云里歌单更多 / 想省心${c.reset}`);
  console.log('');

  const rl = readline.createInterface({ input, output });
  let choice = '';
  while (true) {
    const ans = (await rl.question('请选择 [1/2] (回车 = 2 网易云): ')).trim().toLowerCase();
    if (ans === '' || ans === '2' || ans === 'netease' || ans === 'n') {
      choice = 'netease';
      break;
    }
    if (ans === '1' || ans === 'qq' || ans === 'q') {
      choice = 'qq';
      break;
    }
    console.log(`${c.red}  请输入 1 或 2${c.reset}`);
  }
  rl.close();

  await upsertEnv(ENV_PATH, { MUSIC_PROVIDER: choice });
  process.env.MUSIC_PROVIDER = choice;

  const label = choice === 'qq' ? 'QQ 音乐' : '网易云音乐';
  console.log(`${c.green}✓ 已写入 .env: MUSIC_PROVIDER=${choice}（${label}）${c.reset}`);
  if (choice === 'netease') {
    console.log(`${c.dim}  启动后弹窗会让你扫码登录；如果你知道自己的网易云 uid，可以提前填到 .env 的 NETEASE_UID=（不填只是拉不到个人歌单，听歌不受影响）${c.reset}`);
  } else {
    console.log(`${c.dim}  接下来会让你填 QQ 号（QQ_UIN），之后启动时会引导你放 cookie${c.reset}`);
  }
  console.log('');
  return choice;
}

// 命令行直接跑
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('setup-provider.js');

if (isDirectRun) {
  promptAndWriteMusicProvider().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
