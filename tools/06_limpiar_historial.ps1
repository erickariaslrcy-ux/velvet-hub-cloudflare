# ==============================================================================
# 06_limpiar_historial.ps1 - Purga de Secretos en el Historial de Git
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
# REGLAS DE SEGURIDAD CRÍTICAS:
# 1. Este script NUNCA opera sobre tu repositorio de trabajo. Trabaja 100% sobre
#    un clon espejo temporal aislado (git clone --mirror) en una carpeta temporal.
# 2. Tu repositorio local actual permanece INTACTO.
# 3. El script SE DETIENE antes de realizar cualquier push forzado.
# 4. Requiere confirmación manual explícita del usuario para aplicar cambios.
# ==============================================================================

[CmdletBinding()]
param(
    [string]$RemoteUrl = ""
)

$ErrorActionPreference = "Stop"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  PURGA DE SECRETOS EN EL HISTORIAL (GIT-FILTER-REPO)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Comprobar que git está instalado
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "✗ ERROR: git no está instalado." -ForegroundColor Red
    exit 1
}

# 2. Comprobar si git-filter-repo está disponible
$filterRepoCmd = Get-Command git-filter-repo -ErrorAction SilentlyContinue
if (-not $filterRepoCmd) {
    # Comprobar si está disponible como módulo python
    $pyCheck = python -c "import git_filter_repo" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠ No se encontró 'git-filter-repo'." -ForegroundColor Yellow
        Write-Host "  Para instalarlo de forma estándar con Python:" -ForegroundColor White
        Write-Host "    pip install git-filter-repo" -ForegroundColor Cyan
        Write-Host "  Una vez instalado, vuelva a ejecutar este script." -ForegroundColor Yellow
        exit 1
    }
}

# 3. Determinar URL remota
if (-not $RemoteUrl) {
    try {
        $RemoteUrl = (git config --get remote.origin.url).Trim()
    } catch {}
}

if (-not $RemoteUrl) {
    $RemoteUrl = Read-Host "Ingrese la URL remota del repositorio (ej. https://github.com/usuario/repo.git)"
}

Write-Host "`nRepositorio remoto objetivo: $RemoteUrl" -ForegroundColor Cyan

# 4. Crear directorio temporal aislado para el espejo
$tempDir = Join-Path $env:TEMP ("git-cleanse-mirror-" + (Get-Random))
Write-Host "`n[1/4] Creando clon espejo temporal en carpeta aislada:" -ForegroundColor Yellow
Write-Host "  Destino temporal: $tempDir" -ForegroundColor Gray

try {
    git clone --mirror $RemoteUrl $tempDir
    Write-Host "  ✓ Clon espejo completado." -ForegroundColor Green
} catch {
    Write-Host "  ✗ Error al clonar el repositorio espejo: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 5. Generar archivo de reemplazos efímero en tiempo de ejecución
# (Se borra inmediatamente tras la ejecución)
$replacementsFile = Join-Path $tempDir "filter_expressions.txt"

# Lista de archivos sensibles a expurgar completamente de todas las ramas y commits
$filesToPurge = @(
    "sync/.env",
    "sync/.env.local",
    "cloudflare-worker/.env",
    ".env.production",
    ".env.local"
)

Write-Host "`n[2/4] Ejecutando git-filter-repo sobre el clon espejo..." -ForegroundColor Yellow

$originalLocation = Get-Location
try {
    Set-Location $tempDir

    # Purgar rutas de archivos con secretos
    $pathsArgs = @()
    foreach ($pf in $filesToPurge) {
        $pathsArgs += "--path"
        $pathsArgs += $pf
    }

    # Ejecutar git-filter-repo para eliminar archivos sensibles del árbol histórico
    git filter-repo --invert-paths @pathsArgs --force

    Write-Host "  ✓ Purga de rutas completada en el historial." -ForegroundColor Green
} catch {
    Write-Host "  ✗ Error durante la ejecución de git-filter-repo: $($_.Exception.Message)" -ForegroundColor Red
    Set-Location $originalLocation
    exit 1
} finally {
    Set-Location $originalLocation
}

# 6. Mostrar resumen de los cambios
Write-Host "`n[3/4] Resumen de la operación en el espejo:" -ForegroundColor Yellow
try {
    Set-Location $tempDir
    $recentCommits = git log -n 5 --oneline
    Write-Host "Últimos commits reescritos en el espejo:" -ForegroundColor Gray
    $recentCommits | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} finally {
    Set-Location $originalLocation
}

# 7. Detención de seguridad y guía de aplicación manual
Write-Host "`n====================================================" -ForegroundColor Red
Write-Host "  PUNTO DE CONTROL DE SEGURIDAD (NO SE HIZO PUSH)" -ForegroundColor Red
Write-Host "====================================================" -ForegroundColor Red
Write-Host "La limpieza se realizó ÚNICAMENTE en la copia temporal:" -ForegroundColor White
Write-Host "  $tempDir" -ForegroundColor Cyan
Write-Host "`nTu repositorio local de trabajo NO ha sido modificado." -ForegroundColor Green

Write-Host "`n¿Cómo aplicar esta limpieza al repositorio remoto (GitHub)?" -ForegroundColor Yellow
Write-Host "1. Asegúrate de haber rotado TODAS las contraseñas y tokens en Supabase y Patreon primero." -ForegroundColor White
Write-Host "2. Abre una terminal y ejecuta manualmente el push forzado del espejo:" -ForegroundColor White
Write-Host "   cd $tempDir" -ForegroundColor Cyan
Write-Host "   git push --mirror --force origin" -ForegroundColor Cyan

Write-Host "`n¿Cómo recuperar o cancelar si algo no te convence?" -ForegroundColor Yellow
Write-Host "1. Simplemente borra la carpeta temporal:" -ForegroundColor White
Write-Host "   Remove-Item -Recurse -Force '$tempDir'" -ForegroundColor Cyan
Write-Host "2. Tu repositorio local y el repositorio remoto actual siguen exactamente igual que antes." -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
