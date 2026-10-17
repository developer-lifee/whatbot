const fs = require('fs');
const path = require('path');
const { seedPlatformsToDb } = require('../platformsDbService');

async function main() {
    const jsonPath = path.join(__dirname, '../platforms.json');
    if (!fs.existsSync(jsonPath)) {
        console.error('platforms.json not found');
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log(`Seeding ${data.length} platforms into DB...`);
    await seedPlatformsToDb(data);
    console.log('✅ Platforms DB synchronized successfully!');
    process.exit(0);
}

main().catch(err => {
    console.error('Error syncing DB:', err);
    process.exit(1);
});
