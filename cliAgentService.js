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
const { execSync, execFile, execFileSync } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const REPO_DIR = path.resolve(__dirname);
const AGY_MODEL = 'Gemini 4 Hydrogen (Medium)';
const AGY_CLI_MODELS = ['gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low', 'gemini-3.8-flash-medium'];
const GEMINI_MODEL = AGY_MODEL;

let lastCliErrorDetails = null;

function getLastCliErrorDetails() {
    return lastCliErrorDetails;
}

/**
 * Invoca directamente el CLI oficial de Antigravity (agy) autenticado con la cuenta de Google
 * con soporte para reanudar conversaciones existentes (--conversation) y rotación de modelos Gemini Flash.
 */
async function callAgyCli(prompt, systemInstruction = "Eres Antigravity CLI, asistente senior de ingeniería de software.", conversationId = null) {
    const fullPrompt = `${systemInstruction}\n\n${prompt}`;
    const agyBin = fs.existsSync('/usr/local/bin/agy') ? '/usr/local/bin/agy' : (fs.existsSync('/root/.local/bin/agy') ? '/root/.local/bin/agy' : 'agy');

    const modelErrors = [];
    lastCliErrorDetails = null;

    for (const cliModel of AGY_CLI_MODELS) {
        try {
            const agyArgs = [
                '-p', fullPrompt,
                '--model', cliModel,
                '--output-format', 'json',
                '--disable-slash-commands',
                '--dangerously-skip-permissions'
            ];
            if (conversationId) {
                agyArgs.push('--conversation', conversationId);
            }
            const { stdout, stderr } = await execFileAsync(agyBin, agyArgs, {
                cwd: REPO_DIR,
                encoding: 'utf8',
                timeout: 65000,
                maxBuffer: 20 * 1024 * 1024,
                env: { ...process.env, PATH: `/usr/local/bin:/root/.local/bin:${process.env.PATH}` }
            });
            const trimmed = (stdout || '').trim();
            if (trimmed && !trimmed.includes('RESOURCE_EXHAUSTED') && !trimmed.includes('"status":"ERROR"')) {
                console.log(`[Antigravity CLI] ✅ Respuesta generada exitosamente con modelo ${cliModel}${conversationId ? ' (continuando conversación previa)' : ''}`);
                lastCliErrorDetails = null;
                return trimmed;
            }
            const errComb = `${trimmed} ${stderr || ''}`;
            if (errComb.includes('RESOURCE_EXHAUSTED') || errComb.includes('429')) {
                modelErrors.push(`${cliModel}: 🚨 Cuota / Modelo agotado (HTTP 429 RESOURCE_EXHAUSTED)`);
            } else {
                modelErrors.push(`${cliModel}: ⚠️ Respuesta vacía o estado ERROR (${trimmed.slice(0, 100)})`);
            }
            console.warn(`[Antigravity CLI] Modelo ${cliModel} devolvió respuesta incompleta o con error, probando siguiente...`);
        } catch (e) {
            const rawErr = `${e.message || ''} ${e.stderr || ''} ${e.stdout || ''}`;
            if (e.killed || e.signal === 'SIGTERM' || /timed?\s*out/i.test(rawErr)) {
                modelErrors.push(`${cliModel}: ⏱️ Timeout (>90s) procesando solicitud en CLI`);
            } else if (rawErr.includes('RESOURCE_EXHAUSTED') || rawErr.includes('429')) {
                modelErrors.push(`${cliModel}: 🚨 Cuota / Modelo agotado (HTTP 429 RESOURCE_EXHAUSTED)`);
            } else if (/auth|token|login|credential/i.test(rawErr)) {
                modelErrors.push(`${cliModel}: 🔑 Error de autenticación / sesión OAuth en CLI`);
            } else {
                modelErrors.push(`${cliModel}: ❌ Fallo de ejecución (${(e.message || '').split('\n')[0].slice(0, 100)})`);
            }
            console.warn(`[Antigravity CLI] Advertencia ejecutando binario agy con ${cliModel}:`, e.message.split('\n')[0]);
        }
    }

    // Si falló con conversationId, intentar una vez más sin conversationId por si la sesión previa caducó
    if (conversationId) {
        console.warn('[Antigravity CLI] Reintentando llamada CLI en sesión limpia (sin conversationId)...');
        return callAgyCli(prompt, systemInstruction, null);
    }

    lastCliErrorDetails = modelErrors.join('\n• ');
    return null;
}

