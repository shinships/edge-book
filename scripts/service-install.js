// Install EdgeBook as a Windows Service (auto-start on boot, auto-restart on crash).
//
// MUST be run from an ELEVATED (Administrator) shell — installing a Windows
// service requires admin rights; node-windows/winsw will otherwise fail or
// trigger a UAC prompt.
//
//   1. npm run build          # ensure dist/ is fresh
//   2. (stop any manually-run bot — only ONE instance may poll Telegram)
//   3. npm run service:install
//
const path = require('path');
const { Service } = require('node-windows');

const projectRoot = path.resolve(__dirname, '..');

const svc = new Service({
    name: 'EdgeBookBot',
    description: 'EdgeBook — Telegram trading research bot (grammY). Runs dist/index.js in the background.',
    script: path.join(projectRoot, 'service-entry.js'),
    // cwd for the service process: .env (dotenv) and ./service_account.json resolve from here.
    workingDirectory: projectRoot,
    // Restart policy: wait 2s before a restart, grow the delay 50% each time, cap restarts.
    wait: 2,
    grow: 0.5,
    maxRestarts: 10,
});

svc.on('install', () => {
    console.log('✅ EdgeBookBot service installed. Starting...');
    svc.start();
});
svc.on('alreadyinstalled', () => {
    console.log('ℹ️  EdgeBookBot service is already installed. Run service:uninstall first to reinstall.');
});
svc.on('start', () => {
    console.log('✅ EdgeBookBot service started — now running in the background and on every boot.');
    console.log('   Manage via services.msc, or: sc start EdgeBookBot.exe / sc stop EdgeBookBot.exe');
});
svc.on('error', (err) => {
    console.error('❌ Service error:', err);
});

console.log('Installing EdgeBookBot Windows Service (requires Administrator)...');
svc.install();
