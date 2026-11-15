# ==============================================================================
# 00_preflight.ps1 - Verificación Pre-vuelo del Repositorio y Entorno
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
# Este script verifica de forma no destructiva que el entorno de desarrollo y
# el estado del código cumplen con todos los estándares antes de subir cambios.
# NUNCA imprime ni guarda secretos.
# ==============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$failures = 0

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  VERIFICACIÓN PRE-VUELO (PREFLIGHT CHECK)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Comprobar herramientas instaladas (git, node, npm)
Write-Host "`n[1/5] Comprobando herramientas instaladas..." -ForegroundColor Yellow
$tools = @("git", "node", "npm")
foreach ($tool in $tools) {
    $found = Get-Command $tool -ErrorAction SilentlyContinue
    if ($found) {
        $version = & $tool --version 2>$null
        Write-Host "  ✓ $tool encontrado: $version" -ForegroundColor Green
    } else {
        Write-Host "  ✗ ERROR: $tool no está instalado o no está en el PATH." -ForegroundColor Red
        $failures++
    }
}

# 2. Comprobar rama activa (debe ser fix/auditoria-completa)
Write-Host "`n[2/5] Comprobando rama de Git..." -ForegroundColor Yellow
try {
    $currentBranch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
    if ($currentBranch -eq "fix/auditoria-completa") {
        Write-Host "  ✓ Rama correcta: $currentBranch" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ ADVERTENCIA: La rama activa es '$currentBranch' (se esperaba 'fix/auditoria-completa')." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ✗ No se pudo determinar la rama actual de Git." -ForegroundColor Red
    $failures++
}

# 3. Comprobar .git/config en busca de tokens en la URL remota
Write-Host "`n[3/5] Comprobando seguridad de URLs remotas en Git..." -ForegroundColor Yellow
try {
    $remotes = git remote -v
    $hasTokenInRemote = $false
    foreach ($line in $remotes) {
        if ($line -match "https?://([^@/:]+):([^@/:]+)@") {
            $hasTokenInRemote = $true
            Write-Host "  ✗ ALERTA DE SEGURIDAD: Se detectaron credenciales en la URL de remote:" -ForegroundColor Red
            Write-Host "    $line" -replace ":[^@/:]+@", ":***@"
            Write-Host "    -> Para corregirlo sin exponer credenciales, ejecute:" -ForegroundColor Cyan
            Write-Host "       git remote set-url origin https://github.com/USUARIO/REPOSITORIO.git" -ForegroundColor White
            $failures++
            break
        }
    }
    if (-not $hasTokenInRemote) {
        Write-Host "  ✓ URLs remotas seguras (sin credenciales hardcodeadas)." -ForegroundColor Green
    }
} catch {
    Write-Host "  ⚠ No se pudo verificar la configuración remota de Git." -ForegroundColor Yellow
}

# 4. Escaneo de secretos en el árbol de archivos (sin mostrar valores)
Write-Host "`n[4/5] Escaneando árbol de trabajo en busca de secretos hardcodeados..." -ForegroundColor Yellow
$secretPatterns = @(
    @{ Name = "Supabase Service Role JWT"; Pattern = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}' },
    @{ Name = "Private Key PEM"; Pattern = '-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----' },
    @{ Name = "Patreon Access Token"; Pattern = 'access_token\s*[:=]\s*["''][a-zA-Z0-9_\-]{30,}["'']' },
    @{ Name = "Database Password String"; Pattern = 'postgres(?:ql)?:\/\/[^:]+:([^@\s]{8,})@' }
)

$excludedPaths = @("\.git\", "node_modules\", "_archivo\", "_BACKUP_", "\.env", "dist\", "\.wrangler\")
$filesToScan = Get-ChildItem -Recurse -File | Where-Object {
    $path = $_.FullName
    $skip = $false
    foreach ($exc in $excludedPaths) {
        if ($path -like "*$exc*") { $skip = $true; break }
    }
    -not $skip
}

$secretsFound = 0
foreach ($file in $filesToScan) {
    try {
        $content = Get-Content -Path $file.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $content) { continue }
        foreach ($sp in $secretPatterns) {
            if ($content -match $sp.Pattern) {
                # Se reporta archivo y tipo, NUNCA el valor del secreto
                Write-Host "  ✗ Posible secreto detectado [$($sp.Name)] en archivo: $($file.FullName)" -ForegroundColor Red
                $secretsFound++
            }
        }
    } catch {}
}

if ($secretsFound -eq 0) {
    Write-Host "  ✓ Cero secretos detectados en archivos rastreados." -ForegroundColor Green
} else {
    Write-Host "  ✗ Se detectaron $secretsFound posibles secretos. Revise antes de continuar." -ForegroundColor Red
    $failures++
}

# 5. Ejecución de la suite completa de pruebas automatizadas
Write-Host "`n[5/5] Ejecutando suite de pruebas automatizadas (npm test)..." -ForegroundColor Yellow
try {
    npm test
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n  ✓ Todas las suites de prueba pasaron exitosamente." -ForegroundColor Green
    } else {
        Write-Host "`n  ✗ Las pruebas automatizadas fallaron (código $LASTEXITCODE)." -ForegroundColor Red
        $failures++
    }
} catch {
    Write-Host "`n  ✗ Error al ejecutar npm test: $_" -ForegroundColor Red
    $failures++
}

# Resumen final
Write-Host "`n====================================================" -ForegroundColor Cyan
if ($failures -eq 0) {
    Write-Host "  RESULTADO PRE-VUELO: APROBADO (Todo listo)" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "  RESULTADO PRE-VUELO: FALLÓ ($failures error(es) detectado(s))" -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Cyan
    exit 1
}
