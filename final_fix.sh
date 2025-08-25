#!/bin/bash
echo "🧹 COMPLETE CLEANUP - Killing ALL processes..."

# Kill all node and npm processes system-wide
pkill -9 -f "node" 2>/dev/null || true
pkill -9 -f "npm" 2>/dev/null || true
pkill -9 -f "server.js" 2>/dev/null || true

# Wait for processes to die
sleep 5

# Kill any remaining processes on common ports
for port in {3000..3010}; do
    fuser -k ${port}/tcp 2>/dev/null || true
done

sleep 2

echo "🔍 Finding completely free port..."
for port in {3000..3050}; do
    if ! (timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null); then
        echo "✅ Port $port is completely free"
        
        # Update .env with the free port
        sed -i "s/PORT=.*/PORT=$port/" .env
        echo "📝 Updated .env: PORT=$port"
        
        # Start server in background with nohup to avoid terminal issues
        echo "🚀 Starting server on port $port..."
        nohup npm start > server.log 2>&1 &
        
        # Wait and check if it started successfully
        sleep 5
        if ps aux | grep -v grep | grep "node server.js" > /dev/null; then
            echo "✅ Server started successfully on port $port"
            echo "📋 Server PID: $(pgrep -f 'node server.js')"
            echo "📜 Check server.log for details"
            exit 0
        else
            echo "❌ Failed to start on port $port"
        fi
    fi
done

echo "❌ Could not find available port"
exit 1
