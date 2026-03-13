#!/bin/bash
echo "🚀 Reiniciando WhatBot por completo..."

# 1. Matar procesos de Node que usen el puerto 3000
PID=$(lsof -t -i:3000)
if [ -z "$PID" ]; then
    echo "✅ El puerto 3000 ya está libre."
else
    echo "⚠️ Matando proceso ghost en puerto 3000 (PID: $PID)..."
    kill -9 $PID
fi

# 2. Limpiar archivos temporales de sesión (OPCIONAL - descomenta si el QR falla)
# echo "🧹 Limpiando caché de sesión..."
# rm -rf .wwebjs_auth .wwebjs_cache

# 3. Arrancar el bot
echo "🟢 Iniciando bot..."
npm start
