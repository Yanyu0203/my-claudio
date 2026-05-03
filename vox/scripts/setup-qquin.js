/**
 * 交互式设置 QQ 号到 .env 的 QQ_UIN
 *
 * 用法:
 *   npm run setup:qquin
 *
 * 也会在 server 首次启动 + TTY 环境下被自动调用
 */
import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { upsertEnv, isValidUin } from './_lib/env-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const ENV_PATH = path.join(projectRoot, '.env');

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

/**
 * 交互式询问并写入 QQ_UIN
 * @returns {Promise<string|null>} 写入的 QQ 号，未写入返回 null
 */
export async function promptAndWriteQQUin() {
  if (!process.stdin.isTTY) {
    console.log('');
    console.log(`${c.yellow}⚠ QQ_UIN 未配置，且当前不在交互式终端，无法弹问。${c.reset}`);
    console.log(`${c.dim}  请手动跑：${c.bold}npm run setup:qquin${c.reset}`);
    console.log(`${c.dim}  或编辑 .env，把 QQ_UIN= 后面填上你的 QQ 号${c.reset}`);
    return null;
  }

  console.log('');
  console.log(`${c.bold}${c.cyan}═══ 设置你的 QQ 号 ═══${c.reset}`);
  console.log(`${c.dim}  Vox 需要你的 QQ 号来拉取你的 QQ 音乐歌单。${c.reset}`);
  console.log(`${c.dim}  这个号必须和你之前喂 cookie 时登录的 QQ 一致。${c.reset}`);
  console.log('');

  const rl = readline.createInterface({ input, output });
  let uin = '';
  while (true) {
    const ans = (await rl.question('请输入你的 QQ 号 (5-12 位数字): ')).trim();
    if (!ans) {
      console.log(`${c.yellow}  跳过设置${c.reset}`);
      rl.close();
      return null;
    }
    if (!isValidUin(ans)) {
      console.log(`${c.red}  格式不对，应该是 5-12 位数字（不带 'o' 前缀）${c.reset}`);
      continue;
    }
    uin = ans;
    break;
  }
  rl.close();

  await upsertEnv(ENV_PATH, { QQ_UIN: uin });
  process.env.QQ_UIN = uin; // 同步进当前进程，方便 server 立刻用

  console.log(`${c.green}✓ 已写入 .env: QQ_UIN=${uin}${c.reset}`);
  console.log('');
  return uin;
}

// 命令行直接跑
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('setup-qquin.js');

if (isDirectRun) {
  promptAndWriteQQUin().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
