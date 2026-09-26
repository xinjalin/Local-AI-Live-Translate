<#
  Local AI Live Translate - first-run setup.  Author: xinjalin.  License: MIT.

  Downloads what the server needs and checks every file against the hash pinned in
  tools\dependencies.json before using it:
    runtime\   a private, portable Python (python.org's NuGet package: no installer, no admin
               rights, nothing changed on the PC) plus the packages in server\requirements.txt
    models\    the speech models

  START_Local_AI_Live_Translate.bat runs this on every start. Anything already in place is skipped
  in well under a second, so after a `git pull` new or changed dependencies install themselves.

  Options:  -ModelsOnly   only the models
            -RuntimeOnly  only Python and its packages
#>
param([switch]$ModelsOnly, [switch]$RuntimeOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$Deps = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'dependencies.json') | ConvertFrom-Json
$Tmp = Join-Path $Root '.setup-tmp'
# Windows' own curl and tar (Windows 10 1803 and later), not ones from Git or other tools on PATH.
$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$Announced = $false

function Say([string]$text) {
    if (-not $script:Announced) {
        Write-Host ''
        Write-Host 'First run: downloading what Local AI Live Translate needs (one time, needs internet).'
        $script:Announced = $true
    }
    Write-Host "  - $text"
}

function Get-File([string]$url, [string]$dest) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    & $Curl -L --fail --retry 3 --retry-delay 3 --progress-bar -o $dest $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $url" }
}

function Assert-Hash([string]$file, [string]$algorithm, [string]$expected) {
    $actual = (Get-FileHash -Algorithm $algorithm -Path $file).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        Remove-Item -Force $file
        throw "Checksum mismatch for $(Split-Path -Leaf $file): expected $expected, got $actual. The download was removed; run again."
    }
}

function Install-Runtime {
    $python = Join-Path $Root 'runtime\python.exe'
    $venv = Join-Path $Root 'server\.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) {
        if (Test-Path $venv) { return }  # a developer setup (server\.venv) is used instead
        $py = $Deps.python
        Say "Python $($py.version) (portable, ~$($py.size_mb) MB)"
        $pkg = Join-Path $Tmp 'python.zip'  # a .nupkg is a zip file
        Get-File $py.url $pkg
        Assert-Hash $pkg 'SHA512' $py.sha512
        $unpacked = Join-Path $Tmp 'python'
        if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
        Expand-Archive -Path $pkg -DestinationPath $unpacked
        Move-Item -Path (Join-Path $unpacked 'tools') -Destination (Join-Path $Root 'runtime')
    }
    # Python packages: installed again whenever server\requirements.txt changes.
    $requirements = Join-Path $Root 'server\requirements.txt'
    $marker = Join-Path $Root 'runtime\.requirements-sha256'
    $wanted = (Get-FileHash -Algorithm SHA256 -Path $requirements).Hash
    if ((Test-Path $marker) -and ((Get-Content -Raw $marker).Trim() -eq $wanted)) { return }
    Say 'Python packages (sherpa-onnx, numpy, websockets, httpx, opencc; ~70 MB)'
    & $python -E -s -m ensurepip --upgrade 2>&1 | Out-Null
    & $python -E -s -m pip install --disable-pip-version-check --no-warn-script-location --only-binary=:all: -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Installing the Python packages failed.' }
    Set-Content -Path $marker -Value $wanted -Encoding Ascii
}

function Install-Models {
    foreach ($model in $Deps.models) {
        $missing = @($model.files | Where-Object { -not (Test-Path (Join-Path $Root $_.path)) })
        if ($missing.Count -eq 0) { continue }
        Say "$($model.name) (~$($model.size_mb) MB)"
        if ($model.archive) {
            $archive = Join-Path $Tmp (Split-Path -Leaf $model.archive.url)
            Get-File $model.archive.url $archive
            Assert-Hash $archive 'SHA256' $model.archive.sha256
            $target = Join-Path $Root $model.archive.extract_to
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            & $Tar -xjf $archive -C $target
            if ($LASTEXITCODE -ne 0) { throw "Unpacking $archive failed." }
            Remove-Item -Force $archive
            foreach ($file in $model.files) { Assert-Hash (Join-Path $Root $file.path) 'SHA256' $file.sha256 }
        } else {
            foreach ($file in $missing) {
                $part = Join-Path $Tmp (Split-Path -Leaf $file.path)
                Get-File $file.url $part
                Assert-Hash $part 'SHA256' $file.sha256
                $dest = Join-Path $Root $file.path
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
                Move-Item -Force -Path $part -Destination $dest
            }
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
    if (-not $ModelsOnly) { Install-Runtime }
    if (-not $RuntimeOnly) { Install-Models }
    if ($Announced) { Write-Host '  Done.'; Write-Host '' }
} catch {
    Write-Host ''
    Write-Host "[ERROR] Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check the internet connection and run START_Local_AI_Live_Translate.bat again.'
    exit 1
} finally {
    if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
}
