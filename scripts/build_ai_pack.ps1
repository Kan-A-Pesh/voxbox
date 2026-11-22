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

Remove-Item $Tmp -Recurse -Force
Write-Host "Voix IA pack ready in $OutputDir"
