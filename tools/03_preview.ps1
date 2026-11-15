# ==============================================================================
# 03_preview.ps1 - Publicación de Rama y Guía de Preview en Cloudflare Pages
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
# Este script sube la rama 'fix/auditoria-completa' al repositorio remoto (push normal,
# SIN --force) para activar la compilación y despliegue de Preview en Cloudflare Pages.
# ==============================================================================

[CmdletBinding()]
param(
    [switch]$AutoConfirm = $false
)

$ErrorActionPreference = "Stop"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  PUBLICACIÓN DE RAMA PARA PREVIEW (CLOUDFLARE PAGES)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Verificar rama activa
$currentBranch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
if ($currentBranch -ne "fix/auditoria-completa") {
    Write-Host "✗ ERROR: Debe estar en la rama 'fix/auditoria-completa' para ejecutar este script." -ForegroundColor Red
    Write-Host "  Rama actual: $currentBranch" -ForegroundColor Yellow
    exit 1
}

# 2. Verificar estado de cambios locales
$status = git status --porcelain
if ($status) {
    Write-Host "⚠ Hay cambios locales pendientes de commit. Se recomienda hacer commit antes de subir:" -ForegroundColor Yellow
    git status -s
    Write-Host "`n¿Desea continuar de todos modos? (S/N):" -ForegroundColor Yellow
    $resp = Read-Host
    if ($resp -ne "S" -and $resp -ne "s") {
        Write-Host "Operación cancelada por el usuario." -ForegroundColor Gray
        exit 0
    }
}

# 3. Confirmación de push
Write-Host "`nSe ejecutará un push seguro (SIN --force):" -ForegroundColor White
Write-Host "  git push origin fix/auditoria-completa" -ForegroundColor Cyan

if (-not $AutoConfirm) {
    $confirm = Read-Host "¿Desea subir la rama a origin ahora? (S/N)"
    if ($confirm -ne "S" -and $confirm -ne "s") {
        Write-Host "Push cancelado por el usuario." -ForegroundColor Gray
        exit 0
    }
}

try {
    Write-Host "`nSubiendo rama a origin..." -ForegroundColor Yellow
    git push origin fix/auditoria-completa
    Write-Host "`n✓ Rama subida exitosamente al repositorio remoto." -ForegroundColor Green
} catch {
    Write-Host "`n✗ Error al ejecutar git push: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Verifique que tiene permisos en el remoto y que no hay conflictos." -ForegroundColor Yellow
    exit 1
}

# 4. Instrucciones claras para obtener la URL de Preview en Cloudflare Pages
Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host "  CÓMO OBTENER SU URL DE PREVIEW EN CLOUDFLARE" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "1. Inicie sesión en el panel de Cloudflare (https://dash.cloudflare.com/)." -ForegroundColor White
Write-Host "2. En el menú izquierdo, navegue a: 'Compute (Workers) > Workers & Pages'." -ForegroundColor White
Write-Host "3. Haga clic en su proyecto de Pages (ej. 'morbohub')." -ForegroundColor White
Write-Host "4. Vaya a la pestaña 'Deployments'." -ForegroundColor White
Write-Host "5. En la sección 'Preview Deployments' verá el despliegue automático de la rama:" -ForegroundColor White
Write-Host "   Branch: fix/auditoria-completa" -ForegroundColor Green
Write-Host "   Estado: Success" -ForegroundColor Green
Write-Host "6. La URL de preview tendrá un formato similar a:" -ForegroundColor White
Write-Host "   https://fix-auditoria-completa.morbohub.pages.dev" -ForegroundColor Cyan
Write-Host "   (o una URL con hash de commit: https://<hash>.morbohub.pages.dev)" -ForegroundColor Gray
Write-Host "`n-> Copie esa URL y ejecute el probador automatizado:" -ForegroundColor Yellow
Write-Host "   .\tools\04_probar_preview.ps1 -PreviewUrl 'https://su-url.pages.dev'" -ForegroundColor White
Write-Host "====================================================" -ForegroundColor Cyan
