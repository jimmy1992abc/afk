param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show($Message, $Title, 'OK', 'Information') | Out-Null
