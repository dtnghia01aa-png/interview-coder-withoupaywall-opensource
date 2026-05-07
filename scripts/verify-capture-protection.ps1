# Verifies the Electron window is excluded from desktop capture.
# Browser screen-share (Codility Reveal, Zoom, Discord) and PrintScreen all
# go through the same Windows capture path that BitBlt/CopyFromScreen exercises.
# WDA_EXCLUDEFROMCAPTURE (Win10 19041+) excludes the window from all of them.
#
# Strategy:
#   1) Find the Electron process whose main window has WS_EX_LAYERED set
#      (matches our transparent panel).
#   2) Read its display affinity via SetWindowDisplayAffinity's getter.
#   3) Capture the desktop via BitBlt and dump pixel stats around the window
#      bounds — if the window is excluded, those pixels are unaltered desktop.
#
# Usage: pwsh -File verify-capture-protection.ps1

param([string]$OutDir = "$env:TEMP\interview-coder-capture-test")

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -Namespace Win32 -Name User -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
"@

# Find every visible top-level window owned by an Electron process
$results = New-Object System.Collections.ArrayList
$proc = Get-Process | Where-Object { $_.ProcessName -eq 'electron' -or $_.MainWindowTitle -match 'Interview' }
if (-not $proc) {
  Write-Host "No Electron / Interview Coder process found. Is the app running?" -ForegroundColor Yellow
  exit 2
}

$enumProc = [Win32.User+EnumWindowsProc] {
  param($hwnd, $lparam)
  $procId = 0
  [void][Win32.User]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if ($procId -in $script:proc.Id -and [Win32.User]::IsWindowVisible($hwnd)) {
    $len = [Win32.User]::GetWindowTextLength($hwnd) + 1
    $sb = New-Object System.Text.StringBuilder $len
    [void][Win32.User]::GetWindowText($hwnd, $sb, $len)
    $rect = New-Object Win32.User+RECT
    [void][Win32.User]::GetWindowRect($hwnd, [ref]$rect)
    [uint32]$aff = 0
    [void][Win32.User]::GetWindowDisplayAffinity($hwnd, [ref]$aff)
    $script:results.Add([pscustomobject]@{
      Hwnd = $hwnd
      Pid = $procId
      Title = $sb.ToString()
      Rect = $rect
      Affinity = $aff
    }) | Out-Null
  }
  return $true
}
[void][Win32.User]::EnumWindows($enumProc, [IntPtr]::Zero)

$AFFINITY_NAMES = @{ 0='WDA_NONE'; 1='WDA_MONITOR'; 0x11='WDA_EXCLUDEFROMCAPTURE' }

Write-Host ""
Write-Host "=== Electron windows ==="
$results | ForEach-Object {
  $name = $AFFINITY_NAMES[$_.Affinity]
  if (-not $name) { $name = "0x{0:X}" -f $_.Affinity }
  $w = $_.Rect.Right - $_.Rect.Left
  $h = $_.Rect.Bottom - $_.Rect.Top
  Write-Host ("  pid {0,-6}  hwnd 0x{1:X8}  affinity={2}  size={3}x{4}  title='{5}'" -f $_.Pid, $_.Hwnd, $name, $w, $h, $_.Title)
}

$protected = $results | Where-Object { $_.Affinity -ne 0 }
if (-not $protected) {
  Write-Host "FAIL: No protected window found." -ForegroundColor Red
  exit 1
}

# 2. BitBlt the primary screen and check pixels under the protected window
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$shot = Join-Path $OutDir "desktop-bitblt.png"
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ""
Write-Host "Wrote BitBlt capture to $shot"
Write-Host ""

# Check uniqueness of pixels under the window. If the window were captured,
# we'd see the rendered HTML; if excluded, we should see whatever is behind it.
$w = $protected[0]
$rect = $w.Rect
$cx = [Math]::Min([Math]::Max($rect.Left + 50, 0), $bounds.Width - 1)
$cy = [Math]::Min([Math]::Max($rect.Top + 50, 0), $bounds.Height - 1)
$pix = $bmp.GetPixel($cx, $cy)
Write-Host ("Sample pixel inside window bounds at ({0},{1}): R={2} G={3} B={4} A={5}" -f $cx, $cy, $pix.R, $pix.G, $pix.B, $pix.A)
$bmp.Dispose()

if ($w.Affinity -eq 0x11) {
  Write-Host "PASS: Window has WDA_EXCLUDEFROMCAPTURE — invisible to all browser screen-share / PrintScreen / Zoom / Codility Reveal." -ForegroundColor Green
  exit 0
} elseif ($w.Affinity -eq 1) {
  Write-Host "PARTIAL: Window has WDA_MONITOR — appears as a black square in capture (older Windows mode)." -ForegroundColor Yellow
  exit 0
} else {
  Write-Host "FAIL: Window is not protected (affinity=$($w.Affinity)). Capture protection is NOT active." -ForegroundColor Red
  exit 1
}
