$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoPath
$env:UV_SYSTEM_CERTS = 'true'
$source = 'https://github.com/filippovarini/community-fish-detector/releases/download/2026.07.06-release/cfd-rf-detr-medium-1024-2026.03.24.cp-011.20260706-release.pth'
$expected = '2e94814c7a9318aa2e98e5f6b866ceebe0b5b8f92e6fccb912e7e334a7913911'
New-Item -ItemType Directory -Path .tools/animals -Force | Out-Null
if (-not (Test-Path -LiteralPath .tools/animals/model.pth)) {
    Invoke-WebRequest $source -OutFile .tools/animals/model.pth
}
$actual = (Get-FileHash -LiteralPath .tools/animals/model.pth -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw 'Model checksum mismatch' }
@{model='Community Fish Detector RF-DETR Medium 1024'; source=$source; sha256=$expected; release='2026.07.06-release'; scope='generic fish; local ecological accuracy unvalidated'} | ConvertTo-Json | Set-Content .tools/animals/model-source.json
if (-not (Test-Path -LiteralPath .tools/animal-env/Scripts/python.exe)) {
    uv venv .tools/animal-env --python 3.12.16
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
uv pip install --python .tools/animal-env/Scripts/python.exe torch==2.15.0+cpu torchvision==0.29.2+cpu --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
uv pip install --python .tools/animal-env/Scripts/python.exe rfdetr==1.12.1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
uv pip freeze --python .tools/animal-env/Scripts/python.exe | Set-Content .tools/animals/installed-requirements.txt
