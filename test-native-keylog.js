const tls = require('tls');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Test Node.js native keylog functionality
async function testNativeKeylog() {
    console.log('Testing Node.js native TLS keylog functionality...');
    
    const keylogDir = 'C:\\Users\\IQD964\\AppData\\Local\\httptoolkit\\Config\\keylogs';
    const keylogFile = path.join(keylogDir, 'native-test.log');
    
    // Ensure directory exists
    if (!fs.existsSync(keylogDir)) {
        fs.mkdirSync(keylogDir, { recursive: true });
    }
    
    // Clean up existing keylog file
    if (fs.existsSync(keylogFile)) {
        fs.unlinkSync(keylogFile);
    }
    
    console.log('Keylog file will be written to:', keylogFile);
    
    // Create a simple HTTPS server
    const serverOptions = {
        key: fs.readFileSync('node_modules/mockttp/test/fixtures/test-ca.key'),
        cert: fs.readFileSync('node_modules/mockttp/test/fixtures/test-ca.pem')
    };
    
    const server = https.createServer(serverOptions, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from HTTPS server\n');
    });
    
    // Listen for keylog events on the server
    server.on('keylog', (line, tlsSocket) => {
        console.log('Server keylog event received:', line.toString().substring(0, 50) + '...');
        fs.appendFileSync(keylogFile, line);
    });
    
    return new Promise((resolve, reject) => {
        server.listen(0, 'localhost', async () => {
            const port = server.address().port;
            console.log(`HTTPS server listening on port ${port}`);
            
            try {
                // Make an HTTPS request to the server
                const options = {
                    hostname: 'localhost',
                    port: port,
                    path: '/',
                    method: 'GET',
                    rejectUnauthorized: false // Accept self-signed cert
                };
                
                const req = https.request(options, (res) => {
                    console.log('Response status:', res.statusCode);
                    
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('end', () => {
                        console.log('Response body:', data.trim());
                        
                        // Check if keylog file was created
                        setTimeout(() => {
                            if (fs.existsSync(keylogFile)) {
                                const keylogContent = fs.readFileSync(keylogFile, 'utf8');
                                console.log('✓ Keylog file created with', keylogContent.split('\n').length - 1, 'lines');
                                console.log('First few lines:', keylogContent.split('\n').slice(0, 3).join('\n'));
                            } else {
                                console.log('✗ Keylog file was not created');
                            }
                            
                            server.close();
                            resolve();
                        }, 1000);
                    });
                });
                
                req.on('error', (err) => {
                    console.error('Request error:', err.message);
                    server.close();
                    reject(err);
                });
                
                req.end();
                
            } catch (error) {
                console.error('Test error:', error.message);
                server.close();
                reject(error);
            }
        });
        
        server.on('error', (err) => {
            console.error('Server error:', err.message);
            reject(err);
        });
    });
}

if (require.main === module) {
    testNativeKeylog()
        .then(() => {
            console.log('Native keylog test completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Native keylog test failed:', error.message);
            process.exit(1);
        });
}