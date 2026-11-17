#Requires -Version 5.1
<#
.SYNOPSIS
  Put the tools norns-js needs on a Windows machine, and nothing else.

.DESCRIPTION
  E9-77. Two machines are involved in publishing this and they need very
  different things, so this takes a role:

    -Role publish   git and Node. Enough to make the repository, push it, and
                    run `npx wrangler pages deploy`. A few hundred MB.
    -Role build     the whole WebAssembly toolchain as well: Python, a CMake
                    that is NOT too new, Ninja, and emscripten 4.0.18 cloned
                    into third_party/emsdk. About 3 GB and a long afternoon.

  IT CHECKS BEFORE IT INSTALLS, every time, and it prints what it found. A
  setup script that reinstalls what is already there is a setup script nobody
  runs twice.

  WRITTEN FOR POWERSHELL 5.1, which is what a fresh Windows has. No `&&`, no
  ternary, no null-coalescing — the point is to run on a machine that has had
  nothing done to it yet, including the install of PowerShell 7.

  NOTHING IS PARSED OUT OF WINGET. Its output is localised: on the machine
  this was written on it says "Trouvé Git [Git.Git]". Every decision here is
  made from `Get-Command` and from exit codes, which do not change language.

.PARAMETER Role
  publish (default) or build.

.PARAMETER DryRun
  Say what would be installed and install nothing.

.EXAMPLE
  .\tools\setup-windows.ps1
  .\tools\setup-windows.ps1 -Role build
  .\tools\setup-windows.ps1 -Role build -DryRun
#>
[CmdletBinding()]
param(
  [ValidateSet("publish", "build")]
  [string] $Role = "publish",
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$script:Repo = Split-Path -Parent $PSScriptRoot
$script:Failed = @()
$script:Installed = @()
$script:Pending = @()

# --- saying things ---------------------------------------------------------

function Say([string] $text, [string] $colour = "Gray") {
  Write-Host $text -ForegroundColor $colour
}
function Head([string] $text) {
  Write-Host ""
  Write-Host $text -ForegroundColor White
  Write-Host ("-" * 74) -ForegroundColor DarkGray
}
function Ok([string] $what, [string] $detail) {
  Write-Host ("  [ok]   {0,-12} {1}" -f $what, $detail) -ForegroundColor Green
}
function Act([string] $what, [string] $detail) {
  Write-Host ("  [...]  {0,-12} {1}" -f $what, $detail) -ForegroundColor Yellow
}
function Bad([string] $what, [string] $detail) {
  Write-Host ("  [NO]   {0,-12} {1}" -f $what, $detail) -ForegroundColor Red
  $script:Failed += $what
}

# --- finding things --------------------------------------------------------

# A new install does not reach a shell that was already open. Re-reading both
# halves of the registry PATH is the difference between "install, then tell
# the user to open a new window" and a script that just carries on.
function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ";"
}

function Get-Exe([string] $name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($null -eq $c) { return $null }
  # Get-Command finds aliases and functions too; only a real file is a tool.
  if ($c.CommandType -ne "Application") { return $null }
  return $c.Source
}

# The first dotted number anywhere in `<tool> --version`. Every tool here
# prints one; none of them print it in the same place.
function Get-ToolVersion([string] $exe, [string[]] $toolArgs) {
  try {
    $raw = & $exe @toolArgs 2>&1 | Out-String
  } catch {
    return $null
  }
  $m = [regex]::Match($raw, "(\d+)\.(\d+)(\.(\d+))?")
  if (-not $m.Success) { return $null }
  $patch = "0"
  if ($m.Groups[4].Success) { $patch = $m.Groups[4].Value }
  return [version]("{0}.{1}.{2}" -f $m.Groups[1].Value, $m.Groups[2].Value, $patch)
}

function Install-WithWinget([string] $id, [string] $version) {
  if ($DryRun) {
    Act $id "would install (dry run)"
    $script:Pending += $id
    return $false
  }
  $wingetArgs = @(
    "install", "--id", $id, "--exact", "--silent",
    "--accept-package-agreements", "--accept-source-agreements",
    "--disable-interactivity"
  )
  if ($version) { $wingetArgs += @("--version", $version) }
  Act $id "winget install"
  & winget @wingetArgs
  $code = $LASTEXITCODE
  # winget returns a large negative number for "already installed", which is
  # a success for our purposes and not an error worth stopping on.
  if ($code -ne 0) {
    Say ("         winget exit {0} — continuing, the check below decides" -f $code) "DarkGray"
  }
  Update-PathFromRegistry
  $script:Installed += $id
  return $true
}

