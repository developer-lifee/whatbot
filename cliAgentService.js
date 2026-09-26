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
const { execSync, execFileSync } = require('child_process');

const REPO_DIR = path.resolve(__dirname);
const AGY_MODEL = 'Gemini 3.8 Flash (High)';
const GEMINI_MODEL = AGY_MODEL;

/**
 * Invoca directamente el CLI oficial de Antigravity (agy) autenticado con la cuenta de Google
 */
async function callAgyCli(prompt, systemInstruction = "Eres Antigravity CLI, asistente senior de ingeniería de software.") {
    const fullPrompt = `${systemInstruction}\n\n${prompt}`;
    try {
        const agyBin = fs.existsSync('/usr/local/bin/agy') ? '/usr/local/bin/agy' : (fs.existsSync('/root/.local/bin/agy') ? '/root/.local/bin/agy' : 'agy');
        const output = execFileSync(agyBin, ['-p', fullPrompt, '--model', AGY_MODEL, '--dangerously-skip-permissions'], {
            cwd: REPO_DIR,
            encoding: 'utf8',
            timeout: 60000,
            env: { ...process.env, PATH: `/usr/local/bin:/root/.local/bin:${process.env.PATH}` }
        }).trim();
        if (output) return output;
    } catch (e) {
        console.warn('[Antigravity CLI] Advertencia ejecutando binario agy:', e.message);
    }
    // Fallback a HTTP si fuera necesario
    return await callGemini38FlashHttp(prompt, systemInstruction);
}

function getGeminiApiKeys() {
    return [
        process.env.GEMINI_API_KEY_6324,
        process.env.GEMINI_API_KEY_182,
        process.env.GEMINI_API_KEY
    ].filter(Boolean);
}

/**
 * Fallback HTTP a Google Gemini en caso de indisponibilidad del binario agy
 */
async function callGemini38FlashHttp(prompt, systemInstruction = "Eres Antigravity CLI, asistente senior de ingeniería de software.") {
    const keys = getGeminiApiKeys();
    
    // Modelos disponibles en orden de preferencia
    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
    let lastError = null;

    if (keys.length > 0) {
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
    }

    // Fallback robusto a DeepSeek si Gemini tiene alta demanda o falla
    try {
        console.warn('[Antigravity CLI] Recurriendo a DeepSeek como fallback de ingeniería...');
        const { callDeepSeek } = require('./aiService');
        return await callDeepSeek(prompt, systemInstruction, false);
    } catch (dsErr) {
        console.error('[Antigravity CLI] Falló también fallback a DeepSeek:', dsErr.message);
    }

    throw lastError || new Error("Error inesperado en llamada a Gemini / DeepSeek");
}

/**
 * Aplica modificaciones de código en los archivos afectados por el ticket
 */
