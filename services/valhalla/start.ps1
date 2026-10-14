$ErrorActionPreference = 'Stop'
$serviceRoot = $PSScriptRoot
$configPath = Join-Path $serviceRoot 'data\valhalla.json'
$packageRoot = Join-Path $serviceRoot '.venv\Lib\site-packages'
$serviceExe = Join-Path $packageRoot 'valhalla\bin\valhalla_service.exe'
$logRoot = Join-Path $serviceRoot 'logs'

try {
    $health = Invoke-RestMethod 'http://127.0.0.1:8002/status' -TimeoutSec 3
    if ($health.version -and $health.available_actions -contains 'route') {
        Write-Host "Valhalla $($health.version) is already running at http://localhost:8002"
        exit 0
    }
} catch { }

if (!(Test-Path -LiteralPath $serviceExe) -or !(Test-Path -LiteralPath (Join-Path $serviceRoot 'data\build-info.json'))) {
    throw 'Valhalla or Taiwan routing data is missing. See services/valhalla/README.md for setup.'
}
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
# Keep the routing service local to this computer. The web backend calls it.
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config.httpd.service.listen = 'tcp://127.0.0.1:8002'
$config.httpd.service.timeout_seconds = 30
$config.logging.color = $false
$configText = $config | ConvertTo-Json -Depth 32
[IO.File]::WriteAllText($configPath, $configText, (New-Object Text.UTF8Encoding $false))
$originalPath = $env:PATH
try {
    $env:PATH = (Join-Path $packageRoot 'pyvalhalla.libs') + ';' + $originalPath
    $serviceProcess = Start-Process -FilePath $serviceExe -ArgumentList ('"' + $configPath + '" 2') -WorkingDirectory $serviceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'service.stdout.log') -RedirectStandardError (Join-Path $logRoot 'service.stderr.log') -PassThru
} finally {
    $env:PATH = $originalPath
}
@{ pid = $serviceProcess.Id; startedAt = $serviceProcess.StartTime.ToUniversalTime().Ticks.ToString(); executable = $serviceExe } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logRoot 'service-process.json')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($serviceProcess.HasExited) { throw 'Valhalla stopped during startup. Check services/valhalla/logs/service.stderr.log.' }
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8002/status' -TimeoutSec 2
        if ($health.version -and $health.available_actions -contains 'route') {
            Write-Host "Valhalla $($health.version) is ready at http://localhost:8002 (PID $($serviceProcess.Id))."
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw 'Valhalla has not responded yet. Check services/valhalla/logs/service.stdout.log.'
