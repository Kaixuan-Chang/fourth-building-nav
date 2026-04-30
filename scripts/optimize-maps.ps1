param(
  [string]$MapsDir,
  [int]$MaxWidth = 1600
)

$ErrorActionPreference = "Stop"

if (-not $MapsDir) {
  $MapsDir = Join-Path $PSScriptRoot "..\maps"
}

$resolvedMapsDir = (Resolve-Path $MapsDir).Path
$tempRoot = Join-Path $env:TEMP ("fourth-building-nav-map-opt-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  $files = Get-ChildItem -LiteralPath $resolvedMapsDir -Recurse -Filter *.png -File
  $total = $files.Count
  $index = 0

  foreach ($file in $files) {
    $index++
    Write-Host ("[{0}/{1}] {2}" -f $index, $total, $file.FullName)

    $relativePath = $file.FullName.Substring($resolvedMapsDir.Length).TrimStart('\')
    $tempFile = Join-Path $tempRoot $relativePath
    $tempDir = Split-Path -Parent $tempFile
    if (-not (Test-Path $tempDir)) {
      New-Item -ItemType Directory -Path $tempDir | Out-Null
    }

    $vf = "scale='min(iw,$MaxWidth)':-2:flags=lanczos"
    & ffmpeg -y -i $file.FullName -vf $vf -compression_level 9 $tempFile | Out-Null

    $originalSize = (Get-Item -LiteralPath $file.FullName).Length
    $newSize = (Get-Item -LiteralPath $tempFile).Length

    if ($newSize -lt $originalSize) {
      Move-Item -LiteralPath $tempFile -Destination $file.FullName -Force
    } else {
      Remove-Item -LiteralPath $tempFile -Force
    }
  }
}
finally {
  if (Test-Path $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
