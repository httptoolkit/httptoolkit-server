const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Test script to verify SSL keylog functionality
async function testKeylogGeneration() {
    console.log('Testing SSL keylog generation...');
    
    try {
        // First, create a mock session via the admin API
        console.log('Creating mock session...');
        const createSessionResponse = await makeRequest({
            hostname: '127.0.0.1',
            port: 45456,
            path: '/start',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://app.httptoolkit.tech' // Add proper CORS origin
            }
        }, JSON.stringify({
            options: {
                cors: false,
                recordTraffic: false
            }
        }));
        
        console.log('Mock session response:', createSessionResponse.statusCode);
        console.log('Response data:', createSessionResponse.data);
        
        if (createSessionResponse.statusCode === 200) {
            const sessionData = JSON.parse(createSessionResponse.data);
            const proxyPort = sessionData.port || 8000; // Get the actual proxy port
            
            console.log(`Mock session created successfully on port ${proxyPort}`);
            
            // Wait a moment for the session to be ready
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Now make HTTPS requests through the proxy
            await makeHttpsRequestThroughProxy(proxyPort);
        } else {
            console.log('Failed to create mock session, trying direct proxy test...');
            // Try with default port 8000
            await makeHttpsRequestThroughProxy(8000);
        }
        
    } catch (error) {
        console.error('Test error:', error.message);
        console.log('Trying direct proxy test with default port...');
        await makeHttpsRequestThroughProxy(8000);
    }
}

async function makeHttpsRequestThroughProxy(proxyPort) {
    console.log(`Making HTTPS request through proxy on port ${proxyPort}...`);
    
    return new Promise((resolve) => {
        // Create a simple HTTPS request through the proxy
        const options = {
            hostname: 'httpbin.org',
            port: 443,
            path: '/get',
            method: 'GET',
            headers: {
                'Host': 'httpbin.org',
                'User-Agent': 'HTTPToolkit-Test/1.0'
            },
            // Configure proxy
            agent: new https.Agent({
                rejectUnauthorized: false,
                // Use HTTP CONNECT method through proxy
                proxy: `http://127.0.0.1:${proxyPort}`
            })
        };
        
        const req = https.request(options, (res) => {
            console.log(`Response status: ${res.statusCode}`);
            console.log('Response headers:', res.headers);
            
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log('Request completed successfully');
                console.log('Response length:', data.length);
                setTimeout(() => {
                    checkKeylogFiles();
                    resolve();
                }, 3000); // Wait longer for keylog writes
            });
        });
        
        req.on('error', (err) => {
            console.error('Request error:', err.message);
            setTimeout(() => {
                checkKeylogFiles();
                resolve();
            }, 3000);
        });
        
        req.setTimeout(10000, () => {
            console.log('Request timed out');
            req.destroy();
            setTimeout(() => {
                checkKeylogFiles();
                resolve();
            }, 1000);
        });
        
        req.end();
    });
}

function makeRequest(options, data = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, data: responseData });
            });
        });
        
        req.on('error', reject);
        
        if (data) {
            req.write(data);
        }
        req.end();
    });
}

function checkKeylogFiles() {
    console.log('\n=== Checking for keylog files ===');
    
    // Check the actual config path from the debug output
    const configPath = 'C:\\Users\\IQD964\\AppData\\Local\\httptoolkit\\Config';
    const keylogDir = path.join(configPath, 'keylogs');
    
    console.log(`Keylog directory: ${keylogDir}`);
    
    if (fs.existsSync(keylogDir)) {
        console.log('✓ Keylog directory exists!');
        
        const files = fs.readdirSync(keylogDir);
        console.log(`Found ${files.length} files:`, files);
        
        if (files.length === 0) {
            console.log('✗ No keylog files found');
            
            // Try to create test files to verify write permissions
            try {
                const testFile = path.join(keylogDir, 'test-write.txt');
                fs.writeFileSync(testFile, 'test content');
                console.log('✓ Directory is writable');
                fs.unlinkSync(testFile);
            } catch (err) {
                console.log('✗ Directory write test failed:', err.message);
            }
        } else {
            files.forEach(file => {
                const filePath = path.join(keylogDir, file);
                const stats = fs.statSync(filePath);
                console.log(`\n📄 ${file}:`);
                console.log(`   Size: ${stats.size} bytes`);
                console.log(`   Modified: ${stats.mtime}`);
                
                if (stats.size > 0) {
                    console.log('✓ File has content!');
                    const content = fs.readFileSync(filePath, 'utf8');
                    console.log('   First few lines:');
                    content.split('\n').slice(0, 5).forEach((line, i) => {
                        if (line.trim()) console.log(`   ${i + 1}: ${line}`);
                    });
                } else {
                    console.log('✗ File is empty');
                }
            });
        }
    } else {
        console.log('✗ Keylog directory does not exist');
        
        // Try to create it manually to test permissions
        try {
            fs.mkdirSync(keylogDir, { recursive: true });
            console.log('✓ Successfully created keylog directory manually');
        } catch (err) {
            console.log('✗ Failed to create keylog directory:', err.message);
        }
    }
    
    console.log('=== End keylog check ===\n');
}

// Wait for server to be ready, then run test
console.log('Waiting for server to be ready...');
setTimeout(testKeylogGeneration, 4000);