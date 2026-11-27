# Builds the optional "VoxBox - Voix IA" pack on a Windows x64 runner with Python 3.11.
# Output layout (installed into <VoxBox>\resources\ by installer/ai-pack.nsi):
#   rvc-assets\  contentvec.onnx, rmvpe.onnx, onnxruntime.dll (+providers_shared), DirectML.dll, notices
#   rvc-voices\  bundled voices converted from converter/bundled_voices.json
#   converter\   embedded Python + convert_rvc.py (used when the user imports a .pth)
# Nothing here runs on the user's PC: the app never downloads anything for AI voices.
param([Parameter(Mandatory = $true)][string]$OutputDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path $PSScriptRoot -Parent
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$Assets = Join-Path $OutputDir 'rvc-assets'
$Voices = Join-Path $OutputDir 'rvc-voices'
$Converter = Join-Path $OutputDir 'converter'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force $OutputDir, $Voices, $Tmp | Out-Null

function Get-Verified([string]$Url, [string]$Sha256, [string]$Out) {
    Invoke-WebRequest $Url -OutFile $Out
    $Hash = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Hash -ne $Sha256) { throw "Checksum mismatch for $Url : $Hash" }
}

# 1. ContentVec + RMVPE (checksums pinned in converter/assets.json).
python (Join-Path $Root 'converter/fetch_assets.py') $Assets
if ($LASTEXITCODE -ne 0) { throw 'fetch_assets.py failed' }

# 2. ONNX Runtime 1.22 with the DirectML provider: one build serving NVIDIA and AMD.
$Ort = Join-Path $Tmp 'ort.zip'
Get-Verified 'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/1.22.1/microsoft.ml.onnxruntime.directml.1.22.1.nupkg' `
    '210823f9932f81f222e2d05d04531d948a4d75dbf527dfb94195ad61371ab728' $Ort
Expand-Archive $Ort -DestinationPath (Join-Path $Tmp 'ort')
Copy-Item (Join-Path $Tmp 'ort/runtimes/win-x64/native/onnxruntime.dll') $Assets
Copy-Item (Join-Path $Tmp 'ort/runtimes/win-x64/native/onnxruntime_providers_shared.dll') $Assets
Copy-Item (Join-Path $Tmp 'ort/LICENSE') (Join-Path $Assets 'LICENSE-onnxruntime.txt')
Copy-Item (Join-Path $Tmp 'ort/ThirdPartyNotices.txt') (Join-Path $Assets 'ThirdPartyNotices-onnxruntime.txt')
$Dml = Join-Path $Tmp 'dml.zip'
Get-Verified 'https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg' `
    '4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9' $Dml
Expand-Archive $Dml -DestinationPath (Join-Path $Tmp 'dml')
Copy-Item (Join-Path $Tmp 'dml/bin/x64-win/DirectML.dll') $Assets
Copy-Item (Join-Path $Tmp 'dml/LICENSE.txt') (Join-Path $Assets 'LICENSE-DirectML.txt')

# 3. Embedded converter runtime.
& (Join-Path $Root 'converter/build_runtime.ps1') -OutputDir $Converter
$Python = Join-Path $Converter 'python.exe'

# 4. Bundled voices: download, verify, convert, mark as built-in with attribution.
$Manifest = Get-Content (Join-Path $Root 'converter/bundled_voices.json') -Raw | ConvertFrom-Json
foreach ($Voice in $Manifest) {
    $Pth = Join-Path $Tmp "$($Voice.id).pth"
    Get-Verified $Voice.sourceUrl $Voice.sha256 $Pth
    $Dest = Join-Path $Voices $Voice.id
    & $Python -I (Join-Path $Converter 'convert_rvc.py') --pth $Pth --output $Dest --id $Voice.id --name $Voice.name
    if ($LASTEXITCODE -ne 0) { throw "Conversion failed for $($Voice.id)" }
    $MetaPath = Join-Path $Dest 'meta.json'
    $Meta = Get-Content $MetaPath -Raw | ConvertFrom-Json
    $Meta.builtin = $true
    $Meta | Add-Member -Force -NotePropertyName license -NotePropertyValue "$($Voice.license). $($Voice.attribution)"
    $Meta | ConvertTo-Json -Depth 5 | Set-Content $MetaPath -Encoding UTF8
}

