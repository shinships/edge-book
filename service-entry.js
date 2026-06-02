// Stable entry point for the Windows Service wrapper (node-windows).
//
// We point the service at THIS launcher rather than directly at dist/index.js so
// node-windows writes its generated `daemon/` folder (winsw exe + config + logs)
// here at the project root — NOT inside the rebuildable dist/ directory, which
// `npm run build` / a manual clean could wipe out from under a running service.
require('./dist/index.js');
