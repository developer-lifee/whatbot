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
 * Convierte un buffer MP3 a OGG Opus listo para enviarse como nota de voz (PTT) en WhatsApp.
 */
async function convertMp3ToWhatsAppOgg(mp3Buffer) {
  if (!Buffer.isBuffer(mp3Buffer) || mp3Buffer.length === 0) {
    throw new Error('Buffer de audio MP3 inválido para conversión.');
  }

  const id = crypto.randomBytes(6).toString('hex');
  const tmpMp3 = path.join(os.tmpdir(), `eleven_in_${id}.mp3`);
  const tmpOgg = path.join(os.tmpdir(), `eleven_out_${id}.ogg`);
  const ffmpeg = resolveFfmpegPath();

  try {
    fs.writeFileSync(tmpMp3, mp3Buffer);
    await execFileAsync(ffmpeg, [
      '-y',
      '-i', tmpMp3,
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '16000',
      tmpOgg
    ], { timeout: 30000 });
    return fs.readFileSync(tmpOgg);
  } finally {
    try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch {}
    try { if (fs.existsSync(tmpOgg)) fs.unlinkSync(tmpOgg); } catch {}
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
  const ffmpeg = resolveFfmpegPath();
  const safePauseSec = Math.max(0, Math.min(2000, Number(pauseMs) || 0)) / 1000;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const args = ['-y'];
    const filterParts = [];
    const concatLabels = [];

    for (let i = 0; i < mp3Buffers.length; i++) {
      const segPath = path.join(tmpDir, `seg_${i}.mp3`);
      fs.writeFileSync(segPath, mp3Buffers[i]);
      args.push('-i', segPath);

      const needsPad = safePauseSec > 0 && i < mp3Buffers.length - 1;
      const padFilter = needsPad ? `,apad=pad_dur=${safePauseSec}` : '';
      filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono${padFilter}[a${i}]`);
      concatLabels.push(`[a${i}]`);
    }

    const filterComplex = `${filterParts.join(';')};${concatLabels.join('')}concat=n=${mp3Buffers.length}:v=0:a=1[outa]`;
    const mergedMp3Path = path.join(tmpDir, 'merged.mp3');

    args.push(
      '-filter_complex', filterComplex,
      '-map', '[outa]',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '1',
      mergedMp3Path
    );

    await execFileAsync(ffmpeg, args, { timeout: 60000 });
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
  listVoices,
  textToSpeechMp3,
  convertMp3ToWhatsAppOgg,
  mergeElevenLabsSegments
};
