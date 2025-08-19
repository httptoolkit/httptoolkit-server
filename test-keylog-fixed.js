const { getLocal } = require('mockttp');
const tls = require('tls');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Fixed test based on official mockttp keylog test patterns
async function testKeylogFixed() {
    console.log('Testing keylog functionality with proper TLS connections...');
    
    const keylogDir = 'C:\\Users\\IQD964\\AppData\\Local\\httptoolkit\\Config\\keylogs';
    const incomingKeylogFile = path.join(keylogDir, 'test-incoming-tls.log');
    const upstreamKeylogFile = path.join(keylogDir, 'test-upstream-tls.log');
    
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
        // Test 1: Incoming keylog events
        console.log('\n=== Testing Incoming Keylog Events ===');
        await testIncomingKeylog(incomingKeylogFile);
        
        // Test 2: Upstream keylog events
        console.log('\n=== Testing Upstream Keylog Events ===');
        await testUpstreamKeylog(upstreamKeylogFile);
        
        // Final check
        console.log('\n=== Final Keylog File Check ===');
        checkKeylogFiles([incomingKeylogFile, upstreamKeylogFile]);
        
    } catch (error) {
        console.error('Test error:', error);
    }
}

async function testIncomingKeylog(incomingKeylogFile) {
    // Create server with incoming keylog configuration
    const server = getLocal({
        debug: true,
        https: {
            keyPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.key',
            certPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.pem',
            sslKeylog: {
                incomingKeylogFile: incomingKeylogFile
            }
        }
    });
    
    let keylogEventCount = 0;
    server.on('tls-keylog', (event) => {
        if (event.connectionType === 'incoming') {
            keylogEventCount++;
            console.log(`Incoming TLS Keylog Event #${keylogEventCount}:`);
            console.log(`  Connection Type: ${event.connectionType}`);
            console.log(`  Remote: ${event.remoteAddress}:${event.remotePort}`);
            console.log(`  Local: ${event.localAddress}:${event.localPort}`);
            console.log(`  Keylog Line: ${event.keylogLine.substring(0, 50)}...`);
        }
    });
    
    try {
        // Set up a simple response
        await server.forGet('/').thenReply(200, 'Test response');
        
        // Start the server
        await server.start();
        console.log(`Server started on port ${server.port}`);
        
        // Make direct TLS connection (this should trigger incoming keylog)
        console.log('Making direct TLS connection...');
        const tlsSocket = await openRawTlsSocket(server, {
            rejectUnauthorized: false
        });
        
        // Send HTTP request over TLS
        tlsSocket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        
        // Wait for response
        await new Promise((resolve) => {
            tlsSocket.on('data', (data) => {
                console.log('Received TLS response:', data.toString().substring(0, 100) + '...');
                resolve();
            });
            tlsSocket.on('end', resolve);
            setTimeout(resolve, 5000); // Timeout after 5 seconds
        });
        
        tlsSocket.end();
        
        // Wait for keylog events to be processed
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Total incoming keylog events: ${keylogEventCount}`);
        
    } finally {
        await server.stop();
    }
}

async function testUpstreamKeylog(upstreamKeylogFile) {
    // Create target server
    const targetServer = getLocal({
        https: {
            keyPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.key',
            certPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.pem'
        }
    });
    
    // Create proxy server with upstream keylog configuration
    const proxyServer = getLocal({
        debug: true,
        https: {
            keyPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.key',
            certPath: 'D:\\httptoolkit\\httptoolkit-server\\node_modules\\mockttp\\test\\fixtures\\test-ca.pem',
            sslKeylog: {
                upstreamKeylogFile: upstreamKeylogFile
            }
        }
    });
    
    let keylogEventCount = 0;
    proxyServer.on('tls-keylog', (event) => {
        if (event.connectionType === 'upstream') {
            keylogEventCount++;
            console.log(`Upstream TLS Keylog Event #${keylogEventCount}:`);
            console.log(`  Connection Type: ${event.connectionType}`);
            console.log(`  Remote: ${event.remoteAddress}:${event.remotePort}`);
            console.log(`  Local: ${event.localAddress}:${event.localPort}`);
            console.log(`  Keylog Line: ${event.keylogLine.substring(0, 50)}...`);
        }
    });
    
    try {
        // Start both servers
        await targetServer.start();
        await proxyServer.start();
        console.log(`Target server started on port ${targetServer.port}`);
        console.log(`Proxy server started on port ${proxyServer.port}`);
        
        // Set up target response
        await targetServer.forGet('/target').thenReply(200, 'Target response');
        
        // Set up proxy to forward to target
        await proxyServer.forGet('/target').thenPassThrough({
            forwarding: { targetHost: 'localhost', targetPort: targetServer.port }
        });
        
        // Make HTTPS request through proxy (this should trigger upstream keylog)
        console.log('Making HTTPS request through proxy...');
        const response = await makeHttpsRequest({
            hostname: 'localhost',
            port: proxyServer.port,
            path: '/target',
            rejectUnauthorized: false
        });
        
        console.log(`Response status: ${response.statusCode}`);
        
        // Wait for keylog events to be processed
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Total upstream keylog events: ${keylogEventCount}`);
        
    } finally {
        await proxyServer.stop();
        await targetServer.stop();
    }
}

// Helper function to create raw TLS socket (similar to mockttp test utils)
function openRawTlsSocket(server, options = {}) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host: 'localhost',
            port: server.port,
            ...options
        });
        socket.once('secureConnect', () => resolve(socket));
        socket.once('error', reject);
    });
}

// Helper function to make HTTPS requests
function makeHttpsRequest(options) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, data });
            });
        });
        
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
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
console.log('Starting fixed keylog test...');
testKeylogFixed().then(() => {
    console.log('Test completed');
}).catch(error => {
    console.error('Test failed:', error);
});