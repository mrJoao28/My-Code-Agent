# Executado com pwsh no Windows e Linux, depois de bun run build.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$taskIsWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTemp = Join-Path ([IO.Path]::GetTempPath()) ('myagent-package-' + [guid]::NewGuid().ToString())
$taskOriginalPath = $env:PATH
$taskOriginalHome = $env:MYAGENT_HOME
$taskNpm = (Get-Command $(if ($taskIsWindows) { 'npm.cmd' } else { 'npm' }) -CommandType Application).Source
$taskNode = (Get-Command node -CommandType Application).Source
$taskManifest = Get-Content -Raw (Join-Path $taskRoot 'packages/myagent/package.json') | ConvertFrom-Json

try {
    New-Item -ItemType Directory -Path $taskTemp | Out-Null
    $taskPrefix = Join-Path $taskTemp 'install with spaces'
    $env:MYAGENT_HOME = Join-Path $taskTemp 'home'
    Push-Location (Join-Path $taskRoot 'packages/myagent')
    try {
        $taskPackOutput = & $taskNpm pack --json --ignore-scripts --pack-destination $taskTemp
        if ($LASTEXITCODE -ne 0) { throw 'npm pack falhou.' }
        $taskPack = @($taskPackOutput | ConvertFrom-Json)[0]
    } finally { Pop-Location }
    $taskExpected = @('README.md', 'package.json', 'bin/myagent.js', 'dist/cli.js', 'dist/grep-worker.js', 'dist/source-worker.js')
    if (Compare-Object ($taskExpected | Sort-Object) ($taskPack.files.path | Sort-Object)) {
        throw ('Conteúdo inesperado no tarball: ' + ($taskPack.files.path -join ', '))
    }
    $taskTarball = Join-Path $taskTemp $taskPack.filename
    Push-Location $taskTemp
    try {
        # A instalação também precisa funcionar sem Bun, inclusive os postinstalls.
        $taskNodeOnly = Join-Path $taskTemp 'node-only'
        New-Item -ItemType Directory -Path $taskNodeOnly | Out-Null
        Copy-Item -LiteralPath $taskNode -Destination (Join-Path $taskNodeOnly $(if ($taskIsWindows) { 'node.exe' } else { 'node' }))
        $taskWithoutBun = $taskOriginalPath -split [IO.Path]::PathSeparator | Where-Object {
            $_ -and !(Test-Path -LiteralPath (Join-Path $_ 'bun')) -and !(Test-Path -LiteralPath (Join-Path $_ 'bun.exe')) -and !(Test-Path -LiteralPath (Join-Path $_ 'bun.cmd'))
        }
        $env:PATH = (@($taskNodeOnly) + @($taskWithoutBun)) -join [IO.Path]::PathSeparator
        & $taskNpm install --global --prefix $taskPrefix --package-lock=false --no-audit --no-fund $taskTarball
        if ($LASTEXITCODE -ne 0) { throw 'A instalação do tarball falhou.' }
        $taskCommand = if ($taskIsWindows) { Join-Path $taskPrefix 'myagent.cmd' } else { Join-Path $taskPrefix 'bin/myagent' }
        $env:PATH = $taskOriginalPath
        $taskVersion = & $taskCommand --version
        if ($LASTEXITCODE -ne 0 -or "$taskVersion".Trim() -ne $taskManifest.version) { throw 'myagent --version falhou.' }
        & $taskCommand doctor
        if ($LASTEXITCODE -ne 0) { throw 'myagent doctor falhou.' }
        if (!(Test-Path (Join-Path $env:MYAGENT_HOME 'myagent.db'))) { throw 'doctor não criou o SQLite no home temporário.' }

        # O shim npm precisa encontrar Node, mas nenhum Bun; não alteramos o PATH real.
        if (!$taskIsWindows) {
            # Utilitários usados pelo shim POSIX do npm, sem disponibilizar outros runtimes.
            foreach ($taskUtility in @('dirname', 'sed', 'uname')) {
                New-Item -ItemType SymbolicLink -Path (Join-Path $taskNodeOnly $taskUtility) -Target (Get-Command $taskUtility -CommandType Application).Source | Out-Null
            }
        }
        $env:PATH = $taskNodeOnly
        $ErrorActionPreference = 'Continue'
        $taskMissing = (& $taskCommand --version 2>&1 | Out-String)
        $taskMissingExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($taskMissingExit -eq 0 -or $taskMissing -notmatch 'https://bun\.sh' -or $taskMissing -notmatch 'PATH') {
            throw ('Diagnóstico de Bun ausente falhou: ' + $taskMissing)
        }
        Write-Output "Pacote validado: 6 arquivos, versão $taskVersion, doctor e Bun ausente; shim $taskCommand."
    } finally { Pop-Location }
} finally {
    $env:PATH = $taskOriginalPath
    $env:MYAGENT_HOME = $taskOriginalHome
    # Apaga somente o diretório temporário exclusivo criado por este script.
    $taskResolved = [IO.Path]::GetFullPath($taskTemp)
    $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($taskResolved.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $taskResolved -Leaf) -like 'myagent-package-*') {
        if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force }
    }
}
