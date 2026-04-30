/**
 * .env 文件读写 helper
 * 共享给 setup-brain / setup-qquin / server 启动检测
 */
import fs from 'node:fs/promises';

/**
 * 把若干 KEY=value 写入 .env（已有覆盖、没的追加）
 * @param {string} envPath  .env 文件绝对路径
 * @param {Record<string,string>} kvs
 */
export async function upsertEnv(envPath, kvs) {
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch {
    /* 没有就新建 */
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
  await fs.writeFile(envPath, content, 'utf8');
}

/**
 * 判断 QQ_UIN 是否「真填了」
 * 占位符 / 空 / 老示例值都视为未填
 */
export function isPlaceholderUin(uin) {
  if (!uin) return true;
  const s = String(uin).trim();
  if (!s) return true;
  if (s === '123456789' || s === '1234567890' || s === 'YOUR_QQ' || s === 'your_qq') return true;
  return false;
}

/**
 * 校验 QQ 号格式：纯数字、5-12 位
 */
export function isValidUin(s) {
  return /^[1-9]\d{4,11}$/.test(String(s).trim());
}
