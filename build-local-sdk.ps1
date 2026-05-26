param(
    [switch]$InstallDeps,
    [string]$Version,
    [switch]$Latest
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Test-Path (Join-Path $repoRoot "package.json"))) {
    throw "Could not find package.json in SDK repo: $repoRoot"
}

if ($Version -and $Latest) {
    throw "Use either -Version or -Latest, not both."
}

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    throw "npm was not found in PATH. Install Node.js (includes npm), then retry."
}

function Invoke-BuildInPath {
    param(
        [string]$Path,
        [switch]$AlwaysInstallDeps
    )

    if ($AlwaysInstallDeps -or -not (Test-Path (Join-Path $Path "node_modules"))) {
        Write-Host "Installing SDK dependencies in $Path ..."
        Push-Location $Path
        try {
            npm install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
    }

    Write-Host "Building SDK in $Path ..."
    Push-Location $Path
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not $Version -and -not $Latest) {
    Invoke-BuildInPath -Path $repoRoot -AlwaysInstallDeps:$InstallDeps
    Write-Host "SDK build completed successfully from current checkout."
    exit 0
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    throw "git was not found in PATH. It is required for -Version and -Latest modes."
}

Push-Location $repoRoot
try {
    if ($Latest) {
        $resolvedTag = (git tag --list "v*" --sort=-v:refname | Select-Object -First 1)
        if (-not $resolvedTag) {
            throw "No version tags found (expected tags like v0.1.7)."
        }
    }
    else {
        if ($Version.StartsWith("v")) {
            $resolvedTag = $Version
        }
        else {
            $resolvedTag = "v$Version"
        }
    }

    $exists = (git tag --list $resolvedTag)
    if (-not $exists) {
        throw "Tag not found in shimmer-web-sdk repo: $resolvedTag"
    }
}
finally {
    Pop-Location
}

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "shimmer-web-sdk-build"
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
$worktreePath = Join-Path $tmpRoot ([Guid]::NewGuid().ToString())

Push-Location $repoRoot
try {
    Write-Host "Creating temporary worktree at tag $resolvedTag ..."
    git worktree add --detach $worktreePath $resolvedTag | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "git worktree add failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

try {
    Invoke-BuildInPath -Path $worktreePath -AlwaysInstallDeps:$true

    $builtDist = Join-Path $worktreePath "dist"
    $targetDist = Join-Path $repoRoot "dist"
    if (-not (Test-Path $builtDist)) {
        throw "Built dist folder not found: $builtDist"
    }

    New-Item -ItemType Directory -Path $targetDist -Force | Out-Null
    Copy-Item -Path (Join-Path $builtDist "*") -Destination $targetDist -Recurse -Force
    Write-Host "SDK build completed successfully from tag $resolvedTag and copied to $targetDist"
}
finally {
    Push-Location $repoRoot
    try {
        git worktree remove $worktreePath --force | Out-Null
    }
    finally {
        Pop-Location
    }
}
