/**
 * 大脑 (Brain) CLI 桥接 —— 通用层
 * --------------------------------------------------
 * 支持 3 种「类 Claude Code CLI」工具：
 *   - CodeBuddy CLI       命令: codebuddy
 *   - Claude Code (官方)  命令: claude
 *   - Claude Internal     命令: claude-internal （腾讯内部独立分发）
 *
 * CLI 接口几乎一致，但有一些**已知差异**：
 *   - 跳权限询问参数：
 *       codebuddy        -y
 *       claude           --dangerously-skip-permissions
 *       claude-internal  --dangerously-skip-permissions（不接受 -y）
 *   - 其它都一样：-p 非交互、prompt 是位置参数
 *
 * 配置：
 *   BRAIN_BIN     必填，可执行文件名（codebuddy / claude / claude-internal / 绝对路径）
 *   BRAIN_FLAVOR  可选，仅做日志/UI 显示
 *   CODEBUDDY_BIN 兼容旧配置
 */
import { spawn } from 'node:child_process';

/**
 * 拿当前要调的大脑可执行文件名
 */
export function resolveBrainBin() {
  return (
    process.env.BRAIN_BIN ||
    process.env.CODEBUDDY_BIN ||
    'codebuddy'
  );
}

export function getBrainFlavor() {
  return process.env.BRAIN_FLAVOR || 'codebuddy';
}

/**
 * 根据 bin 名字猜「跳权限询问」要用哪个 flag
 * @param {string} bin
 * @returns {string|null} flag，null = 不传
 */
function pickSkipPermFlag(bin) {
  const name = (bin || '').split(/[/\\]/).pop().toLowerCase();
  if (name === 'codebuddy' || name === 'cbc') return '-y';
  // claude / claude-internal / 任何 claude-* 都用长参数
  if (name.startsWith('claude')) return '--dangerously-skip-permissions';
  // 默认用 -y（兼容老行为）
  return '-y';
}

/**
 * 调大脑一次，返回 stdout 文本
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string}                [opts.bin]                    可执行文件，覆盖 env
 * @param {number}                [opts.timeoutMs=180000]       超时 ms
 * @param {(chunk:string)=>void}  [opts.onStream]               流式输出回调
 * @param {string[]}              [opts.extraArgs]              额外参数
 * @param {boolean}               [opts.skipPermissions=true]   是否跳权限询问
 * @returns {Promise<string>}
 */
export function callBrain(prompt, opts = {}) {
  const bin = opts.bin || resolveBrainBin();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const skipPermissions = opts.skipPermissions !== false;

  const args = [];
  if (skipPermissions) {
    const flag = pickSkipPermFlag(bin);
    if (flag) args.push(flag);
  }
  args.push('-p');
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      const s = buf.toString('utf8');
      stdout += s;
      if (opts.onStream) opts.onStream(s);
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const hint =
        err.code === 'ENOENT'
          ? `\n  → 可执行文件 "${bin}" 找不到。\n` +
            `    1. 确认它装了：which ${bin}\n` +
            `    2. 重选大脑：cd claudio && npm run setup:brain`
          : '';
      reject(new Error(`spawn ${bin} 失败: ${err.message}${hint}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        return reject(new Error(`大脑 (${bin}) 超时 (${timeoutMs}ms)`));
      }
      if (code !== 0) {
        const authHint = /Authentication required|login/i.test(stderr + stdout)
          ? `\n  → 大脑没登录。手动登录后重试：\n    ${bin}    ← 进交互界面\n    /login`
          : '';
        const argHint = /unknown option/i.test(stderr)
          ? `\n  → CLI 参数不认。可能是 bin 名字判断错了，把 BRAIN_BIN 改成准确名字（含 "claude" 子串会用 --dangerously-skip-permissions，否则用 -y）`
          : '';
        return reject(
          new Error(
            `大脑 (${bin}) 退出码 ${code}\nstderr:\n${stderr}\nstdout:\n${stdout.slice(-500)}${authHint}${argHint}`
          )
        );
      }
      resolve(stdout);
    });
  });
}

/**
 * 调大脑并尝试从 stdout 抽 JSON
 */
export async function callBrainJSON(prompt, opts = {}) {
  const raw = await callBrain(prompt, opts);
  return extractJSON(raw);
}

/**
 * 从任意文本里抽出第一个合法 JSON 对象 / 数组
 */
export function extractJSON(text) {
  if (!text) throw new Error('大脑返回空');

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 落到下面 */
    }
  }

  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('从大脑返回里抽不出 JSON。原文前 500 字:\n' + text.slice(0, 500));
}
