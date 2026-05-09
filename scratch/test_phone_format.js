function formatWhatsAppNumber(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('57') && digits.length === 12) {
        return `57 ${digits.slice(2, 5)} ${digits.slice(5)}`;
    }
    if (digits.startsWith('57')) {
        return `57 ${digits.slice(2)}`;
    }
    return digits;
}

const testIds = [
    "573183981522@c.us",
    "573183981522:12@c.us",
    "573101234567@c.us",
    "573101234567:5@c.us"
];

testIds.forEach(id => {
    const phone = id.split('@')[0].split(':')[0].replace(/\D/g, '');
    const formatted = formatWhatsAppNumber(phone);
    console.log(`Original: ${id} -> Cleaned: ${phone} -> Formatted: "${formatted}"`);
});