# --- the tools -------------------------------------------------------------

function Require-Tool {
  param(
    [string] $Name,
    [string] $Exe,
    [string[]] $VersionArgs = @("--version"),
    [version] $Minimum = $null,
    [version] $Below = $null,
    [string] $WingetId = $null,
    [string] $WingetVersion = $null,
    [string] $Why = ""
  )

  $path = Get-Exe $Exe
  if ($null -ne $path) {
    $v = Get-ToolVersion $path $VersionArgs

    # A TOOL THAT WILL NOT SAY ITS VERSION IS NOT A TOOL.
    #
    # E9-82, found on a real machine and not here. Windows plants App
    # Execution Aliases in `…\AppData\Local\Microsoft\WindowsApps` — zero-byte
    # stubs that Get-Command reports as an Application. `python.exe` is one
    # of them, and running it prints "Python est introuvable ; exécutez sans
    # arguments à installer à partir du Microsoft Store" and exits.
    #
    # This used to let it through: `$v` came back null, a null is not less
    # than the minimum, so the check passed and the panel said `[ok] python`.
    # Then `emsdk install` ran, called python, got the Store advertisement,
    # and failed 2 GB into the afternoon with nothing pointing at the cause.
    if ($null -eq $v) {
      if (Test-StoreStub $path) {
        Act $Name "is the Microsoft Store placeholder, not $Exe"
      } else {
        Act $Name ("at {0}, but it will not report a version" -f $path)
      }
    } else {
      $tooOld = ($null -ne $Minimum -and $v -lt $Minimum)
      $tooNew = ($null -ne $Below -and $v -ge $Below)
      if (-not $tooOld -and -not $tooNew) {
        Ok $Name ("{0}  {1}" -f $v, $path)
        return
      }
      if ($tooNew) {
        Bad $Name ("{0} is too new — {1}" -f $v, $Why)
        return
      }
      Act $Name ("{0} is below {1} — upgrading" -f $v, $Minimum)
    }
  } else {
    Act $Name "not found"
  }

  if ($null -eq $WingetId) {
    Bad $Name $Why
    return
  }
  $did = Install-WithWinget $WingetId $WingetVersion
  if (-not $did) { return }

  $path = Get-Exe $Exe
  if ($null -eq $path) {
    Bad $Name "installed, but $Exe is still not on PATH — open a new terminal and run this again"
    return
  }
  $v = Get-ToolVersion $path $VersionArgs
  if ($null -eq $v) {
    if (Test-StoreStub $path) {
      # Installing a real Python does not remove the alias, and the alias
      # sits in a PATH entry Windows puts early. Turning it off is a
      # Settings toggle and there is no way to do it from here.
      Bad $Name ("installed, but $Exe still resolves to the Microsoft Store placeholder at $path. " +
        "Turn it off: Settings > Apps > Advanced app settings > App execution aliases, " +
        "switch off both $Exe entries, then open a new terminal and run this again")
    } else {
      Bad $Name ("installed, but $path will not report a version")
    }
    return
  }
  if ($null -ne $Minimum -and $v -lt $Minimum) {
    Bad $Name ("{0} is still below {1}" -f $v, $Minimum)
    return
  }
  Ok $Name ("{0}  {1}" -f $v, $path)
}

<#
  An App Execution Alias: a zero-byte reparse point under WindowsApps that
  Windows swaps for a Store advertisement when you run it. `python.exe` and
  `python3.exe` are there on every stock Windows 11, and they come before a
  real install on PATH.
#>
function Test-StoreStub([string] $path) {
  if ($path -notlike "*\WindowsApps\*") { return $false }
  try {
    return ((Get-Item $path -Force).Length -eq 0)
  } catch {
    return $true
  }
}

# --- what is already in Windows -------------------------------------------

