const body = `@bot envia un mensaje a estos destinatarios diciendo “si recibiste este mensaje es porque las cuentas de spotify quedaron pendientes contigo y te debemos una garantia en caso de no ser asi ignorar el mensaje, las opciones que tenemos son 

1.usar otro correo para spotify
2.tener el saldo restante para compra de cuentas 

Wilson Garcia      57 313 3495828
Manuel Del Rio     57 301 5468517
Alejandra Olaya    57 320 2794469
Cristian Castillo  57 323 6128398
Juan Orjuela       17865389888    
Anderson bastilla  57 302 4427261
Jeimmy Mora        57 320 2794469
Danna Ruiz 57 311 4478813
Frankyerson Florez 57 314 6006168
Camilo Cárdenas    57 314 3852734
David Moreno       57 320 4331498
Laura      57 313 2510957
Valeria González   57 316 6122949
Harrison Martinez  57 311 7669691
samuel castro      573209692129    
Jordan Sanchez     57 302 7883197`;

const lines = body.split('\n');
const parsedRecipients = [];
const otherLines = [];

for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+)\s+([\d\s+-]{10,20})$/);
    if (match) {
        const name = match[1].trim();
        const phone = match[2].replace(/\D/g, '');
        if (phone.length >= 10 && phone.length <= 15) {
            parsedRecipients.push({ name, phone });
            continue;
        }
    }
    otherLines.push(line);
}

console.log("Parsed Recipients count:", parsedRecipients.length);
console.log("Parsed Recipients:", parsedRecipients);
console.log("Other lines:\n", otherLines.join('\n'));
