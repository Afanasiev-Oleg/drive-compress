// scripts/apps_script_push.js
// Аплоад содержимого каталога appsscript/ в проект Apps Script через сервисный аккаунт

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function main() {
  const ROOT_DIR = process.env.ROOT_DIR || 'appsscript';
  const SCRIPT_ID = process.env.SCRIPT_ID;
  const SA_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!SCRIPT_ID) throw new Error('SCRIPT_ID is not set');
  if (!SA_KEYFILE || !fs.existsSync(SA_KEYFILE)) {
    throw new Error('Service account key file not found (GOOGLE_APPLICATION_CREDENTIALS)');
  }
  if (!fs.existsSync(ROOT_DIR)) throw new Error(`ROOT_DIR not found: ${ROOT_DIR}`);

  // Авторизация по сервисному аккаунту
  const auth = await google.auth.getClient({
    keyFile: SA_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/script.projects'],
  });
  const script = google.script({ version: 'v1', auth });

  // Собираем файлы: .gs -> SERVER_JS, appsscript.json -> JSON (name=appsscript)
  const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name);

  const files = [];
  let haveManifest = false;

  for (const name of entries) {
    const full = path.join(ROOT_DIR, name);
    const ext = path.extname(name).toLowerCase();
    const base = path.basename(name, ext);
    const source = fs.readFileSync(full, 'utf8');

    if (name === 'appsscript.json') {
      files.push({ name: 'appsscript', type: 'JSON', source });
      haveManifest = true;
    } else if (ext === '.gs') {
      files.push({ name: base, type: 'SERVER_JS', source });
    } else {
      console.log(`Skipping non-GAS file: ${name}`);
    }
  }

  if (!haveManifest) {
    throw new Error(`Missing manifest: ${path.join(ROOT_DIR, 'appsscript.json')}`);
  }
  if (files.length === 1) {
    throw new Error('No .gs files found to upload');
  }

  // (Необязательно) стабильная сортировка: сначала манифест, затем .gs по алфавиту
  files.sort((a, b) => {
    if (a.type === 'JSON' && b.type !== 'JSON') return -1;
    if (a.type !== 'JSON' && b.type === 'JSON') return 1;
    return a.name.localeCompare(b.name);
  });

  console.log('Uploading files:\n' + files.map(f => ` - ${f.type}: ${f.name}`).join('\n'));

  // Push: projects.updateContent полностью заменяет содержимое проекта
  await script.projects.updateContent({
    scriptId: SCRIPT_ID,
    requestBody: { files },
  });

  console.log(`✅ Updated Apps Script project: ${SCRIPT_ID}`);
}

main().catch(err => {
  console.error('❌ Apps Script push failed:', err.response?.data || err.message || err);
  process.exit(1);
});
