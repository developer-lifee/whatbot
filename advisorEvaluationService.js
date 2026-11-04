// whatbot/advisorEvaluationService.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./database');

const LOCAL_CACHE_PATH = path.join(__dirname, 'logs', 'advisor_evaluations_cache.json');

// Asegurar carpeta de logs
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    try { fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true }); } catch (_) {}
}

/**
 * Genera un perfil psicolaboral y conductual detallado basado en las métricas
 * de reacción, escucha activa, apego a reglas y condiciones cognitivas.
 */
function buildPsychologicalProfile({
    accuracyRate = 0,
    averageTimePerCase = 0,
    tabSwitchesCount = 0,
    audioCasesScore = 0,
    transpositionErrorsCount = 0,
    hasDyslexia = false,
    hasAdhd = false,
    hasVisualFatigue = false,
    medicalNotes = ''
}) {
    // 1. Tolerancia a la Presión Temporal y Control Emocional
    let pressureTolerance = 85;
    let pressureDesc = 'Buen control emocional bajo límites de tiempo de respuesta.';
    if (averageTimePerCase < 18 && accuracyRate >= 80) {
        pressureTolerance = 95;
        pressureDesc = 'Sobresaliente templanza y serenidad. Alta agilidad cognitiva y toma de decisiones firme bajo cronómetro.';
    } else if (averageTimePerCase < 14 && accuracyRate < 70) {
        pressureTolerance = 45;
        pressureDesc = 'Patrón de impulsividad no reflexiva. Tiende a responder con precipitación cometiendo errores por falta de análisis.';
    } else if (averageTimePerCase > 45) {
        pressureTolerance = 55;
        pressureDesc = 'Sensibilidad a la presión temporal. Tiende al sobreanálisis o experimentar lentitud ante volumen concurrente de mensajes.';
    }

    // 2. Escucha Activa y Procesamiento Auditivo
    let activeListening = audioCasesScore || (accuracyRate >= 80 ? 90 : 70);
    let listeningDesc = activeListening >= 80
        ? 'Excelente discriminación fonológica y retención de instrucciones complejas recibidas por nota de voz.'
        : 'Capacidad de síntesis auditiva intermedia; puede requerir reescuchar mensajes de clientes para no omitir datos.';

    // 3. Integridad Operativa y Apego a Protocolos
    let operationalIntegrity = 95;
    let integrityDesc = 'Alto respeto por los protocolos de seguridad bancaria (Bre-V) y confidencialidad.';
    if (tabSwitchesCount >= 4) {
        operationalIntegrity = 30;
        integrityDesc = 'Alerta de confiabilidad: Propensión a buscar atajos o asistencia externa no autorizada durante evaluaciones.';
    } else if (tabSwitchesCount >= 2) {
        operationalIntegrity = 65;
        integrityDesc = 'Integridad bajo observación: Registra salidas de ventana durante la resolución de incidencias.';
    }

    // 4. Empatía y Desescalamiento de Clientes
    let customerEmpathy = accuracyRate >= 75 ? 90 : 65;
    let empathyDesc = accuracyRate >= 75
        ? 'Enfoque constructivo hacia el cliente, capacidad de contener quejas con amabilidad sin perder el rigor de la empresa.'
        : 'Puede presentar respuestas reactivas o apresuradas en situaciones de clientes molestos.';

    // 5. Diagnóstico Psicolaboral Síntesis
    let profileTitle = 'Perfil Analítico y Resolutivo';
    let recommendations = 'Apto para atención al cliente y gestión multicanal.';

    if (transpositionErrorsCount >= 2) {
        profileTitle = 'Perfil con Dislexia / Transposición Alfanumérica Detectada en Prueba';
        recommendations = `ALTO RIESGO OPERATIVO: Falló ${transpositionErrorsCount} pruebas de discriminación visual rápida (inversión de números de cuenta o letras en contraseñas). No apto para chat en vivo; alto riesgo de error en entrega de claves o confirmación de cuentas bancarias.`;
    } else if (hasDyslexia) {
        profileTitle = 'Perfil Vulnerable en Transcripción Alfanumérica (Dislexia Declarada)';
        recommendations = 'No apto para chat en vivo con manejo de claves complejas o cuentas bancarias. Reubicar en soporte por voz o labores sin digitación crítica.';
    } else if (tabSwitchesCount >= 4) {
        profileTitle = 'Perfil con Riesgo de Transgresión de Normas';
        recommendations = 'No recomendado por conductas de atajo y evasión de parámetros de evaluación.';
    } else if (accuracyRate >= 85 && averageTimePerCase <= 35) {
        profileTitle = 'Perfil de Alto Rendimiento (Ágil y Preciso)';
        recommendations = 'Perfil ideal para liderar soporte prioritario y manejo simultáneo de múltiples chats de alta demanda.';
    } else if (accuracyRate < 70) {
        profileTitle = 'Perfil Técnico en Desarrollo';
        recommendations = 'Requiere supervisión constante y formación en políticas antes de interactuar directamente con clientes.';
    }

    return {
        metrics: {
            pressureTolerance,
            activeListening,
            operationalIntegrity,
            customerEmpathy
        },
        descriptors: {
            pressureDesc,
            listeningDesc,
            integrityDesc,
            empathyDesc
        },
        profileTitle,
        recommendations
    };
}

