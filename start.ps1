# ============================================================
# Claudio 一键启动 (Windows PowerShell)
#
# 用法:
#   双击运行 OR 在 PowerShell 里:
#     cd C:\path\to\my-claudio
#     .\start.ps1
#
# 第一次运行可能要解封脚本：
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# ============================================================

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$QQMusicDir = Join-Path $Root "QQMusicApi"
$ClaudioDir = Join-Path $Root "claudio"
$LogDir = Join-Path $Root "logs"
$CookieFile = Join-Path $Root "data\qq_cookie.json"
$QQUin = if ($env:QQ_UIN) { $env:QQ_UIN } else { "1829981984" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "[claudio] 清理老进程..." -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*QQMusicApi*" -or $_.MainWindowTitle -like "*claudio*"
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
        Write-Host "   QQMusicApi 不在本 repo 里，需要单独 clone:" -ForegroundColor Yellow
        Write-Host "     cd $Root"
        Write-Host "     git clone https://github.com/jsososo/QQMusicApi.git"
        Write-Host "     cd QQMusicApi"
        Write-Host "     npm install"
        Write-Host ""
        Write-Host "   完整指引看 SETUP.md「步骤 3」" -ForegroundColor Yellow
        exit 1
    }
    if (-not (Test-Path (Join-Path $QQMusicDir "node_modules"))) {
        Write-Host "❌ QQMusicApi 还没装依赖。请先跑:" -ForegroundColor Red
        Write-Host "     cd $QQMusicDir"
        Write-Host "     npm install"
        Write-Host ""
        Write-Host "   如果报 'certificate has expired'，看 SETUP.md「步骤 3.2」" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[claudio] 启动 QQMusicApi (QQ=$QQUin) ..." -ForegroundColor Cyan
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
    Write-Host "[claudio] QQMusicApi 已在运行" -ForegroundColor Green
}

# ---------- 喂 cookie ----------
if (Test-Path $CookieFile) {
    $existingCookie = Join-Path $QQMusicDir "data\cookie.json"
    $needFeed = $true
    if (Test-Path $existingCookie) {
        if ((Get-Item $existingCookie).Length -gt 100) { $needFeed = $false }
    }
    if ($needFeed) {
        Write-Host "[claudio] 喂 cookie..." -ForegroundColor Cyan
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:3300/user/setCookie" `
                -Method POST -ContentType "application/json" `
                -InFile $CookieFile | Out-Null
            Write-Host "[claudio] cookie 已设置" -ForegroundColor Green
        } catch {
            Write-Host "[claudio] cookie 设置失败: $_" -ForegroundColor Yellow
        }
    }
}

# ---------- 启动 Claudio ----------
Write-Host ""
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host " 🎧 Claudio 启动中" -ForegroundColor Magenta
Write-Host "   前端       : http://localhost:8080" -ForegroundColor White
Write-Host "   QQMusicApi : http://localhost:3300" -ForegroundColor White
Write-Host "   日志       : $LogDir\" -ForegroundColor White
Write-Host "   Ctrl+C 退出 (注意 QQMusicApi 后台进程要手动关)" -ForegroundColor Gray
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host ""

Set-Location $ClaudioDir
node server.js
