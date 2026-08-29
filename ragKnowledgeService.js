const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Supported API Keys array for automated rotation and failover
const GEMINI_KEYS = Array.from(new Set(
  Object.entries(process.env)
    .filter(([key, val]) => (key.startsWith('GEMINI_API_KEY') || key.startsWith('GOOGLE_API_KEY')) && val && val.trim().length > 10)
    .map(([_, val]) => val.trim())
));

let currentKeyIndex = 0;

function getActiveGeminiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  return GEMINI_KEYS[currentKeyIndex % GEMINI_KEYS.length];
}

function rotateGeminiKey() {
  if (GEMINI_KEYS.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    const activeKey = getActiveGeminiKey() || "";
    console.log(`[RAG Gemini Failover] Rotando clave a índice ${currentKeyIndex}. Clave activa ahora termina en: ...${activeKey.slice(-6)}`);
  }
}

// In-memory vector store
let vectorStore = [];
let isInitialized = false;

const CACHE_FILE_PATH = path.join(__dirname, 'knowledge_embeddings_cache.json');

/**
 * Calculates cosine similarity between two float vectors.
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

const EMBEDDING_MODELS = [
  "gemini-embedding-001",
  "gemini-embedding-2"
];

/**
 * Generates an embedding vector using Google Gemini gemini-embedding-001.
 */
async function getEmbedding(text, retryCount = 0) {
  const cleanText = (text || '').trim();
  if (!cleanText) return null;

  if (retryCount >= GEMINI_KEYS.length) {
    console.warn('[RAG Embeddings] Se agotaron los reintentos con todas las claves de Gemini.');
    return null;
  }

  const apiKey = getActiveGeminiKey();
  if (!apiKey) {
    console.warn('[RAG Embeddings] No hay clave de Gemini disponible.');
    return null;
  }

  const modelName = EMBEDDING_MODELS[0];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${apiKey}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${modelName}`,
        content: {
          parts: [{ text: cleanText }]
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 429 || response.status === 403 || response.status === 404) {
      rotateGeminiKey();
      return await getEmbedding(text, retryCount + 1);
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[RAG Embeddings] Error de API (${response.status}):`, errText);
      rotateGeminiKey();
      return await getEmbedding(text, retryCount + 1);
    }

    const data = await response.json();
    if (data.embedding && data.embedding.values) {
      return data.embedding.values;
    }
    return null;
  } catch (err) {
    rotateGeminiKey();
    return await getEmbedding(text, retryCount + 1);
  }
}

/**
 * Collects knowledge documents from support.json, knowledge_base.json, policies.json, and platforms.json.
 */
