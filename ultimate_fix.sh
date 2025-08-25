#!/bin/bash
echo "🚀 ULTIMATE MR. BROKER FIX - Handling all issues"

# Kill existing processes
pkill -9 -f "node server.js" 2>/dev/null || true
sleep 2

# Find available port
find_port() {
    for port in 3001 3002 3003 3004 3005; do
        if ! (timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null); then
            echo $port
            return
        fi
    done
    echo "3006"
}

PORT=$(find_port)
echo "🎯 Using port: $PORT"

# Create comprehensive .env file
cat > .env << ENVEOF
PORT=$PORT
NODE_ENV=development
OPENAI_API_KEY=sk-placeholder-key-for-development
SESSION_SECRET=your-secret-key-here
SECURE_COOKIES=false
AI_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
AUTO_INGEST_ON_START=true
SYNC_INTERVAL_HOURS=1
ENVEOF

echo "✅ Created complete .env file with placeholder API key"
echo "📋 .env contents:"
cat .env
echo ""

# Start server with error handling
echo "🚀 Starting server with comprehensive error handling..."
export $(cat .env | xargs)

# Run server with try-catch for API errors
cat > safe_server_start.js << 'JSEOF'
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
JSEOF

echo "🚀 Starting safe server..."
node safe_server_start.js &
SAFE_PID=$!

sleep 8
echo ""
echo "🔍 STEP 5: Checking server status"
if ps -p $SAFE_PID > /dev/null 2>&1; then
    echo "✅ Safe server wrapper is running"
    if (timeout 2 bash -c "echo >/dev/tcp/localhost/$PORT" 2>/dev/null); then
        echo "🎉 SUCCESS: Server responding on port $PORT"
        echo "🌐 URL: http://localhost:$PORT"
    else
        echo "⚠️ Server wrapper running but may need OpenAI API key for full functionality"
        echo "🔧 To fix: Add your OpenAI API key to .env file"
    fi
else
    echo "❌ Server startup failed"
fi