async function applyCodeModifications(ticket) {
    const rawFiles = Array.isArray(ticket.files) && ticket.files.length > 0 ? ticket.files : [];
    // Si no hay archivos explícitos, deducir según el diagnóstico
    let targetFiles = rawFiles.map(f => f.trim().replace(/^\/+/, '')).filter(Boolean);
    if (targetFiles.length === 0) {
        const diagLower = `${ticket.summary || ''} ${ticket.diagnosis || ''} ${ticket.plan || ''}`.toLowerCase();
        if (diagLower.includes('bancolombia') || diagLower.includes('comprobante') || diagLower.includes('pago') || diagLower.includes('gmail')) {
            targetFiles = ['gmailService.js', 'aiService.js'];
        } else if (diagLower.includes('error') || diagLower.includes('diagnostico')) {
            targetFiles = ['errorDiagnosticService.js'];
        } else {
            targetFiles = ['index.js'];
        }
    }

    const modifiedFiles = [];
    const { callDeepSeek } = require('./aiService');

    for (const relFile of targetFiles) {
        const fullPath = path.resolve(REPO_DIR, relFile);
        if (!fs.existsSync(fullPath)) {
            console.warn(`[Antigravity CLI] Archivo para modificar no existe: ${fullPath}`);
            continue;
        }

        // Si el archivo es demasiado grande (ej: index.js > 500kb), no sobrescribir completo, pedir reemplazo de bloque
        const stats = fs.statSync(fullPath);
        const originalCode = fs.readFileSync(fullPath, 'utf8');

        if (stats.size > 200000) {
            console.log(`[Antigravity CLI] Archivo extenso (${relFile}, ${(stats.size/1024).toFixed(1)}KB). Buscando bloque específico...`);
            const snippetPrompt = `Debes modificar el archivo grande "${relFile}" en el proyecto whatbot.
PLAN DE LA SOLUCIÓN:
${ticket.plan}
DIAGNÓSTICO:
${ticket.diagnosis || ''}

Indica en formato JSON un bloque de búsqueda y reemplazo EXACTO dentro del archivo:
{
  "buscar": "código existente exacto dentro del archivo a reemplazar (al menos 3 a 10 líneas para evitar ambigüedad)",
  "reemplazarPor": "nuevo código de reemplazo con la solución implementada"
}`;
            try {
                let snippetRaw = await callDeepSeek(snippetPrompt, "Responde únicamente con JSON válido.", true);
                snippetRaw = snippetRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
                const parsedSnippet = JSON.parse(snippetRaw);
                if (parsedSnippet.buscar && parsedSnippet.reemplazarPor && originalCode.includes(parsedSnippet.buscar)) {
                    const backupPath = `${fullPath}.bak`;
                    fs.writeFileSync(backupPath, originalCode, 'utf8');
                    const newContent = originalCode.replace(parsedSnippet.buscar, parsedSnippet.reemplazarPor);
                    fs.writeFileSync(fullPath, newContent, 'utf8');
                    try {
                        execSync(`node -c "${fullPath}"`, { cwd: REPO_DIR });
                        fs.unlinkSync(backupPath);
                        modifiedFiles.push(relFile);
                        console.log(`[Antigravity CLI] ✅ Bloque reemplazado y validado con éxito en ${relFile}`);
                        continue;
                    } catch (synErr) {
                        console.error(`[Antigravity CLI] ❌ Error sintáctico tras reemplazo en ${relFile}. Revertiendo:`, synErr.message);
                        fs.copyFileSync(backupPath, fullPath);
                        fs.unlinkSync(backupPath);
                    }
                }
            } catch (snErr) {
                console.warn('[Antigravity CLI] No se pudo aplicar bloque en archivo grande:', snErr.message);
            }
            continue;
        }

        // Archivos de tamaño estándar: reescribir con validación estricta
        const editPrompt = `Actúas como un ingeniero de software senior para el repositorio whatbot.
Se debe implementar la siguiente solución técnica aprobada en el archivo "${relFile}":
PLAN:
${ticket.plan}
DIAGNÓSTICO:
${ticket.diagnosis || ''}

CÓDIGO ORIGINAL DEL ARCHIVO (${relFile}):
\`\`\`javascript
${originalCode}
\`\`\`

REGLAS CRÍTICAS:
1. Devuelve el código JavaScript COMPLETO del archivo con la corrección aplicada.
2. Mantén intacta toda la funcionalidad, imports y lógica que no requiera cambio.
3. El código debe ser 100% sintácticamente válido para Node.js.
4. Responde ÚNICAMENTE con el bloque \`\`\`javascript ... \`\`\` sin explicaciones previas ni posteriores.`;

        let updatedCode = null;
        try {
            const resp = await callDeepSeek(editPrompt, "Eres un asistente de programación experto en Node.js. Responde únicamente con el bloque de código javascript.", false);
            const match = resp.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
            updatedCode = match ? match[1].trim() : resp.trim();
        } catch (e) {
            console.warn('[Antigravity CLI] Falló generación con DeepSeek, intentando Gemini:', e.message);
            try {
                const resp = await callGemini38FlashHttp(editPrompt);
                const match = resp.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
                updatedCode = match ? match[1].trim() : resp.trim();
            } catch (gErr) {
                console.error('[Antigravity CLI] Error en ambos LLMs para editar archivo:', gErr.message);
            }
        }

        if (updatedCode && updatedCode.length > 50 && updatedCode !== originalCode) {
            const backupPath = `${fullPath}.bak`;
            fs.writeFileSync(backupPath, originalCode, 'utf8');
            fs.writeFileSync(fullPath, updatedCode, 'utf8');

            try {
                execSync(`node -c "${fullPath}"`, { cwd: REPO_DIR });
                fs.unlinkSync(backupPath);
                modifiedFiles.push(relFile);
                console.log(`[Antigravity CLI] ✅ Archivo ${relFile} modificado y validado sintácticamente.`);
            } catch (syntaxErr) {
                console.error(`[Antigravity CLI] ❌ Error de sintaxis en ${relFile}. Revertiendo:`, syntaxErr.message);
                fs.copyFileSync(backupPath, fullPath);
                fs.unlinkSync(backupPath);
            }
        }
    }

    return modifiedFiles;
}

