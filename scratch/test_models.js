const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function listModels() {
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
  
  try {
    const response = await fetch(API_URL);
    const data = await response.json();
    if (response.ok) {
      console.log("--- MODELOS DISPONIBLES ---");
      data.models.forEach(m => console.log(`- ${m.name}`));
    } else {
      console.log(`❌ ERROR: ${response.status} - ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.log(`⚠️ ERROR: ${err.message}`);
  }
}

listModels();
