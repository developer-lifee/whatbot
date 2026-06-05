const { getAvailabilityConfig, saveAvailabilityConfig, getPlatformAvailability } = require('../availabilityService');
const { getPlatforms } = require('../salesService');

async function run() {
    console.log("=== Testing Availability Config ===");
    const initialConfig = getAvailabilityConfig();
    console.log("Initial Config:", initialConfig);

    console.log("\n=== Setting manual override for YouTube Premium ===");
    initialConfig["YouTube Premium"] = { immediate: false, reason: "Cuentas cayéndose" };
    saveAvailabilityConfig(initialConfig);

    const updatedConfig = getAvailabilityConfig();
    console.log("Updated Config:", updatedConfig);

    console.log("\n=== Checking getPlatformAvailability for YouTube Premium ===");
    const youtubeAvail = await getPlatformAvailability("YouTube Premium");
    console.log("YouTube Premium Availability:", youtubeAvail);

    console.log("\n=== Checking getPlatformAvailability for Netflix ===");
    const netflixAvail = await getPlatformAvailability("Netflix");
    console.log("Netflix Availability:", netflixAvail);

    console.log("\n=== Restoring config ===");
    delete initialConfig["YouTube Premium"];
    saveAvailabilityConfig(initialConfig);
    console.log("Restored Config:", getAvailabilityConfig());
    
    console.log("\n=== Done! ===");
}

run().catch(console.error);
