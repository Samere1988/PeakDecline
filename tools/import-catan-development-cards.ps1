$ErrorActionPreference = 'Stop'

# Run from the PeakDecline repository root:
#   powershell -ExecutionPolicy Bypass -File .\tools\import-catan-development-cards.ps1
# The user has confirmed the license for these Colonist assets in the task.

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'static\assets\catan\colonist'
$manifestPath = Join-Path $target 'sources.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$assets = [ordered]@{
    'dev-knight.svg'      = 'card_knight.a58573f2154fa93a6319'
    'dev-monopoly.svg'    = 'card_monopoly.dfac189aaff62e271093'
    'dev-roadbuilding.svg'= 'card_roadbuilding.994e8f21698ce6c350bd'
    'dev-victory.svg'     = 'card_vp.672597308e3a8f1100ae'
    'dev-plenty.svg'      = 'card_yearofplenty.3df210b5455b7438db09'
}

foreach ($file in $assets.Keys) {
    $url = 'https://cdn.colonist.io/dist/assets/' + $assets[$file] + '.svg'
    $path = Join-Path $target $file
    Write-Host "Downloading $file ..."
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing
    $content = $response.Content
    [xml]$svg = $content
    if ($svg.DocumentElement.LocalName -ne 'svg') { throw "$file is not an SVG document." }
    if ($svg.SelectNodes("//*[local-name()='script' or local-name()='foreignObject']").Count -gt 0) {
        throw "$file contains executable or embedded HTML content."
    }
    foreach ($element in $svg.SelectNodes('//*')) {
        foreach ($attribute in $element.Attributes) {
            if ($attribute.Name -like 'on*') { throw "$file contains an event handler." }
        }
    }
    [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $entry = [pscustomobject]@{
        file = $file
        source = $url
        sha256 = $hash
        viewBox = $svg.DocumentElement.GetAttribute('viewBox')
        retrieved = (Get-Date).ToString('yyyy-MM-dd')
    }
    $manifest.assets = @($manifest.assets | Where-Object { $_.file -ne $file }) + $entry
}

[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Write-Host 'Development cards imported. Refresh the game to load them.' -ForegroundColor Green
