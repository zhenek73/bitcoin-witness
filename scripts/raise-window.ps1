# Brings a window to the front WITHOUT moving or resizing it.
#
# Deliberately does not call MoveWindow: during a screen recording the window
# layout is set by hand and must not be disturbed. Restores only if minimised.
#
# Usage: .\raise-window.ps1 WindowsTerminal
param([Parameter(Mandatory = $true)][string]$ProcessName)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Raise {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ -ErrorAction SilentlyContinue

$p = Get-Process $ProcessName -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no window for $ProcessName"; exit 1 }

$h = $p.MainWindowHandle
if ([Raise]::IsIconic($h)) { [Raise]::ShowWindow($h, 9) | Out-Null }  # SW_RESTORE, only if minimised
[Raise]::SetForegroundWindow($h) | Out-Null

$r = New-Object Raise+RECT
[Raise]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("raised {0} at {1},{2} size {3}x{4} (unchanged)" -f $ProcessName, $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
