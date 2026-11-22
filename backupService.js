#!/usr/bin/env node

/**
 * Servicio de Backup Automático de Recuperación ante Desastres (Whatbot)
 *
 * Respalda diariamente:
 * 1. Base de datos MariaDB completa (mysqldump --single-transaction --routines --triggers)
 * 2. Secretos, tokens OAuth y configuraciones ignoradas por Git (.env, credentials*.json, token*.json, tokens/, etc.)
 * 3. Configuraciones de Nginx (/etc/nginx/sites-available/*)
 *
 * Empaqueta en .tar.gz, cifra con AES-256-CBC (PBKDF2) si BACKUP_ENCRYPTION_KEY está definida,
 * conserva los últimos 7 respaldos locales en /backups y sube el archivo a Google Drive
 * (carpeta "Whatbot_Backups", conservando los últimos 14 respaldos en Drive).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { google } = require('googleapis');
const { getOAuth2Client } = require('./googleAuthService');
const { pool } = require('./database');

const ROOT_DIR = __dirname;
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const DRIVE_FOLDER_NAME = 'Whatbot_Backups';
const MAX_LOCAL_BACKUPS = 7;
const MAX_DRIVE_BACKUPS = 14;

const CRITICAL_FILES = [
    '.env',
    'credentials.json',
    'credentials_pagos.json',
    'credentials_drive.json',
    'token.json',
    'token_drive.json',
    'token_contacts.json',
    'token_gmail.json',
    'ms_graph_token.json',
    'payment_config.json',
    'support_schedule.json',
    'platform_availability.json',
    'pending_charges.json',
    'short_urls.json',
    'user_states.json',
    'platforms.json',
    'managed_emails.json',
    'admin_knowledge.json',
    'knowledge_base.json',
    'policies.json',
    'support.json',
    'audit_logs.json',
    'recommended_combo.json'
];

const CRITICAL_DIRS = [
    'tokens'
];

function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function copyRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) return;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        ensureDir(dest);
        for (const entry of fs.readdirSync(src)) {
            copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
        }
    } else if (stat.isFile()) {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
    }
}

function dumpDatabase(outputSqlPath) {
    const dbHost = process.env.DB_HOST || '127.0.0.1';
    const dbUser = process.env.DB_USER || 'root';
    const dbPass = process.env.DB_PASSWORD || '';
    const dbName = process.env.DB_NAME || 'whatbot';

    const args = [
        '--single-transaction',
        '--routines',
        '--triggers',
        '--quick',
        '--hex-blob',
        `-h${dbHost}`,
        `-u${dbUser}`,
        dbName
    ];

    const env = { ...process.env };
    if (dbPass) env.MYSQL_PWD = dbPass;

    try {
        const dumpOut = execFileSync('mysqldump', args, {
            env,
            maxBuffer: 256 * 1024 * 1024
        });
        fs.writeFileSync(outputSqlPath, dumpOut);
        return true;
    } catch (err) {
        // Fallback: socket local como root (en VPS Debian/Ubuntu con unix_socket auth)
        console.warn(`[Backup] mysqldump con credenciales .env falló (${err.message.split('\n')[0]}). Probando socket local root...`);
        const fallbackArgs = [
            '--single-transaction',
            '--routines',
            '--triggers',
            '--quick',
            '--hex-blob',
            '-u', 'root',
            dbName
        ];
        const dumpOut = execFileSync('mysqldump', fallbackArgs, {
            maxBuffer: 256 * 1024 * 1024
        });
        fs.writeFileSync(outputSqlPath, dumpOut);
        return true;
    }
}

async function getOrCreateDriveFolder(drive) {
    const listRes = await drive.files.list({
        q: `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive'
    });
    if (listRes.data.files && listRes.data.files.length > 0) {
        return listRes.data.files[0].id;
    }
    const createRes = await drive.files.create({
        requestBody: {
            name: DRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder'
        },
        fields: 'id'
    });
    return createRes.data.id;
}

async function uploadToGoogleDrive(filePath, fileName) {
    const auth = await getOAuth2Client('drive');
    if (!auth) {
        console.warn('[Backup] ⚠️ Cliente de Google Drive no disponible (revisa credentials_drive.json / token_drive.json).');
        return null;
    }

    const drive = google.drive({ version: 'v3', auth });
    const folderId = await getOrCreateDriveFolder(drive);
    const mimeType = fileName.endsWith('.enc') ? 'application/octet-stream' : 'application/gzip';

    const res = await drive.files.create({
        requestBody: {
            name: fileName,
            parents: [folderId]
        },
        media: {
            mimeType,
            body: fs.createReadStream(filePath)
        },
        fields: 'id, name, webViewLink, size'
    });

    // Purgar backups antiguos en Google Drive (conservar últimos MAX_DRIVE_BACKUPS)
    try {
        const existing = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            orderBy: 'createdTime desc',
            fields: 'files(id, name, createdTime)',
            pageSize: 50
        });
        const files = existing.data.files || [];
        if (files.length > MAX_DRIVE_BACKUPS) {
            const toDelete = files.slice(MAX_DRIVE_BACKUPS);
            for (const oldFile of toDelete) {
                await drive.files.delete({ fileId: oldFile.id }).catch(() => {});
                console.log(`[Backup] 🧹 Eliminado respaldo antiguo en Drive: ${oldFile.name}`);
            }
        }
    } catch (pruneErr) {
        console.warn('[Backup] Advertencia limpiando backups antiguos en Drive:', pruneErr.message);
    }

    return {
        id: res.data.id,
        url: res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`,
        size: Number(res.data.size || fs.statSync(filePath).size)
    };
}

function pruneLocalBackups() {
    if (!fs.existsSync(BACKUPS_DIR)) return;
    const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.startsWith('whatbot_backup_'))
        .map(f => ({
            name: f,
            fullPath: path.join(BACKUPS_DIR, f),
            mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);

    if (files.length > MAX_LOCAL_BACKUPS) {
        for (const old of files.slice(MAX_LOCAL_BACKUPS)) {
            try {
                fs.unlinkSync(old.fullPath);
                console.log(`[Backup] 🧹 Eliminado respaldo local antiguo: ${old.name}`);
            } catch (_) {}
        }
    }
}

async function runBackup() {
    const startTs = Date.now();
    const stamp = formatTimestamp();
    const tmpStage = fs.mkdtempSync(path.join(os.tmpdir(), 'whatbot-backup-'));

    console.log(`[Backup] 🚀 Iniciando respaldo de recuperación (${stamp})...`);
    ensureDir(BACKUPS_DIR);

    try {
        // 1. Dump MariaDB
        const sqlPath = path.join(tmpStage, 'whatbot_db.sql');
        dumpDatabase(sqlPath);
        const sqlMb = (fs.statSync(sqlPath).size / (1024 * 1024)).toFixed(2);
        console.log(`[Backup] ✅ Base de datos exportada (${sqlMb} MB).`);

        // 2. Copiar secretos y configuraciones críticas
        const cfgDir = path.join(tmpStage, 'config');
        ensureDir(cfgDir);
        let copiedFiles = 0;
        for (const rel of CRITICAL_FILES) {
            const full = path.join(ROOT_DIR, rel);
            if (fs.existsSync(full)) {
                copyRecursiveSync(full, path.join(cfgDir, rel));
                copiedFiles++;
            }
        }
        // Incluir cualquier token_*.json adicional que no esté en la lista fija
        for (const entry of fs.readdirSync(ROOT_DIR)) {
            if (/^(token_.*\.json|credentials_.*\.json)$/.test(entry) && !CRITICAL_FILES.includes(entry)) {
                copyRecursiveSync(path.join(ROOT_DIR, entry), path.join(cfgDir, entry));
                copiedFiles++;
            }
        }
        for (const dirName of CRITICAL_DIRS) {
            const fullDir = path.join(ROOT_DIR, dirName);
            if (fs.existsSync(fullDir)) {
                copyRecursiveSync(fullDir, path.join(cfgDir, dirName));
            }
        }
        console.log(`[Backup] ✅ ${copiedFiles} archivos de configuración/secretos + carpeta tokens/ copiados.`);

        // 3. Copiar configuraciones de Nginx si existen en el servidor
        const nginxSrc = '/etc/nginx/sites-available';
        if (fs.existsSync(nginxSrc)) {
            try {
                copyRecursiveSync(nginxSrc, path.join(tmpStage, 'nginx', 'sites-available'));
                console.log('[Backup] ✅ Configuraciones de Nginx respaldadas.');
            } catch (ngErr) {
                console.warn('[Backup] ⚠️ No se pudieron copiar configs de Nginx:', ngErr.message);
            }
        }

        // 4. Empaquetar en .tar.gz
        const tarName = `whatbot_backup_${stamp}.tar.gz`;
        const tarPath = path.join(BACKUPS_DIR, tarName);
        execFileSync('tar', ['-czf', tarPath, '-C', tmpStage, '.']);

        let finalPath = tarPath;
        let finalName = tarName;

        // 5. Cifrar con AES-256-CBC si BACKUP_ENCRYPTION_KEY está configurada
        const encKey = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
        if (encKey) {
            const encName = `${tarName}.enc`;
            const encPath = path.join(BACKUPS_DIR, encName);
            execFileSync('openssl', [
                'enc', '-aes-256-cbc', '-pbkdf2', '-salt',
                '-in', tarPath,
                '-out', encPath,
                '-pass', `env:BACKUP_ENCRYPTION_KEY`
            ], {
                env: { ...process.env, BACKUP_ENCRYPTION_KEY: encKey }
            });
            fs.unlinkSync(tarPath);
            finalPath = encPath;
            finalName = encName;
            console.log(`[Backup] 🔐 Respaldo cifrado con AES-256-CBC: ${finalName}`);
        } else {
            console.warn('[Backup] ⚠️ BACKUP_ENCRYPTION_KEY no configurada en .env; respaldo guardado sin cifrado.');
        }

        const finalSizeBytes = fs.statSync(finalPath).size;
        const finalSizeMb = (finalSizeBytes / (1024 * 1024)).toFixed(2);
        console.log(`[Backup] 📦 Archivo final listo: ${finalPath} (${finalSizeMb} MB).`);

        // 6. Subir a Google Drive y registrar en drive_backups
        let driveInfo = null;
        try {
            driveInfo = await uploadToGoogleDrive(finalPath, finalName);
            if (driveInfo) {
                console.log(`[Backup] ☁️ Subido a Google Drive (${DRIVE_FOLDER_NAME}): ${driveInfo.url}`);
                try {
                    await pool.query(
                        `INSERT INTO drive_backups (file_name, original_path, drive_file_id, drive_url, file_size)
                         VALUES (?, ?, ?, ?, ?)`,
                        [finalName, finalPath, driveInfo.id, driveInfo.url, finalSizeBytes]
                    );
                } catch (dbLogErr) {
                    console.warn('[Backup] ⚠️ No se pudo registrar en tabla drive_backups:', dbLogErr.message);
                }
            }
        } catch (driveErr) {
            console.error('[Backup] ❌ Error subiendo a Google Drive:', driveErr.message);
        }

        // 7. Limpiar respaldos locales antiguos
        pruneLocalBackups();

        const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
        console.log(`[Backup] 🎉 Respaldo completado en ${elapsedSec}s.`);

        return {
            success: true,
            fileName: finalName,
            filePath: finalPath,
            sizeBytes: finalSizeBytes,
            encrypted: Boolean(encKey),
            drive: driveInfo
        };
    } finally {
        try {
            fs.rmSync(tmpStage, { recursive: true, force: true });
        } catch (_) {}
    }
}

if (require.main === module) {
    runBackup()
        .then(async (res) => {
            try { await pool.end(); } catch (_) {}
            process.exit(res && res.success ? 0 : 1);
        })
        .catch(async (err) => {
            console.error('[Backup] ❌ Fallo crítico en respaldo:', err);
            try { await pool.end(); } catch (_) {}
            process.exit(1);
        });
}

module.exports = { runBackup };
