# CLAUDE.md — Vox 安装 SOP（给 AI 看的执行手册）

> **AI 助手注意**：本文档是为你（Claude / CodeBuddy / 类似 AI）准备的**确定性执行手册**。
> 用户已授权你按此 SOP 帮 TA 完成 Vox 的安装和首次启动。
> 严格按下面的"阶段"和"动作"执行；遇到 ⚠️**STOP** 标记必须暂停等用户操作。

**本版本对应 Vox v1.0.0**（双音乐源：QQ / 网易云）。

---

## 项目背景

Vox 是一个跑在用户本机的 AI 电台。架构：
- **大脑**：AI CLI 调用（CodeBuddy / Claude Code / Claude Internal 三选一），输出 JSON `{say, play[]}`
- **曲库**：**二选一**
  - QQ 音乐：本地 QQMusicApi 服务（`http://127.0.0.1:3300`）
  - 网易云音乐：进程内 npm 模块 `api-enhanced`（无独立服务），**支持扫码登录**
- **天气**：和风（可选）
- **前端**：浏览器 PWA + WebSocket

详细架构看 [README.md](./README.md)，详细人工指南看 [SETUP.md](./SETUP.md)。

---

## 平台检测

执行前先检测用户的操作系统：

```bash
uname -s 2>/dev/null || echo "windows"
```

记录结果：`Darwin` = macOS，`Linux` = Linux，其他 = Windows。后续根据 OS 选用对应命令变体。

---

## 项目根目录约定

假设用户工作目录为 `<ROOT>`，**就是 my-claudio 这个 git 仓库的根目录**（默认 `~/Desktop/my-claudio` 或 `C:\Users\xxx\Desktop\my-claudio`）。

执行任何命令前，先 `cd <ROOT>` 并确认目录里**应该**有这些：

| 名字 | 在 repo 里？ | 说明 |
|---|---|---|
| `README.md` `SETUP.md` `CLAUDE.md` | ✅ | 文档 |
| `start.sh` `start.ps1` | ✅ | 一键启动脚本（首次会交互式选音乐源） |
| `vox/` | ✅ | 主程序代码 |
| `QQMusicApi/` | ✅ | QQ 音乐源，仓库自带（源自 jsososo/QQMusicApi） |
| `api-enhanced/` | ❌ **按需生成** | 网易云源，用户选了 netease 时 `start.sh` 会自动 git clone + pin commit |
| `data/` | ❌ **运行时建** | 用户的私人数据（cookie / 历史 / 画像）|

**用户拿到的 repo 含前 4 项**。`api-enhanced/` 仅 netease 模式才需要（start.sh 自动处理）。`data/` 会在启动过程中自动建。

---

## 关键设计：v1.0.0 自动化程度

相比老版本，很多事 `start.sh` / `start.ps1` 已经接管：

| 以前要 AI 做 | 现在 |
|---|---|
| 问用户选音乐源 → 写 .env | ✅ `start.sh` 首次启动弹交互菜单 |
| 问 QQ_UIN → 写 .env | ✅ `start.sh` 检测到缺失会调 `setup-qquin.js` |
| 起 QQMusicApi + 推 cookie + 验证 | ✅ `start.sh` 全包（冷启动 + /user/songlist 真验证） |
| clone api-enhanced + 装依赖 | ✅ `start.sh` 首次选 netease 时自动搞 |
| 复制 QQ cookie 粘贴 | 用户在**网页弹窗里**粘 + server 自动落盘 + 自动重启 QQMusicApi |
| 复制 netease cookie | 用户在**网页弹窗扫码**（30 秒），uid 也自动落 .env |

所以 AI 现在的主要任务是：**帮装基础依赖 + 选大脑 CLI + 帮用户跑一下 `start.sh`**，其余交给脚本 + 用户在网页上完成。

---

## 执行阶段总览

| 阶段 | 是否需要人 | 大致耗时 |
|---|---|---|
| 1. 检测环境 | ❌ AI 自动 | 30s |
| 2. 装 Node / Git（如缺）| ❌ AI 自动 | 2-5min |
| 3. **选大脑 CLI + 验证登录** | ⚠️ 必须人扫码登录 | 1-3min |
| 4. 装 Vox 依赖 + 写大脑配置 | ❌ AI 自动 | 1min |
| 5. **选音乐源（通过 start.sh 启动）** | ⚠️ 必须人选 1/2 | 10s |
| 6. **首次登录音乐源** | ⚠️ 必须人扫码（netease）或粘 cookie（qq）| 30s ~ 5min |
| 7. **首次画像设置** | ⚠️ 必须人在网页选歌单 | 1-3min |
| 8. 收尾验证 | ❌ AI 自动 | 30s |

