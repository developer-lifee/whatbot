const fetch = require('node-fetch'); // Assuming node-fetch is available or using built-in fetch if Node 18+
const fs = require('fs');
const path = require('path');

const AZURE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readexcelfunction";
const AZURE_HISTORICO_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readhistoricofunction";
const AZURE_WRITE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/writeexcelfunction";
const SUPPORT_API_URL = "https://sheerit.com.co/api/support.json";

/**
 * Llama a la API de Azure con lógica de reintentos (Retries).
 * @param {number} retries - Cantidad de intentos antes de fallar.
 * @param {number} delay - Demora en ms entre intentos.
 * @returns {Promise<Array>} - Arreglo con los datos limpios de clientes.
 */
/**
 * Retorna la fecha actual normalizada a las 00:00:00 en la zona horaria de Bogotá (UTC-5).
 */
function getTodayInBogota() {
  const dateStr = new Date().toLocaleString("en-US", {timeZone: "America/Bogota"});
  const bogotaDate = new Date(dateStr);
  return new Date(bogotaDate.getFullYear(), bogotaDate.getMonth(), bogotaDate.getDate());
}

/**
 * Convierte un número serial de Excel a un objeto Date de JS normalizado a medianoche local.
 */
function getJsDateFromExcel(excelDate) {
  if (!excelDate || isNaN(parseFloat(excelDate))) return null;
  const jsDate = new Date((parseFloat(excelDate) - 25569) * 86400 * 1000);
  // Usamos componentes UTC para evitar desplazamientos por la zona horaria del servidor
  return new Date(jsDate.getUTCFullYear(), jsDate.getUTCMonth(), jsDate.getUTCDate());
}

/**
 * Obtiene la data cruda completa del Excel (sin filtrar).
 */

