# Baut StudyBuddy nach .\dist  (benötigt nur Windows + Internet beim ersten Lauf)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$deps = Join-Path $root '_deps'
$dist = Join-Path $root 'dist'
$WebView2Version = '1.0.4258.31'
$PdfJsVersion = '4.10.38'
$KatexVersion = '0.16.11'
$PdfLibVersion = '1.17.1'

# --- Abhängigkeiten laden ---
New-Item -ItemType Directory -Force $deps | Out-Null
if (-not (Test-Path "$deps\wv2\lib\net462\Microsoft.Web.WebView2.Core.dll")) {
    Write-Host "Lade WebView2 SDK $WebView2Version ..."
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$WebView2Version" -OutFile "$deps\wv2.zip"
    Expand-Archive "$deps\wv2.zip" "$deps\wv2" -Force
}
if (-not (Test-Path "$deps\pdfjs\package\build\pdf.min.mjs")) {
    Write-Host "Lade PDF.js $PdfJsVersion ..."
    Invoke-WebRequest "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-$PdfJsVersion.tgz" -OutFile "$deps\pdfjs.tgz"
    New-Item -ItemType Directory -Force "$deps\pdfjs" | Out-Null
    tar -xzf "$deps\pdfjs.tgz" -C "$deps\pdfjs"
}
if (-not (Test-Path "$deps\katex\package\dist\katex.mjs")) {
    Write-Host "Lade KaTeX $KatexVersion ..."
    Invoke-WebRequest "https://registry.npmjs.org/katex/-/katex-$KatexVersion.tgz" -OutFile "$deps\katex.tgz"
    New-Item -ItemType Directory -Force "$deps\katex" | Out-Null
    tar -xzf "$deps\katex.tgz" -C "$deps\katex"
}
if (-not (Test-Path "$deps\pdflib\package\dist\pdf-lib.esm.min.js")) {
    Write-Host "Lade pdf-lib $PdfLibVersion ..."
    Invoke-WebRequest "https://registry.npmjs.org/pdf-lib/-/pdf-lib-$PdfLibVersion.tgz" -OutFile "$deps\pdflib.tgz"
    New-Item -ItemType Directory -Force "$deps\pdflib" | Out-Null
    tar -xzf "$deps\pdflib.tgz" -C "$deps\pdflib"
}
if (-not (Test-Path "$root\assets\app.ico")) { & "$root\tools\make-icon.ps1" }

# --- Kompilieren ---
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist | Out-Null
$lib = "$deps\wv2\lib\net462"
& $csc /nologo /target:winexe /platform:x64 /optimize+ /utf8output `
    "/out:$dist\StudyBuddy.exe" "/win32icon:$root\assets\app.ico" "/win32manifest:$root\src\app.manifest" `
    "/r:$lib\Microsoft.Web.WebView2.Core.dll" "/r:$lib\Microsoft.Web.WebView2.WinForms.dll" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll "$root\src\*.cs"
if ($LASTEXITCODE -ne 0) { throw "Kompilieren fehlgeschlagen" }

# --- Dateien zusammenstellen ---
Copy-Item "$lib\Microsoft.Web.WebView2.Core.dll", "$lib\Microsoft.Web.WebView2.WinForms.dll" $dist
Copy-Item "$deps\wv2\runtimes\win-x64\native\WebView2Loader.dll" $dist
Copy-Item "$root\assets\app.ico" $dist
Copy-Item "$root\web" "$dist\web" -Recurse
$pj = "$deps\pdfjs\package"
$t = "$dist\web\pdfjs"
New-Item -ItemType Directory -Force "$t\build", "$t\web" | Out-Null
Copy-Item "$pj\build\pdf.min.mjs", "$pj\build\pdf.worker.min.mjs" "$t\build"
Copy-Item "$pj\web\pdf_viewer.mjs", "$pj\web\pdf_viewer.css" "$t\web"
Copy-Item "$pj\web\images" "$t\web\images" -Recurse
Copy-Item "$pj\cmaps" "$t\cmaps" -Recurse
Copy-Item "$pj\standard_fonts" "$t\standard_fonts" -Recurse
Copy-Item "$pj\LICENSE" "$t\LICENSE"
$kx = "$deps\katex\package"
New-Item -ItemType Directory -Force "$dist\web\katex" | Out-Null
Copy-Item "$kx\dist\katex.mjs", "$kx\dist\katex.min.css", "$kx\LICENSE" "$dist\web\katex"
Copy-Item "$kx\dist\fonts" "$dist\web\katex\fonts" -Recurse
New-Item -ItemType Directory -Force "$dist\web\pdflib" | Out-Null
Copy-Item "$deps\pdflib\package\dist\pdf-lib.esm.min.js" "$dist\web\pdflib"
Copy-Item "$deps\pdflib\package\LICENSE.md" "$dist\web\pdflib\LICENSE.md"
Copy-Item "$root\installer\Install.cmd" $dist
# Windows PowerShell 5.1 braucht UTF-8 mit BOM für Umlaute
foreach ($f in 'install.ps1', 'uninstall.ps1') {
    $txt = [IO.File]::ReadAllText("$root\installer\$f", [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText("$dist\$f", $txt, (New-Object Text.UTF8Encoding $true))
}

Write-Host "Fertig: $dist" -ForegroundColor Green