---

## 阶段 1：检测环境

### 动作 1.1 — 检测平台

```bash
uname -s 2>/dev/null || echo "windows"
```

### 动作 1.2 — 检测已装工具

```bash
node -v
git --version
codebuddy --version 2>&1 | head -1
```

记录哪些已装、哪些没装。

---

## 阶段 2：装 Node / Git

如果阶段 1 检测出缺失：

### macOS（用 Homebrew）

```bash
which brew || (echo "需要先装 Homebrew" && exit 1)
brew install node git
```

### Windows

告诉用户：请去 https://nodejs.org 下载 LTS 版 `.msi` 安装。Git 去 https://git-scm.com/download/win 。等用户装完回复"装好了"再继续。

### 验证

```bash
node -v   # 期望 >= v18
git --version
```

---

## 阶段 3：选大脑 CLI + 验证登录

Vox 支持 3 种大脑 CLI（用户三选一），**三个是独立的可执行文件**：

| 选项 ID | 命令 | 适用 |
|---|---|---|
| `codebuddy`（默认推荐）| `codebuddy` | CodeBuddy 订阅 |
| `claude` | `claude` | Anthropic 官方 Claude Code |
| `claude-internal` | `claude-internal` | 腾讯内部分发的独立 CLI |

⚠️ **重要**：`claude` 和 `claude-internal` 是**不同的二进制**，不要混淆。

### 动作 3.1 — 检测哪些已装

```bash
which codebuddy 2>/dev/null
which claude 2>/dev/null
which claude-internal 2>/dev/null
```

**完整告诉用户结果**：

```
codebuddy: ✓ /opt/homebrew/bin/codebuddy
claude: ✗ 未检测到
claude-internal: ✗ 未检测到
```

### 动作 3.2 — 询问用户用哪个

> ⚠️**STOP**：问用户："Vox 的大脑用哪个 CLI？
>
> 选项：
>   (1) codebuddy        ← CodeBuddy 订阅（推荐，大部分用户）
>   (2) claude           ← Anthropic 官方
>   (3) claude-internal  ← 腾讯内部独立 CLI
>
> 你想用哪个？"

记录用户选择为 `<BRAIN_FLAVOR>` 和对应的 `<BRAIN_BIN>`。

### 动作 3.3 — 测试登录态

```bash
<BRAIN_BIN> -p "用一句话说 hi"
```

期望：6-15 秒内返回一句中文。

### 失败兜底

| 错误 | 修法 |
|---|---|
| `Authentication required` | 让用户跑 `<BRAIN_BIN>` 进交互界面 → `/login` → `/exit`，然后重测 |
| `command not found` | 确认用户是否装了 / 是否需要开新终端让 PATH 生效 |
| 内网版连不上 | 让用户检查 VPN / 公司网络 |

---

## 阶段 4：装 Vox 依赖 + 写大脑配置

### 动作 4.1 — 装依赖

```bash
cd <ROOT>/vox
[ -d node_modules ] || npm install
```

Windows:
```powershell
cd <ROOT>\vox
if (!(Test-Path node_modules)) { npm install }
```

### 动作 4.2 — 复制 .env 模板

```bash
cd <ROOT>/vox
[ -f .env ] || cp .env.example .env
```

Windows:
```powershell
cd <ROOT>\vox
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

### 动作 4.3 — 写入大脑配置

**推荐**：让用户跑 `npm run setup:brain` 交互式选（会自动检测 + 写 `.env`）：

```bash
cd <ROOT>/vox
npm run setup:brain
```

如果用户已经明确选好（阶段 3），也可以 AI 直接 sed 改：

macOS:
```bash
sed -i '' \
  -e "s/^BRAIN_BIN=.*/BRAIN_BIN=<BRAIN_BIN>/" \
  -e "s/^BRAIN_FLAVOR=.*/BRAIN_FLAVOR=<BRAIN_FLAVOR>/" \
  <ROOT>/vox/.env
