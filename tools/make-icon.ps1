# Erzeugt assets\app.ico und assets\icon-256.png
param([string]$OutDir = "$PSScriptRoot\..\assets")
Add-Type -AssemblyName System.Drawing
$D = [System.Drawing.Drawing2D.GraphicsPath]

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure(); return $p
}
function C([int]$a, [int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }
function Brush($c) { New-Object System.Drawing.SolidBrush $c }

# ---------- Master in 1024 px ----------
$S = 1024
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
$g.Clear([System.Drawing.Color]::Transparent)

function Star([float]$cx, [float]$cy, [float]$outer, [float]$inner) {
    # 4-zackiger Funken (wie im Chat-Logo)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts = @()
    for ($i = 0; $i -lt 8; $i++) {
        $a = [Math]::PI / 4 * $i - [Math]::PI / 2
        $rad = if ($i % 2 -eq 0) { $outer } else { $inner }
        $pts += New-Object System.Drawing.PointF ($cx + $rad * [Math]::Cos($a)), ($cy + $rad * [Math]::Sin($a))
    }
    $p.AddPolygon([System.Drawing.PointF[]]$pts); return $p
}

# Hintergrund: abgerundetes Quadrat mit Verlauf (Indigo -> Violett)
$bg = RoundRect 48 48 928 928 210
$lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 48, 48), (New-Object System.Drawing.PointF 976, 976), (C 255 92 110 245), (C 255 88 40 190)
$g.FillPath($lg, $bg)
$gl = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 40), (New-Object System.Drawing.PointF 0, 990), (C 50 255 255 255), (C 0 255 255 255)
$g.FillPath($gl, $bg)

# Blatt (rechts oben) mit Schatten und Eselsohr
$x = 360; $y = 170; $w = 470; $h = 580; $r = 48; $fold = 130
for ($i = 1; $i -le 6; $i++) { $g.FillPath((Brush (C 14 20 0 60)), (RoundRect ($x - $i * 2) ($y + $i * 6) ($w + $i * 4) ($h + $i * 2) 52)) }
$page = New-Object System.Drawing.Drawing2D.GraphicsPath
$page.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
$page.AddLine($x + $r, $y, $x + $w - $fold, $y)
$page.AddLine($x + $w - $fold, $y, $x + $w, $y + $fold)
$page.AddArc($x + $w - 2*$r, $y + $h - 2*$r, 2*$r, 2*$r, 0, 90)
$page.AddArc($x, $y + $h - 2*$r, 2*$r, 2*$r, 90, 90)
$page.CloseFigure()
$g.FillPath((Brush (C 255 255 255 255)), $page)
$fp = New-Object System.Drawing.Drawing2D.GraphicsPath
$fp.AddLine($x + $w - $fold, $y, $x + $w - $fold, $y + $fold - 30)
$fp.AddArc($x + $w - $fold, $y + $fold - 60, 60, 60, 180, -90)
$fp.AddLine($x + $w - $fold + 30, $y + $fold, $x + $w, $y + $fold)
$fp.CloseFigure()
$g.FillPath((Brush (C 255 205 210 250)), $fp)
# Textzeilen
$gray = Brush (C 255 208 212 230)
foreach ($l in @(@(110, 220), @(180, 300), @(250, 260), @(320, 300))) { $g.FillPath($gray, (RoundRect ($x + 70) ($y + $l[0]) $l[1] 30 15)) }

# Sprechblase (links unten, Claude-Orange) mit Funken
$bx = 150; $by = 470; $bw = 470; $bh = 360
for ($i = 1; $i -le 6; $i++) { $g.FillPath((Brush (C 16 30 0 50)), (RoundRect ($bx - $i * 2) ($by + $i * 6) ($bw + $i * 4) ($bh + $i * 2) 110)) }
$bub = RoundRect $bx $by $bw $bh 110
$tail = New-Object System.Drawing.Drawing2D.GraphicsPath
$tail.AddPolygon([System.Drawing.PointF[]]@((New-Object System.Drawing.PointF ($bx + 70), ($by + $bh - 60)), (New-Object System.Drawing.PointF ($bx + 30), ($by + $bh + 90)), (New-Object System.Drawing.PointF ($bx + 200), ($by + $bh - 20))))
$orange = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF $bx, $by), (New-Object System.Drawing.PointF ($bx + $bw), ($by + $bh + 90)), (C 255 238 140 105), (C 255 205 95 65)
$g.FillPath($orange, $bub); $g.FillPath($orange, $tail)
$white = Brush (C 255 255 255 255)
$g.FillPath($white, (Star ($bx + 220) ($by + 180) 120 34))
$g.FillPath($white, (Star ($bx + 365) ($by + 105) 52 15))
$g.Dispose()

# ---------- Größen ableiten ----------
New-Item -ItemType Directory -Force $OutDir | Out-Null
$sizes = 16, 20, 24, 32, 40, 48, 64, 96, 128, 256
$frames = @()
foreach ($s in $sizes) {
    $b = New-Object System.Drawing.Bitmap $s, $s
    $gg = [System.Drawing.Graphics]::FromImage($b)
    $gg.InterpolationMode = 'HighQualityBicubic'; $gg.PixelOffsetMode = 'HighQuality'; $gg.SmoothingMode = 'AntiAlias'
    $gg.DrawImage($bmp, 0, 0, $s, $s); $gg.Dispose()
    $ms = New-Object System.IO.MemoryStream
    if ($s -eq 256) {
        $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $b.Save("$OutDir\icon-256.png")
    } else {
        # klassischer 32-bit-DIB-Eintrag (lesbar auch für System.Drawing.Icon)
        $bw0 = New-Object System.IO.BinaryWriter $ms
        $bw0.Write([UInt32]40); $bw0.Write([Int32]$s); $bw0.Write([Int32]($s * 2))
        $bw0.Write([UInt16]1); $bw0.Write([UInt16]32); $bw0.Write([UInt32]0)
        $maskStride = [int]([Math]::Ceiling($s / 32.0) * 4)
        $bw0.Write([UInt32]($s * $s * 4 + $maskStride * $s))
        $bw0.Write([Int32]0); $bw0.Write([Int32]0); $bw0.Write([UInt32]0); $bw0.Write([UInt32]0)
        $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
        $bd = $b.LockBits($rect, 'ReadOnly', [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $px = New-Object byte[] ($bd.Stride * $s)
        [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $px, 0, $px.Length)
        $b.UnlockBits($bd)
        for ($row = $s - 1; $row -ge 0; $row--) { $bw0.Write($px, $row * $bd.Stride, $s * 4) }
        $bw0.Write((New-Object byte[] ($maskStride * $s)))
        $bw0.Flush()
    }
    $b.Dispose()
    $frames += ,$ms.ToArray()
}
$bmp.Dispose()

$fs = [System.IO.File]::Create("$OutDir\app.ico"); $bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $d = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $bw.Write([byte]$d); $bw.Write([byte]$d); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$frames[$i].Length); $bw.Write([UInt32]$offset)
    $offset += $frames[$i].Length
}
foreach ($f in $frames) { $bw.Write($f) }
$bw.Close()
Write-Host "Icon geschrieben: $OutDir\app.ico"