/**
 * Extrae de forma robusta un objeto JSON de la salida de Antigravity CLI (agy)
 */
function extractJsonFromAgyOutput(text) {
    if (!text) return null;

    function tryParseCandidate(str) {
        if (!str || typeof str !== 'string') return null;
        const matchBlock = str.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
        if (matchBlock) {
            try { return JSON.parse(matchBlock[1]); } catch (e) {}
        }
        const firstBrace = str.indexOf('{');
        const lastBrace = str.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            try { return JSON.parse(str.slice(firstBrace, lastBrace + 1)); } catch (e) {}
        }
        return null;
    }

    // 1. Intentar parsear si text es el wrapper de agy en formato JSON
    let parsedOuter = null;
    try {
        parsedOuter = JSON.parse(text);
    } catch (e) {
        parsedOuter = tryParseCandidate(text);
    }

    if (parsedOuter && typeof parsedOuter === 'object') {
        const convId = parsedOuter.conversation_id || null;
        // Si es el wrapper de agy ({ conversation_id, status, response, ... })
        if (parsedOuter.response && typeof parsedOuter.response === 'string') {
            const inner = tryParseCandidate(parsedOuter.response);
            if (inner && typeof inner === 'object') {
                if (convId && !inner.conversationId) inner.conversationId = convId;
                return inner;
            }
        }
        if (parsedOuter.response && typeof parsedOuter.response === 'object') {
            if (convId && !parsedOuter.response.conversationId) parsedOuter.response.conversationId = convId;
            return parsedOuter.response;
        }
        // Si parsedOuter ya contiene los campos del ticket directamente
        if (parsedOuter.causaRaiz || parsedOuter.planCodigo || parsedOuter.platform || parsedOuter.summary) {
            if (convId && !parsedOuter.conversationId) parsedOuter.conversationId = convId;
            return parsedOuter;
        }
    }

    // 2. Si no fue wrapper, buscar bloque ```json dentro del texto
    const candidate = tryParseCandidate(text);
    if (candidate && typeof candidate === 'object') {
        if (candidate.response && typeof candidate.response === 'string') {
            const inner = tryParseCandidate(candidate.response);
            if (inner) return inner;
        }
        return candidate;
    }

    return null;
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
    
    // Modelos disponibles en el endpoint v1beta en orden de velocidad/disponibilidad
    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
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
                        body: JSON.stringify(payload),
                        signal: AbortSignal.timeout(45000)
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

    throw lastError || new Error("Error inesperado en llamada a Gemini / Antigravity CLI");
}

/**
 * Extrae código JavaScript desempaquetando wrappers JSON de agy si están presentes
 */
