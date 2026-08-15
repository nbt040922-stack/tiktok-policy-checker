param([switch]$InstallBuilder)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv-visual\Scripts\python.exe'
$output = Join-Path $root 'resources\ocr'
$buildRoot = Join-Path $env:TEMP 'tiktok-policy-checker-ocr-build'
if (-not (Test-Path -LiteralPath $python)) { throw 'Create .venv-visual and install requirements-visual.txt first.' }

$pyinstaller = Join-Path (Split-Path -Parent $python) 'pyinstaller.exe'
if (-not (Test-Path -LiteralPath $pyinstaller)) {
  if (-not $InstallBuilder) { throw 'PyInstaller is missing. Re-run with -InstallBuilder to install the build-only tool.' }
  & $python -m pip install 'pyinstaller==6.15.0'
  if ($LASTEXITCODE -ne 0) { throw 'PyInstaller installation failed.' }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($root)
$resolvedOutput = [System.IO.Path]::GetFullPath($output)
if (-not $resolvedOutput.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe OCR output path.' }
Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $output,$buildRoot | Out-Null

& $python -m PyInstaller --noconfirm --clean --onedir --name rapidocr-worker `
  --distpath $output --workpath (Join-Path $buildRoot 'work') --specpath (Join-Path $buildRoot 'spec') `
  --collect-data rapidocr --collect-binaries onnxruntime --hidden-import onnxruntime.capi._pybind_state `
  --exclude-module torch --exclude-module torchvision --exclude-module transformers --exclude-module tensorflow `
  --exclude-module paddle --exclude-module tensorrt (Join-Path $root 'services\visualRisk\ocr-worker.py')
if ($LASTEXITCODE -ne 0) { throw 'OCR worker packaging failed.' }

$nested = Join-Path $output 'rapidocr-worker'
Get-ChildItem -LiteralPath $nested -Force | Move-Item -Destination $output
Remove-Item -LiteralPath $nested -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'resources\ocr-licenses.txt') -Destination (Join-Path $output 'THIRD_PARTY_LICENSES.txt')

$health = & (Join-Path $output 'rapidocr-worker.exe') '--health' | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or -not ($health | Select-String '"type": "ready"')) { throw 'Frozen OCR worker health check failed.' }
[pscustomobject]@{ Result = 'PASS'; Executable = (Join-Path $output 'rapidocr-worker.exe'); SizeBytes = (Get-ChildItem $output -Recurse -File | Measure-Object Length -Sum).Sum; Health = $health }
