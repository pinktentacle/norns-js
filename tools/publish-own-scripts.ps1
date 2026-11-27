# E9-278 -- publish the LIST of the scripts made for norns-js, so that a new one needs no release.
#
#   .\tools\publish-own-scripts.ps1            SHOW what would be published
#   .\tools\publish-own-scripts.ps1 -Push      publish it
#
# Each script is its own public repository (pinktentacle/poche, ...). The page
# reads the list of them from pinktentacle/norns-js-scripts first
# (src/community/own-scripts.ts, OWN_LIST) and installs a listed script from
# its own repository, as it installs any catalogue script; the copy in its
# own build is only for when GitHub cannot be reached. That repository holds
# the list and nothing else: index.json -- public\own-scripts\index.json, as
# tools/build-own-scripts.mjs writes it, naming each script's repository and
# cover -- and a README. No script file is published here.
#
# Every copy of the page (the site, the portable copy, the desktop app) offers
# what the list names the next time it starts; raw.githubusercontent.com may
# take a few minutes to show a new list.
#
# TO ADD A SCRIPT: publish its own repository, put it in norns-scripts/<name>/,
# name it in tools/own-scripts.json ("repo" when it is not
# github.com/<author>/<name>), run `node tools/build-own-scripts.mjs --write`,
# then this with -Push. Commit public/own-scripts/ too, so the next build
# carries the same copy.
#
# BEFORE ANYTHING IS SENT, every listed repository is checked from outside,
# with no login: its <name>.lua and its cover must answer. A list naming a
# private or missing repository is refused, not published.
#
# The first -Push creates the list's repository, public, if it is not there.
# It needs `gh` logged in with the right to push to it. Commits are made as
# John Doe, as every commit of this project is.

param(
  [switch] $Push,
  [string] $Repo = "pinktentacle/norns-js-scripts",
  [string] $Work = (Join-Path ([System.IO.Path]::GetTempPath()) "norns-js-scripts-publish")
)

# Not "Stop": Windows PowerShell 5.1 turns a native command's stderr into a
# terminating error under it, and gh and git both talk on stderr. Every
# native call below checks $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
function Die([string] $m) { Write-Host ""; Write-Host "  $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Step([string] $m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Say([string] $m) { Write-Host "  $m" -ForegroundColor DarkGray }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$IndexFile = Join-Path $Root "public\own-scripts\index.json"
if (-not (Test-Path $IndexFile)) { Die "no public\own-scripts\index.json in $Root." }

Step "the list"
# Only where the scripts' working folder is (it is not in the repository):
# an index behind it would publish an old list.
if (Test-Path (Join-Path $Root "norns-scripts")) {
  Push-Location $Root
  try { $report = (& node tools/build-own-scripts.mjs 2>&1 | Out-String) } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Write-Host $report; Die "build-own-scripts could not read norns-scripts." }
  if ($report -match "run with --write") {
    Write-Host $report -ForegroundColor DarkGray
    Die "public\own-scripts is behind norns-scripts. Run: node tools/build-own-scripts.mjs --write"
  }
  Say "public\own-scripts matches norns-scripts."
} else {
  Say "no norns-scripts here: publishing public\own-scripts\index.json as committed."
}
$indexText = [System.IO.File]::ReadAllText($IndexFile)
$index = $indexText | ConvertFrom-Json
$scripts = @($index.scripts)
if ($scripts.Count -eq 0) { Die "index.json names no script." }

Step "each script's repository, from outside"
$bad = @()
foreach ($s in $scripts) {
  $m = [regex]::Match([string]$s.repo, '^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?$')
  if (-not $m.Success) { $bad += "$($s.name): no GitHub repository in the list ($($s.repo))"; continue }
  $raw = "https://raw.githubusercontent.com/$($m.Groups[1].Value)/$($m.Groups[2].Value)/HEAD"
  if (-not $s.cover) { $bad += "$($s.name): no cover in the list"; continue }
  $missing = @()
  foreach ($f in @("$($s.name).lua", [string]$s.cover)) {
    try {
      $r = Invoke-WebRequest -Uri "$raw/$f" -Method Head -UseBasicParsing -TimeoutSec 30
      if ($r.StatusCode -ne 200) { $missing += $f }
    } catch { $missing += $f }
  }
  if ($missing.Count -gt 0) { $bad += "$($s.name): $($s.repo) does not answer for $($missing -join ', ') (private, missing, or not pushed?)" }
  else { Say "$($s.name)  $($s.repo)" }
}
if ($bad.Count -gt 0) {
  foreach ($b in $bad) { Write-Host "  $b" -ForegroundColor Red }
  Die "the list names something nobody could install. Nothing was published."
}

