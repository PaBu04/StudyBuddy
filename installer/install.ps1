# Installiert StudyBuddy für den aktuellen Benutzer (keine Admin-Rechte nötig)
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dir = Join-Path $env:LOCALAPPDATA 'Programs\StudyBuddy'
$exe = Join-Path $dir 'StudyBuddy.exe'

# Aus dem Quellordner "installer" gestartet? Dann den gebauten Ordner "dist" verwenden.
if (-not (Test-Path (Join-Path $src 'StudyBuddy.exe'))) {
    $dist = Join-Path $src '..\dist'
    if (-not (Test-Path (Join-Path $dist 'StudyBuddy.exe'))) {
        throw "StudyBuddy.exe nicht gefunden. Bitte zuerst build.ps1 ausführen und dist\Install.cmd starten."
    }
    $src = (Resolve-Path $dist).Path
}

Write-Host "Installiere StudyBuddy nach $dir ..."
$procs = @(Get-Process StudyBuddy -ErrorAction SilentlyContinue)
if ($procs.Count) { $procs | Stop-Process -Force; foreach ($p in $procs) { [void]$p.WaitForExit(5000) } }
New-Item -ItemType Directory -Force $dir | Out-Null
if (Test-Path "$dir\web") { Remove-Item "$dir\web" -Recurse -Force }
foreach ($item in Get-ChildItem $src | Where-Object { $_.Name -notin 'Install.cmd', 'install.ps1' }) {
    Copy-Item $item.FullName -Destination $dir -Recurse -Force
}
$missing = 'StudyBuddy.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll', 'uninstall.ps1', 'web\index.html', 'web\pdfjs\build\pdf.worker.min.mjs' |
    Where-Object { -not (Test-Path (Join-Path $dir $_)) }
if ($missing) { throw "Installation unvollständig, es fehlt: $($missing -join ', ')" }

# Startmenü-Verknüpfung
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'StudyBuddy.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk); $s.TargetPath = $exe; $s.WorkingDirectory = $dir
$s.IconLocation = "$exe,0"; $s.Description = 'PDF-Viewer mit Claude als Lernbegleiter'; $s.Save()

# Dateizuordnung (.pdf -> "Öffnen mit" / Standard-Apps)
function Set-Key($path, $values) {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    foreach ($k in $values.Keys) { Set-ItemProperty -Path $path -Name $k -Value $values[$k] }
}
$cmd = "`"$exe`" `"%1`""
$C = 'HKCU:\Software\Classes'
Set-Key "$C\StudyBuddy.Document" @{ '(default)' = 'PDF-Dokument' }
Set-Key "$C\StudyBuddy.Document\DefaultIcon" @{ '(default)' = "`"$exe`",0" }
Set-Key "$C\StudyBuddy.Document\shell\open\command" @{ '(default)' = $cmd }
Set-Key "$C\.pdf\OpenWithProgids" @{ 'StudyBuddy.Document' = '' }
Set-Key "$C\Applications\StudyBuddy.exe" @{ 'FriendlyAppName' = 'StudyBuddy' }
Set-Key "$C\Applications\StudyBuddy.exe\SupportedTypes" @{ '.pdf' = '' }
Set-Key "$C\Applications\StudyBuddy.exe\shell\open\command" @{ '(default)' = $cmd }
Set-Key 'HKCU:\Software\StudyBuddy\Capabilities' @{ 'ApplicationName' = 'StudyBuddy'; 'ApplicationDescription' = 'PDF-Viewer mit Claude als Lernbegleiter' }
Set-Key 'HKCU:\Software\StudyBuddy\Capabilities\FileAssociations' @{ '.pdf' = 'StudyBuddy.Document' }
Set-Key 'HKCU:\Software\RegisteredApplications' @{ 'StudyBuddy' = 'Software\StudyBuddy\Capabilities' }

# Eintrag unter "Apps & Features" zum Deinstallieren
Set-Key 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StudyBuddy' @{
    'DisplayName' = 'StudyBuddy'; 'DisplayVersion' = '0.1.0'; 'Publisher' = 'StudyBuddy'
    'DisplayIcon' = "$exe,0"; 'InstallLocation' = $dir
    'UninstallString' = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dir\uninstall.ps1`""
}
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StudyBuddy' -Name NoModify -Value 1 -Type DWord
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StudyBuddy' -Name NoRepair -Value 1 -Type DWord

Add-Type -Namespace W -Name S -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'
[W.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
try { Start-Process "$env:WINDIR\System32\ie4uinit.exe" -ArgumentList '-show' -Wait } catch { }

Write-Host ""
Write-Host "StudyBuddy ist installiert (Startmenü: StudyBuddy)." -ForegroundColor Green
if ($Quiet) { return }
Write-Host "Um StudyBuddy als Standard für PDFs zu setzen, öffnet sich jetzt die Windows-Einstellung:"
Write-Host "  -> bei '.pdf' StudyBuddy auswählen."
Start-Process 'ms-settings:defaultapps?registeredAppUser=StudyBuddy'