function Test-BuiltIn {
  Head "Already in Windows 10 and 11"

  $tar = Get-Exe "tar"
  if ($null -ne $tar) { Ok "tar" $tar } else { Bad "tar" "expected at C:\Windows\System32\tar.exe on Windows 10 1803 and later" }

  $curl = Get-Exe "curl.exe"
  if ($null -ne $curl) {
    Ok "curl.exe" $curl
    Say '         in PowerShell curl alone is an alias for Invoke-WebRequest. Always curl.exe.' 'DarkGray'
  } else {
    Bad "curl.exe" "expected at C:\Windows\System32\curl.exe"
  }

  $winget = Get-Exe "winget"
  if ($null -ne $winget) {
    Ok "winget" $winget
  } else {
    Bad "winget" "install App Installer from the Microsoft Store, then run this again"
  }

  $ps = $PSVersionTable.PSVersion
  if ($ps.Major -ge 7) {
    Ok "powershell" ("{0}" -f $ps)
  } else {
    Say ("  [--]   {0,-12} {1} — this script is 5.1 and runs; the publishing runbook assumes 7" -f "powershell", $ps) "DarkYellow"
    if ($null -ne (Get-Exe "winget")) {
      Install-WithWinget "Microsoft.PowerShell" $null | Out-Null
      Say '         installed - reopen the terminal as pwsh when this finishes' 'DarkGray'
    }
  }
}

# --- emscripten ------------------------------------------------------------

# 4.0.18 is not a preference. PINS.md: an older one fails in ways that
# read as bugs in this project rather than as a version skew.
$script:EmsdkCommit = "d7b4130688bf"
$script:EmscriptenVersion = "4.0.18"

function Install-Emsdk {
  Head "emscripten $script:EmscriptenVersion"

  $emsdk = Join-Path $script:Repo "third_party\emsdk"
  $emcc = Join-Path $emsdk "upstream\emscripten\emcc.bat"
  $stamp = Join-Path $emsdk "upstream\emscripten\emscripten-version.txt"

  if (Test-Path $emcc) {
    $have = ""
    if (Test-Path $stamp) { $have = (Get-Content $stamp -Raw).Trim().Trim('"') }
    if ($have -eq $script:EmscriptenVersion) {
      Ok "emcc" ("{0}  {1}" -f $have, $emcc)
      return
    }
    Act "emcc" ("have {0}, want {1}" -f $have, $script:EmscriptenVersion)
  }

  if ($DryRun) {
    Act "emsdk" "would clone into third_party\emsdk and install $script:EmscriptenVersion (about 2 GB)"
    return
  }

  # ASKED BEFORE THE 2 GB, not after.
  #
  # E9-82, measured on a real machine: the clone and the checkout succeeded,
  # `install 4.0.18` printed "Python est introuvable ; exécutez sans
  # arguments à installer à partir du Microsoft Store", and the only clue
  # was a message about something else entirely, two gigabytes in.
  $py = Get-Exe "python"
  $pyVersion = $null
  if ($null -ne $py) { $pyVersion = Get-ToolVersion $py @("--version") }
  if ($null -eq $pyVersion) {
    if ($null -ne $py -and (Test-StoreStub $py)) {
      Bad "emsdk" ("python is the Microsoft Store placeholder, and emsdk needs a real one. " +
        "winget install --id Python.Python.3.13 -e, then run this again")
    } else {
      Bad "emsdk" "no working python, and emsdk needs one"
    }
    return
  }

  if (-not (Test-Path (Join-Path $emsdk ".git"))) {
    Act "emsdk" "git clone into third_party\emsdk"
    New-Item -ItemType Directory -Force -Path (Join-Path $script:Repo "third_party") | Out-Null
    & git clone https://github.com/emscripten-core/emsdk.git $emsdk
    if ($LASTEXITCODE -ne 0) { Bad "emsdk" "clone failed"; return }
  }

  # The pinned commit, so the SDK itself is the one PINS.md names.
  Push-Location $emsdk
  try {
    & git fetch --all --tags
    & git checkout $script:EmsdkCommit
    if ($LASTEXITCODE -ne 0) { Bad "emsdk" "checkout $script:EmsdkCommit failed"; return }

    # THROUGH emsdk.py WITH THE PYTHON WE FOUND, not through emsdk.bat.
    #
    # `emsdk.bat` looks for a python it bundles, and failing that does
    # `set EMSDK_PY=python` — from inside a `setlocal`, so an EMSDK_PY
    # exported from here is overwritten. On a machine where `python` on PATH
    # is the Store placeholder there is no way to tell it otherwise, and it
    # is a chicken and egg: `emsdk install python-3.9.2-64bit` would fix the
    # lookup and needs a python to run. Calling emsdk.py directly is what
    # the batch does on its last line anyway, with the one difference that
    # matters here: we choose the interpreter.
    #
    # What is skipped by not going through the .bat is `emsdk_set_env.bat`,
    # which exports EMSDK and EM_CONFIG into the calling shell. Nothing here
    # wants that: `tools/sclang/build.sh` finds emcc by path and sets
    # EM_CONFIG itself.
    Act "emsdk" "install $script:EmscriptenVersion with $py — this downloads about 2 GB"
    & $py "$emsdk\emsdk.py" install $script:EmscriptenVersion
    if ($LASTEXITCODE -ne 0) { Bad "emsdk" "install failed"; return }

    & $py "$emsdk\emsdk.py" activate $script:EmscriptenVersion
    if ($LASTEXITCODE -ne 0) { Bad "emsdk" "activate failed"; return }
  } finally {
    Pop-Location
  }

  if (Test-Path $emcc) {
    Ok "emcc" $emcc
    Say "         the build scripts find this by path, not by PATH — nothing to add to your profile" "DarkGray"
  } else {
    Bad "emcc" "not at $emcc after install"
  }
}

