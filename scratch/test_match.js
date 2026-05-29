const { getPlatforms } = require('../salesService');

async function testMatch() {
    const platforms = await getPlatforms();
    console.log("Total platforms loaded:", platforms.length);
    console.log("Platform names:", platforms.map(p => p.name));

    const item = { platform: "HBOMax" };
    let targetPlatform = item.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const PLATFORM_ALIASES = {
      'amazon': 'prime video',
      'prime': 'prime video',
      'hbo': 'max',
      'hbomax': 'max',
      'disney': 'disney+',
      'star': 'disney+',
      'm365': 'microsoft 365',
      'office': 'microsoft 365'
    };

    if (PLATFORM_ALIASES[targetPlatform]) {
      targetPlatform = PLATFORM_ALIASES[targetPlatform].toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    console.log("targetPlatform after alias:", targetPlatform);

    const platform = platforms.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlatform)) ||
      platforms.find(p => targetPlatform.includes(p.name.toLowerCase().replace(/[^a-z0-9]/g, '')));

    console.log("Matched platform:", platform ? platform.name : "null");
}

testMatch();