function loadSourceDocuments() {
  const chunks = [];

  // 1. support.json (Plataformas y sus problemas comunes detallados)
  const supportPath = path.join(__dirname, 'support.json');
  if (fs.existsSync(supportPath)) {
    try {
      const supportData = JSON.parse(fs.readFileSync(supportPath, 'utf8'));
      if (Array.isArray(supportData)) {
        supportData.forEach(platform => {
          const platName = platform.name || platform.id;
          if (Array.isArray(platform.issues)) {
            platform.issues.forEach(issue => {
              const issueTitle = issue.title || issue.id;
              const steps = (issue.steps || []).map(s => typeof s === 'string' ? s : s.text || '').join('\n');
              chunks.push({
                id: `support_${platform.id}_${issue.id}`,
                source: 'support.json',
                category: `Soporte: ${platName}`,
                title: `${platName} - ${issueTitle}`,
                content: `PLATAFORMA: ${platName}\nPROBLEMA: ${issueTitle}\nPASOS DE SOLUCIÓN:\n${steps}`
              });
            });
          }
        });
      }
    } catch (e) {
      console.warn('[RAG Loader] Error leyendo support.json:', e.message);
    }
  }

  // 2. knowledge_base.json
  const kbPath = path.join(__dirname, 'knowledge_base.json');
  if (fs.existsSync(kbPath)) {
    try {
      const kbData = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
      if (kbData.streaming_general_rules) {
        for (const [key, val] of Object.entries(kbData.streaming_general_rules)) {
          chunks.push({
            id: `kb_rule_${key}`,
            source: 'knowledge_base.json',
            category: 'Reglas de Streaming',
            title: `Regla: ${key}`,
            content: typeof val === 'string' ? val : JSON.stringify(val)
          });
        }
      }
      if (kbData.platform_rules) {
        for (const [plat, rule] of Object.entries(kbData.platform_rules)) {
          chunks.push({
            id: `kb_platform_${plat}`,
            source: 'knowledge_base.json',
            category: 'Reglas por Plataforma',
            title: `Plataforma ${plat}`,
            content: `PLATAFORMA: ${plat}\nREGLAS:\n${typeof rule === 'string' ? rule : JSON.stringify(rule)}`
          });
        }
      }
    } catch (e) {
      console.warn('[RAG Loader] Error leyendo knowledge_base.json:', e.message);
    }
  }

  // 3. policies.json
  const policiesPath = path.join(__dirname, 'policies.json');
  if (fs.existsSync(policiesPath)) {
    try {
      const polData = JSON.parse(fs.readFileSync(policiesPath, 'utf8'));
      if (polData.terminos_y_condiciones) {
        for (const [key, val] of Object.entries(polData.terminos_y_condiciones)) {
          const content = Array.isArray(val) ? val.join('\n') : (typeof val === 'string' ? val : JSON.stringify(val));
          chunks.push({
            id: `policy_${key}`,
            source: 'policies.json',
            category: 'Términos y Políticas',
            title: `Política: ${key}`,
            content: `POLÍTICA (${key}):\n${content}`
          });
        }
      }
    } catch (e) {
      console.warn('[RAG Loader] Error leyendo policies.json:', e.message);
    }
  }

  // 4. Guías maestras de negocio críticas
  chunks.push({
    id: 'master_netflix_household',
    source: 'system',
    category: 'Soporte Crítico',
    title: 'Netflix: Pantalla de Hogar / Ver temporalmente / Código de Viaje',
    content: `GUÍA NETFLIX HOGAR EN TELEVISORES:
1. Si en el TV sale el aviso "¿Entendimos mal? Si estás de viaje o fuera de casa, puedes obtener un código para ver Netflix temporalmente en este dispositivo", NO significa que la sesión se cerró ni que la clave esté mal.
2. El usuario debe seleccionar "Ver temporalmente" (o "Actualizar Hogar") con el control de su TV.
3. En la siguiente pantalla debe seleccionar "Enviar correo" o "Enviar código".
4. En cuanto le dé enviar, el usuario escribe la palabra "código" o entra a https://sheerit.co/actualizar y el sistema le entrega su código de 4 dígitos en segundos.`
  });

  chunks.push({
    id: 'master_profiles_creation',
    source: 'system',
    category: 'Soporte Crítico',
    title: 'Creación y Asignación de Perfiles',
    content: `GUÍA DE PERFILES:
1. Si el cliente indica que no ve su nombre ("no sale mi nombre", "cuál perfil es el mío", "no está mi perfil"), debe presionar el botón "Añadir perfil" (o "+") en su pantalla y crearlo con su nombre exacto registrado.
2. Está estrictamente PROHIBIDO modificar o tomar perfiles de otros compañeros para no cruzar pantallas.
3. Si la cuenta ya alcanzó el límite máximo de perfiles y no deja crear uno nuevo, soporte le reasignará una cuenta nueva de inmediato.`
  });

  chunks.push({
    id: 'master_warranty_guarantee',
    source: 'system',
    category: 'Garantía y Políticas',
    title: 'Garantía por Caída Prematura de Servicios',
    content: `POLÍTICA DE GARANTÍA SHEERIT:
1. Si un servicio se cae o muestra publicidad (ej: YouTube Premium, Canva, etc.) y la suscripción está dentro de su fecha de vencimiento contratada, el cliente tiene garantía 100% activa.
2. Queda ESTRICTAMENTE PROHIBIDO cobrar dinero, pedir renovaciones o solicitar pagos si la cuenta aún está vigente. La reactivación o invitación de reemplazo es $0 COP (gratis).`
  });

  chunks.push({
    id: 'master_payment_methods',
    source: 'system',
    category: 'Pagos',
    title: 'Medios de Pago Oficiales',
    content: `MEDIOS DE PAGO OFICIALES DE SHEERIT STORE:
- Llave Bre-V: 0087387259 (Nequi, Daviplata, Bancolombia, dale!, Lulo, apps bancarias con Bre-V). Entrega y validación automática inmediata ⚡.
- Transferencias Nequi / Bancolombia por QR.`
  });

  chunks.push({
    id: 'master_claude_plans',
    source: 'system',
    category: 'Plataformas e IA',
    title: 'Planes de Claude Pro y Claude Max (Modalidad y Características)',
    content: `MODALIDAD Y CARACTERÍSTICAS DE CLAUDE PRO & CLAUDE MAX:
1. Modalidad de cuenta: Todos los planes de Claude (Claude Pro, Claude Pro x2, Claude Max, Claude Max x5) son CUENTAS COMPARTIDAS asignadas por Sheerit (correo y clave o enlace de inicio), NO son individuales ni en correo personal.
2. Capacidad y Distribución de uso:
   - Claude Pro Estándar ($20.000/mes): Cuenta compartida estándar para uso moderado (15% a 25% de uso).
   - Claude Pro x2 ($30.000/mes): Cuenta compartida con grupo reducido para alto uso (40% a 60% de uso de tokens).
   - Claude Max ($60.000/mes): Cuenta compartida con grupo reducido de alto rendimiento con acceso prioritario a Claude 3.7 Sonnet y Opus.
   - Claude Max x5 ($130.000/mes): Cuenta compartida con grupo muy reducido para trabajo pesado / intensivo (garantizando entre 40% y 60% o más de uso continuo sin saturación).
3. Respuesta ante preguntas sobre si es compartida o individual: Indicar siempre con claridad que es una cuenta compartida pero gestionada con grupos reducidos según el plan para garantizar entre 40% y 60% de uso intensivo sin límites molestos.`
  });

  return chunks;
}

