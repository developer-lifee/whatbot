# Guía de Recuperación ante Desastres (Whatbot)

Si pierdes acceso al VPS actual, puedes levantar todo el ecosistema en un servidor nuevo en ~5 minutos usando el último respaldo en **OneDrive** (carpeta `Whatbot_Backups`, o respaldo secundario en Google Drive) y Docker.

## 1. Requisitos en el servidor nuevo
```bash
# Instalar Docker y Docker Compose (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
git clone https://github.com/developer-lifee/whatbot.git
cd whatbot
```

## 2. Descargar y descifrar el último respaldo de Google Drive
Descarga el archivo más reciente `whatbot_backup_YYYY-MM-DD_HH-mm.tar.gz.enc` desde tu carpeta **Whatbot_Backups** en Google Drive al servidor nuevo y descífralo con tu `BACKUP_ENCRYPTION_KEY`:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in whatbot_backup_YYYY-MM-DD_HH-mm.tar.gz.enc \
  -out backup.tar.gz \
  -pass pass:"TU_BACKUP_ENCRYPTION_KEY"

mkdir -p restore_tmp
tar -xzf backup.tar.gz -C restore_tmp
```

## 3. Restaurar configuraciones y secretos
```bash
cp -r restore_tmp/config/. ./
# (Opcional) Restaurar configuraciones de Nginx si usas Nginx en el host:
# sudo cp -r restore_tmp/nginx/sites-available/* /etc/nginx/sites-available/
```

> En `.env`, verifica que `DB_HOST=db` (o la IP/host de tu MariaDB) y que `DB_USER`, `DB_PASSWORD`, `DB_NAME` coincidan con `docker-compose.yml`.

## 4. Levantar con Docker Compose y restaurar MariaDB
```bash
docker compose up -d --build
# Esperar ~10s a que MariaDB esté healthy y restaurar el dump SQL:
docker exec -i whatbot-db mariadb -u root -p"$DB_ROOT_PASSWORD" whatbot < restore_tmp/whatbot_db.sql
docker compose restart whatbot
```

## 5. Reconectar WhatsApp y verificar
```bash
docker compose logs -f whatbot
```
Escanea el código QR (o usa el código de emparejamiento desde el panel web) y el bot quedará operando con toda tu base de datos, contabilidad, tokens y configuraciones intactas.

## Respaldo manual en el VPS actual
```bash
cd /root/whatbot && node backupService.js
```