```

Windows:
```powershell
(Get-Content "<ROOT>\vox\.env") `
  -replace '^BRAIN_BIN=.*', "BRAIN_BIN=<BRAIN_BIN>" `
  -replace '^BRAIN_FLAVOR=.*', "BRAIN_FLAVOR=<BRAIN_FLAVOR>" |
  Set-Content "<ROOT>\vox\.env"
```

---

## 阶段 5 ⚠️**STOP** — 选音乐源（通过 start.sh 触发）

### 动作 5.1 — 第一次启动脚本

```bash
cd <ROOT>
chmod +x start.sh   # macOS/Linux 首次
./start.sh
```

Windows:
```powershell
cd <ROOT>
.\start.ps1
```

### 动作 5.2 — 脚本会弹出选择菜单

首次跑 start.sh 会看到：

```
═══ 选择音乐源 ═══
  1) QQ 音乐
     · 需要本地起 QQMusicApi 服务（start.sh 会自动起）
     · 浏览器 F12 复制 cookie（5 分钟）
  2) 网易云音乐 (推荐)
     · 不用额外服务
     · 扫码登录（手机 App 扫一下就好，30 秒）

请选择 [1/2] (回车 = 2 网易云):
```

### 动作 5.3 — 询问用户

> ⚠️**STOP**：把这个菜单完整转述给用户，问：
>
> "start.sh 在问你选哪个音乐源。想用 QQ 音乐还是网易云？
> - 选 **2（网易云）** 最省心：扫码登录，30 秒搞定，不用 F12 复制 cookie
> - 选 **1（QQ 音乐）**：如果你在 QQ 音乐攒了很多歌单
>
> 告诉我选几，我继续帮你。"

根据用户选择：
- 选 1 → 进入"**分支 A · QQ 音乐**"
- 选 2 → 进入"**分支 B · 网易云**"

### 分支 A · QQ 音乐

#### 动作 5.A.1 — start.sh 会进一步要 QQ 号

脚本会检测 `.env` 里有没有 `QQ_UIN`，没有就调 `setup-qquin.js` 问。

> ⚠️**STOP**：问用户："你的 QQ 号是多少？（数字，不带 'o'）"
> 拿到后告诉用户把它输入到 start.sh 的交互提示里。

### 分支 B · 网易云

#### 动作 5.B.1 — 无需额外输入

start.sh 会自动：
1. 检查 `api-enhanced/` 是否存在，不存在则 `git clone` 上游仓库并 `checkout` 到 pin commit
2. 运行 `npm install` 装依赖
3. 启动 Vox server

**告诉用户**："start.sh 会自动拉取网易云 API 代码并装依赖，首次需要 1-3 分钟（网络好的话），完事会自动进到下一步。"

### 动作 5.4 — 验证 Vox 起来了

等 start.sh 日志出现：

```
🎧 Vox is running at http://localhost:8080
```

```bash
curl -s http://localhost:8080/api/health
```

期望 `{"ok":true, ...}`。

---

## 阶段 6 ⚠️**STOP** — 首次登录音乐源

Vox 启动后会自动 probe cookie。首次肯定没 cookie → **浏览器打开 `http://localhost:8080` 会自动弹"COOKIE 失效"弹窗**。

### 告诉用户：

> ⚠️**STOP**：打开浏览器访问 http://localhost:8080 ，应该会自动弹一个登录窗。
>
> - **如果你选的是网易云**：窗口里会有**「点这里生成二维码」**按钮。点它 → 出二维码 → 用网易云音乐**手机 App** → 「我的」→ 右上角「扫一扫」→ 扫一下 → 手机点确认。30 秒就好。
> - **如果你选的是 QQ 音乐**：窗口下部会折叠着"手动粘贴 cookie"区。展开它，按窗口里的步骤复制 cookie 粘贴。
>
> 登录成功后窗口会自动关闭并开始推荐。"

### AI 不要替用户操作这一步

- ❌ 不要试图用自动化工具去操作浏览器
- ❌ 不要让用户 F12 去手动复制（网易云用户完全不用，QQ 用户应该在网页弹窗里走）
- ✅ 等用户回复"登录好了"/"看到在播了"再进下一步

---

## 阶段 7 ⚠️**STOP** — 首次画像设置

登录成功后，浏览器**自动弹 INITIALIZE TASTE 窗口**，让用户选要灌哪些歌单。

