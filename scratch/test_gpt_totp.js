const { generateGPTCode, checkAndIncrementUsage, resetAllUsage, saveSecret } = require('../totpService');

// 1. Setup a test secret
const testEmail = "testgpt@sheerit.com";
const testSecret = "JBSWY3DPEHPK3PXP"; // Base32 secret for 'hello world'
saveSecret(testEmail, testSecret);

console.log("--- TEST 1: Code Generation ---");
const code = generateGPTCode(testEmail);
console.log(`Generated code for ${testEmail}: ${code} (Should be 6 digits)`);

console.log("\n--- TEST 2: Usage Limits ---");
const phone = "573110000000";
for (let i = 1; i <= 5; i++) {
    const allowed = checkAndIncrementUsage(phone, testEmail);
    console.log(`Attempt ${i}: ${allowed ? "ALLOWED ✅" : "DENIED ❌"}`);
}

console.log("\n--- TEST 3: Reset Logic ---");
resetAllUsage();
const allowedAfterReset = checkAndIncrementUsage(phone, testEmail);
console.log(`Attempt after reset: ${allowedAfterReset ? "ALLOWED ✅" : "DENIED ❌"}`);
