// Simple mock of getDurationMonths
function getDurationMonths(detection, inputToUse) {
    let durationMonths = 1;
    if (detection && detection.metadata) {
        if (detection.metadata.duration_months) {
            durationMonths = parseInt(detection.metadata.duration_months) || 1;
        } else if (detection.metadata.duration) {
            const match = String(detection.metadata.duration).match(/\d+/);
            if (match) durationMonths = parseInt(match[0]) || 1;
        }
    }
    const lowerInput = (inputToUse || "").toLowerCase();
    const monthsMatch = lowerInput.match(/(\d+)\s*(mes|month)/i);
    if (monthsMatch && durationMonths === 1) {
        durationMonths = parseInt(monthsMatch[1]) || 1;
    }
    // Robust fallbacks for annual / years
    if (durationMonths === 1) {
        if (lowerInput.includes("anual") || lowerInput.includes("anualidad") || lowerInput.includes("año") || lowerInput.includes("year")) {
            durationMonths = 12;
        } else if (lowerInput.includes("semestral") || lowerInput.includes("semestre") || lowerInput.includes("6 meses")) {
            durationMonths = 6;
        } else if (lowerInput.includes("trimestral") || lowerInput.includes("trimestre") || lowerInput.includes("3 meses")) {
            durationMonths = 3;
        }
    }
    return durationMonths;
}

const inputs = [
    { detection: { metadata: null }, text: "Disculpa en este mes se me vence la cuenta de YouTube (creo), para renovarte la anualidad otra vez. Cuanto seria??" },
    { detection: { metadata: { duration_months: 6 } }, text: "cuanto es?" },
    { detection: { metadata: null }, text: "renovar el año completo" },
    { detection: { metadata: null }, text: "precio por 3 meses" }
];

inputs.forEach(ip => {
    console.log(`Text: "${ip.text}" -> Calculated Duration: ${getDurationMonths(ip.detection, ip.text)} months`);
});
