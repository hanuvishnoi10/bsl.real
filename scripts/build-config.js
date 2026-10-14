const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.js');
const backendUrl = (process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').trim();

if (backendUrl && fs.existsSync(configPath)) {
    console.log(`[Build Config]: Detected BACKEND_URL="${backendUrl}". Injecting into config.js...`);
    let content = fs.readFileSync(configPath, 'utf-8');
    content = content.replace(
        /const INJECTED_BACKEND_URL = '.*?';/,
        `const INJECTED_BACKEND_URL = '${backendUrl}';`
    );
    fs.writeFileSync(configPath, content, 'utf-8');
    console.log('[Build Config]: Successfully updated config.js for Render deployment.');
} else {
    console.log('[Build Config]: No BACKEND_URL provided or config.js not found. Keeping default configuration.');
}
