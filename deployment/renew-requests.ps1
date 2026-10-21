$ErrorActionPreference = 'Stop'
$nginxRoot = 'C:\Users\Plex\Desktop\New folder\nginx-1.27.5'
$certRoot = 'C:\Users\Plex\Documents\ChatGPT\Whtool\live-https'
docker run --rm -v "${certRoot}:/workspace" certbot/certbot:latest renew --cert-name requests.peakdecline.com --webroot --webroot-path /workspace/acme --config-dir /workspace/letsencrypt --work-dir /workspace/work --logs-dir /workspace/logs --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Certificate renewal failed' }
$archive = Join-Path $certRoot 'letsencrypt\archive\requests.peakdecline.com'
foreach ($entry in @(@('fullchain','chain'),@('privkey','key'))) {
    $stem = $entry[0]
    $latest = Get-ChildItem -LiteralPath $archive -Filter "$stem*.pem" | Sort-Object { [int]($_.BaseName.Substring($stem.Length)) } | Select-Object -Last 1
    $target = Join-Path $nginxRoot "ssl\requests.peakdecline.com-$($entry[1]).pem"
    if ((Get-FileHash -LiteralPath $latest.FullName).Hash -ne (Get-FileHash -LiteralPath $target).Hash) {
        Copy-Item -LiteralPath $latest.FullName -Destination $target
        $changed = $true
    }
}
if ($changed) {
    Push-Location $nginxRoot
    try {
        & '.\nginx.exe' -t
        if ($LASTEXITCODE -ne 0) { throw 'Nginx certificate validation failed' }
        & '.\nginx.exe' -s reload
        if ($LASTEXITCODE -ne 0) { throw 'Nginx reload failed' }
    } finally { Pop-Location }
}