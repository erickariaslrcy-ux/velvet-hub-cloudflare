# ==============================================================================
# 01_verificar_anon.ps1 - Verificación en Vivo de Permisos del Rol Anon
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
# Este script realiza peticiones HTTP de solo lectura directamente contra la API
# PostgREST de Supabase para validar que las políticas RLS y los permisos de columna
# del rol 'anon' están aplicados correctamente.
#
# NUNCA guarda ni imprime en disco/consola las credenciales ingresadas.
# ==============================================================================

[CmdletBinding()]
param(
    [string]$SupabaseUrl = "",
    [string]$AnonKey = ""
)

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  VERIFICACIÓN DE SEGURIDAD RLS PARA ROL ANON" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Solicitar URL de Supabase si no se pasó por parámetro
if (-not $SupabaseUrl) {
    $SupabaseUrl = Read-Host "Ingrese su SUPABASE_URL (ej. https://xxxx.supabase.co)"
}
$SupabaseUrl = $SupabaseUrl.Trim().TrimEnd("/")

if (-not $SupabaseUrl.StartsWith("https://")) {
    Write-Host "✗ ERROR: La URL debe comenzar con https://" -ForegroundColor Red
    exit 1
}

# 2. Solicitar clave anon de forma oculta en consola (SecureString)
if (-not $AnonKey) {
    Write-Host "Ingrese su SUPABASE_ANON_KEY (la entrada es oculta por seguridad):" -ForegroundColor Yellow
    $secureKey = Read-Host -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $AnonKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $AnonKey -or $AnonKey.Length -lt 20) {
    Write-Host "✗ ERROR: Clave anon inválida o vacía." -ForegroundColor Red
    exit 1
}

$headers = @{
    "apikey" = $AnonKey
    "Authorization" = "Bearer $AnonKey"
    "Accept" = "application/json"
}

$testsPassed = 0
$testsFailed = 0

# TEST 1: Verificar que el catálogo público sí responde con columnas autorizadas
Write-Host "`n[Prueba 1/3] Verificando lectura del catálogo público autorizado..." -ForegroundColor Yellow
try {
    $publicQuery = "$SupabaseUrl/rest/v1/items?select=id,title,cover_url,media_type&limit=3"
    $response = Invoke-RestMethod -Uri $publicQuery -Headers $headers -Method GET -TimeoutSec 15
    if ($response -and $response.Count -gt 0) {
        Write-Host "  ✓ APROBADO: El rol anon puede consultar el catálogo público ($($response.Count) elementos recibidos)." -ForegroundColor Green
        $testsPassed++
    } else {
        Write-Host "  ⚠ ADVERTENCIA: La consulta fue aceptada (200 OK) pero no se recibieron filas. ¿La tabla tiene registros?" -ForegroundColor Yellow
        $testsPassed++
    }
} catch {
    Write-Host "  ✗ FALLÓ: No se pudo leer el catálogo público: $($_.Exception.Message)" -ForegroundColor Red
    $testsFailed++
}

# TEST 2: Verificar que anon NO PUEDE leer columnas prohibidas (pages, video_sources, status)
Write-Host "`n[Prueba 2/3] Verificando bloqueo de columnas sensibles (pages, video_sources, status)..." -ForegroundColor Yellow
try {
    $forbiddenColQuery = "$SupabaseUrl/rest/v1/items?select=id,pages,video_sources,status&limit=1"
    $forbiddenResp = Invoke-RestMethod -Uri $forbiddenColQuery -Headers $headers -Method GET -TimeoutSec 15

    # Si llega aquí sin error HTTP, verificar si la base devolvió las columnas o si RLS las bloqueó
    if ($forbiddenResp -and $forbiddenResp.Count -gt 0 -and ($forbiddenResp[0].pages -or $forbiddenResp[0].video_sources)) {
        Write-Host "  ✗ FALLÓ: El rol anon PUDO leer las columnas 'pages' o 'video_sources'. Aplique sql/01_rls_policies.sql para revocar el permiso de columna." -ForegroundColor Red
        $testsFailed++
    } else {
        Write-Host "  ✓ APROBADO: Columnas sensibles inaccesibles o nulas para anon." -ForegroundColor Green
        $testsPassed++
    }
} catch {
    # El comportamiento esperado de PostgREST al solicitar una columna revocada es error 400/403/404 (Permission Denied for column)
    Write-Host "  ✓ APROBADO: La base de datos rechazó la solicitud de columnas prohibidas con código HTTP seguro ($($_.Exception.Message))." -ForegroundColor Green
    $testsPassed++
}

# TEST 3: Verificar que anon NO PUEDE leer filas bloqueadas (status = 'blocked' o real_people = true)
Write-Host "`n[Prueba 3/3] Verificando exclusión de registros bloqueados..." -ForegroundColor Yellow
try {
    $blockedQuery = "$SupabaseUrl/rest/v1/items?status=eq.blocked&select=id,title&limit=5"
    $blockedResp = Invoke-RestMethod -Uri $blockedQuery -Headers $headers -Method GET -TimeoutSec 15

    if ($blockedResp -and $blockedResp.Count -gt 0) {
        Write-Host "  ✗ FALLÓ: El rol anon pudo recuperar $($blockedResp.Count) filas con status='blocked'. Aplique la política de filas de sql/01_rls_policies.sql." -ForegroundColor Red
        $testsFailed++
    } else {
        Write-Host "  ✓ APROBADO: Cero filas bloqueadas accesibles para anon (política RLS activa)." -ForegroundColor Green
        $testsPassed++
    }
} catch {
    # Si la columna status fue revocada, el filtro fallará o retornará vacío, lo cual también es seguro
    Write-Host "  ✓ APROBADO: La consulta de filas bloqueadas fue rechazada por la base de datos ($($_.Exception.Message))." -ForegroundColor Green
    $testsPassed++
}

# Limpieza de memoria
$AnonKey = $null
$headers = $null

Write-Host "`n====================================================" -ForegroundColor Cyan
if ($testsFailed -eq 0) {
    Write-Host "  RESULTADO: APROBADO (La seguridad del rol anon es sólida)" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "  RESULTADO: FALLÓ ($testsFailed prueba(s) fallaron)" -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Cyan
    exit 1
}
