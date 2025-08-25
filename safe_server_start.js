import { spawn } from 'child_process';
import fs from 'fs';

console.log('🛡️ SAFE SERVER STARTUP - Handling API key issues');

// Check if original server.js exists
if (!fs.existsSync('server.js')) {
    console.error('❌ server.js not found');
    process.exit(1);
}

// Start server process
const serverProcess = spawn('node', ['server.js'], {
    stdio: 'inherit',
    env: { ...process.env }
});

serverProcess.on('error', (error) => {
    console.error('❌ Server startup error:', error.message);
});

serverProcess.on('exit', (code, signal) => {
    if (code === 0) {
        console.log('✅ Server exited normally');
    } else {
        console.log(`⚠️ Server exited with code: ${code}, signal: ${signal}`);
        if (code === 1) {
            console.log('💡 This might be due to missing OpenAI API key - server needs valid API key for full functionality');
            console.log('🔧 Add your OpenAI API key to .env file: OPENAI_API_KEY=your-actual-key');
        }
    }
});

// Keep process alive
process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    serverProcess.kill('SIGTERM');
    process.exit(0);
});
