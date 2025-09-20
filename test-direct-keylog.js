const { getLocal } = require('mockttp');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Direct test of mockttp keylog functionality
async function testDirectKeylog() {
    console.log('Testing direct mockttp keylog functionality...');
    
    const keylogDir = 'C:\\Users\\IQD964\\AppData\\Local\\httptoolkit\\Config\\keylogs';
    const incomingKeylogFile = path.join(keylogDir, 'direct-incoming-tls.log');
    const upstreamKeylogFile = path.join(keylogDir, 'direct-upstream-tls.log');
    
    // Ensure keylog directory exists
    if (!fs.existsSync(keylogDir)) {
        fs.mkdirSync(keylogDir, { recursive: true });
    }
    
    // Clean up any existing test files
    [incomingKeylogFile, upstreamKeylogFile].forEach(file => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            console.log(`Cleaned up existing file: ${file}`);
        }
    });
    
    try {
        // Create mockttp server with keylog configuration
        console.log('Creating mockttp server with keylog configuration...');
        const mockServer = getLocal({
            debug: true,
            https: {
                keyPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.key',
                certPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.pem',
                sslKeylog: {
                    incomingKeylogFile: incomingKeylogFile,
                    upstreamKeylogFile: upstreamKeylogFile
                }
            }
        });
        
        // Set up a simple passthrough rule
        await mockServer.forAnyRequest().thenPassThrough();
        
        // Start the server
        console.log('Starting mockttp server...');
        await mockServer.start();
        const proxyPort = mockServer.port;
        console.log(`Mockttp server started on port ${proxyPort}`);
        
        // Subscribe to keylog events
        let keylogEventCount = 0;
        mockServer.on('tls-keylog', (event) => {
            keylogEventCount++;
            console.log(`TLS Keylog Event #${keylogEventCount}:`);
            console.log(`  Connection Type: ${event.connectionType}`);
            console.log(`  Remote: ${event.remoteAddress}:${event.remotePort}`);
            console.log(`  Local: ${event.localAddress}:${event.localPort}`);
            console.log(`  Keylog Line: ${event.keylogLine.substring(0, 50)}...`);
        });
        
        // Wait a moment for server to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Make HTTPS request through the proxy
        console.log('Making HTTPS request through mockttp proxy...');
        await makeHttpsRequestThroughMockttp(proxyPort);
        
        // Wait for keylog events to be processed
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log(`Total keylog events received: ${keylogEventCount}`);
        
        // Check for keylog files
        checkKeylogFiles([incomingKeylogFile, upstreamKeylogFile]);
        
        // Stop the server
        await mockServer.stop();
        console.log('Mockttp server stopped');
        
    } catch (error) {
        console.error('Test error:', error);
    }
}

async function makeHttpsRequestThroughMockttp(proxyPort) {
    return new Promise((resolve, reject) => {
        // Configure the request to use the mockttp proxy
        const options = {
            hostname: 'httpbin.org',
            port: 443,
            path: '/get',
            method: 'GET',
            headers: {
                'Host': 'httpbin.org',
                'User-Agent': 'MockttpKeylogTest/1.0'
            },
            // Use the proxy
            agent: new https.Agent({
                rejectUnauthorized: false, // Accept self-signed certs
                // Set proxy via environment variable approach
            })
        };
        
        // Set proxy environment variables
        process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
        process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
        
        const req = https.request(options, (res) => {
            console.log(`Response status: ${res.statusCode}`);
            
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log('HTTPS request completed successfully');
                console.log(`Response length: ${data.length} bytes`);
                resolve();
            });
        });
        
        req.on('error', (err) => {
            console.error('HTTPS request error:', err.message);
            resolve(); // Don't reject, continue with test
        });
        
        req.setTimeout(15000, () => {
            console.log('HTTPS request timed out');
            req.destroy();
            resolve();
        });
        
        req.end();
    });
}

function checkKeylogFiles(filePaths) {
    console.log('\n=== Checking keylog files ===');
    
    filePaths.forEach(filePath => {
        const fileName = path.basename(filePath);
        console.log(`\nChecking ${fileName}:`);
        
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            console.log(`  ✓ File exists (${stats.size} bytes)`);
            console.log(`  Modified: ${stats.mtime}`);
            
            if (stats.size > 0) {
                console.log('  ✓ File has content!');
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n').filter(line => line.trim());
                console.log(`  Lines: ${lines.length}`);
                
                // Show first few lines
                lines.slice(0, 3).forEach((line, i) => {
                    console.log(`  ${i + 1}: ${line}`);
                });
                
                if (lines.length > 3) {
                    console.log(`  ... and ${lines.length - 3} more lines`);
                }
            } else {
                console.log('  ✗ File is empty');
            }
        } else {
            console.log('  ✗ File does not exist');
        }
    });
    
    console.log('=== End keylog check ===\n');
}

// Run the test
console.log('Starting direct mockttp keylog test...');
testDirectKeylog().then(() => {
    console.log('Test completed');
}).catch(error => {
    console.error('Test failed:', error);
});