# --- the repository itself -------------------------------------------------

function Install-NodeModules {
  Head "the repository"

  $pkg = Join-Path $script:Repo "package.json"
  if (-not (Test-Path $pkg)) {
    Bad "package.json" "not at $pkg — run this from inside a checkout"
    return
  }
  Ok "repo" $script:Repo

  $modules = Join-Path $script:Repo "node_modules"
  if (Test-Path $modules) {
    Ok "node_modules" "present"
    return
  }
  # `ci` AND NOT `install` WHEN THERE IS A LOCKFILE. E9-95. `npm install`
  # resolves the ranges in package.json afresh and may write a different
  # lockfile; `npm ci` takes `package-lock.json` exactly as published and
  # fails if the two disagree. On a machine that is about to produce the
  # build other people download, resolving something newer than what was
  # tested is the wrong direction to be wrong in.
  $lock = Join-Path $script:Repo "package-lock.json"
  $cmd = "ci"
  if (-not (Test-Path $lock)) { $cmd = "install" }

  if ($DryRun) {
    Act "npm" ("would run npm " + $cmd)
    return
  }
  Act "npm" ("npm " + $cmd)
  Push-Location $script:Repo
  try {
    & npm $cmd
    if ($LASTEXITCODE -ne 0) {
      Bad "npm" ("npm " + $cmd + " failed")
    } else {
      Ok "node_modules" "installed"
    }
  } finally {
    Pop-Location
  }
}

# --- go --------------------------------------------------------------------

Write-Host ""
Write-Host "norns-js — Windows setup, role: $Role" -ForegroundColor Cyan
if ($DryRun) { Write-Host "DRY RUN — nothing will be installed" -ForegroundColor Magenta }

Update-PathFromRegistry
Test-BuiltIn

Head "Both roles"

Require-Tool -Name "git" -Exe "git" -Minimum ([version]"2.30.0") `
  -WingetId "Git.Git" `
  -Why "needed for everything, and Git for Windows is also where Git Bash comes from"

# Node: wrangler and tools/serve.mjs want 20 or newer; vitest 5.1 declares
# ^22.12 || ^24 || >=26, so a build machine needs 22. Read off the installed
# vitest rather than remembered.
$nodeMin = [version]"20.0.0"
if ($Role -eq "build") { $nodeMin = [version]"22.12.0" }
Require-Tool -Name "node" -Exe "node" -Minimum $nodeMin `
  -WingetId "OpenJS.NodeJS.LTS" `
  -Why "vitest 5.1 declares node ^22.12.0 || ^24.0.0 || >=26.0.0"

if ($Role -eq "publish") {
  # E9-78 — the GitHub CLI, so the forks and the release are commands rather
  # than a morning of clicking. Seven forks, a repository, a release and an
  # upload is seven web forms; `gh` makes it seven lines you can read back.
  Require-Tool -Name "gh" -Exe "gh" `
    -WingetId "GitHub.cli" `
    -Why "the publishing runbook drives the forks and the release through it"
}

