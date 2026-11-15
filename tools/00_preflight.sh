#!/usr/bin/env bash
# ==============================================================================
# 00_preflight.sh - Verificación Pre-vuelo del Repositorio y Entorno
# Proyecto: Velvet Hub / Morbohub
# ==============================================================================
set -euo pipefail

FAILURES=0

echo "===================================================="
echo "  VERIFICACIÓN PRE-VUELO (PREFLIGHT CHECK)"
echo "===================================================="

# 1. Herramientas
echo -e "\n[1/5] Comprobando herramientas instaladas..."
for tool in git node npm; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "  ✓ $tool encontrado: $($tool --version 2>/dev/null || true)"
    else
        echo "  ✗ ERROR: $tool no está instalado."
        FAILURES=$((FAILURES + 1))
    fi
done

# 2. Rama
echo -e "\n[2/5] Comprobando rama de Git..."
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [ "$BRANCH" = "fix/auditoria-completa" ]; then
    echo "  ✓ Rama correcta: $BRANCH"
else
    echo "  ⚠ ADVERTENCIA: La rama activa es '$BRANCH' (se esperaba 'fix/auditoria-completa')."
fi

# 3. Remotes
echo -e "\n[3/5] Comprobando seguridad de URLs remotas en Git..."
if git remote -v | grep -E "https?://[^@/:]+:[^@/:]+@" >/dev/null 2>&1; then
    echo "  ✗ ALERTA: Se detectaron credenciales en la URL remota de git."
    echo "    Corregir con: git remote set-url origin https://github.com/USUARIO/REPO.git"
    FAILURES=$((FAILURES + 1))
else
    echo "  ✓ URLs remotas seguras (sin credenciales hardcodeadas)."
fi

# 4. Pruebas npm
echo -e "\n[4/5] Ejecutando suite de pruebas automatizadas..."
if npm test; then
    echo "  ✓ Todas las suites de prueba pasaron exitosamente."
else
    echo "  ✗ Las pruebas automatizadas fallaron."
    FAILURES=$((FAILURES + 1))
fi

echo -e "\n===================================================="
if [ "$FAILURES" -eq 0 ]; then
    echo "  RESULTADO PRE-VUELO: APROBADO (Todo listo)"
    echo "===================================================="
    exit 0
else
    echo "  RESULTADO PRE-VUELO: FALLÓ ($FAILURES errores detectados)"
    echo "===================================================="
    exit 1
fi