/**
 * Determina la recomendación de contratación y motivos basados en precisión,
 * tiempos de respuesta y condiciones cognitivas/de lectura.
 */
function evaluateHiringRecommendation({
    hasDyslexia = false,
    hasAdhd = false,
    hasVisualFatigue = false,
    totalScore = 0,
    accuracyRate = 0,
    averageTimePerCase = 0,
    tabSwitchesCount = 0,
    audioCasesScore = 0,
    transpositionErrorsCount = 0,
    medicalNotes = ''
}) {
    const reasons = [];

    // 1. Detección Anti-Trampa (Cambio de pestaña / consulta externa a ChatGPT)
    if (tabSwitchesCount >= 4) {
        reasons.push(
            `ALERTA DE TRAMPA (${tabSwitchesCount} cambios de pestaña): El candidato salió repetidamente de la ventana de la prueba para consultar herramientas externas o IA.`
        );
    } else if (tabSwitchesCount >= 2) {
        reasons.push(
            `ACTIVIDAD SOSPECHOSA (${tabSwitchesCount} cambios de ventana): Posible intento de consulta externa durante las preguntas cronometradas.`
        );
    }

    // 2. Filtro estricto por Dislexia / Transposición de Caracteres (Empírica o Declarada)
    if (transpositionErrorsCount >= 2) {
        reasons.push(
            `DISLEXIA / TRANSPOSICIÓN DETECTADA EN PRUEBA (${transpositionErrorsCount} fallas): ` +
            "El candidato invirtió letras o números en cotejo de contraseñas de streaming o llaves Bre-V. " +
            "Riesgo operativo crítico para chat en vivo y validación bancaria."
        );
    } else if (hasDyslexia) {
        reasons.push(
            "DISLEXIA DECLARADA: Alto riesgo operativo para chat en vivo. " +
            "Dificultades en decodificación y transposición de caracteres comprometen " +
            "el envío exacto de correos, contraseñas alfanuméricas, cuentas bancarias y códigos 2FA."
        );
    }

    // 3. Filtro de precisión técnica
    if (accuracyRate < 60) {
        reasons.push(`PRECISIÓN CRÍTICA (${accuracyRate}%): Desconocimiento grave de protocolos de corte, cobro o plataformas.`);
    } else if (accuracyRate < 75) {
        reasons.push(`PRECISIÓN MEDIA-BAJA (${accuracyRate}%): Comete errores en validación de pagos o resolución.`);
    }

    // 4. Filtro de velocidad bajo presión
    if (averageTimePerCase > 50) {
        reasons.push(`TIEMPO LENTO (${averageTimePerCase}s/caso): Dificultad para mantener el ritmo ante múltiples chats concurrentes.`);
    }

    // Veredicto final
    let recommendation = 'RECOMENDADO';

    if (tabSwitchesCount >= 4) {
        recommendation = 'DESCARTADO_TRAMPA_DETECTADA';
    } else if (transpositionErrorsCount >= 2 || hasDyslexia) {
        recommendation = 'NO_RECOMENDADO_CHAT';
    } else if (accuracyRate < 70) {
        recommendation = 'DESCARTADO_BAJA_PRECISION';
    } else if (accuracyRate < 80 || averageTimePerCase > 45 || hasAdhd || tabSwitchesCount >= 2) {
        recommendation = 'OBSERVACION_PRUEBA';
    } else {
        recommendation = 'APTO_CONTRATAR';
    }

    return {
        recommendation,
        rejectionReasons: reasons.join('\n') || 'Cumple con los estándares operativos de precisión y velocidad.'
    };
}

/**
 * Guarda una evaluación de asesor/postulante en MySQL y en respaldo local.
 */
