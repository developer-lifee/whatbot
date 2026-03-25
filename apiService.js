const fetch = require('node-fetch'); // Assuming node-fetch is available or using built-in fetch if Node 18+

const AZURE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readexcelfunction";

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

module.exports = {
  fetchCustomersData,
  getAccountsByPhone
};
