$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.12+ x64 is required to build.' }
    }
    & .venv/Scripts/python.exe -m pip install -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & .venv/Scripts/python.exe -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw 'Router tests failed.' }
    & .venv/Scripts/python.exe build.py
    if ($LASTEXITCODE -ne 0) { throw 'Portable build failed.' }
    Push-Location '..'
    try {
        node --import tsx --test test/router.test.cjs test/router-bundle.test.cjs test/router-startup.test.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Relay or portable app verification failed.' }
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}