async function fetchRawData(retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(AZURE_API_URL);
      if (!response.ok) throw new Error(`HTTP Error! Status: ${response.status}`);
      
      const json = await response.json();
      const data = json.data || [];
      if (data.length > 0) {
          console.log(`[API Service] Columnas detectadas en el Excel:`, Object.keys(data[0]).join(', '));
      }
      return data;
      
    } catch (error) {
      console.error(`[API Service] Error al obtener datos (Intento ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) throw error;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

async function fetchCustomersData(retries = 3, delay = 2000) {
  try {
    const data = await fetchRawData(retries, delay);
    if (!Array.isArray(data)) return [];
    return data.map((cliente, index) => {
        cliente._rowNumber = index + 2;
        return cliente;
    }).filter(cliente => cliente.Nombre && cliente.Nombre.trim() !== "");
  } catch (err) {
    throw err;
  }
}

/**
 * Busca las cuentas asociadas a un número de teléfono específico.
 * @param {string} phoneNumber - El número a buscar (sólo dígitos).
 * @returns {Promise<Array>} - Arreglo de cuentas encontradas.
 */
async function getAccountsByPhone(phoneNumber) {
  try {
    const clientes = await fetchCustomersData();
    const userAccounts = clientes.filter(c => {
      if (!c.numero) return false;
      const normalizedJsonNumber = c.numero.toString().replace(/\D/g, '');
      return normalizedJsonNumber === phoneNumber || (normalizedJsonNumber.length >= 10 && phoneNumber.endsWith(normalizedJsonNumber.slice(-10)));
    });
    return userAccounts;
  } catch (error) {
    console.error("[API Service] Error buscando cuentas por número:", error);
    throw error;
  }
}

/**
 * Llama a la API de Azure para obtener el historial.
 * @param {number} retries - Cantidad de intentos antes de fallar.
 * @param {number} delay - Demora en ms entre intentos.
 * @returns {Promise<Object>} - Objeto JSON con el historial estructurado por número.
 */
async function fetchHistoricoData(retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(AZURE_HISTORICO_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP Error! Status: ${response.status}`);
      }
      
      const json = await response.json();
      const matriz2D = json.data;

      if (!matriz2D || !Array.isArray(matriz2D)) {
        throw new Error("Formato de datos no válido desde Azure Histórico");
      }

      return procesarHistoricoArray(matriz2D);

    } catch (error) {
      console.error(`[API Service] Error al obtener datos históricos (Intento ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) {
        throw new Error("Fallaron todos los intentos de conexión a la API de Azure Histórico.");
      }
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

/**
 * Procesa la matriz 2D del histórico agrupándola por número de WhatsApp.
 * @param {Array<Array>} matriz2D 
 * @returns {Object} JSON estructurado por número
 */
function procesarHistoricoArray(matriz2D) {
    if (!matriz2D || matriz2D.length === 0) return {};

    const filaTitulos = matriz2D[0];
    const bloques = [];
    let startIndex = 0;
    
    // 1. Encontrar dónde empieza y termina cada mes en la Fila 1
    for (let i = 0; i < filaTitulos.length; i++) {
        const valor = filaTitulos[i] ? filaTitulos[i].toString().trim().toLowerCase() : "";
        if (valor === "streaming" && i !== 0) {
            bloques.push({ start: startIndex, end: i - 1 });
            startIndex = i;
        }
    }
    bloques.push({ start: startIndex, end: filaTitulos.length - 1 });
    
    const datosGenerales = {};

    // 2. Iterar por el resto de filas
    for (let rowIndex = 1; rowIndex < matriz2D.length; rowIndex++) {
        const fila = matriz2D[rowIndex];
        if (!fila || fila.length === 0) continue;

        for (const bloque of bloques) {
            let itemStreaming = "";
            let itemNumero = "";
            let itemNombre = "";
            let itemApellido = "";
            let itemFechaCorte = "";
            let itemCorreo = "";
            let itemVencimiento = "";
            let itemMetodoPago = "";
            let itemDeben = "";

            for (let i = bloque.start; i <= bloque.end; i++) {
                let titulo = filaTitulos[i] ? filaTitulos[i].toString().trim().toLowerCase() : "";
                const valor = fila[i] !== undefined && fila[i] !== null ? fila[i] : "";
                
                if (titulo === "streaming") itemStreaming = valor;
                else if (titulo.includes("numero") || titulo.includes("tel") || titulo === "número" || titulo.includes("whatsapp")) itemNumero = valor;
                else if (titulo.includes("nombbre") || titulo === "nombre") itemNombre = valor;
                else if (titulo === "apellido") itemApellido = valor;
                else if (titulo === "fecha" || titulo.includes("corte")) itemFechaCorte = valor;
                else if (titulo.includes("correo")) itemCorreo = valor;
                else if (titulo.includes("vencimiento")) itemVencimiento = valor;
                else if (titulo.includes("metodo") || titulo.includes("medio") || titulo.includes("pago")) itemMetodoPago = valor;
                else if (titulo.includes("deben")) itemDeben = valor;
            }
            
            if (itemNumero && itemStreaming) {
                itemNumero = itemNumero.toString().replace(/\D/g, '');
                if (!itemNumero.startsWith("57") && itemNumero.length === 10) {
                    itemNumero = "57" + itemNumero;
                }

                if (!datosGenerales[itemNumero]) {
                    datosGenerales[itemNumero] = {
                        nombre: itemNombre,
                        apellido: itemApellido,
                        historial: []
                    };
                }

                datosGenerales[itemNumero].historial.push({
                    fecha_corte: itemFechaCorte,
                    streaming: itemStreaming,
                    correo: itemCorreo,
                    vencimiento: itemVencimiento,
                    metodo_pago: itemMetodoPago,
                    deben: itemDeben
                });
            }
        }
    }
    
    return datosGenerales;
}

/**
 * Actualiza los datos de una fila en el Excel a través de la API de Azure.
 * @param {number} rowNumber - El número de fila en Excel (empieza en 1, los datos suelen empezar en 2).
 * @param {Object} updates - Un objeto con las columnas a actualizar { "columna": "nuevo_valor" }.
 * @returns {Promise<Object>} - La respuesta de la API.
 */
async function updateExcelData(rowNumber, updates) {
  try {
    console.log(`[API Service] Intentando escribir en fila ${rowNumber}:`, JSON.stringify(updates));
    const response = await fetch(AZURE_WRITE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ rowNumber, updates })
    });
    
    if (!response.ok) {
       let errorDetails = "";
       try {
           errorDetails = await response.text();
       } catch(e) {}
       console.error(`[API Service] Error HTTP ${response.status}: ${errorDetails}`);
       throw new Error(`HTTP Error al escribir! Status: ${response.status} - ${errorDetails}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error("[API Service] Error crítico al escribir en Excel:", error.message);
    throw error;
  }
}

/**
 * Obtiene la base de conocimiento de soporte en formato JSON.
 * @returns {Promise<Array>} - El array de plataformas y problemas técnicos.
 */
async function getSupportKnowledge() {
  const localPath = path.join(__dirname, 'support.json');
  try {
    const response = await fetch(SUPPORT_API_URL);
    if (!response.ok) throw new Error(`HTTP Error! Status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn("[API Service] No se pudo obtener soporte remoto, intentando local...");
    try {
      if (fs.existsSync(localPath)) {
        const localData = fs.readFileSync(localPath, 'utf8');
        return JSON.parse(localData);
      }
    } catch (localError) {
      console.error("[API Service] Error crítico: No se pudo cargar ni la base remota ni la local.", localError.message);
    }
    return [];
  }
}


module.exports = {
  fetchRawData,
  fetchCustomersData,
  getAccountsByPhone,
  fetchHistoricoData,
  procesarHistoricoArray,
  updateExcelData,
  getSupportKnowledge,
  getTodayInBogota,
  getJsDateFromExcel
};

