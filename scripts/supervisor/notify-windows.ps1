param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)

# A modal dialog waits for a click that, by definition of away-from-keyboard,
# nobody is there to give. Show a balloon that dismisses itself instead.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = New-Object System.Windows.Forms.NotifyIcon
try {
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(10000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Seconds 10
} finally {
  $icon.Visible = $false
  $icon.Dispose()
}
