const fetch = require('node-fetch'); // Assuming node-fetch is available or using built-in fetch if Node 18+

const AZURE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readexcelfunction";
const AZURE_HISTORICO_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readhistoricofunction";
const AZURE_WRITE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/writeexcelfunction";

/**
 * Llama a la API de Azure con lógica de reintentos (Retries).
 * @param {number} retries - Cantidad de intentos antes de fallar.
 * @param {number} delay - Demora en ms entre intentos.
 * @returns {Promise<Array>} - Arreglo con los datos limpios de clientes.
 */
async function fetchCustomersData(retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(AZURE_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP Error! Status: ${response.status}`);
      }
      
      const json = await response.json();
      const clientes = json.data;

      if (!clientes || !Array.isArray(clientes)) {
        throw new Error("Formato de datos no válido desde Azure");
      }

      // Filtrar filas vacías
      const clientesLimpios = clientes.filter(cliente => cliente.Nombre && cliente.Nombre.trim() !== "");
      return clientesLimpios;

    } catch (error) {
      console.error(`[API Service] Error al obtener datos (Intento ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) {
        throw new Error("Fallaron todos los intentos de conexión a la API de Azure.");
      }
      // Esperar antes del siguiente intento
      await new Promise(res => setTimeout(res, delay));
    }
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
    const response = await fetch(AZURE_WRITE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ rowNumber, updates })
    });
    
    if (!response.ok) {
       throw new Error(`HTTP Error al escribir! Status: ${response.status}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error("[API Service] Error al escribir en Excel:", error);
    throw error;
  }
}

module.exports = {
  fetchCustomersData,
  getAccountsByPhone,
  fetchHistoricoData,
  procesarHistoricoArray,
  updateExcelData
};
