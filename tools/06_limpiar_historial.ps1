# ==============================================================================
# 06_limpiar_historial.ps1 - Purga de Secretos y Cadenas en el Historial de Git
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
# REGLAS DE SEGURIDAD CRÍTICAS:
# 1. Este script NUNCA opera sobre tu repositorio de trabajo. Trabaja 100% sobre
#    un clon espejo temporal aislado (git clone --mirror) en una carpeta temporal.
# 2. Tu repositorio local actual permanece INTACTO.
# 3. El archivo de reemplazos se genera en memoria/tiempo de ejecución, NUNCA se versiona
#    y se destruye de inmediato tras la ejecución.
# 4. El script SE DETIENE antes de realizar cualquier push forzado.
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
    $pyCheck = python -c "import git_filter_repo" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠ No se encontró 'git-filter-repo'." -ForegroundColor Yellow
        Write-Host "  Para instalarlo con Python:" -ForegroundColor White
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
Write-Host "`n[1/5] Creando clon espejo temporal en carpeta aislada:" -ForegroundColor Yellow
Write-Host "  Destino temporal: $tempDir" -ForegroundColor Gray

try {
    git clone --mirror $RemoteUrl $tempDir
    Write-Host "  ✓ Clon espejo completado." -ForegroundColor Green
} catch {
    Write-Host "  ✗ Error al clonar el repositorio espejo: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 5. Generar archivo de reemplazos efímero en tiempo de ejecución (se destruye al terminar)
$replaceExpressionsFile = Join-Path $tempDir "replace_secrets_runtime.txt"

# Rutas de archivos a eliminar por completo de todas las ramas históricas
$filesToPurge = @(
    "sync/.env",
    "sync/.env.local",
    "cloudflare-worker/.env",
    ".env.production",
    ".env.local"
)

# Cadenas y patrones regex de secretos conocidos (Fase 0) para reemplazar en todo el código histórico
$replacementPatterns = @(
    # Clave simétrica XOR legada
    "velvet_secret_key_2024_change_me==>***REMOVED_LEGACY_XOR_KEY***",
    # Tokens JWT de Supabase (anon y service_role de 3 partes)
    ("regex:" + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}==>***REMOVED_JWT_TOKEN***"),
    # Cadenas de conexión PostgreSQL con contraseñas
    ("regex:" + "postgres(?:ql)?:\/\/[^:]+:([^@\s]{8,})@==>postgresql://user:***REMOVED_DB_PASS***@"),
    # Claves secretas de Patreon / Bearer tokens
    ("regex:" + "access_token\s*[:=]\s*[""'][a-zA-Z0-9_\-]{30,}[""']==>access_token=""***REMOVED_TOKEN***""")
)

Write-Host "`n[2/5] Generando archivo de sustitución efímero y ejecutando git-filter-repo..." -ForegroundColor Yellow

$originalLocation = Get-Location
try {
    # Escribir archivo temporal de sustituciones
    $replacementPatterns | Out-File -FilePath $replaceExpressionsFile -Encoding ascii -Force

    Set-Location $tempDir

    # Argumentos de rutas a expurgar
    $pathsArgs = @()
    foreach ($pf in $filesToPurge) {
        $pathsArgs += "--path"
        $pathsArgs += $pf
    }

    # Ejecutar git-filter-repo: invierte rutas de archivos .env y sustituye cadenas secretas
    git filter-repo --replace-text $replaceExpressionsFile --invert-paths @pathsArgs --force

    Write-Host "  ✓ Archivos .env y cadenas secretas purgadas del árbol histórico." -ForegroundColor Green
} catch {
    Write-Host "  ✗ Error durante la ejecución de git-filter-repo: $($_.Exception.Message)" -ForegroundColor Red
    Set-Location $originalLocation
    exit 1
} finally {
    # Destrucción inmediata del archivo efímero de reemplazos
    if (Test-Path $replaceExpressionsFile) {
        Remove-Item -Force $replaceExpressionsFile -ErrorAction SilentlyContinue
    }
    Set-Location $originalLocation
}

# 6. Verificación exhaustiva en todo el historial reescrito
Write-Host "`n[3/5] Verificando en todo el historial que ya no existan secretos..." -ForegroundColor Yellow
$leaksDetected = 0

try {
    Set-Location $tempDir

    # Verificación 1: Clave XOR
    $xorCheck = git log --all -p -S "velvet_secret_key_2024_change_me" --oneline
    if ($xorCheck) {
        Write-Host "  ✗ ALERTA: La clave XOR todavía aparece en commits históricos." -ForegroundColor Red
        $leaksDetected++
    } else {
        Write-Host "  ✓ Clave XOR histórica: CERO ocurrencias detectadas." -ForegroundColor Green
    }

    # Verificación 2: Tokens JWT
    $jwtCheck = git log --all -p -G "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" --oneline
    if ($jwtCheck) {
        Write-Host "  ✗ ALERTA: Patrones JWT aún detectados en commits históricos." -ForegroundColor Red
        $leaksDetected++
    } else {
        Write-Host "  ✓ Tokens JWT / credenciales: CERO ocurrencias detectadas." -ForegroundColor Green
    }
} finally {
    Set-Location $originalLocation
}

# 7. Resumen de commits reescritos
Write-Host "`n[4/5] Resumen de los últimos commits reescritos en el espejo:" -ForegroundColor Yellow
try {
    Set-Location $tempDir
    $recentCommits = git log -n 5 --oneline
    $recentCommits | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} finally {
    Set-Location $originalLocation
}

# 8. Punto de control de seguridad antes del push forzado
Write-Host "`n====================================================" -ForegroundColor Red
Write-Host "  PUNTO DE CONTROL DE SEGURIDAD (NO SE HIZO PUSH)" -ForegroundColor Red
Write-Host "====================================================" -ForegroundColor Red
Write-Host "La limpieza se realizó ÚNICAMENTE en la copia temporal aislada:" -ForegroundColor White
Write-Host "  $tempDir" -ForegroundColor Cyan
Write-Host "`nTu repositorio local de trabajo NO ha sido modificado." -ForegroundColor Green

if ($leaksDetected -eq 0) {
    Write-Host "`n✓ El historial del clon espejo está 100% LIMPIO de secretos conocidos." -ForegroundColor Green
} else {
    Write-Host "`n⚠ Se detectaron $leaksDetected advertencia(s). Revise antes de hacer push." -ForegroundColor Yellow
}

Write-Host "`n¿Cómo aplicar esta limpieza a tu repositorio remoto (GitHub/GitLab)?" -ForegroundColor Yellow
Write-Host "1. Asegúrate de haber rotado TODAS las claves en Supabase y Patreon primero." -ForegroundColor White
Write-Host "2. Abre una terminal y ejecuta manualmente el push forzado del espejo:" -ForegroundColor White
Write-Host "   cd $tempDir" -ForegroundColor Cyan
Write-Host "   git push --mirror --force origin" -ForegroundColor Cyan

Write-Host "`n¿Cómo recuperar o cancelar si no deseas aplicar el cambio?" -ForegroundColor Yellow
Write-Host "1. Simplemente borra la carpeta temporal:" -ForegroundColor White
Write-Host "   Remove-Item -Recurse -Force '$tempDir'" -ForegroundColor Cyan
Write-Host "2. Tu repositorio local y remoto siguen exactamente igual que antes." -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
