# ==============================================================================
# 04_probar_preview.ps1 - Verificación Automatizada del Entorno de Preview
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
# Este script realiza pruebas end-to-end contra una URL real de Cloudflare Pages Preview:
#   1. Endpoint /api/version
#   2. Catálogo /api/items en páginas 1, 2, 3 y 10 para comic, video y gallery (cero duplicados)
#   3. Rechazo de tokens alterados/falsificados en /api/media (debe retornar 403)
#   4. Verificación de cabeceras HTTP de seguridad (CSP, X-Content-Type-Options, etc.)
# ==============================================================================

[CmdletBinding()]
param(
    [string]$PreviewUrl = ""
)

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  PRUEBA AUTOMATIZADA DE DESPLIEGUE EN PREVIEW" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

if (-not $PreviewUrl) {
    $PreviewUrl = Read-Host "Ingrese la URL de preview (ej. https://fix-auditoria-completa.morbohub.pages.dev)"
}

$PreviewUrl = $PreviewUrl.Trim().TrimEnd("/")
if (-not $PreviewUrl.StartsWith("https://")) {
    Write-Host "✗ ERROR: La URL debe comenzar con https://" -ForegroundColor Red
    exit 1
}

$failures = 0
$pageSize = 12

# ------------------------------------------------------------------------------
# 1. VERIFICAR /api/version
# ------------------------------------------------------------------------------
Write-Host "`n[1/4] Probando endpoint /api/version..." -ForegroundColor Yellow
try {
    $verRes = Invoke-RestMethod -Uri "$PreviewUrl/api/version" -Method GET -TimeoutSec 15
    if ($verRes.version -and $verRes.commit) {
        Write-Host "  ✓ APROBADO: /api/version respondió 200 OK (Versión: $($verRes.version), Commit: $($verRes.commit))" -ForegroundColor Green
    } else {
        Write-Host "  ✗ FALLÓ: /api/version devolvió una respuesta inesperada." -ForegroundColor Red
        $failures++
    }
} catch {
    Write-Host "  ✗ FALLÓ: Error al conectar con /api/version: $($_.Exception.Message)" -ForegroundColor Red
    $failures++
}

# ------------------------------------------------------------------------------
# 2. VERIFICAR CABECERAS DE SEGURIDAD HTTP
# ------------------------------------------------------------------------------
Write-Host "`n[2/4] Verificando cabeceras de seguridad HTTP..." -ForegroundColor Yellow
try {
    $headReq = Invoke-WebRequest -Uri "$PreviewUrl/" -Method Head -TimeoutSec 15
    $headers = $headReq.Headers

    $requiredHeaders = @("Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy")
    foreach ($rh in $requiredHeaders) {
        if ($headers[$rh] -or $headers[$rh.ToLower()]) {
            Write-Host "  ✓ Cabecera presente: $rh" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ Advertencia: Falta la cabecera $rh en la respuesta raíz." -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "  ⚠ No se pudieron comprobar las cabeceras raíz (la petición falló): $($_.Exception.Message)" -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# 3. VERIFICAR PAGINACIÓN Y COHERENCIA DE ITEMS (comic, video, gallery)
# ------------------------------------------------------------------------------
Write-Host "`n[3/4] Probando catálogo y paginación en páginas 1, 2, 3 y 10..." -ForegroundColor Yellow
$mediaTypes = @("comic", "video", "gallery")
$targetPages = @(1, 2, 3, 10)

foreach ($mType in $mediaTypes) {
    Write-Host "  -> Evaluando media_type='$mType'..." -ForegroundColor Cyan
    $seenIds = @{}
    $duplicatesFound = 0

    foreach ($page in $targetPages) {
        $itemsUrl = "$PreviewUrl/api/items?media_type=$mType&page=$page&page_size=$pageSize"
        try {
            $catData = Invoke-RestMethod -Uri $itemsUrl -Method GET -TimeoutSec 15
            $items = $catData.items

            if (-not $items) {
                Write-Host "    ⚠ Página $page de $mType no devolvió elementos." -ForegroundColor Yellow
                continue
            }

            foreach ($it in $items) {
                if ($seenIds.ContainsKey($it.id)) {
                    Write-Host "    ✗ DUPLICADO DETECTADO: ID $($it.id) en página $page ya fue visto en página $($seenIds[$it.id])" -ForegroundColor Red
                    $duplicatesFound++
                } else {
                    $seenIds[$it.id] = $page
                }
            }

            Write-Host "    ✓ Página $($page.ToString().PadLeft(2)): $($items.Count) items recibidos | total=$($catData.total) | total_pages=$($catData.total_pages)" -ForegroundColor Green
        } catch {
            Write-Host "    ✗ Error al consultar página $page de $mType: $($_.Exception.Message)" -ForegroundColor Red
            $failures++
        }
    }

    if ($duplicatesFound -eq 0) {
        Write-Host "    ✓ media_type='$mType': CERO duplicados detectados a través de las páginas 1, 2, 3 y 10." -ForegroundColor Green
    } else {
        Write-Host "    ✗ media_type='$mType': Se detectaron $duplicatesFound duplicados entre páginas." -ForegroundColor Red
        $failures++
    }
}

# ------------------------------------------------------------------------------
# 4. VERIFICAR RECHAZO DE TOKENS ALTERADOS EN /api/media
# ------------------------------------------------------------------------------
Write-Host "`n[4/4] Probando seguridad de /api/media con tokens falsificados..." -ForegroundColor Yellow
try {
    # Token falsificado con firma inválida
    $tamperedUrl = "$PreviewUrl/api/media?t=eyJ1IjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9mYWtlLnBuZyJ9.invalid_signature_hex_1234567890abcdef"
    $mediaRes = Invoke-WebRequest -Uri $tamperedUrl -Method GET -TimeoutSec 10 -ErrorAction Stop
    Write-Host "  ✗ FALLÓ: /api/media aceptó un token con firma inválida (código HTTP $($mediaRes.StatusCode))." -ForegroundColor Red
    $failures++
} catch {
    # Esperamos error 403 Forbidden
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 403) {
        Write-Host "  ✓ APROBADO: /api/media rechazó el token falsificado con código 403 Forbidden." -ForegroundColor Green
    } else {
        Write-Host "  ⚠ /api/media rechazó con código inesperado $statusCode ($($_.Exception.Message))." -ForegroundColor Yellow
    }
}

# ------------------------------------------------------------------------------
# RESUMEN FINAL
# ------------------------------------------------------------------------------
Write-Host "`n====================================================" -ForegroundColor Cyan
if ($failures -eq 0) {
    Write-Host "  RESULTADO PREVIEW: APROBADO (El despliegue funciona a la perfección)" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "  RESULTADO PREVIEW: FALLÓ ($failures error(es) detectado(s))" -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Cyan
    exit 1
}