> 告诉用户："登录成功后会自动弹 **INITIALIZE TASTE** 窗口，选 1-3 个你最常听的歌单（每个指定抽样：全量/随机 N/前 N）。点开始 → 进度条 60-180 秒 → 画像生成完毕 → 自动开始播第一段。"

**AI 不要替用户选歌单**——这是用户的音乐人格，用户自己选最准。

---

## 阶段 8：收尾验证

用户反馈"在播了"后：

### 动作 8.1 — 检查画像

```bash
ls -la <ROOT>/data/taste.md
cat <ROOT>/data/taste.md | head -20
```

应该有 1-3 KB 的内容。

### 动作 8.2 — 检查会话状态

```bash
curl -s http://localhost:8080/api/health
```

期望：
```json
{"ok":true, "historyCount":N, "messageCount":N, "hasTaste":true}
```

`hasTaste:true` 表示画像就绪。

---

## 错误处理

| 错误 | 阶段 | 修法 |
|---|---|---|
| `Authentication required` | 3 | 用户没登录 AI CLI，引导 `/login` |
| `npm install` 超时 | 4 | 指定国内镜像 `npm install --registry=https://registry.npmmirror.com` |
| `start.sh: MUSIC_PROVIDER : unbound variable` | 5 | 说明用户用了非常老版本的 start.sh，让 TA `git pull` 更新 |
| `git clone api-enhanced` 失败 | 5.B | 网络问题 / GitHub 被墙。让用户手动 clone 到 `<ROOT>/api-enhanced` |
| QQ cookie 显示 301 未登录 | 6 | 用户从没登录的 y.qq.com 复制了 cookie，让 TA 在浏览器确认右上角是自己头像再复制 |
| 网易云二维码一直 waiting | 6 | 用户没用手机 App 扫；扫了没在手机上点确认 |
| 网页一直 'AI THINKING' 超过 5 分钟 | 7 | 看 `logs/vox.log`；多半大脑 CLI 调用超时 |
| 浏览器没弹画像设置窗口 | 7 | `data/taste.md` 已存在。让用户点右上角 ✦ RESET TASTE 按钮手动触发 |
| Windows: 脚本不能执行 | 5 | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |

---

## AI 行为准则

1. **每个阶段执行前**，先用一句话告诉用户当前在做什么
2. **每个 ⚠️STOP 步骤**必须显式暂停，不要自己编 cookie / KEY 等用户私密信息
3. **不要修改** `data/` 下任何文件（用户私人数据）
4. **遇到错误**优先查上面"错误处理"表，再看 SETUP.md「常见错误对照表」
5. **不要静默修改** `vox/` 源代码（除非用户明确要求 + 你说清楚改了啥）
6. **不要 `git commit`** 任何东西，除非用户要求
7. **优先让脚本干活**：不要手动执行 start.sh 里已经做的事（起 QQMusicApi / 推 cookie / clone api-enhanced 等），会导致进程冲突
8. 整个流程跑通后，**给用户一个简短总结**：哪些跑通了、哪些是用户后续可调的

---

## 最终交付

跑完阶段 8 后，给用户输出类似总结：

```
✅ Vox 安装完成（v1.0.0）

音乐源: <MUSIC_PROVIDER>        ← qq 或 netease
大脑:   <BRAIN_BIN>

数据目录: <ROOT>/data
- vox.db                    （SQLite，记你播放/对话/缓存）
- taste.md                  （你的音乐画像，可手改）
- qq_cookie.json            （QQ 模式下的登录态）
- netease_cookie.txt        （网易云模式下的登录态，扫码后自动生成）

服务:
- Vox 前端          http://localhost:8080  ← 打开这个
- QQMusicApi        http://localhost:3300  ← 仅 QQ 模式

下次启动只需:
  cd <ROOT>
  ./start.sh        (Mac)
  .\start.ps1       (Windows)

想换音乐源（QQ ↔ 网易云）→ 删掉 vox/.env 里 MUSIC_PROVIDER= 那行再启动，会再弹菜单
想重来画像 → 浏览器右上角 ✦ RESET TASTE
要加/改天气 → 改 vox/.env 的 QWEATHER_* 三行
Cookie 失效 → 浏览器会自动弹登录窗，网易云扫码 30 秒，QQ 粘贴 cookie
```
