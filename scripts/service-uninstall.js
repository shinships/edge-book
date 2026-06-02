// Uninstall the EdgeBook Windows Service.
//
// MUST be run from an ELEVATED (Administrator) shell:
//   npm run service:uninstall
//
const path = require('path');
const { Service } = require('node-windows');

const projectRoot = path.resolve(__dirname, '..');

const svc = new Service({
    name: 'EdgeBookBot',
    script: path.join(projectRoot, 'service-entry.js'),
});

svc.on('uninstall', () => {
    console.log('✅ EdgeBookBot service uninstalled.');
});
svc.on('alreadyuninstalled', () => {
    console.log('ℹ️  EdgeBookBot service was not installed.');
});
svc.on('error', (err) => {
    console.error('❌ Service error:', err);
});

console.log('Uninstalling EdgeBookBot Windows Service (requires Administrator)...');
svc.uninstall();
