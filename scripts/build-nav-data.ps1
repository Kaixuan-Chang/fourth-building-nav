param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$dataDir = Join-Path $Root 'data'
$hotDir = Join-Path $dataDir 'hotspots'

$starts = Import-Csv -LiteralPath (Join-Path $dataDir 'starts.csv')
$destinations = Import-Csv -LiteralPath (Join-Path $dataDir 'destinations.csv')
$bindings = Import-Csv -LiteralPath (Join-Path $dataDir 'route-bindings.csv')

$hotspots = @{}
Get-ChildItem -LiteralPath $hotDir -Filter *.csv | ForEach-Object {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
  $hotspots[$name] = @(Import-Csv -LiteralPath $_.FullName)
}

$payload = [ordered]@{
  starts = @($starts)
  destinations = @($destinations)
  bindings = @($bindings)
  hotspots = $hotspots
} | ConvertTo-Json -Depth 10 -Compress

"window.NAV_DATA = $payload;" | Set-Content -LiteralPath (Join-Path $dataDir 'nav-data.js') -Encoding UTF8
Write-Host '已生成 data/nav-data.js'
