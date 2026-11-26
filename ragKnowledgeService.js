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
  "gemini-embedding-001"
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
      if (kbData.general_policies) {
        for (const [key, val] of Object.entries(kbData.general_policies)) {
          chunks.push({
            id: `kb_general_policy_${key}`,
            source: 'knowledge_base.json',
            category: 'Políticas Generales',
            title: `Política general: ${key}`,
            content: typeof val === 'string' ? val : JSON.stringify(val)
          });
        }
      }
      if (kbData.support_protocol) {
        const sp = kbData.support_protocol;
        const content = typeof sp === 'string' ? sp : Object.entries(sp).map(([k, v]) => `${k}: ${v}`).join('\n');
        chunks.push({
          id: 'kb_support_protocol',
          source: 'knowledge_base.json',
          category: 'Protocolo de Soporte',
          title: 'Protocolo de atención en fallas y credenciales',
          content
        });
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
      if (Array.isArray(polData.terms_and_conditions)) {
        polData.terms_and_conditions.forEach((item, idx) => {
          const paragraphs = Array.isArray(item.paragraphs) ? item.paragraphs.join('\n') : '';
          chunks.push({
            id: `policy_tc_${idx}`,
            source: 'policies.json',
            category: 'Términos y Condiciones',
            title: item.title || `Términos ${idx + 1}`,
            content: `${item.title || ''}\n${paragraphs}`.trim()
          });
        });
      }
      if (Array.isArray(polData.refund_policy)) {
        polData.refund_policy.forEach((item, idx) => {
          const paragraphs = Array.isArray(item.paragraphs) ? item.paragraphs.join('\n') : '';
          chunks.push({
            id: `policy_refund_${idx}`,
            source: 'policies.json',
            category: 'Política de Reembolsos',
            title: item.title || `Reembolso ${idx + 1}`,
            content: `${item.title || ''}\n${paragraphs}`.trim()
          });
        });
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
1. Si en pantalla aparece un perfil llamado "DISPONIBLE" o "LIBRE", el cliente puede entrar a ese y renombrarlo con su nombre exacto registrado.
2. Si no aparece "DISPONIBLE" o "LIBRE" y no ve su nombre, debe presionar "Añadir perfil" (o "+") y crearlo con su nombre exacto registrado. Está estrictamente PROHIBIDO tomar o modificar perfiles de otros clientes activos.
3. Si la cuenta ya alcanzó el límite máximo de perfiles y no deja crear uno nuevo, NO prometer cambio de cuenta nueva: pedirle una foto de la pantalla de perfiles para identificar qué perfil de un ex-cliente ya inactivo puede editar y renombrar con su nombre.`
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
    title: 'Planes de Claude Pro y Claude Max (Modalidad, Acceso y Características)',
    content: `MODALIDAD, ACCESO Y CARACTERÍSTICAS DE CLAUDE PRO & CLAUDE MAX:
1. Modalidad de cuenta: Todos los planes de Claude (Pro Estándar, Pro x2 / 4x-6x, Max y Max x5) son CUENTAS COMPARTIDAS asignadas por Sheerit (no individuales en correo personal). Consulta siempre los precios vigentes directamente en el catálogo dinámico del sistema (no inventes ni uses precios estáticos).
2. Capacidad y Distribución de uso:
   - Claude Pro Estándar: Cuenta compartida estándar para uso moderado (15% a 25% de uso).
   - Claude Pro x2 (grupo reducido): Cuenta compartida con grupo reducido para mayor rendimiento (40% a 60% de uso).
   - Claude Max: Cuenta compartida de alto rendimiento con grupo reducido y acceso prioritario a modelos avanzados.
   - Claude Max x5: Cuenta compartida con grupo muy reducido para trabajo pesado / intensivo con amplia disponibilidad de uso continuo.
3. Inicio de sesión y código de 6 dígitos: Anthropic envía un enlace de acceso al correo; si la app o pantalla del cliente pide un código de 6 dígitos, al abrir el enlace que envía el bot en el navegador se muestra el código temporal (o inicia sesión directamente).
4. Respuesta ante preguntas sobre si es compartida o individual: Indicar siempre con claridad que es una cuenta compartida gestionada con grupos controlados según el plan elegido.`
  });

  chunks.push({
    id: 'master_individual_slots_policy',
    source: 'system',
    category: 'Plataformas y Modalidades',
    title: 'Modalidad de Cupo Individual en Cuentas Familiares (Apple One, Gemini, YouTube, Spotify)',
    content: `POLÍTICA DE CUPOS INDIVIDUALES EN GRUPOS FAMILIARES:
1. En todos los servicios que se activan mediante invitación familiar a correo propio o Apple ID (Apple One, Gemini Correo Propio, YouTube Premium, Spotify Personal, Microsoft 365, etc.), el cliente adquiere ÚNICAMENTE UN CUPO INDIVIDUAL PARA 1 SOLA PERSONA al precio vigente del catálogo.
2. Sheerit Store administra el grupo familiar y agrega al cliente como miembro invitado individual.
3. El cliente NO es el administrador del grupo familiar y NO puede agregar a sus familiares, ni invitar a 6 personas, ni compartir el plan con otros por ese mismo valor.
4. Si el cliente pregunta si puede compartirlo con su grupo familiar o meter a sus familiares sin costo adicional, la respuesta debe ser:
   "No, el valor del catálogo corresponde a 1 cupo individual para tu cuenta personal. Te unimos a nuestro grupo mediante invitación para que disfrutes de todos los beneficios con total privacidad e independencia en tu propio correo/Apple ID, pero no incluye cupos adicionales para compartir con familiares. Si algún familiar también desea el servicio, debe adquirir su propio cupo individual."`
  });

  chunks.push({
    id: 'master_youtube_sales_suspended',
    source: 'system',
    category: 'Plataformas y Disponibilidad',
    title: 'YouTube Premium: Ventas Nuevas Suspendidas (Solo Garantías y Renovaciones)',
    content: `POLÍTICA ACTUAL DE YOUTUBE PREMIUM:
1. Actualmente las ventas nuevas de YouTube Premium están SUSPENDIDAS indefinidamente (no hay stock para clientes nuevos).
2. Queda prohibido cotizar, prometer o enviar medios de pago para compras nuevas de YouTube Premium.
3. Únicamente se brinda soporte técnico, garantías (reposición gratis si está vigente) y renovaciones a clientes antiguos que ya tengan YouTube Premium activo.`
  });

  return chunks;
}

/**
 * Calculates hash of all source knowledge files and built-in system guides to detect changes.
 */
function getKnowledgeSourceHash() {
  const docsPayload = JSON.stringify(loadSourceDocuments());
  const platformsPath = path.join(__dirname, 'platforms.json');
  const platformsRaw = fs.existsSync(platformsPath) ? fs.readFileSync(platformsPath, 'utf8') : '';
  return crypto.createHash('md5').update(docsPayload + platformsRaw).digest('hex');
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
  console.log(`[RAG Service] Generando embeddings para ${docs.length} fragmentos de conocimiento con Gemini gemini-embedding-001...`);

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
