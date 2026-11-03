// whatbot/wikiRagService.js
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_PATH = path.join(__dirname, 'admin_knowledge.json');

let cachedChunks = null;

/**
 * Divide la wiki y el conocimiento operativo en chunks atómicos estructurados.
 */
function buildKnowledgeChunks() {
    if (cachedChunks) return cachedChunks;

    const chunks = [];
    if (!fs.existsSync(KNOWLEDGE_PATH)) return [];

    try {
        const raw = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));

        // 1. Chunks de la Wiki Operativa
        if (raw.wiki_operations) {
            for (const [key, section] of Object.entries(raw.wiki_operations)) {
                const title = section.title || key;
                const paragraphs = section.paragraphs || [];

                // Dividir párrafos largos en bloques de máximo 3 párrafos o ~1000 caracteres
                let currentBlock = [];
                let currentLen = 0;
                let subIdx = 1;

                paragraphs.forEach((p) => {
                    const cleanP = p.trim();
                    if (!cleanP) return;

                    currentBlock.push(cleanP);
                    currentLen += cleanP.length;

                    if (currentLen >= 800 || currentBlock.length >= 4) {
                        chunks.push({
                            id: `wiki_${key.toLowerCase()}_${subIdx++}`,
                            category: 'Wiki Operativa',
                            platform: key,
                            title: `${title} (Parte ${subIdx - 1})`,
                            content: currentBlock.join('\n\n'),
                            keywords: extractKeywords(`${title} ${currentBlock.join(' ')}`)
                        });
                        currentBlock = [];
                        currentLen = 0;
                    }
                });

                if (currentBlock.length > 0) {
                    chunks.push({
                        id: `wiki_${key.toLowerCase()}_${subIdx}`,
                        category: 'Wiki Operativa',
                        platform: key,
                        title: subIdx > 1 ? `${title} (Parte ${subIdx})` : title,
                        content: currentBlock.join('\n\n'),
                        keywords: extractKeywords(`${title} ${currentBlock.join(' ')}`)
                    });
                }
            }
        }

        // 2. Chunks de Protocolos Operativos
        if (raw.operational_protocols) {
            for (const [protoKey, val] of Object.entries(raw.operational_protocols)) {
                chunks.push({
                    id: `proto_${protoKey}`,
                    category: 'Protocolo Operativo',
                    platform: 'General',
                    title: `Protocolo: ${protoKey.replace(/_/g, ' ').toUpperCase()}`,
                    content: `${val.description || ''}\nProcedimiento: ${val.procedure || ''}\nReglas: ${JSON.stringify(val)}`,
                    keywords: extractKeywords(`${protoKey} ${val.description || ''} ${val.procedure || ''}`)
                });
            }
        }

        cachedChunks = chunks;
        console.log(`[Wiki RAG] 📚 Índice de conocimiento construido: ${chunks.length} chunks activos.`);
    } catch (e) {
        console.error('[Wiki RAG] Error leyendo admin_knowledge.json:', e.message);
    }

    return cachedChunks || [];
}

/**
 * Extrae palabras clave normalizadas (lematización simple y sin stop words).
 */
function extractKeywords(text = '') {
    const stopWords = new Set([
        'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por', 'un', 'para', 'con', 
        'no', 'una', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'este', 'sí', 
        'porque', 'esta', 'son', 'entre', 'está', 'cuando', 'muy', 'sin', 'sobre', 'también', 'me', 
        'hasta', 'hay', 'donde', 'quien', 'desde', 'todo', 'nos', 'durante', 'todos', 'uno', 'les', 
        'ni', 'contra', 'otros', 'ese', 'eso', 'ante', 'ellos', 'e', 'esto', 'mí', 'antes', 'algunos'
    ]);

    return text
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
}

/**
 * Motor de recuperación RAG (Retrieval) basado en BM25 / TF-IDF ponderado por coincidencia semántica.
 */
function retrieveRelevantChunks(query = '', options = {}) {
    const maxChunks = options.maxChunks || 3;
    const minScore = options.minScore || 0.1;
    const chunks = buildKnowledgeChunks();

    const queryTokens = extractKeywords(query);
    if (queryTokens.length === 0) return chunks.slice(0, maxChunks);

    const scored = chunks.map(chunk => {
        let score = 0;
        const chunkKeywordsSet = new Set(chunk.keywords);
        const chunkTextLower = chunk.content.toLowerCase();
        const chunkTitleLower = chunk.title.toLowerCase();

        queryTokens.forEach(token => {
            // Match en título (peso x3)
            if (chunkTitleLower.includes(token)) score += 3.0;
            // Match en keywords (peso x1.5)
            if (chunkKeywordsSet.has(token)) score += 1.5;
            // Match en contenido (frecuencia con saturación)
            if (chunkTextLower.includes(token)) {
                score += 1.0;
            }
        });

        // Boost especial por entidad de plataforma si coincide exactamente
        const platformLower = (chunk.platform || '').toLowerCase();
        if (query.toLowerCase().includes(platformLower) && platformLower.length > 2) {
            score += 4.0;
        }

        return { ...chunk, score };
    });

    // Filtrar y ordenar
    const results = scored
        .filter(c => c.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxChunks);

    return results;
}

/**
 * Formatea los chunks encontrados para inyectarlos en el prompt del LLM.
 */
function formatChunksForPrompt(query = '', maxChunks = 3) {
    const relevant = retrieveRelevantChunks(query, { maxChunks });
    if (relevant.length === 0) return '';

    return relevant.map((chunk, idx) => 
        `[REFERENCIA RAG #${idx + 1} - ${chunk.title.toUpperCase()} (${chunk.category})]:\n${chunk.content}`
    ).join('\n\n---\n\n');
}

module.exports = {
    buildKnowledgeChunks,
    retrieveRelevantChunks,
    formatChunksForPrompt
};