/**
 * Aplica los cambios en el código, realiza el commit y ejecuta git push a origin main
 */
async function executeFixAndCommit(ticket) {
    console.log(`[Antigravity CLI] 🚀 Ejecutando resolución en código para ticket #${ticket.id || 'N/A'}...`);

    const commitMessage = ticket.commitMessage || 
        `fix(bot): resolver incidencia en ${ticket.platform || 'servicio'}\n\n` +
        `- Causa raíz: ${ticket.diagnosis || 'Reportado en soporte'}\n` +
        `- Solución: ${ticket.plan || 'Actualización de validaciones y credenciales'}\n` +
        `- Prevención: Refuerzo de consistencia entre datos y flujos de entrega.`;

    try {
        // 1. Modificar internamente los archivos de código
        const codeFilesModified = await applyCodeModifications(ticket);

        // 2. Preparar stage de Git
        execSync('git add -A', { cwd: REPO_DIR });
        const statusAfter = execSync('git status --porcelain', { cwd: REPO_DIR, encoding: 'utf8' }).trim();

        let commitHash = null;
        let pushed = false;

        if (statusAfter) {
            const sanitizedMsg = commitMessage.replace(/"/g, '\\"');
            execSync(`git commit -m "${sanitizedMsg}"`, { cwd: REPO_DIR });
            commitHash = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
            console.log(`[Antigravity CLI] ✅ Commit creado: ${commitHash}`);

            // 3. Ejecutar git push a origin main
            try {
                execSync('git push origin main', { cwd: REPO_DIR, encoding: 'utf8' });
                pushed = true;
                console.log(`[Antigravity CLI] 🚀 git push origin main exitoso.`);
            } catch (pushErr) {
                console.error('[Antigravity CLI] ⚠️ Error en git push:', pushErr.message);
                // Si el push requiere pull previo
                try {
                    execSync('git pull --rebase origin main && git push origin main', { cwd: REPO_DIR, encoding: 'utf8' });
                    pushed = true;
                    console.log(`[Antigravity CLI] 🚀 git push origin main exitoso tras rebase.`);
                } catch (rebaseErr) {
                    console.error('[Antigravity CLI] ❌ git push falló definitivamente:', rebaseErr.message);
                }
            }
        } else {
            commitHash = execSync('git rev-parse --short HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
            console.log(`[Antigravity CLI] ℹ️ Sin cambios de archivo nuevos. HEAD: ${commitHash}`);
            // Asegurar que el repositorio remoto esté al día
            try {
                execSync('git push origin main', { cwd: REPO_DIR, encoding: 'utf8' });
                pushed = true;
            } catch (e) {}
        }

        // Obtener lista final de archivos tocados
        let changedFiles = codeFilesModified;
        if (changedFiles.length === 0) {
            try {
                const diffFiles = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: REPO_DIR, encoding: 'utf8' }).trim();
                changedFiles = diffFiles ? diffFiles.split('\n') : [];
            } catch (e) {}
        }

        return {
            success: true,
            commitHash,
            commitMessage,
            changedFiles,
            pushed,
            model: GEMINI_MODEL
        };
    } catch (err) {
        console.error('[Antigravity CLI] ❌ Error ejecutando commit/push:', err.message);
        return {
            success: false,
            error: err.message,
            commitHash: null,
            pushed: false,
            model: GEMINI_MODEL
        };
    }
}

// Ejecución directa por terminal CLI (ej: agy-fix "descripcion")
if (require.main === module) {
    const args = process.argv.slice(2);
    const query = args.join(' ').trim() || "Auditoría general de errores";
    (async () => {
        console.log(`[Antigravity CLI] 🧠 Analizando con ${AGY_MODEL}: "${query}"`);
        try {
            const answer = await callAgyCli(`Analiza este requerimiento o error en el proyecto whatbot: "${query}". Describe la solución técnica.`);
            console.log('\n--- DIAGNÓSTICO ANTIGRAVITY CLI ---');
            console.log(answer);
        } catch (e) {
            console.error('Error:', e.message);
        }
    })();
}

module.exports = {
    callGemini38Flash: callAgyCli,
    callAgyCli,
    executeFixAndCommit,
    applyCodeModifications,
    GEMINI_MODEL: AGY_MODEL
};

