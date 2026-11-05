# Run on a Windows x64 packaging runner with Python 3.11 installed (setup-python).
# Produces a complete offline converter folder. No pip/download occurs on user's PC.
param([Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
if (Test-Path $OutputDir) { throw "Output must not already exist: $OutputDir" }
python -c 'import sys, struct; assert sys.version_info[:2] == (3, 11) and struct.calcsize("P") == 8, "Python 3.11 x64 packaging runner required"'
if ($LASTEXITCODE -ne 0) { throw 'Wrong runner Python version or architecture' }
$Archive = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString() + '.zip')
try {
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip' -OutFile $Archive
    $Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Hash -ne '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b') { throw 'Python archive checksum mismatch' }
    Expand-Archive $Archive -DestinationPath $OutputDir
    $Site = Join-Path $OutputDir 'Lib/site-packages'
    New-Item -ItemType Directory -Force $Site | Out-Null
    # Use the runner's pip to populate the embedded runtime, including native wheels.
    python -m pip install --only-binary=:all: --no-compile --target $Site -r (Join-Path $PSScriptRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    @('python311.zip', '.', 'Lib/site-packages', 'import site') | Set-Content (Join-Path $OutputDir 'python311._pth') -Encoding ASCII
    Copy-Item (Join-Path $PSScriptRoot 'convert_rvc.py') $OutputDir
    Copy-Item (Join-Path $PSScriptRoot 'vendor') $OutputDir -Recurse
    Copy-Item (Join-Path $PSScriptRoot 'licenses') $OutputDir -Recurse
    $EmbeddedPython = Join-Path $OutputDir 'python.exe'
    & $EmbeddedPython -I -c 'import torch, faiss, onnx, scipy; assert torch.__version__.startswith("2.6.0"); assert not torch.cuda.is_available()'
    if ($LASTEXITCODE -ne 0) { throw 'Embedded runtime smoke test failed' }
    & $EmbeddedPython -I (Join-Path $OutputDir 'convert_rvc.py') --help
    if ($LASTEXITCODE -ne 0) { throw 'Converter smoke test failed' }
    # Pinning wheels does not remove their redistribution requirements. Retain all
    # *.dist-info licences plus Python's bundled LICENSE.txt and vendored notices.
} finally {
    Remove-Item $Archive -ErrorAction SilentlyContinue
}