async function saveAdvisorEvaluation(data) {
    const candidateName = (data.candidateName || data.name || 'Sin Nombre').trim();
    const candidateEmail = (data.candidateEmail || data.email || '').trim();
    const candidatePhone = (data.candidatePhone || data.phone || '').trim();
    const hasDyslexia = Boolean(data.hasDyslexia);
    const hasAdhd = Boolean(data.hasADHD || data.hasAdhd);
    const hasVisualFatigue = Boolean(data.hasVisualFatigue);
    const medicalNotes = (data.medicalNotes || '').trim();
    const totalScore = Number(data.totalScore || data.score || 0);
    const accuracyRate = Number(data.accuracyRate || 0);
    const totalTimeSeconds = Number(data.totalTimeTaken || data.totalTime || 0);
    const averageTimePerCase = Number(data.averageTimePerCase || (data.casesCount ? Math.round(totalTimeSeconds / data.casesCount) : 0));
    const tabSwitchesCount = Number(data.tabSwitchesCount || data.tabSwitches || 0);
    const audioCasesScore = Number(data.audioCasesScore || 0);
    const transpositionErrorsCount = Number(data.transpositionErrorsCount || 0);
    const psychProfile = buildPsychologicalProfile({
        accuracyRate,
        averageTimePerCase,
        tabSwitchesCount,
        audioCasesScore,
        transpositionErrorsCount,
        hasDyslexia,
        hasAdhd,
        hasVisualFatigue,
        medicalNotes
    });

    let answersObject = data.detailedAnswers || data.answers || {};
    if (typeof answersObject === 'string') {
        try { answersObject = JSON.parse(answersObject); } catch (_) {}
    }
    answersObject.psychologicalProfile = psychProfile;
    const detailedAnswers = JSON.stringify(answersObject);

    const { recommendation, rejectionReasons } = evaluateHiringRecommendation({
        hasDyslexia,
        hasAdhd,
        hasVisualFatigue,
        totalScore,
        accuracyRate,
        averageTimePerCase,
        tabSwitchesCount,
        audioCasesScore,
        transpositionErrorsCount,
        medicalNotes
    });

    let savedId = null;

    // 1. Guardar en MySQL
    try {
        const [result] = await pool.query(
            `INSERT INTO advisor_evaluations 
            (candidate_name, candidate_email, candidate_phone, has_dyslexia, has_adhd, has_visual_fatigue, 
             medical_notes, total_score, accuracy_rate, total_time_seconds, average_time_per_case, 
             tab_switches_count, audio_cases_score, transposition_errors_count, hiring_recommendation, rejection_reasons, detailed_answers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                candidateName, candidateEmail, candidatePhone,
                hasDyslexia ? 1 : 0, hasAdhd ? 1 : 0, hasVisualFatigue ? 1 : 0,
                medicalNotes, totalScore, accuracyRate, totalTimeSeconds, averageTimePerCase,
                tabSwitchesCount, audioCasesScore, transpositionErrorsCount, recommendation, rejectionReasons, detailedAnswers
            ]
        );
        savedId = result.insertId;
        console.log(`[Advisor Evaluation] ✅ Evaluación guardada en BD MySQL con ID #${savedId} (${candidateName} - ${recommendation} - TabSwitches: ${tabSwitchesCount})`);
    } catch (err) {
        console.error('[Advisor Evaluation] ⚠️ Error guardando en MySQL, utilizando respaldo JSON:', err.message);
    }

    // 2. Guardar en respaldo local JSON
    const record = {
        id: savedId || Date.now(),
        candidateName,
        candidateEmail,
        candidatePhone,
        hasDyslexia,
        hasAdhd,
        hasVisualFatigue,
        medicalNotes,
        totalScore,
        accuracyRate,
        totalTimeSeconds,
        averageTimePerCase,
        tabSwitchesCount,
        audioCasesScore,
        hiringRecommendation: recommendation,
        rejectionReasons,
        createdAt: new Date().toISOString()
    };

    try {
        let list = [];
        if (fs.existsSync(LOCAL_CACHE_PATH)) {
            list = JSON.parse(fs.readFileSync(LOCAL_CACHE_PATH, 'utf8'));
        }
        list.unshift(record);
        fs.writeFileSync(LOCAL_CACHE_PATH, JSON.stringify(list.slice(0, 500), null, 2), 'utf8');
    } catch (e) {
        console.warn('[Advisor Evaluation] Error writing local cache:', e.message);
    }

    return {
        success: true,
        id: savedId || record.id,
        recommendation,
        rejectionReasons
    };
}

/**
 * Obtiene el listado de evaluaciones para el panel administrativo.
 */
async function getAdvisorEvaluations() {
    try {
        const [rows] = await pool.query(
            `SELECT id, candidate_name, candidate_email, candidate_phone, has_dyslexia, has_adhd, 
                    has_visual_fatigue, medical_notes, total_score, accuracy_rate, total_time_seconds, 
                    average_time_per_case, tab_switches_count, audio_cases_score, transposition_errors_count, 
                    hiring_recommendation, rejection_reasons, detailed_answers, created_at 
             FROM advisor_evaluations 
             ORDER BY created_at DESC 
             LIMIT 200`
        );
        return rows;
    } catch (err) {
        console.warn('[Advisor Evaluation] Fallback a caché local:', err.message);
        if (fs.existsSync(LOCAL_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(LOCAL_CACHE_PATH, 'utf8'));
        }
        return [];
    }
}

module.exports = {
    saveAdvisorEvaluation,
    getAdvisorEvaluations,
    evaluateHiringRecommendation,
    buildPsychologicalProfile
};
