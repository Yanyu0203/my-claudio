/**
 * 验证 qqmusic.js 客户端是否打通
 *
 * 用法:
 *   cd claudio
 *   npm install
 *   cp .env.example .env   # 改里面的 QQ_UIN
 *   npm run verify:qq
 */

import 'dotenv/config';
import { createQQMusic } from '../src/qqmusic.js';

const qq = createQQMusic({
  apiBase: process.env.QQMUSIC_API_URL,
  uin: process.env.QQ_UIN,
});

const line = (t) => console.log('\n========== ' + t + ' ==========');
const ok = (m) => console.log('  ✅ ' + m);
const fail = (m) => console.log('  ❌ ' + m);

async function main() {
  // ---------- 1. 搜歌 ----------
  line('1. 搜歌：晴天 周杰伦');
  let searchHits = [];
  try {
    searchHits = await qq.search('晴天 周杰伦', 3);
    if (!searchHits.length) {
      fail('搜歌返回空');
    } else {
      ok(`命中 ${searchHits.length} 条`);
      searchHits.forEach((s, i) => {
        console.log(
          `     ${i + 1}. ${s.title} - ${s.artist}  [${s.album}]  mid=${s.songmid}`
        );
      });
    }
  } catch (e) {
    fail('搜歌异常: ' + e.message);
  }

  // ---------- 2. 拿播放直链（对所有命中逐个尝试，找到一个能播的为止） ----------
  line('2. 拿播放直链（依次尝试每首）');
  if (!searchHits.length) {
    fail('上一步没拿到歌，跳过');
  } else {
    let any = false;
    for (const s of searchHits) {
      try {
        const url = await qq.getPlayUrl(s.songmid);
        if (url) {
          ok(`【${s.title}】可播：${url.slice(0, 90)}...`);
          any = true;
          break;
        } else {
          console.log(`     · 【${s.title}】无直链（VIP/版权）`);
        }
      } catch (e) {
        console.log(`     · 【${s.title}】异常: ${e.message}`);
      }
    }
    if (!any) fail('3 首都拿不到直链 —— 尝试搜更通俗的歌（如「告白气球」）');
  }

  // ---------- 3. 拉我的歌单 ----------
  line(`3. 拉我的歌单 (uin=${process.env.QQ_UIN})`);
  let firstPlaylist = null;
  try {
    const list = await qq.getMyPlaylists();
    if (!list.length) {
      fail('没拉到任何歌单（确认 cookie 已 setCookie 过 + uin 正确）');
    } else {
      ok(`拿到 ${list.length} 个歌单：`);
      list.slice(0, 8).forEach((p, i) => {
        console.log(
          `     ${i + 1}. ${p.name}  (${p.songCount} 首)  tid=${p.tid}`
        );
      });
      if (list.length > 8) console.log(`     ... 还有 ${list.length - 8} 个`);
      firstPlaylist = list[0];
    }
  } catch (e) {
    fail('拉歌单异常: ' + e.message);
  }

  // ---------- 4. 拉歌单详情 ----------
  line('4. 拉单个歌单的歌');
  if (!firstPlaylist) {
    fail('上一步没拿到歌单，跳过');
  } else {
    try {
      const detail = await qq.getPlaylistSongs(firstPlaylist.tid);
      ok(`歌单 [${detail.name}] 共 ${detail.total} 首，前 5 首：`);
      detail.songs.slice(0, 5).forEach((s, i) => {
        console.log(`     ${i + 1}. ${s.title} - ${s.artist}`);
      });
    } catch (e) {
      fail('拉歌单详情异常: ' + e.message);
    }
  }

  console.log('\n— 验证结束 —\n');
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
