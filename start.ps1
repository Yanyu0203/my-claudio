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
$ApiEnhancedDir = Join-Path $Root "api-enhanced"
$VoxDir = Join-Path $Root "vox"
$LogDir = Join-Path $Root "logs"
$QQCookieFile = Join-Path $Root "data\qq_cookie.json"

# ---------- 读 MUSIC_PROVIDER ----------
# 优先级：环境变量 > .env > 交互式弹问（仅首次）
$Provider = $env:MUSIC_PROVIDER
$envFile = Join-Path $VoxDir ".env"
$hasProviderLine = $false
if ((Test-Path $envFile) -and ((Get-Content $envFile) -match '^MUSIC_PROVIDER=')) {
    $hasProviderLine = $true
}

if ([string]::IsNullOrEmpty($Provider) -and $hasProviderLine) {
    $line = (Get-Content $envFile | Where-Object { $_ -match '^MUSIC_PROVIDER=' } | Select-Object -Last 1)
    if ($line) { $Provider = ($line -replace '^MUSIC_PROVIDER=', '').Trim('"',"'",' ') }
}

# 还是没值 → 首次启动，交互式问用户
if ([string]::IsNullOrEmpty($Provider)) {
    if ([Environment]::UserInteractive -and $Host.Name -ne 'ServerRemoteHost') {
        Write-Host ""
        Write-Host "[vox] 第一次启动，先选个音乐源..." -ForegroundColor Cyan
        if (-not (Test-Path (Join-Path $VoxDir "node_modules"))) {
            Push-Location $VoxDir; npm install --silent; Pop-Location
        }
        Push-Location $VoxDir
        try { node scripts/setup-provider.js } finally { Pop-Location }
        if (Test-Path $envFile) {
            $line = (Get-Content $envFile | Where-Object { $_ -match '^MUSIC_PROVIDER=' } | Select-Object -Last 1)
            if ($line) { $Provider = ($line -replace '^MUSIC_PROVIDER=', '').Trim('"',"'",' ') }
        }
    } else {
        Write-Host "❌ 没设 MUSIC_PROVIDER，且当前不在交互式终端，无法弹问" -ForegroundColor Red
        Write-Host "   请编辑 $envFile 添加一行：MUSIC_PROVIDER=netease （或 qq）"
        exit 1
    }
}

if ($Provider -ne 'qq' -and $Provider -ne 'netease') {
    Write-Host "❌ 不支持的 MUSIC_PROVIDER=$Provider，支持: qq / netease" -ForegroundColor Red
    exit 1
}

Write-Host "[vox] music provider = $Provider"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "[vox] 清理老进程..." -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*QQMusicApi*" -or $_.MainWindowTitle -like "*vox*"
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

