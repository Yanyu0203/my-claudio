# data/ 目录模板参考

> 这个 `data.example/` 目录是**给新用户参考的模板**，真正运行时 Vox 会读 `../data/`（被 `.gitignore` 忽略的私人目录）。

`data/` 目录里会有哪些东西：

| 文件 | 作用 | 什么时候产生 |
|---|---|---|
| `qq_cookie.json` | QQ 音乐登录凭证 | 你从浏览器复制过来，或 `npm run setup:cookie` 生成 |
| `taste.md` | 你的音乐口味画像（给大脑读） | 第一次跑 `npm run bootstrap:taste` 时，大脑看你的歌单写出来 |
| `taste-deltas.md` | 画像演化追加日志 | 后续聊天中 DJ 自动追加 |
| `vox.db` / `claudio.db` | SQLite：播放历史 / 对话 / 缓存 | 首次启动自动建 |
| `vox.db-shm` `vox.db-wal` | SQLite 的 WAL 伴生文件 | 同上，SQLite 自己维护 |

## 这个目录里的模板文件

- `qq_cookie.example.json` — cookie 文件的外层结构。**字段 data 的值是一整串浏览器复制的 cookie 文本**
- `taste.example.md` — 大脑给你写的画像大概长什么样（用作参考，不用照抄）

## 你不需要手动建 data/

跑 `./start.sh`（或 `npm start`）时 Vox 会自动建 `data/` 目录并生成空的数据库。你只需要补 `qq_cookie.json`（setup-cookie 脚本帮你做）。
