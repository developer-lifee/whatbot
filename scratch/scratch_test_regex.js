const body = `
Tu código de acceso único para Disney+
Tu código de acceso es: 
893456
Si no solicitaste este código, puedes ignorar este mensaje.
<a href="https://www.disneyplus.com/es-419/account/update">Botón de actualizar</a>
`;

const cleanBody = body.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');

let code = null;

// Buscamos algo parecido a "código" seguido de cosas no numéricas y luego números
const specificCodeMatch = cleanBody.match(/(?:c[oó]digo|pin|code)[^\d]{0,40}?\b([0-9]{4,8})\b/i);
if (specificCodeMatch) {
    code = specificCodeMatch[1];
} else {
    // Si no, buscamos un código alfanumérico que parezca un código de streaming común (6 o 8 caracteres mayúsculas y números)
    const alphaNumMatch = cleanBody.match(/\b([A-Z0-9]{6,8})\b/);
    if (alphaNumMatch && /[A-Z]/.test(alphaNumMatch[1]) && /[0-9]/.test(alphaNumMatch[1])) {
        code = alphaNumMatch[1];
    } else {
        const fallbackMatch = cleanBody.match(/\b\d{4,8}\b/);
        code = fallbackMatch ? fallbackMatch[0] : null;
    }
}

console.log("Code:", code);
