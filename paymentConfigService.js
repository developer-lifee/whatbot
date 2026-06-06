const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'payment_config.json');

const DEFAULT_CONFIG = {
  "qr_negocios": {
    "enabled": false,
    "automatic": true,
    "label": "QR Negocios",
    "description": "🤖 *QR Negocios (RECOMENDADO - ENTREGA INMEDIATA ⚡)*\n\nPor favor, escanea el código que te envío a continuación para la **activación automática** inmediata. ⚡"
  },
  "llave": {
    "enabled": true,
    "automatic": true,
    "label": "Llave Bre-V",
    "description": "🤖 *LLAVE Bre-V (ENTREGA INMEDIATA ⚡)*",
    "sub_methods": [
      {
        "id": "llave_bot",
        "label": "Llave Principal",
        "value": "0087387259",
        "enabled": true,
        "automatic": true
      },
      {
        "id": "llave_esteban",
        "label": "Llave Esteban",
        "value": "1032936324",
        "enabled": true,
        "automatic": false
      }
    ]
  },
  "nequi": {
    "enabled": false,
    "automatic": false,
    "label": "Nequi",
    "description": "🤖 *Nequi*\n\nPor favor realiza tu transferencia usando nuestra *Llave Bre-V* para recibir entrega inmediata. ⚡"
  },
  "daviplata": {
    "enabled": true,
    "automatic": false,
    "label": "Daviplata",
    "description": "🤖 *Daviplata*\n\nNúmero de celular: `3107946794`\nCC: 1032936324\n\n💡 *Nota:* Ten en cuenta que el registro de este pago será **manual** y un asesor tendrá que verificar tu comprobante cuando esté disponible. 😊"
  },
  "bancolombia": {
    "enabled": true,
    "automatic": true,
    "label": "Bancolombia",
    "description": "🤖 *Bancolombia (Abono Directo - VALIDACIÓN AUTOMÁTICA ⚡)*\n\nNúmero de cuenta: 46772753713\nTipo: Ahorros\nCC: 1032936324\n\n💡 *Tip:* Si pagas a esta cuenta, el bot valida tu transferencia automáticamente en segundos. ⚡"
  }
};

function getPaymentConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    savePaymentConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error("[Payment Config Service] Error reading payment_config.json:", e.message);
    return DEFAULT_CONFIG;
  }
}

function savePaymentConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error("[Payment Config Service] Error writing payment_config.json:", e.message);
  }
}

module.exports = {
  getPaymentConfig,
  savePaymentConfig
};
