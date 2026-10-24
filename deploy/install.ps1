# Установка / обновление сайта подписатьэцп.рф на Windows 10.
# Запуск: PowerShell от имени администратора:
#   powershell -ExecutionPolicy Bypass -File install.ps1                 (последний релиз с GitHub)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Bundle X.zip  (из локального архива)
param(
  [string]$Bundle = "",
  [string]$Dir = "C:\podpisat",
  [string]$Repo = "marat560-tech/podpisat"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = "Tls12"

New-Item -ItemType Directory -Force $Dir, "$Dir\logs" | Out-Null

if (-not $Bundle) {
  Write-Host "==> Скачиваю последнюю сборку сайта из $Repo"
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -eq "podpisat-site.zip" } | Select-Object -First 1
  if (-not $asset) { throw "В релизе $($rel.tag_name) нет podpisat-site.zip" }
  $Bundle = Join-Path $Dir "podpisat-site.zip"
  Invoke-WebRequest $asset.browser_download_url -OutFile $Bundle -UseBasicParsing
  Write-Host "    релиз $($rel.tag_name)"
}

Write-Host "==> Распаковываю сайт"
$tmp = Join-Path $env:TEMP ("podpisat-" + [guid]::NewGuid())
Expand-Archive -Path $Bundle -DestinationPath $tmp -Force
if (Test-Path "$Dir\site") { Remove-Item "$Dir\site" -Recurse -Force }
Copy-Item "$tmp\site" "$Dir\site" -Recurse
Copy-Item "$tmp\deploy\Caddyfile" "$Dir\Caddyfile" -Force
Remove-Item $tmp -Recurse -Force

Write-Host "==> КриптоПро: скачиваю cadesplugin_api.js с официального сайта"
try {
  Invoke-WebRequest "https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js" `
    -OutFile "$Dir\site\static\vendor\cadesplugin_api.js" -UseBasicParsing
} catch { Write-Warning "Не удалось скачать cadesplugin_api.js: $_ (подпись через КриптоПро не будет работать)" }

if (-not (Test-Path "$Dir\caddy.exe")) {
  Write-Host "==> Скачиваю Caddy"
  $rel = Invoke-RestMethod "https://api.github.com/repos/caddyserver/caddy/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -like "*_windows_amd64.zip" } | Select-Object -First 1
  Invoke-WebRequest $asset.browser_download_url -OutFile "$Dir\caddy.zip" -UseBasicParsing
  Expand-Archive "$Dir\caddy.zip" "$Dir\caddy-tmp" -Force
  Copy-Item "$Dir\caddy-tmp\caddy.exe" "$Dir\caddy.exe" -Force
  Remove-Item "$Dir\caddy.zip", "$Dir\caddy-tmp" -Recurse -Force
}

& "$Dir\caddy.exe" validate --config "$Dir\Caddyfile" --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw "Ошибка в Caddyfile" }

$svc = Get-Service podpisat-web -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "==> Регистрирую службу podpisat-web"
  sc.exe create podpisat-web start= auto DisplayName= "podpisat.rf web (Caddy)" binPath= "`"$Dir\caddy.exe`" run --config `"$Dir\Caddyfile`" --adapter caddyfile" | Out-Null
  sc.exe failure podpisat-web reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
  Start-Service podpisat-web
} else {
  Write-Host "==> Перезапускаю службу"
  Restart-Service podpisat-web
}
Start-Sleep 3
Get-Service podpisat-web | Format-Table Name, Status -AutoSize
Write-Host "Готово. Сайт: https://подписатьэцп.рф (после того как DNS укажет на этот сервер и проброшены порты 80/443)."
