# Установка / обновление сайта подписатьэцп.рф на Windows 10.
# Запуск: PowerShell от имени администратора:
#   powershell -ExecutionPolicy Bypass -File install.ps1                 (последний релиз с GitHub)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Bundle X.zip  (из локального архива)
# Скрипт регистрирует задачу podpisat-update: раз в 5 минут запускает себя с -Auto
# и ставит новый релиз, если он появился.
param(
  [string]$Bundle = "",
  [string]$Dir = "C:\podpisat",
  [string]$Repo = "marat560-tech/podpisat",
  [switch]$Auto
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = "Tls12"

# Invoke-WebRequest в Windows PowerShell 5.1 бывает очень медленным и обрывается — качаем curl.exe (есть в Windows 10)
function Get-File($Url, $Out) {
  & curl.exe -sSfL --retry 3 --connect-timeout 20 -o $Out $Url
  if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать $Url (curl $LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force $Dir, "$Dir\logs" | Out-Null
$tagFile = Join-Path $Dir "release.txt"
$tag = ""

if (-not $Bundle) {
  Write-Host "==> Скачиваю последнюю сборку сайта из $Repo"
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $tag = $rel.tag_name
  if ($Auto -and (Test-Path $tagFile) -and ((Get-Content $tagFile -Raw).Trim() -eq $tag)) { exit 0 }
  if ($Auto) { Start-Transcript -Append "$Dir\logs\update.log" | Out-Null }
  $asset = $rel.assets | Where-Object { $_.name -eq "podpisat-site.zip" } | Select-Object -First 1
  if (-not $asset) { throw "В релизе $($rel.tag_name) нет podpisat-site.zip" }
  $Bundle = Join-Path $Dir "podpisat-site.zip"
  Get-File $asset.browser_download_url $Bundle
  Write-Host "    релиз $($rel.tag_name)"
}

Write-Host "==> Распаковываю сайт"
$tmp = Join-Path $Dir "tmp-extract"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $Bundle -DestinationPath $tmp -Force
if (Test-Path "$Dir\site") { Remove-Item "$Dir\site" -Recurse -Force }
Copy-Item "$tmp\site" "$Dir\site" -Recurse
$oldCaddy = if (Test-Path "$Dir\Caddyfile") { (Get-FileHash "$Dir\Caddyfile").Hash } else { "" }
Copy-Item "$tmp\deploy\Caddyfile" "$Dir\Caddyfile" -Force
$caddyChanged = (Get-FileHash "$Dir\Caddyfile").Hash -ne $oldCaddy
Copy-Item "$tmp\deploy\install.ps1" "$Dir\install.ps1" -Force
Remove-Item $tmp -Recurse -Force

Write-Host "==> КриптоПро: скачиваю cadesplugin_api.js с официального сайта"
try {
  Get-File "https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js" "$Dir\site\static\vendor\cadesplugin_api.js"
} catch { Write-Warning "Не удалось скачать cadesplugin_api.js: $_ (подпись через КриптоПро не будет работать)" }

if (-not (Test-Path "$Dir\caddy.exe")) {
  Write-Host "==> Скачиваю Caddy"
  $rel = Invoke-RestMethod "https://api.github.com/repos/caddyserver/caddy/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -like "*_windows_amd64.zip" } | Select-Object -First 1
  Get-File $asset.browser_download_url "$Dir\caddy.zip"
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
} elseif ($caddyChanged -or $svc.Status -ne "Running") {
  Write-Host "==> Перезапускаю службу"
  Restart-Service podpisat-web
} else {
  Write-Host "==> Caddyfile не изменился, служба работает без перезапуска"
}
if ($tag) { Set-Content $tagFile $tag }

if (-not $Auto -and -not (Get-ScheduledTask -TaskName podpisat-update -ErrorAction SilentlyContinue)) {
  Write-Host "==> Регистрирую автообновление (каждые 5 минут)"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Dir\install.ps1`" -Auto"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName podpisat-update -Action $action -Trigger $trigger -User SYSTEM -RunLevel Highest -Force | Out-Null
}
Start-Sleep 3
Get-Service podpisat-web | Format-Table Name, Status -AutoSize
Write-Host "Готово. Сайт: https://подписатьэцп.рф (после того как DNS укажет на этот сервер и проброшены порты 80/443)."
