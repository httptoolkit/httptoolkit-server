/* Compatibility entry point. The runtime is compiled from TypeScript by npm run build. */
let runtime;
try {
    runtime = require('./dist/server.js');
} catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && error.message.includes("'./dist/server.js'")) {
        console.error('Build the proxy first: npm run build');
        process.exit(1);
    }
    throw error;
}
module.exports = runtime;
if (require.main === module) {
    runtime.main().catch(error => { console.error(error); process.exit(1); });
}
