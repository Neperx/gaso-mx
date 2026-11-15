# Deploy Gaso a Cloudflare Pages (producción).
# Uso: pwsh ./scripts/deploy-pages.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
Write-Host 'Deploying gaso-mx to Cloudflare Pages...'
npx wrangler pages deploy . --project-name=gaso-mx --branch=main --commit-dirty=true
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'OK -> https://gaso-mx.pages.dev'
