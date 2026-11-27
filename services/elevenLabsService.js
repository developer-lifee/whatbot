const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

function resolveFfmpegPath() {
  const candidates = ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

function resolveFfprobePath() {
  const candidates = ['/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffprobe';
}

async function parseElevenLabsError(response) {
  const status = response.status;
  try {
    const raw = await response.text();
    const parsed = JSON.parse(raw);
    const detail = parsed?.detail?.message || parsed?.detail || parsed?.message || raw;
    return `ElevenLabs HTTP ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  } catch {
    return `ElevenLabs HTTP ${status}`;
  }
}

/**
 * Obtiene la duración en segundos (entero >= 1) de un archivo de audio usando ffprobe/ffmpeg.
 */
async function getAudioDurationSec(filePath) {
  try {
    const ffprobe = resolveFfprobePath();
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 10000 });
    const parsed = parseFloat(String(stdout || '').trim());
    if (!isNaN(parsed) && parsed > 0) {
      return Math.max(1, Math.round(parsed));
    }
  } catch {}
  return 5;
}

/**
 * Normaliza cualquier audio subido (.mp3, .ogg, .wav, .m4a, .aac) a MP3 mono limpio y sin metadatos.
 */
async function normalizeUploadedAudioToMp3(inputPath, outputMp3Path) {
  const ffmpeg = resolveFfmpegPath();
  await execFileAsync(ffmpeg, [
    '-y',
    '-i', inputPath,
    '-map_metadata', '-1',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '1',
    outputMp3Path
  ], { timeout: 45000 });
  return getAudioDurationSec(outputMp3Path);
}

/**
 * Concatena múltiples archivos de audio en un solo MP3 limpio (sin metadatos) respetando una pausa natural.
 */
async function concatenateAudioFilesToMp3(filePaths, outputMp3Path, pauseMs = 350) {
  const ffmpeg = resolveFfmpegPath();
  const safePauseSec = Math.max(0, Math.min(2000, Number(pauseMs) || 0)) / 1000;

  const args = ['-y'];
  const filterParts = [];
  const concatLabels = [];

  for (let i = 0; i < filePaths.length; i++) {
    args.push('-i', filePaths[i]);
    const needsPad = safePauseSec > 0 && i < filePaths.length - 1;
    const padFilter = needsPad ? `,apad=pad_dur=${safePauseSec}` : '';
    filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono${padFilter}[a${i}]`);
    concatLabels.push(`[a${i}]`);
  }

  const filterComplex = `${filterParts.join(';')};${concatLabels.join('')}concat=n=${filePaths.length}:v=0:a=1[outa]`;
  args.push(
    '-filter_complex', filterComplex,
    '-map', '[outa]',
    '-map_metadata', '-1',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '1',
    outputMp3Path
  );

  await execFileAsync(ffmpeg, args, { timeout: 60000 });
}

/**
 * Lista las voces disponibles en la cuenta de ElevenLabs del cliente.
 */
async function listVoices(apiKey) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('Debes ingresar tu API Key de ElevenLabs.');
  }

  const res = await fetch(`${ELEVENLABS_BASE_URL}/voices`, {
    method: 'GET',
    headers: { 'xi-api-key': cleanKey },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    throw new Error(await parseElevenLabsError(res));
  }

  const data = await res.json();
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  return voices.map(v => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category || 'custom',
    preview_url: v.preview_url || null,
    labels: v.labels || {}
  }));
}

/**
 * Genera un buffer MP3 a partir de texto usando ElevenLabs TTS.
 */
async function textToSpeechMp3(text, { apiKey, voiceId, modelId = 'eleven_multilingual_v2', stability = 0.5, similarityBoost = 0.75 } = {}) {
  const cleanKey = String(apiKey || '').trim();
  const cleanVoice = String(voiceId || '').trim();
  const cleanText = String(text || '').trim();

  if (!cleanKey) throw new Error('Falta la API Key de ElevenLabs.');
  if (!cleanVoice) throw new Error('Debes seleccionar o indicar un Voice ID de ElevenLabs.');
  if (!cleanText) throw new Error('El texto a convertir en audio no puede estar vacío.');

  const res = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(cleanVoice)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': cleanKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: cleanText,
      model_id: modelId || 'eleven_multilingual_v2',
      voice_settings: {
        stability,
        similarity_boost: similarityBoost
      }
    }),
    signal: AbortSignal.timeout(45000)
  });

  if (!res.ok) {
    throw new Error(await parseElevenLabsError(res));
  }

  const arrBuf = await res.arrayBuffer();
  return Buffer.from(arrBuf);
}

/**
 * Convierte un buffer MP3/audio a OGG Opus fresco sin metadatos heredados (nota de voz nativa PTT en WhatsApp).
 */
