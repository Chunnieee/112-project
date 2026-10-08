$ErrorActionPreference = 'Stop'
$recordPath = Join-Path $PSScriptRoot 'logs\service-process.json'
if (!(Test-Path -LiteralPath $recordPath)) {
    Write-Host 'No Valhalla process was started by this project.'
    exit 0
}
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$serviceProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($serviceProcess) {
    if ($serviceProcess.Path -ne $record.executable -or $serviceProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startedAt) {
        throw 'The saved process ID belongs to another process; it will not be stopped.'
    }
    Stop-Process -Id $serviceProcess.Id
}
Remove-Item -LiteralPath $recordPath
Write-Host 'Valhalla stopped. Taiwan routing data has been kept.'
