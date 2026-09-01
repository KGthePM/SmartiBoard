$ErrorActionPreference = 'Stop'

# Clone-and-run entry point for native Windows.
# Matches start.sh: use Node 22-26, install dependencies when needed, then run dev.

Set-Location -LiteralPath $PSScriptRoot

$NodeVersion = '24.20.0'
$NodeDir = '.node'
$MinMajor = 22
$MaxMajor = 26

function Say($Message) {
  Write-Host $Message
}

function Die($Message) {
  [Console]::Error.WriteLine('')
  [Console]::Error.WriteLine($Message)
  [Console]::Error.WriteLine('')
  exit 1
}

$Lan = $env:SMARTI_LAN
foreach ($Arg in $args) {
  switch ($Arg) {
    '--lan' { $Lan = '1' }
    default {
      Die "Unknown option: $Arg`nUsage: .\start.ps1 [--lan]`n`n  --lan    also serve to other devices on this network (see README)"
    }
  }
}

function Node-Major($NodePath) {
  try {
    $Major = & $NodePath -e "console.log(process.versions.node.split('.')[0])" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return [int]$Major
  } catch {
    return $null
  }
}

function Supported($Major) {
  return $null -ne $Major -and $Major -ge $MinMajor -and $Major -le $MaxMajor
}

function Bootstrap-Node {
  $Arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $Arch) { $Arch = $env:PROCESSOR_ARCHITECTURE }

  switch ($Arch) {
    'AMD64' { $Cpu = 'x64' }
    'x86_64' { $Cpu = 'x64' }
    'ARM64' { $Cpu = 'arm64' }
    'aarch64' { $Cpu = 'arm64' }
    default {
      Die "Unsupported CPU: $Arch`nInstall Node $MinMajor+ yourself, then: npm install && npm run dev"
    }
  }

  $Name = "node-v$NodeVersion-win-$Cpu"
  $Url = "https://nodejs.org/dist/v$NodeVersion/$Name.zip"
  $Tmp = '.node-tmp'
  $Zip = Join-Path $Tmp "$Name.zip"

  Say "No suitable Node found. Downloading Node $NodeVersion (win-$Cpu, ~30 MB)..."
  Say "It goes in .\$NodeDir; nothing outside this folder is modified."

  if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $Tmp | Out-Null

  try {
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
  } catch {
    if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force }
    Die "Download failed: $Url"
  }

  $Sums = Join-Path $Tmp 'SHASUMS256.txt'
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $Sums -UseBasicParsing
    $Expected = (Select-String -LiteralPath $Sums -Pattern " $Name.zip`$" | Select-Object -First 1).Line.Split(' ')[0]
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLowerInvariant()
    if ($Expected -and $Actual -and $Expected.ToLowerInvariant() -ne $Actual) {
      Remove-Item -LiteralPath $Tmp -Recurse -Force
      Die 'Checksum mismatch on the Node download; refusing to use it.'
    }
    if ($Actual) { Say 'Checksum verified.' }
  } catch {
    Say 'Could not verify checksum; continuing with the downloaded archive.'
  }

  Say 'Unpacking...'
  try {
    Expand-Archive -LiteralPath $Zip -DestinationPath $Tmp -Force
  } catch {
    if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force }
    Die 'Could not unpack the Node archive.'
  }

  if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $Tmp $Name) -Destination $NodeDir
  Remove-Item -LiteralPath $Tmp -Recurse -Force
  Say "Node $NodeVersion ready in .\$NodeDir"
}

$BootNode = Join-Path $NodeDir 'node.exe'
$BootMajor = if (Test-Path -LiteralPath $BootNode) { Node-Major $BootNode } else { $null }

if (Supported $BootMajor) {
  Say "Using bootstrapped Node $(& $BootNode -v) from .\$NodeDir"
  $env:PATH = "$(Resolve-Path -LiteralPath $NodeDir);$env:PATH"
} else {
  $SystemNode = Get-Command node -ErrorAction SilentlyContinue
  $SystemMajor = if ($SystemNode) { Node-Major $SystemNode.Source } else { $null }
  if (Supported $SystemMajor) {
    Say "Using system Node $(& $SystemNode.Source -v)"
  } else {
    Bootstrap-Node
    $env:PATH = "$(Resolve-Path -LiteralPath $NodeDir);$env:PATH"
  }
}

$NeedsInstall = -not (Test-Path -LiteralPath 'node_modules' -PathType Container)
if (-not $NeedsInstall -and (Test-Path -LiteralPath 'package-lock.json' -PathType Leaf)) {
  $NeedsInstall = (Get-Item -LiteralPath 'package-lock.json').LastWriteTimeUtc -gt (Get-Item -LiteralPath 'node_modules').LastWriteTimeUtc
}

if ($NeedsInstall) {
  Say 'Installing dependencies...'
  & npm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (Test-Path -LiteralPath 'node_modules' -PathType Container) {
  & node -e "require('better-sqlite3')" *> $null
  if ($LASTEXITCODE -ne 0) {
    Say 'Existing dependencies were built for a different Node; reinstalling...'
    Remove-Item -LiteralPath 'node_modules' -Recurse -Force
    & npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

Say ''
if ($Lan) {
  $LanIp = (& node -e "const nets = require('os').networkInterfaces(); for (const list of Object.values(nets)) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) { console.log(n.address); process.exit(0); }" 2>$null)

  Say 'Starting Smarti Board on http://localhost:3000'
  if ($LanIp) {
    Say "  ...and on http://$LanIp`:3000 for other devices on this network"
  } else {
    Say '  ...and on the LAN address of this machine, port 3000 (could not detect which)'
  }
  Say ''
  Say '  !  No password. Anyone who can reach that address can read and edit'
  Say '  !  every board, and spend whatever model provider key you configured.'
  Say '  !  Use it on a network you trust.'
  Say ''
  $env:SMARTI_HOST = '0.0.0.0'
  & npm run dev
  exit $LASTEXITCODE
}

Say 'Starting Smarti Board on http://localhost:3000'
Say ''
& npm run dev
exit $LASTEXITCODE