function extractCodeFromResponse(resp) {
    if (!resp) return null;
    let text = resp;
    try {
        const parsed = JSON.parse(resp);
        if (parsed) {
            if (typeof parsed.response === 'string') text = parsed.response;
            else if (typeof parsed.text === 'string') text = parsed.text;
            else if (typeof parsed.output === 'string') text = parsed.output;
            else if (typeof parsed.content === 'string') text = parsed.content;
        }
    } catch (e) {}

    const match = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : text.trim();
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
            console.log(`[Antigravity CLI] Archivo extenso (${relFile}, ${(stats.size/1024).toFixed(1)}KB). Extrayendo contexto relevante para reemplazo preciso...`);
            
            // Extraer palabras clave para localizar el fragmento exacto en el archivo grande
            const textToSearch = `${ticket.plan || ''} ${ticket.diagnosis || ''} ${ticket.summary || ''} ${ticket.rawMessage || ''}`;
            const quotedMatches = textToSearch.match(/'([^']+)'|"([^"]+)"|`([^`]+)`/g) || [];
            const cleanTerms = quotedMatches.map(m => m.replace(/['"`]/g, '').trim()).filter(t => t.length >= 4);
            const rawWords = textToSearch.split(/[\s,.;:()]+/).filter(w => w.length >= 5 && !['revisar', 'filtros', 'asignacion', 'modificar', 'archivo', 'codigo', 'reporte'].includes(w.toLowerCase()));
            const searchTerms = Array.from(new Set([...cleanTerms, ...rawWords]));

            const lines = originalCode.split('\n');

            // 1. Extraer rangos de líneas explícitos citados en el plan/diagnóstico (ej. "líneas 12489-12506", "línea 12498", "index.js:12453-12477")
            const explicitRanges = [];
            const rangeRegex = /(?:l[ií]neas?\s*|:\s*)(\d{2,6})(?:\s*[-–a]\s*(\d{2,6}))?/gi;
            let rm;
            while ((rm = rangeRegex.exec(textToSearch)) !== null) {
                const sLine = parseInt(rm[1], 10);
                const eLine = rm[2] ? parseInt(rm[2], 10) : sLine;
                if (sLine >= 1 && sLine <= lines.length) {
                    const startIdx = Math.max(0, Math.min(sLine, eLine) - 15);
                    const endIdx = Math.min(lines.length, Math.max(sLine, eLine) + 20);
                    explicitRanges.push([startIdx, endIdx]);
                }
            }

            // Fusionar rangos solapados
            explicitRanges.sort((a, b) => a[0] - b[0]);
            const mergedRanges = [];
            for (const rng of explicitRanges) {
                if (!mergedRanges.length || rng[0] > mergedRanges[mergedRanges.length - 1][1]) {
                    mergedRanges.push([...rng]);
                } else {
                    mergedRanges[mergedRanges.length - 1][1] = Math.max(mergedRanges[mergedRanges.length - 1][1], rng[1]);
                }
            }

            let contextSnippet = "";
            if (mergedRanges.length > 0) {
                contextSnippet = mergedRanges.slice(0, 4).map(([s, e]) => {
                    return `// --- FRAGMENTO (${relFile} líneas ${s + 1}-${e}) ---\n` + lines.slice(s, e).join('\n');
                }).join('\n\n');
            } else {
                let bestLineIdx = -1;
                let bestScore = 0;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    let score = 0;
                    for (const term of searchTerms) {
                        if (line.includes(term)) score += 3;
                        else if (line.toLowerCase().includes(term.toLowerCase())) score += 1;
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestLineIdx = i;
                    }
                }

                if (bestLineIdx >= 0) {
                    const start = Math.max(0, bestLineIdx - 40);
                    const end = Math.min(lines.length, bestLineIdx + 60);
                    contextSnippet = lines.slice(start, end).join('\n');
                } else {
                    contextSnippet = lines.slice(0, 100).join('\n');
                }
            }

            const snippetPrompt = `Debes modificar el archivo grande "${relFile}" en el proyecto whatbot.
PLAN DE LA SOLUCIÓN:
${ticket.plan}
DIAGNÓSTICO:
${ticket.diagnosis || ''}

AQUÍ TIENES LOS FRAGMENTOS REALES DEL ARCHIVO "${relFile}" DONDE DEBE APLICARSE LA MODIFICACIÓN (NO leas archivos del disco, usa este código exacto):
\`\`\`javascript
${contextSnippet}
\`\`\`

Indica en formato JSON el bloque (o bloques) de búsqueda y reemplazo EXACTO. Cada bloque "buscar" DEBE existir idéntico (carácter por carácter) dentro del código mostrado arriba (sin incluir los comentarios "// --- FRAGMENTO... ---"):
{
  "buscar": "código existente exacto dentro del fragmento (de 3 a 12 líneas)",
  "reemplazarPor": "nuevo código de reemplazo con la solución implementada",
  "cambios": [
    {
      "buscar": "código existente exacto 1",
      "reemplazarPor": "nuevo código 1"
    }
  ]
}`;
            try {
                let parsedSnippet = null;
                // 1. Intentar con Gemini HTTP directo primero por velocidad (<5s) al tener ya el contexto en memoria
                try {
                    const snippetRaw = await callGemini38FlashHttp(snippetPrompt, "Responde ÚNICAMENTE con JSON válido con 'buscar'/'reemplazarPor' o 'cambios'.");
                    parsedSnippet = extractJsonFromAgyOutput(snippetRaw);
                } catch (gemErr) {
                    console.warn('[Antigravity CLI] Falló Gemini HTTP rápido para snippet, probando agy CLI:', gemErr.message);
                }

                // 2. Fallback a Antigravity CLI (agy) indicando no abrir herramientas de lectura
                if (!parsedSnippet || (!parsedSnippet.buscar && !Array.isArray(parsedSnippet.cambios))) {
                    try {
                        const snippetRaw = await callAgyCli(snippetPrompt, "Eres Antigravity CLI. NO uses herramientas para leer archivos porque el fragmento ya está en el prompt. Devuelve ÚNICAMENTE el JSON con 'buscar' y 'reemplazarPor' (o 'cambios') sin explicaciones.");
                        parsedSnippet = extractJsonFromAgyOutput(snippetRaw);
                    } catch (agyErr) {
                        console.warn('[Antigravity CLI] Falló agy para snippet:', agyErr.message);
                    }
                }

                const editBlocks = [];
                if (parsedSnippet) {
                    if (Array.isArray(parsedSnippet.cambios) && parsedSnippet.cambios.length > 0) {
                        for (const c of parsedSnippet.cambios) {
                            if (c && c.buscar && c.reemplazarPor) editBlocks.push(c);
                        }
                    }
                    if (editBlocks.length === 0 && parsedSnippet.buscar && parsedSnippet.reemplazarPor) {
                        editBlocks.push({ buscar: parsedSnippet.buscar, reemplazarPor: parsedSnippet.reemplazarPor });
                    }
                }

                if (editBlocks.length > 0) {
                    let workingContent = originalCode;
                    let appliedCount = 0;

                    for (const blk of editBlocks) {
                        let searchTarget = blk.buscar;
                        let replaceTarget = blk.reemplazarPor;
                        let canApply = workingContent.includes(searchTarget);

                        if (!canApply) {
                            const normOriginal = workingContent.replace(/\r\n/g, '\n');
                            const normSearch = searchTarget.replace(/\r\n/g, '\n');
                            if (normOriginal.includes(normSearch)) {
                                workingContent = normOriginal;
                                searchTarget = normSearch;
                                replaceTarget = replaceTarget.replace(/\r\n/g, '\n');
                                canApply = true;
                            }
                        }

                        if (canApply && searchTarget !== replaceTarget) {
                            workingContent = workingContent.replace(searchTarget, replaceTarget);
                            appliedCount++;
                        }
                    }

                    if (appliedCount > 0) {
                        const backupPath = `${fullPath}.bak`;
                        fs.writeFileSync(backupPath, originalCode, 'utf8');
                        fs.writeFileSync(fullPath, workingContent, 'utf8');
                        try {
                            execSync(`node -c "${fullPath}"`, { cwd: REPO_DIR });
                            fs.unlinkSync(backupPath);
                            modifiedFiles.push(relFile);
                            console.log(`[Antigravity CLI] ✅ ${appliedCount} bloque(s) reemplazado(s) y validado(s) con éxito en ${relFile}`);
                            continue;
                        } catch (synErr) {
                            console.error(`[Antigravity CLI] ❌ Error sintáctico tras reemplazo en ${relFile}. Revertiendo:`, synErr.message);
                            fs.copyFileSync(backupPath, fullPath);
                            fs.unlinkSync(backupPath);
                        }
                    } else {
                        console.warn(`[Antigravity CLI] ⚠️ Ningún bloque 'buscar' coincidió de forma idéntica en ${relFile}.`);
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
            const resp = await callAgyCli(editPrompt, "Eres Antigravity CLI. Devuelve únicamente el bloque de código javascript.");
            updatedCode = extractCodeFromResponse(resp);
        } catch (e) {
            console.warn('[Antigravity CLI] Falló generación con agy, intentando Gemini:', e.message);
            try {
                const resp = await callGemini38FlashHttp(editPrompt);
                updatedCode = extractCodeFromResponse(resp);
            } catch (gErr) {
                console.error('[Antigravity CLI] Fallaron agy y Gemini para generar código:', gErr.message);
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

    const nowBogota = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const cleanPlat = (ticket.platform || 'servicio').toLowerCase().replace(/\s+/g, '-');
    const commitTitle = `fix(${cleanPlat}): resolver incidencia de ${ticket.summary ? ticket.summary.slice(0, 50) : 'soporte'}`;

    // Construir mensaje de commit exhaustivo con trazabilidad total del caso
    const clientStr = `${ticket.clientName ? ticket.clientName + ' ' : ''}${ticket.clientPhone ? '(+57 ' + ticket.clientPhone + ')' : 'No especificado'}`;
    const rawMsgClean = (ticket.rawMessage || ticket.rawOcr || ticket.summary || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/"/g, "'")
        .trim();
    const rawMsgExcerpt = rawMsgClean.length > 150 ? rawMsgClean.slice(0, 150) + '...' : rawMsgClean;

    let commitMessage = `${commitTitle}\n\n` +
        `- Fecha y Hora: ${nowBogota}\n` +
        `- Cliente: ${clientStr}\n` +
        `- Plataforma: ${ticket.platform || 'General'}\n` +
        `- Caso: ${ticket.summary || 'Incidencia técnica reportada'}\n` +
        `- Mensaje / Reporte: "${rawMsgExcerpt || 'N/A'}"\n` +
        `- Causa raíz: ${ticket.diagnosis || 'Reportado en soporte'}\n` +
        `- Solución en código: ${ticket.plan || 'Actualización de validaciones'}\n` +
        `- Ticket ID: #${ticket.id || 'N/A'}\n` +
        `- Prevención: Refuerzo de consistencia entre datos y flujos de entrega.`;

    if (ticket.commitMessage && !ticket.commitMessage.includes('- Caso:') && ticket.commitMessage !== ticket.summary) {
        commitMessage += `\n\nDetalle adicional:\n${ticket.commitMessage}`;
    }

    try {
        // 1. Modificar internamente los archivos de código
        const codeFilesModified = await applyCodeModifications(ticket);
        if (!codeFilesModified || codeFilesModified.length === 0) {
            console.warn('[Antigravity CLI] ⚠️ applyCodeModifications no pudo aplicar cambios en ningún archivo.');
            return {
                success: false,
                error: 'No se identificaron modificaciones de código concretas para este ticket o el plan era operativo/preliminar.'
            };
        }

        // 2. Preparar stage de Git (únicamente de los archivos de código modificados para no arrastrar cachés JSON de runtime)
        execFileSync('git', ['add', '--', ...codeFilesModified], { cwd: REPO_DIR });
        const statusAfter = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: REPO_DIR, encoding: 'utf8' }).trim();

        let commitHash = null;
        let pushed = false;

        if (statusAfter) {
            const tempCommitMsgPath = path.join(REPO_DIR, '.git', 'COMMIT_EDITMSG_AGENT');
            fs.writeFileSync(tempCommitMsgPath, commitMessage, 'utf8');
            try {
                execFileSync('git', ['commit', '-F', tempCommitMsgPath, '--', ...codeFilesModified], { cwd: REPO_DIR, encoding: 'utf8' });
            } finally {
                if (fs.existsSync(tempCommitMsgPath)) {
                    try { fs.unlinkSync(tempCommitMsgPath); } catch (_) {}
                }
            }
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
            console.warn('[Antigravity CLI] ⚠️ No se detectó ninguna modificación de código real en los archivos.');
            return {
                success: false,
                error: 'No se identificaron modificaciones de código concretas en los archivos del repositorio. No se generó ningún commit en blanco.',
                commitHash: null,
                pushed: false,
                model: GEMINI_MODEL
            };
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
        try {
            // Revertir cambios en Git si falló el commit o push para no dejar el working tree sucio
            execSync('git reset --hard HEAD && git clean -fd', { cwd: REPO_DIR });
        } catch (_) {}
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
    callGemini38FlashHttp,
    extractJsonFromAgyOutput,
    executeFixAndCommit,
    applyCodeModifications,
    getLastCliErrorDetails,
    GEMINI_MODEL: AGY_MODEL
};