function Test-Port($port) {
    try {
        $tcp = New-Object Net.Sockets.TcpClient
        $tcp.Connect('127.0.0.1', $port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

# ============================================================
# 分支 A：qq provider
# ============================================================
if ($Provider -eq 'qq') {
    # QQ_UIN 检查
    $QQUin = $env:QQ_UIN
    if ([string]::IsNullOrEmpty($QQUin)) {
        $envFile = Join-Path $VoxDir ".env"
        if (Test-Path $envFile) {
            $line = (Get-Content $envFile | Where-Object { $_ -match '^QQ_UIN=' } | Select-Object -Last 1)
            if ($line) { $QQUin = ($line -replace '^QQ_UIN=', '').Trim('"',"'",' ') }
        }
    }
    $placeholders = @('', '123456789', '1234567890', 'YOUR_QQ', 'your_qq')
    if ($placeholders -contains $QQUin) {
        Write-Host ""
        Write-Host "[vox] ⚠️  没检测到真实 QQ_UIN" -ForegroundColor Yellow
        Write-Host ""
        if (-not (Test-Path (Join-Path $VoxDir "node_modules"))) {
            Push-Location $VoxDir; npm install --silent; Pop-Location
        }
        Push-Location $VoxDir
        try { node scripts/setup-qquin.js } finally { Pop-Location }
        $envFile = Join-Path $VoxDir ".env"
        if (Test-Path $envFile) {
            $line = (Get-Content $envFile | Where-Object { $_ -match '^QQ_UIN=' } | Select-Object -Last 1)
            if ($line) { $QQUin = ($line -replace '^QQ_UIN=', '').Trim('"',"'",' ') }
        }
        if ($placeholders -contains $QQUin) {
            Write-Host "❌ QQ_UIN 仍未填，退出" -ForegroundColor Red
            exit 1
        }
    }

    # 启动 QQMusicApi
    if (-not (Test-Port 3300)) {
        if (-not (Test-Path $QQMusicDir)) {
            Write-Host "❌ 找不到 QQMusicApi 目录: $QQMusicDir" -ForegroundColor Red
            exit 1
        }
        if (-not (Test-Path (Join-Path $QQMusicDir "node_modules"))) {
            Write-Host "[vox] QQMusicApi 首次使用，自动装依赖..." -ForegroundColor Cyan
            Push-Location $QQMusicDir
            try { npm install --silent; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
            finally { Pop-Location }
        }
        Write-Host "[vox] 启动 QQMusicApi (QQ=$QQUin) ..." -ForegroundColor Cyan
        $env:QQ = $QQUin
        Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", "cd /d `"$QQMusicDir`" && yarn start > `"$LogDir\qqmusicapi.log`" 2>&1" `
            -WindowStyle Hidden
        for ($i = 0; $i -lt 20; $i++) {
            if (Test-Port 3300) { break }
            Start-Sleep -Milliseconds 500
        }
    } else {
        Write-Host "[vox] QQMusicApi 已在运行" -ForegroundColor Green
    }

    # 推 cookie
    if (Test-Path $QQCookieFile) {
        Write-Host "[vox] 推送 cookie 到 QQMusicApi..." -ForegroundColor Cyan
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3300/user/setCookie" `
                -Method POST -ContentType "application/json" `
                -InFile $QQCookieFile
            if ($resp.result -eq 100) {
                Write-Host "[vox] cookie 推送成功" -ForegroundColor Green
            } else {
                Write-Host "[vox] ⚠️  cookie 推送响应异常" -ForegroundColor Yellow
            }
        } catch { Write-Host "[vox] cookie 推送失败: $_" -ForegroundColor Yellow }
    }
}

# ============================================================
# 分支 B：netease provider
# ============================================================
# ============================================================
# 分支 B：netease provider
# ============================================================
# api-enhanced 不打包进本仓库；首次使用时自动 clone 到 pin 的 commit
$ApiEnhancedRepo = "https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git"
$ApiEnhancedPin  = "15fa49a2e8e63456a58e0ec1e81f7283176bd4b2"

if ($Provider -eq 'netease') {
    if (-not (Test-Path $ApiEnhancedDir)) {
        Write-Host "[vox] 没找到 api-enhanced，自动 clone（一次性，需要联网）..." -ForegroundColor Cyan
        $hasGit = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
        if (-not $hasGit) {
            Write-Host "❌ 没装 git，无法 clone api-enhanced。" -ForegroundColor Red
            Write-Host "   请先装 git，或手动跑：git clone $ApiEnhancedRepo `"$ApiEnhancedDir`"" -ForegroundColor Yellow
            exit 1
        }
        git clone $ApiEnhancedRepo "$ApiEnhancedDir"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ clone api-enhanced 失败（网络问题？）" -ForegroundColor Red
            Write-Host "   手动跑：git clone $ApiEnhancedRepo `"$ApiEnhancedDir`""
            exit 1
        }
        Push-Location $ApiEnhancedDir
        try {
            git checkout $ApiEnhancedPin 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[vox] ✅ api-enhanced 已 checkout 到 pin commit $($ApiEnhancedPin.Substring(0,7))" -ForegroundColor Green
            } else {
                Write-Host "[vox] ⚠️  checkout pin commit 失败，使用上游 main 最新版" -ForegroundColor Yellow
            }
        } finally { Pop-Location }
    }
    if (-not (Test-Path (Join-Path $ApiEnhancedDir "node_modules"))) {
        Write-Host "[vox] api-enhanced 首次使用，自动装依赖..." -ForegroundColor Cyan
        Push-Location $ApiEnhancedDir
        try { npm install --silent; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
        finally { Pop-Location }
    }
    Write-Host "[vox] api-enhanced 已就绪" -ForegroundColor Green
}

# ---------- 启动 Vox ----------
Write-Host ""
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host " 🎧 Vox 启动中（$Provider）" -ForegroundColor Magenta
Write-Host "   前端       : http://localhost:8080" -ForegroundColor White
if ($Provider -eq 'qq') {
    Write-Host "   QQMusicApi : http://localhost:3300" -ForegroundColor White
}
Write-Host "   日志       : $LogDir\" -ForegroundColor White
Write-Host "=============================================" -ForegroundColor Magenta
Write-Host ""

Set-Location $VoxDir
node server.js
