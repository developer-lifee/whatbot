const { normalizeStreamingName } = require('../availabilityService');

const testCases = [
    { input: "HBO", expected: "hbo" },
    { input: "HBOMax", expected: "hbo" },
    { input: "HBO PLATINO", expected: "hbo_platino" },
    { input: "HBOMax Platino", expected: "hbo_platino" },
    { input: "hbo max platinum", expected: "hbo_platino" },
    { input: "Netflix", expected: "netflix" }
];

let failed = false;
console.log("Testing normalizeStreamingName...");
for (const tc of testCases) {
    const result = normalizeStreamingName(tc.input);
    const pass = result === tc.expected;
    console.log(`Input: "${tc.input}" -> Got: "${result}" (Expected: "${tc.expected}") -> ${pass ? "PASS" : "FAIL"}`);
    if (!pass) failed = true;
}

if (failed) {
    console.error("Test suite FAILED!");
    process.exit(1);
} else {
    console.log("Test suite PASSED!");
}