async function convertMp3ToWhatsAppOgg(mp3Buffer) {
  if (!Buffer.isBuffer(mp3Buffer) || mp3Buffer.length === 0) {
    throw new Error('Buffer de audio inválido para conversión.');
  }

  const id = crypto.randomBytes(6).toString('hex');
  const tmpIn = path.join(os.tmpdir(), `eleven_in_${id}.mp3`);
  const tmpOgg = path.join(os.tmpdir(), `eleven_out_${id}.ogg`);
  const ffmpeg = resolveFfmpegPath();

  try {
    fs.writeFileSync(tmpIn, mp3Buffer);
    await execFileAsync(ffmpeg, [
      '-y',
      '-i', tmpIn,
      '-map_metadata', '-1',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '16000',
      tmpOgg
    ], { timeout: 30000 });
    return fs.readFileSync(tmpOgg);
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
    try { if (fs.existsSync(tmpOgg)) fs.unlinkSync(tmpOgg); } catch {}
  }
}

/**
 * Construye una nota de voz fresca (sin etiqueta de reenviado) uniendo 1 o varios archivos de audio subidos.
 */
async function buildFreshWhatsAppVoiceNoteFromFiles(audioFilePaths, { pauseMs = 350 } = {}) {
  const validPaths = (Array.isArray(audioFilePaths) ? audioFilePaths : []).filter(p => p && fs.existsSync(p));
  if (validPaths.length === 0) {
    throw new Error('No se encontraron los archivos de audio solicitados.');
  }
  if (validPaths.length > 10) {
    throw new Error('Máximo 10 audios por nota de voz combinada.');
  }

  const tmpDir = path.join(os.tmpdir(), `saas_voice_${crypto.randomBytes(6).toString('hex')}`);
  const ffmpeg = resolveFfmpegPath();

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const targetMp3Path = path.join(tmpDir, 'final.mp3');

    if (validPaths.length === 1) {
      await execFileAsync(ffmpeg, [
        '-y',
        '-i', validPaths[0],
        '-map_metadata', '-1',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '1',
        targetMp3Path
      ], { timeout: 45000 });
    } else {
      await concatenateAudioFilesToMp3(validPaths, targetMp3Path, pauseMs);
    }

    const durationSec = await getAudioDurationSec(targetMp3Path);
    const mp3Buffer = fs.readFileSync(targetMp3Path);
    const oggBuffer = await convertMp3ToWhatsAppOgg(mp3Buffer);

    return {
      mp3Buffer,
      oggBuffer,
      durationSec,
      filesCount: validPaths.length
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Genera y une varios segmentos de ElevenLabs (misma voz o distintas voces) en un solo MP3 + OGG.
 */
async function mergeElevenLabsSegments(segments, { apiKey, defaultVoiceId, modelId = 'eleven_multilingual_v2', pauseMs = 300 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('Debes enviar al menos 1 segmento de texto para generar el audio.');
  }
  if (segments.length > 10) {
    throw new Error('Máximo 10 segmentos por unión de audio.');
  }

  const mp3Buffers = [];
  let totalChars = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] || {};
    const segText = String(seg.text || '').trim();
    const segVoice = String(seg.voiceId || defaultVoiceId || '').trim();
    if (!segText) {
      throw new Error(`El segmento #${i + 1} está vacío.`);
    }
    if (!segVoice) {
      throw new Error(`Falta Voice ID para el segmento #${i + 1}.`);
    }
    totalChars += segText.length;
    const mp3 = await textToSpeechMp3(segText, { apiKey, voiceId: segVoice, modelId });
    mp3Buffers.push(mp3);
  }

  if (mp3Buffers.length === 1) {
    const mp3Buffer = mp3Buffers[0];
    const oggBuffer = await convertMp3ToWhatsAppOgg(mp3Buffer);
    return {
      mp3Buffer,
      oggBuffer,
      totalChars,
      segmentsCount: 1
    };
  }

  const tmpDir = path.join(os.tmpdir(), `eleven_merge_${crypto.randomBytes(6).toString('hex')}`);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const segPaths = [];
    for (let i = 0; i < mp3Buffers.length; i++) {
      const segPath = path.join(tmpDir, `seg_${i}.mp3`);
      fs.writeFileSync(segPath, mp3Buffers[i]);
      segPaths.push(segPath);
    }

    const mergedMp3Path = path.join(tmpDir, 'merged.mp3');
    await concatenateAudioFilesToMp3(segPaths, mergedMp3Path, pauseMs);
    const mp3Buffer = fs.readFileSync(mergedMp3Path);
    const oggBuffer = await convertMp3ToWhatsAppOgg(mp3Buffer);

    return {
      mp3Buffer,
      oggBuffer,
      totalChars,
      segmentsCount: mp3Buffers.length
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  getAudioDurationSec,
  normalizeUploadedAudioToMp3,
  buildFreshWhatsAppVoiceNoteFromFiles,
  listVoices,
  textToSpeechMp3,
  convertMp3ToWhatsAppOgg,
  mergeElevenLabsSegments
};
