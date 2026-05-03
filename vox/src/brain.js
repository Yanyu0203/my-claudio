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
            `    2. 重选大脑：cd vox && npm run setup:brain`
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
 * 流式版：一边产生 reply 字段一边把"reply"内容往外推
 * 用于 chatReply——让前端能像 ChatGPT 那样看字一个个冒出来
 *
 * 约定：prompt 里必须把 reply 字段放在最前面，且 JSON 是顶层 object
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {(replyDelta: string) => void} opts.onReplyDelta  每次 reply 字段有新字时触发
 * @returns {Promise<object>} 解析后的 JSON
 */
export async function callBrainJSONStreamReply(prompt, opts = {}) {
  const { onReplyDelta, ...rest } = opts;
  const streamer = makeReplyStreamer(onReplyDelta);
  const raw = await callBrain(prompt, {
    ...rest,
    onStream: (chunk) => streamer.push(chunk),
  });
  return extractJSON(raw);
}

/**
 * 增量扫描 stdout 流，一旦遇到 "reply": " 就进入吐字模式，
 * 遇到未转义的 " 结尾停止。只处理第一次出现的 reply 字段。
 */
function makeReplyStreamer(onDelta) {
  let buf = '';
  let phase = 'seek'; // seek → inStr → done
  let cursor = 0;
  let escape = false;

  return {
    push(chunk) {
      if (!onDelta || phase === 'done') { buf += chunk; return; }
      buf += chunk;

      if (phase === 'seek') {
        // 找 "reply" : " 开头（容忍空白）
        const m = buf.slice(cursor).match(/"reply"\s*:\s*"/);
        if (!m) return;
        cursor = cursor + m.index + m[0].length;
        phase = 'inStr';
      }

      if (phase === 'inStr') {
        // 从 cursor 扫到第一个未转义的 "
        let emit = '';
        for (; cursor < buf.length; cursor++) {
          const ch = buf[cursor];
          if (escape) {
            // 处理转义：\" \\ \n \t 等
            if (ch === 'n') emit += '\n';
            else if (ch === 't') emit += '\t';
            else if (ch === 'r') emit += '';
            else emit += ch;
            escape = false;
            continue;
          }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') {
            phase = 'done';
            cursor++;
            break;
          }
          emit += ch;
        }
        if (emit) onDelta(emit);
      }
    },
  };
}

/**
 * 从任意文本里抽出第一个合法 JSON 对象 / 数组
 *
 * 兼容大脑常见输出问题：
 *  - markdown 代码块包裹
 *  - 字符串里带未转义的裸双引号（如 reason 里写了 "挺好"）→ 自动启发式修复
 */
export function extractJSON(text) {
  if (!text) throw new Error('大脑返回空');

  // 1. 优先尝试代码块（最常见的合法情况）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) {
    candidates.push(fence[1].trim());
    // 还要尝试"修复后再字符串感知截取"，应对 fence 内本身有裸引号导致截不全
    const repaired = repairJSON(fence[1].trim());
    const obj = sliceBalancedJSON(repaired, '{', '}');
    if (obj) candidates.push(obj);
    const arr = sliceBalancedJSON(repaired, '[', ']');
    if (arr) candidates.push(arr);
  }

  // 2. 再从原文里字符串感知地找 {…} / […]
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const found = sliceBalancedJSON(text, open, close);
    if (found) candidates.push(found);
  }

  // 3. 兜底：先全文修复一次再找
  const repaired = repairJSON(text);
  if (repaired !== text) {
    for (const [open, close] of [['{', '}'], ['[', ']']]) {
      const found = sliceBalancedJSON(repaired, open, close);
      if (found) candidates.push(found);
    }
  }

  // 4. 依次尝试解析（每个都试 raw + repair 两个版本，挑第一个 object 类型的成功结果）
  let lastSuccess;
  for (const raw of candidates) {
    const parsed = tryParseWithRepair(raw);
    if (parsed === undefined) continue;
    // 优先返回 object（Vox 都是顶层 object 结构）
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    lastSuccess = parsed;
  }
  if (lastSuccess !== undefined) return lastSuccess;

  throw new Error('从大脑返回里抽不出 JSON。原文前 500 字:\n' + text.slice(0, 500));
}

/**
 * 字符串感知地切出第一个配对的 {…} 或 […]
 * 在字符串内的 { } " 不影响计数
 */
function sliceBalancedJSON(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 先直接 parse；失败就尝试启发式修复后再 parse
 */
function tryParseWithRepair(raw) {
  try { return JSON.parse(raw); } catch (_) {}
  const repaired = repairJSON(raw);
  if (repaired !== raw) {
    try { return JSON.parse(repaired); } catch (_) {}
  }
  return undefined;
}

/**
 * 启发式修复常见裸引号问题
 * 思路：JSON 字符串值的合法结尾只有 ",  ",\n  " }  " ]  " ：
 *   遇到 " 后看后面第一个非空白字符，如果不是 [,}\]:] 也不是文件末尾，
 *   就大概率是字符串中间的裸引号，转义掉。
 *
 * 同时修：
 *   - 末尾未关闭的字符串
 *   - 末尾未关闭的 { / [
 *   - 缺失的 value（如 "taste_delta": <空>）补成 ""
 *   - 末尾多余逗号
 */
function repairJSON(raw) {
  let s = raw.trim();

  // ---- 第 1 遍：扫描修裸引号 + 补未关闭字符串，并跟踪括号深度 ----
  let out = '';
  let inStr = false;
  let escape = false;
  const stack = []; // 跟踪 { [ 嵌套

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }

    if (ch === '"') {
      if (!inStr) {
        inStr = true;
        out += ch;
      } else {
        // 在字符串里遇到 " —— 看下一个非空白字符
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const next = s[j];
        if (next === ',' || next === '}' || next === ']' || next === ':' || j >= s.length) {
          // 合法结尾
          inStr = false;
          out += ch;
        } else {
          // 裸引号 —— 转义
          out += '\\"';
        }
      }
      continue;
    }

    if (!inStr) {
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
    }

    out += ch;
  }

  // 末尾字符串没关
  if (inStr) out += '"';

  // ---- 第 2 遍：清理 + 补结构 ----
  // 把"key":\s*$  补成 "key":""
  out = out.replace(/("[^"\n]*"\s*:\s*)(?=\s*$)/m, '$1""');
  // 把"key":\s*[}\]]  补成 "key":""<原来的>
  out = out.replace(/("[^"\n]*"\s*:\s*)(?=[\s\n\r]*[}\]])/g, '$1""');
  // 末尾多余逗号
  out = out.replace(/,\s*([}\]])/g, '$1');

  // 关掉所有还开着的 { [
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }

  return out;
}