/**
 * Calculates hash of all source knowledge files to detect changes.
 */
function getKnowledgeSourceHash() {
  const files = [
    path.join(__dirname, 'support.json'),
    path.join(__dirname, 'knowledge_base.json'),
    path.join(__dirname, 'policies.json'),
    path.join(__dirname, 'platforms.json')
  ];

  let combined = '';
  for (const f of files) {
    if (fs.existsSync(f)) {
      combined += fs.readFileSync(f, 'utf8');
    }
  }
  return crypto.createHash('md5').update(combined).digest('hex');
}

/**
 * Initializes or loads the vector knowledge base in memory.
 */
async function initKnowledgeVectors(forceRefresh = false) {
  console.log('[RAG Service] Inicializando base de conocimiento vectorial...');
  const currentHash = getKnowledgeSourceHash();

  if (!forceRefresh && fs.existsSync(CACHE_FILE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE_PATH, 'utf8'));
      if (cached && cached.hash === currentHash && Array.isArray(cached.vectors) && cached.vectors.length > 0) {
        vectorStore = cached.vectors;
        isInitialized = true;
        console.log(`[RAG Service] ✅ Base de conocimiento cargada desde caché (${vectorStore.length} vectores listos en memoria).`);
        return;
      }
    } catch (e) {
      console.warn('[RAG Service] Caché inválido o corrupto, regenerando vectores...');
    }
  }

  const docs = loadSourceDocuments();
  console.log(`[RAG Service] Generando embeddings para ${docs.length} fragmentos de conocimiento con Gemini text-embedding-004...`);

  const vectors = [];
  for (const doc of docs) {
    const textToEmbed = `${doc.title}\n${doc.content}`;
    const embedding = await getEmbedding(textToEmbed);
    if (embedding) {
      vectors.push({
        id: doc.id,
        source: doc.source,
        category: doc.category,
        title: doc.title,
        content: doc.content,
        embedding: embedding
      });
    }
  }

  vectorStore = vectors;
  isInitialized = true;

  try {
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify({ hash: currentHash, updatedAt: new Date().toISOString(), vectors }, null, 2), 'utf8');
    console.log(`[RAG Service] ✅ ${vectors.length} vectores indexados y guardados en caché local con éxito.`);
  } catch (err) {
    console.error('[RAG Service] Error guardando caché de vectores:', err.message);
  }
}

/**
 * Searches the knowledge base for the most relevant documents for a user query.
 * @param {string} query The user query or message.
 * @param {number} topK Maximum number of results to return.
 * @param {number} minScore Minimum similarity score threshold (0.0 to 1.0).
 * @returns {Promise<Array<{id: string, title: string, category: string, content: string, score: number}>>}
 */
async function searchKnowledge(query, topK = 3, minScore = 0.45) {
  if (!isInitialized || vectorStore.length === 0) {
    await initKnowledgeVectors();
  }

  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return [];

  const queryVec = await getEmbedding(cleanQuery);
  if (!queryVec) return [];

  const scored = vectorStore.map(doc => {
    const score = cosineSimilarity(queryVec, doc.embedding);
    return {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      content: doc.content,
      score: Math.round(score * 100) / 100
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.filter(item => item.score >= minScore).slice(0, topK);
}

/**
 * Formats RAG search results into a clean string to be injected into system prompts.
 */
function formatRagContext(searchResults) {
  if (!searchResults || searchResults.length === 0) return '';
  let text = '📚 CONOCIMIENTO Y POLÍTICAS RELEVANTES RECUPERADAS (RAG):\n';
  searchResults.forEach((r, idx) => {
    text += `\n[DOCUMENTO ${idx + 1}: ${r.title} (Relevancia: ${Math.round(r.score * 100)}%)]\n${r.content}\n`;
  });
  return text;
}

module.exports = {
  initKnowledgeVectors,
  searchKnowledge,
  getEmbedding,
  cosineSimilarity,
  formatRagContext
};
