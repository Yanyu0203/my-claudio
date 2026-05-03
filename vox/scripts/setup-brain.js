/**
 * 交互式选择大脑（codebuddy / claude / claude-internal）
 *
 * 用法:
 *   npm run setup:brain
 *
 * 流程:
 *   1. 自动 which 检测 codebuddy / claude
 *   2. 列出选项给用户选
 *   3. 简单测试 (调一句"hi") 确认能用
 *   4. 写入 .env 的 BRAIN_BIN / BRAIN_FLAVOR
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callBrain } from '../src/brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const ENV_PATH = path.join(projectRoot, '.env');

const FLAVORS = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy CLI',
    bin: 'codebuddy',
    desc: '默认推荐，走你的 CodeBuddy 订阅',
    install_hint: '官网安装: https://www.codebuddy.ai',
  },
  {
    id: 'claude',
    label: 'Claude Code (Anthropic 官方)',
    bin: 'claude',
    desc: '官方 CLI，走你的 claude.ai 订阅 / API Key',
    install_hint: '安装: npm install -g @anthropic-ai/claude-code  (详见 https://docs.anthropic.com/en/docs/claude-code)',
  },
  {
    id: 'claude-internal',
    label: 'Claude Internal (腾讯内部版)',
    bin: 'claude-internal',
    desc: '腾讯内部的 Claude Code 分发，独立命令 claude-internal',
    install_hint: '请按公司内网文档安装，安装后能在终端直接 claude-internal 调通',
  },
];

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};

function whichBin(bin) {
  // 跨平台检测：Mac/Linux 用 which，Windows 用 where
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const found = (r.stdout || '').split(/\r?\n/)[0].trim();
  return found || null;
}

async function safeQuestion(rl, question, defaultVal = '') {
  return new Promise((resolve) => {
    let done = false;
    const onClose = () => {
      if (done) return;
      done = true;
      resolve(defaultVal);
    };
    rl.once('close', onClose);
    rl.question(question)
      .then((ans) => {
        if (done) return;
        done = true;
        rl.off('close', onClose);
        resolve((ans || '').trim() || defaultVal);
      })
      .catch(() => {
        if (done) return;
        done = true;
        resolve(defaultVal);
      });
  });
}

async function main() {
  console.log('');
  console.log(`${c.bold}${c.cyan}═══ 选择 Vox 的大脑 ═══${c.reset}`);
  console.log('');

  // 先 which 一下，给每个选项标可用性
  const detected = FLAVORS.map((f) => ({
    ...f,
    found: whichBin(f.bin),
  }));

  detected.forEach((f, i) => {
    const tag = f.found
      ? `${c.green}✓ 已装${c.reset} ${c.dim}(${f.found})${c.reset}`
      : `${c.yellow}✗ 系统里找不到 ${f.bin} 命令${c.reset}`;
    console.log(`  ${c.bold}${i + 1}.${c.reset} ${f.label}    ${tag}`);
    console.log(`     ${c.dim}${f.desc}${c.reset}`);
    if (!f.found && f.install_hint) {
      console.log(`     ${c.dim}→ ${f.install_hint}${c.reset}`);
    }
    console.log('');
  });

  const rl = readline.createInterface({ input, output });
  let choice;
  while (true) {
    const ans = await safeQuestion(rl, `选哪个？输入数字 1-${FLAVORS.length}（默认 1）: `, '1');
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < FLAVORS.length) {
      choice = detected[idx];
      break;
    }
    console.log(`${c.red}无效输入${c.reset}`);
  }

  if (!choice.found) {
    console.log('');
    console.log(`${c.yellow}⚠ 你选了 ${choice.label}，但系统里找不到 ${choice.bin} 命令。${c.reset}`);
    console.log(`${c.dim}  ${choice.install_hint}${c.reset}`);
    console.log('');
    console.log(`${c.bold}你确定已经装好了 ${choice.bin} 吗？${c.reset}`);
    console.log(`${c.dim}  - 如果还没装，请先去装好（参考上面的提示），然后重新跑 npm run setup:brain${c.reset}`);
    console.log(`${c.dim}  - 如果装了但 PATH 没生效，重开终端再跑这个脚本${c.reset}`);
    console.log(`${c.dim}  - 如果就是想先把配置写下来等以后装，输入 y 继续${c.reset}`);
    const cont = (await safeQuestion(rl, '继续写入 .env 吗？[y/N]: ', 'n')).toLowerCase();
    if (cont !== 'y') {
      rl.close();
      console.log('');
      console.log(`${c.dim}已退出。装好 ${choice.bin} 后再重跑 npm run setup:brain${c.reset}`);
      process.exit(1);
    }
  }

  // 内网版本提醒
  if (choice.id === 'claude-internal') {
    console.log('');
    console.log(`${c.cyan}ℹ 你选了 Claude Internal（腾讯内部版）。${c.reset}`);
    console.log(`${c.dim}  Vox 会以 ${choice.bin} -p "<prompt>" 形式调它。${c.reset}`);
    console.log(`${c.dim}  确保你已经通过公司流程登录、且 VPN/网络正常。${c.reset}`);
  }

  // 测试调用
  if (choice.found) {
    console.log('');
    const test = (await safeQuestion(rl, `要不要测试调一下 "${choice.bin}"（约 6-15 秒）？[Y/n]: `, 'y')).toLowerCase();
    if (test !== 'n') {
      console.log(`${c.dim}  正在调 ${choice.bin} -p "用一句话说 hi"${c.reset}`);
      const t0 = Date.now();
      try {
        process.env.BRAIN_BIN = choice.bin;
        const out = await callBrain('用一句话说 hi', { timeoutMs: 60000 });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`${c.green}  ✓ 成功 (${dt}s): ${out.trim().slice(0, 80)}${c.reset}`);
      } catch (e) {
        console.log(`${c.red}  ✗ 失败: ${e.message}${c.reset}`);
        const cont = (await safeQuestion(rl, '测试失败，仍然写入 .env 吗？[y/N]: ', 'n')).toLowerCase();
        if (cont !== 'y') {
          rl.close();
          process.exit(1);
        }
      }
    }
  }
  rl.close();

  // 写入 .env
  await upsertEnv({
    BRAIN_BIN: choice.bin,
    BRAIN_FLAVOR: choice.id,
  });

  console.log('');
  console.log(`${c.green}${c.bold}✓ 大脑设置完成${c.reset}`);
  console.log(`  ${c.dim}写入 .env:${c.reset}`);
  console.log(`    BRAIN_BIN=${choice.bin}`);
  console.log(`    BRAIN_FLAVOR=${choice.id}`);
  console.log('');
  console.log(`  下一步: ${c.bold}npm run bootstrap:taste${c.reset}（如果还没跑过）`);
  console.log(`         ${c.bold}npm start${c.reset}（启动服务）`);
  console.log('');
}

/**
 * 把若干 KEY=value 写入 .env（已有的覆盖、没的追加）
 */
async function upsertEnv(kvs) {
  let content = '';
  try {
    content = await fs.readFile(ENV_PATH, 'utf8');
  } catch {
    /* 没有 .env 就新建 */
  }

  for (const [k, v] of Object.entries(kvs)) {
    const re = new RegExp(`^${k}\\s*=.*$`, 'm');
    const line = `${k}=${v}`;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += line + '\n';
    }
  }
  await fs.writeFile(ENV_PATH, content, 'utf8');
}

main().catch((e) => {
  console.error('\n❌ 异常:', e.message);
  process.exit(1);
});