# 5. Smoke test the packaged converter with an index too (FAISS + PyTorch in the
#    same import, the path users take with downloaded models). No OpenMP
#    workaround variable may be set: the index must convert in its own process.
if ($env:KMP_DUPLICATE_LIB_OK) { throw 'KMP_DUPLICATE_LIB_OK must not be set for the smoke test' }
$SmokeIndex = Join-Path $Tmp 'smoke.index'
& $Python -I -c "import faiss, numpy as np, sys; i = faiss.IndexFlatL2(768); i.add(np.random.default_rng(1).normal(size=(64, 768)).astype('float32')); faiss.write_index(i, sys.argv[1])" $SmokeIndex
if ($LASTEXITCODE -ne 0) { throw 'Could not create the smoke-test index' }
$First = $Manifest[0]
$SmokeOut = Join-Path $Tmp 'smoke-with-index'
& $Python -I (Join-Path $Converter 'convert_rvc.py') --pth (Join-Path $Tmp "$($First.id).pth") --index $SmokeIndex --output $SmokeOut --id smoke --name Smoke
if ($LASTEXITCODE -ne 0) { throw 'Packaged converter failed with an index' }
if (-not (Test-Path (Join-Path $SmokeOut 'index.bin'))) { throw 'Packaged converter wrote no index.bin' }

# 6. Smoke test the online import path (--untrusted) on Windows, where the converter caps its
#    memory with a job object: a valid zip checkpoint (re-saved, whatever the format of the
#    bundled one) must convert under the ceiling, and an allocation past a small ceiling must fail.
$SmokeZip = Join-Path $Tmp 'smoke-zip.pth'
& $Python -I -c "import sys, torch; torch.save(torch.load(sys.argv[1], map_location='cpu', weights_only=True), sys.argv[2])" (Join-Path $Tmp "$($First.id).pth") $SmokeZip
if ($LASTEXITCODE -ne 0) { throw 'Could not re-save the smoke-test checkpoint' }
$SmokeOnline = Join-Path $Tmp 'smoke-online'
& $Python -I (Join-Path $Converter 'convert_rvc.py') --pth $SmokeZip --output $SmokeOnline --id smoke-online --name Smoke --untrusted
if ($LASTEXITCODE -ne 0) { throw 'Packaged converter failed on an online (--untrusted) checkpoint' }
if (-not (Test-Path (Join-Path $SmokeOnline 'model.onnx'))) { throw 'Packaged converter wrote no model.onnx for --untrusted' }
# The job object itself: assigned without error, and an allocation past its ceiling fails
# (exit 0 only on MemoryError; a setup failure raises and exits non-zero).
& $Python -I -c "import sys; sys.path.insert(0, sys.argv[1]); import convert_rvc as c; c.limit_memory(256 * 1024**2, 0)`ntry:`n    bytearray(1024**3)`nexcept MemoryError:`n    sys.exit(0)`nsys.exit('allocation past the job object ceiling succeeded')" $Converter
if ($LASTEXITCODE -ne 0) { throw 'Converter memory ceiling (job object) could not be set or is not enforced' }
# The same conversion through the converter's online path with a 64 MiB ceiling: it must reach
# the ceiling (limit_memory called with that budget, job assigned) and then fail on memory,
# publishing nothing. Any other failure, or a success, fails the build.
$SmokeCapped = Join-Path $Tmp 'smoke-capped'
$CappedCheck = Join-Path $Tmp 'smoke_capped.py'
@'
import sys
sys.path.insert(0, sys.argv[1])
import convert_rvc as c
c.MAX_UNTRUSTED_MEMORY = 64 * 1024**2
applied = []
real_limit = c.limit_memory
def limit(budget, mapped):
    real_limit(budget, mapped)
    applied.append(budget)
c.limit_memory = limit
try:
    c.convert(c.Path(sys.argv[2]), None, c.Path(sys.argv[3]), "smoke-capped", "Smoke", untrusted=True)
except Exception as error:
    reached = applied == [c.MAX_UNTRUSTED_MEMORY]
    memory = isinstance(error, MemoryError) or "memory" in str(error).lower()
    if reached and memory:
        sys.exit(0)
    sys.exit(f"capped conversion failed for another reason (ceiling applied: {reached}): {error!r}")
sys.exit("capped conversion succeeded past the memory ceiling")
'@ | Set-Content $CappedCheck -Encoding UTF8
& $Python -I $CappedCheck $Converter $SmokeZip $SmokeCapped
if ($LASTEXITCODE -ne 0) { throw 'Converter memory ceiling (job object) is not enforced on --untrusted conversions' }
if (Test-Path (Join-Path $SmokeCapped 'meta.json')) { throw 'A conversion past the memory ceiling published a model' }

Remove-Item $Tmp -Recurse -Force
Write-Host "Voix IA pack ready in $OutputDir"
