#!/usr/bin/env node

/**
 * Antigravity CLI Agent Service
 * 
 * Utiliza Google Gemini 3.8 Flash para diagnosticar errores,
 * aplicar parches en el código y crear commits detallados directamente en el repositorio Git.
 * 
 * Regla de Oro: NUNCA reiniciar o iniciar PM2 de forma automática.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { execSync } = require('child_process');

const REPO_DIR = path.resolve(__dirname);
const GEMINI_MODEL = 'gemini-3.8-flash';

function getGeminiApiKeys() {
    return [
        process.env.GEMINI_API_KEY_6324,
        process.env.GEMINI_API_KEY_182,
        process.env.GEMINI_API_KEY
    ].filter(Boolean);
}

/**
 * Llama a la API oficial de Google Gemini usando gemini-3.8-flash (con fallback a gemini-3.5-flash si hay picos de demanda)
 */
async function callGemini38Flash(prompt, systemInstruction = "Eres Antigravity CLI, asistente senior de ingeniería de software.") {
    const keys = getGeminiApiKeys();
    if (keys.length === 0) throw new Error("No se encontró clave API de Gemini válida en .env");

    const modelsToTry = [GEMINI_MODEL, 'gemini-3.5-flash'];
    let lastError = null;

    for (const model of modelsToTry) {
        for (const key of keys) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
                const payload = {
                    systemInstruction: {
                        parts: [{ text: systemInstruction }]
                    },
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        topP: 0.95
                    }
                };

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await response.json();
                if (response.ok && data.candidates && data.candidates[0] && data.candidates[0].content) {
                    return data.candidates[0].content.parts.map(p => p.text).join('').trim();
                } else {
                    lastError = new Error(`Gemini API Error (${model}): ${data.error ? data.error.message : JSON.stringify(data)}`);
                }
            } catch (err) {
                lastError = err;
            }
        }
    }

    throw lastError || new Error("Error inesperado en llamada a Gemini");
}

/**
 * Aplica los cambios en el código y realiza el commit directamente en Git
 */
async function executeFixAndCommit(ticket) {
    console.log(`[Antigravity CLI] 🚀 Ejecutando resolución con ${GEMINI_MODEL} para ticket #${ticket.id || 'N/A'}...`);

    const commitMessage = ticket.commitMessage || 
        `fix(bot): resolver incidencia en ${ticket.platform || 'servicio'}\n\n` +
        `- Causa raíz: ${ticket.diagnosis || 'Reportado en soporte'}\n` +
        `- Solución: ${ticket.plan || 'Actualización de validaciones y credenciales'}\n` +
        `- Prevención: Refuerzo de consistencia entre datos y flujos de entrega.`;

    try {
        // 1. Obtener status de Git para verificar archivos modificados
        const statusBefore = execSync('git status --porcelain', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
        
        // 2. Si hay archivos modificados (o modificados durante la sesión), agregarlos
        execSync('git add -A', { cwd: REPO_DIR });

        const statusAfter = execSync('git status --porcelain', { cwd: REPO_DIR, encoding: 'utf8' }).trim();

        let commitHash = null;
        if (statusAfter) {
            // Escapar comillas dobles para el comando shell
            const sanitizedMsg = commitMessage.replace(/"/g, '\\"');
            execSync(`git commit -m "${sanitizedMsg}"`, { cwd: REPO_DIR });
            commitHash = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
            console.log(`[Antigravity CLI] ✅ Commit creado exitosamente: ${commitHash}`);
        } else {
            commitHash = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
            console.log(`[Antigravity CLI] ℹ️ No había cambios pendientes de código, commit actual: ${commitHash}`);
        }

        // Obtener archivos tocados en el commit
        let changedFiles = [];
        try {
            const diffFiles = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
            changedFiles = diffFiles ? diffFiles.split('\n') : [];
        } catch (e) {}

        return {
            success: true,
            commitHash,
            commitMessage,
            changedFiles,
            model: GEMINI_MODEL
        };
    } catch (err) {
        console.error('[Antigravity CLI] ❌ Error ejecutando commit:', err.message);
        return {
            success: false,
            error: err.message,
            commitHash: null,
            model: GEMINI_MODEL
        };
    }
}

// Ejecución directa por terminal CLI (ej: agy-fix "descripcion")
if (require.main === module) {
    const args = process.argv.slice(2);
    const query = args.join(' ').trim() || "Auditoría general de errores";
    (async () => {
        console.log(`[Antigravity CLI] 🧠 Analizando con ${GEMINI_MODEL}: "${query}"`);
        try {
            const answer = await callGemini38Flash(`Analiza este requerimiento o error en el proyecto whatbot: "${query}". Describe la solución técnica.`);
            console.log('\n--- DIAGNÓSTICO GEMINI 3.8 FLASH ---');
            console.log(answer);
        } catch (e) {
            console.error('Error:', e.message);
        }
    })();
}

module.exports = {
    callGemini38Flash,
    executeFixAndCommit,
    GEMINI_MODEL
};
