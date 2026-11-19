$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:DOTNET_CLI_HOME = Join-Path $PSScriptRoot '.cache\dotnet'
$env:NUGET_PACKAGES = Join-Path $PSScriptRoot '.cache\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
& npm.cmd --prefix pose_studio ci --no-audit --no-fund --cache (Join-Path $PSScriptRoot '.cache\npm')
if ($LASTEXITCODE -ne 0) { throw 'Pose Studio dependency installation failed.' }
& npm.cmd --prefix pose_studio run build
if ($LASTEXITCODE -ne 0) { throw 'Pose Studio web build failed.' }
& dotnet build pose_studio/host/PoseStudio.csproj -c Release -o (Join-Path $PSScriptRoot 'build\pose-studio')
if ($LASTEXITCODE -ne 0) { throw 'Pose Studio desktop build failed.' }
