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
    medicalNotes = ''
}) {
    const reasons = [];

    // 1. Filtro estricto por Dislexia para cargos de chat y manejo de credenciales
    if (hasDyslexia) {
        reasons.push(
            "DISLEXIA DECLARADA: Alto riesgo operativo para chat en vivo. " +
            "Dificultades en decodificación y transposición de caracteres comprometen " +
            "el envío exacto de correos, contraseñas alfanuméricas, cuentas bancarias y códigos 2FA."
        );
    }

    // 2. Filtro de precisión técnica
    if (accuracyRate < 60) {
        reasons.push(`PRECISIÓN CRÍTICA (${accuracyRate}%): Desconocimiento grave de protocolos de corte, cobro o plataformas.`);
    } else if (accuracyRate < 75) {
        reasons.push(`PRECISIÓN MEDIA-BAJA (${accuracyRate}%): Comete errores en validación de pagos o resolución.`);
    }

    // 3. Filtro de velocidad bajo presión
    if (averageTimePerCase > 50) {
        reasons.push(`TIEMPO LENTO (${averageTimePerCase}s/caso): Dificultad para mantener el ritmo ante múltiples chats concurrentes.`);
    }

    // Veredicto final
    let recommendation = 'RECOMENDADO';

    if (hasDyslexia) {
        recommendation = 'NO_RECOMENDADO_CHAT';
    } else if (accuracyRate < 70) {
        recommendation = 'DESCARTADO_BAJA_PRECISION';
    } else if (accuracyRate < 80 || averageTimePerCase > 45 || hasAdhd) {
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
    const detailedAnswers = JSON.stringify(data.detailedAnswers || data.answers || {});

    const { recommendation, rejectionReasons } = evaluateHiringRecommendation({
        hasDyslexia,
        hasAdhd,
        hasVisualFatigue,
        totalScore,
        accuracyRate,
        averageTimePerCase,
        medicalNotes
    });

    let savedId = null;

    // 1. Guardar en MySQL
    try {
        const [result] = await pool.query(
            `INSERT INTO advisor_evaluations 
            (candidate_name, candidate_email, candidate_phone, has_dyslexia, has_adhd, has_visual_fatigue, 
             medical_notes, total_score, accuracy_rate, total_time_seconds, average_time_per_case, 
             hiring_recommendation, rejection_reasons, detailed_answers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                candidateName, candidateEmail, candidatePhone,
                hasDyslexia ? 1 : 0, hasAdhd ? 1 : 0, hasVisualFatigue ? 1 : 0,
                medicalNotes, totalScore, accuracyRate, totalTimeSeconds, averageTimePerCase,
                recommendation, rejectionReasons, detailedAnswers
            ]
        );
        savedId = result.insertId;
        console.log(`[Advisor Evaluation] ✅ Evaluación guardada en BD MySQL con ID #${savedId} (${candidateName} - ${recommendation})`);
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
                    average_time_per_case, hiring_recommendation, rejection_reasons, created_at 
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
    evaluateHiringRecommendation
};
