const fs = require('fs');
const path = require('path');

// Load .env from project root so FMS_* values are set in one place
const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const env = {};
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) env[m[1].trim()] = m[2].replace(/^["']|["']$/g, '').trim();
    });
}

// Target directory and file for the build-time config
const configDir = path.join(__dirname, '../src-tauri/resources');
const configPath = path.join(configDir, 'config.json');

console.log('Generating build-time configuration from .env...');

// Build config: use .env values so FMS_EMAIL/FMS_PASSWORD etc. are set in one place
const buildConfig = {
    FMS_EMAIL: env.FMS_EMAIL || "admin@eglobalsphere.com",
    FMS_PASSWORD: env.FMS_PASSWORD || "changeme",
    FMS_LICENSE_KEY: env.FMS_LICENSE_KEY || "FMS-8A2B-4C9D-1E7F-3B6A",
    FMS_MAIN_BACKEND_URL: env.FMS_MAIN_BACKEND_URL || "",
    FMS_LICENSE_PUBLIC_KEY_PEM: env.FMS_LICENSE_PUBLIC_KEY_PEM || "",
    FMS_LICENSE_ISSUER: env.FMS_LICENSE_ISSUER || "fms-main-backend",
    FMS_COMPANY_NAME: env.FMS_COMPANY_NAME || "EglobalSphere",
    FMS_COMPANY_IMAGE: env.FMS_COMPANY_IMAGE || "",
    FMS_SUPER_ADMIN_NAME: env.FMS_SUPER_ADMIN_NAME || "Super Admin",
    FMS_ENV: env.FMS_ENV || "development",
    FMS_ALLOW_DEV_LICENSE_FALLBACK: env.FMS_ALLOW_DEV_LICENSE_FALLBACK || "false",
    FMS_LICENSE_KEY_VERIFICATION_ENABLED: env.FMS_LICENSE_KEY_VERIFICATION_ENABLED || "true",
    BUILD_TIMESTAMP: new Date().toISOString()
};

// Ensure the resources directory exists
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}

// Write the config to a JSON file that will be bundled as a resource
fs.writeFileSync(configPath, JSON.stringify(buildConfig, null, 2));

console.log(`Hard-coded build configuration saved to ${configPath}`);
console.log(`Injected Email: ${buildConfig.FMS_EMAIL}`);
console.log(`Injected Main Backend URL: ${buildConfig.FMS_MAIN_BACKEND_URL || "(not set)"}`);