Step "github"
$gh = $null
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { $gh = "gh is not installed (https://cli.github.com)." }
else {
  $null = & gh auth status 2>&1
  if ($LASTEXITCODE -ne 0) { $gh = "gh is not logged in. Run: gh auth login" }
}
if ($null -ne $gh) {
  if ($Push) { Die $gh }
  # Showing what would go needs no GitHub: carry on as if it were empty.
  Say "$gh -- showing what would be published as if $Repo were empty."
  $exists = $false
} else {
  $null = & gh repo view $Repo --json name 2>&1
  $exists = ($LASTEXITCODE -eq 0)
  if ($exists) { Say "$Repo is there." }
  elseif ($Push) {
    Say "creating $Repo, public ..."
    & gh repo create $Repo --public --disable-wiki --disable-issues --description "The list of the scripts made for norns-js, which its script store reads" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "gh repo create failed." }
    $exists = $true
  } else {
    Say "$Repo does not exist yet: -Push creates it, public."
  }
}

Step "the copy"
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction Stop }
if ($exists) {
  & git -c core.autocrlf=false clone --quiet "https://github.com/$Repo.git" $Work 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "git clone of $Repo failed." }
} else {
  New-Item -ItemType Directory -Force $Work | Out-Null
  & git -C $Work init --quiet | Out-Null
}
# The list and its README, and nothing else: whatever else is there goes.
Get-ChildItem $Work -Force | Where-Object { $_.Name -ne ".git" } | Remove-Item -Recurse -Force -ErrorAction Stop
[System.IO.File]::WriteAllText((Join-Path $Work "index.json"), $indexText)
$lines = @(
  "# norns-js-scripts",
  "",
  "The list of the scripts made for [norns-js](https://github.com/pinktentacle/norns-js), which its script store",
  "reads: ``index.json``. Each script is its own repository, named in the list, and the store installs it from there.",
  "",
  "Written by ``tools/publish-own-scripts.ps1`` in norns-js; changes made here are overwritten.",
  ""
)
foreach ($s in $scripts) { $lines += "- [$($s.name)]($($s.repo)) -- $($s.description)" }
$lines += ""
[System.IO.File]::WriteAllText((Join-Path $Work "README.md"), ($lines -join "`n"))

& git -C $Work -c core.autocrlf=false add -A
$changes = @(& git -C $Work -c core.autocrlf=false status --porcelain)
if ($changes.Count -eq 0) {
  Say "nothing to publish: $Repo already has exactly this list."
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
  exit 0
}
$changes | ForEach-Object { Say "  $_" }
$unexpected = @($changes | Where-Object { $_ -notmatch '\s(index\.json|README\.md)$' })
if ($unexpected.Count -gt 0) { Die ("only index.json and README.md may be published here, not: " + ($unexpected -join ", ")) }

if (-not $Push) {
  Write-Host ""
  Write-Host "  nothing sent. Run again with -Push to publish." -ForegroundColor Yellow
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
  exit 0
}

Step "publish"
& git -C $Work -c core.autocrlf=false -c user.name="John Doe" -c user.email="john.doe@example.com" commit --quiet -m ("list: " + (($scripts | ForEach-Object { $_.name }) -join ", "))
if ($LASTEXITCODE -ne 0) { Die "git commit failed." }
& git -C $Work branch -M main
if (-not ((& git -C $Work remote) -contains "origin")) { & git -C $Work remote add origin "https://github.com/$Repo.git" }
& git -C $Work push --quiet origin main 2>&1 | ForEach-Object { Say "$_" }
if ($LASTEXITCODE -ne 0) { Die "git push failed." }
Say "published. The page reads https://raw.githubusercontent.com/$Repo/main/index.json"
Say "(raw.githubusercontent.com may show the old list for a few minutes)."
Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