if ($Role -eq "build") {
  Head "The WebAssembly toolchain"

  # 3.13, AND THE FLOOR IS 3.10. Both are read off emsdk rather than picked.
  #
  # This said 3.12 with a minimum of 3.8, and neither number came from
  # anywhere — which is the kind of guess this project exists to not make.
  # emsdk states its own floor and prints it:
  #
  #   emsdk.py:29   if sys.version_info < (3, 10):
  #                   print('error: emsdk requires python 3.10 or above')
  #
  # and emsdk.bat's FIRST choice is a python it bundles itself,
  # `python\3.13.3_64bit\python.exe` — so 3.13 is the version upstream ships
  # and tests against on Windows, which makes it the one to install. 3.14
  # exists in winget and works here, but nothing upstream has run against
  # it; being newer than the toolchain is how CMake 4 broke the build.
  Require-Tool -Name "python" -Exe "python" -Minimum ([version]"3.10.0") `
    -WingetId "Python.Python.3.13" `
    -Why "emsdk.py refuses below 3.10, and emsdk bundles 3.13.3 on Windows"

  # CMAKE 4.x IS TOO NEW and the build says so rather than failing deep in a
  # configure: SuperCollider's tree still declares cmake_minimum_required
  # below 3.5, and CMake 4 removed compatibility with it. So this is pinned,
  # and `winget install Kitware.CMake` with no version would break the build.
  Require-Tool -Name "cmake" -Exe "cmake" -Minimum ([version]"3.20.0") -Below ([version]"4.0.0") `
    -WingetId "Kitware.CMake" -WingetVersion "3.31.8" `
    -Why "SuperCollider declares cmake_minimum_required below 3.5 and CMake 4 dropped it — install 3.31.x"

  Require-Tool -Name "ninja" -Exe "ninja" `
    -WingetId "Ninja-build.Ninja" `
    -Why "SuperCollider's own build is used rather than hand-written em++ calls"

  # GIT BASH, FOUND BY ITS PATH ON DISK AND NOT BY PATH THE VARIABLE.
  #
  # `bash` on a Windows PATH is usually C:\Windows\System32\bash.exe, the WSL
  # launcher, because System32 comes first — measured on the machine this was
  # written on, which HAS Git Bash installed and still resolves `bash` to WSL.
  # The build scripts are run as `bash tools/sclang/build.sh`, so that is a
  # real trap and not a technicality: WSL has no emsdk, no cmake and none of
  # third_party/, and the failure reads as a broken build script.
  #
  # Git for Windows puts bash beside git, so git's own location is the answer.
  $gitExe = Get-Exe "git"
  $gitBash = $null
  if ($null -ne $gitExe) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitExe)
    $candidate = Join-Path $gitRoot "bin\bash.exe"
    if (Test-Path $candidate) { $gitBash = $candidate }
  }
  if ($null -eq $gitBash) {
    foreach ($c in @("C:\Program Files\Git\bin\bash.exe", "C:\Program Files (x86)\Git\bin\bash.exe")) {
      if ($null -eq $gitBash -and (Test-Path $c)) { $gitBash = $c }
    }
  }

  if ($null -ne $gitBash) {
    Ok "git bash" $gitBash
    $onPath = Get-Exe "bash"
    if ($null -ne $onPath -and $onPath -like "*System32*") {
      Say '         bash on your PATH is WSL, not this one. Run the stage-1 builds from' 'DarkYellow'
      Say '         a Git Bash window, or call the full path above.' 'DarkYellow'
    }
  } else {
    Bad "git bash" "not beside git. Reinstall Git for Windows; the build scripts need it and not WSL"
  }

  Install-Emsdk
}

Install-NodeModules

# --- what happened ---------------------------------------------------------

Head "Summary"

if ($script:Pending.Count -gt 0) {
  Write-Host ("  would install: {0}" -f ($script:Pending -join ", ")) -ForegroundColor Magenta
}
if ($script:Installed.Count -gt 0) {
  Say ("  installed: {0}" -f ($script:Installed -join ", "))
}

if ($script:Failed.Count -gt 0) {
  Write-Host ("  {0} unresolved: {1}" -f $script:Failed.Count, ($script:Failed -join ", ")) -ForegroundColor Red
  Write-Host ""
  Write-Host "  If anything says it is not on PATH, open a NEW terminal and run this again." -ForegroundColor DarkGray
  exit 1
}

Write-Host "  everything this role needs is present." -ForegroundColor Green
Write-Host ""
if ($Role -eq "publish") {
  # NAMED BY WHAT IT IS AND NOT BY ITS PATH. `docs/` is export-ignored, so
  # a clone of the published tree has no `12-PUBLISHING.md` to be sent to.
  Say "  Next: the publishing runbook, step 1. It is working material and is not" "DarkGray"
  Say "        in this repository — it stays with whoever is doing the publishing." "DarkGray"
} else {
  Say "  Next: .\tools\build-wasm.ps1 — the two build stages, in order." "DarkGray"
  Say "        -DryRun first: it says what it would build and what is already there." "DarkGray"
  Say "  third_party/ still needs its other sixteen trees — PINS.md." "DarkGray"
}
Write-Host ""
