# ============================================================
# Vox 一键启动 (Windows PowerShell)
#
# 用法:
#   双击运行 OR 在 PowerShell 里:
#     cd C:\path\to\my-vox
#     .\start.ps1
#
# 第一次运行可能要解封脚本：
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# ============================================================

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$QQMusicDir = Join-Path $Root "QQMusicApi"
$VoxDir = Join-Path $Root "vox"
$LogDir = Join-Path $Root "logs"
$CookieFile = Join-Path $Root "data\qq_cookie.json"

# ---------- 读 QQ_UIN：优先 env 变量 > vox/.env > 占位 ----------
# 真实的 QQ 号只会存在 vox/.env（已被 .gitignore），脚本里不写死任何个人信息
$QQUin = $env:QQ_UIN
if ([string]::IsNullOrEmpty($QQUin)) {
    $envFile = Join-Path $VoxDir ".env"
    if (Test-Path $envFile) {
        $line = (Get-Content $envFile | Where-Object { $_ -match '^QQ_UIN=' } | Select-Object -Last 1)
        if ($line) { $QQUin = ($line -replace '^QQ_UIN=', '').Trim('"',"'", ' ') }
    }
}

# 空 / 占位符 → 引导用户现在填一下
$placeholders = @('', '123456789', '1234567890', 'YOUR_QQ', 'your_qq')
if ($placeholders -contains $QQUin) {
    Write-Host ""
    Write-Host "[vox] ⚠️  没检测到真实 QQ_UIN" -ForegroundColor Yellow
    Write-Host "[vox]    现在帮你填一下（只要 QQ 号，不要密码）"
    Write-Host ""
    if (-not (Test-Path (Join-Path $VoxDir "node_modules"))) {
        Push-Location $VoxDir; npm install --silent; Pop-Location
    }
    Push-Location $VoxDir
    try { node scripts/setup-qquin.js } finally { Pop-Location }
    # 重新读
    $envFile = Join-Path $VoxDir ".env"
    if (Test-Path $envFile) {
        $line = (Get-Content $envFile | Where-Object { $_ -match '^QQ_UIN=' } | Select-Object -Last 1)
        if ($line) { $QQUin = ($line -replace '^QQ_UIN=', '').Trim('"',"'", ' ') }
    }
    if ($placeholders -contains $QQUin) {
        Write-Host "❌ QQ_UIN 仍未填，退出" -ForegroundColor Red
        exit 1
    }
    Write-Host "[vox] ✅ QQ_UIN 已保存到 $VoxDir\.env" -ForegroundColor Green
    Write-Host ""
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "[vox] 清理老进程..." -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*QQMusicApi*" -or $_.MainWindowTitle -like "*vox*"
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# ---------- 启动 QQMusicApi ----------
function Test-Port($port) {
    try {
        $tcp = New-Object Net.Sockets.TcpClient
        $tcp.Connect('127.0.0.1', $port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

if (-not (Test-Port 3300)) {
    if (-not (Test-Path $QQMusicDir)) {
        Write-Host ""
        Write-Host "❌ 找不到 QQMusicApi 目录: $QQMusicDir" -ForegroundColor Red
        Write-Host ""
        Write-Host "   正常情况下 my-vox 仓库里自带这个目录。你这份似乎缺失，" -ForegroundColor Yellow
        Write-Host "   可以重新拉一次仓库，或手动 clone 兜底:" -ForegroundColor Yellow
        Write-Host "     cd $Root"
        Write-Host "     git clone https://github.com/jsososo/QQMusicApi.git"
        Write-Host "     cd QQMusicApi"
        Write-Host "     npm install"
        Write-Host ""
        Write-Host "   完整指引看 SETUP.md「步骤 3」" -ForegroundColor Yellow
        exit 1
    }
    if (-not (Test-Path (Join-Path $QQMusicDir "node_modules"))) {
        Write-Host "[vox] QQMusicApi 首次使用，自动装依赖..." -ForegroundColor Cyan
        Push-Location $QQMusicDir
        try {
            npm install --silent
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        } catch {
            Write-Host "❌ QQMusicApi 装依赖失败，手动跑:" -ForegroundColor Red
            Write-Host "     cd $QQMusicDir"
            Write-Host "     npm install"
            exit 1
        } finally {
            Pop-Location
        }
    }
    Write-Host "[vox] 启动 QQMusicApi (QQ=$QQUin) ..." -ForegroundColor Cyan
    $env:QQ = $QQUin
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "cd /d `"$QQMusicDir`" && yarn start > `"$LogDir\qqmusicapi.log`" 2>&1" `
        -WindowStyle Hidden

    # 等启动
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-Port 3300) { break }
        Start-Sleep -Milliseconds 500
    }
} else {
    Write-Host "[vox] QQMusicApi 已在运行" -ForegroundColor Green
}

# ---------- 喂 cookie ----------
# 每次启动都重推：cookie 可能已更新；QQMusicApi 进程内的 cookie 也会在上面重启时丢失
if (Test-Path $CookieFile) {
    Write-Host "[vox] 推送 cookie 到 QQMusicApi..." -ForegroundColor Cyan
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3300/user/setCookie" `
            -Method POST -ContentType "application/json" `
            -InFile $CookieFile
        if ($resp.result -eq 100) {
            Write-Host "[vox] cookie 推送成功" -ForegroundColor Green
        } else {
            Write-Host "[vox] ⚠️  cookie 推送响应异常: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Yellow
            Write-Host "[vox]    （继续启动，但可能只能播非 VIP 歌曲）" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[vox] cookie 推送失败: $_" -ForegroundColor Yellow
    }
}

# ---------- 启动 Vox ----------
Write-Host ""
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host " 🎧 Vox 启动中" -ForegroundColor Magenta
Write-Host "   前端       : http://localhost:8080" -ForegroundColor White
Write-Host "   QQMusicApi : http://localhost:3300" -ForegroundColor White
Write-Host "   日志       : $LogDir\" -ForegroundColor White
Write-Host "   Ctrl+C 退出 (注意 QQMusicApi 后台进程要手动关)" -ForegroundColor Gray
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host ""

Set-Location $VoxDir
node server.js
