# Entfernt StudyBuddy für den aktuellen Benutzer
$dir = Join-Path $env:LOCALAPPDATA 'Programs\StudyBuddy'
Get-Process StudyBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

$C = 'HKCU:\Software\Classes'
Remove-Item "$C\StudyBuddy.Document", "$C\Applications\StudyBuddy.exe", 'HKCU:\Software\StudyBuddy',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StudyBuddy' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty "$C\.pdf\OpenWithProgids" -Name 'StudyBuddy.Document' -ErrorAction SilentlyContinue
Remove-ItemProperty 'HKCU:\Software\RegisteredApplications' -Name 'StudyBuddy' -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'StudyBuddy.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA 'StudyBuddy') -Recurse -Force -ErrorAction SilentlyContinue

Set-Location $env:TEMP
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "StudyBuddy wurde entfernt." -ForegroundColor Green
