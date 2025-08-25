#!/bin/bash
echo "🚀 SMART SERVER STARTUP - Automatic port detection"

# Function to find available port
find_available_port() {
    for port in 3001 3002 3003 3004 3005; do
        if ! (timeout 1 bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null); then
            echo $port
            return
        fi
    done
    echo "3006"  # fallback port
}

# Kill any existing processes
pkill -9 -f "node server.js" 2>/dev/null || true
sleep 2

# Find available port
AVAILABLE_PORT=$(find_available_port)
echo "🎯 Using port: $AVAILABLE_PORT"

# Update .env file with the available port
echo "PORT=$AVAILABLE_PORT" > .env
echo "NODE_ENV=production" >> .env
echo "✅ Updated .env with port $AVAILABLE_PORT"

# Start server
echo "🚀 Starting Mr. Broker server on port $AVAILABLE_PORT..."
export PORT=$AVAILABLE_PORT
node server.js &
SERVER_PID=$!

echo "✅ Server started with PID: $SERVER_PID"
echo "🌐 Server URL: http://localhost:$AVAILABLE_PORT"
echo "🔑 Admin: cognitive_internal / coggpt25"
echo "🔑 Client: genentech_user / demo123"

# Wait and verify
sleep 8
if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo "🎉 SUCCESS: Server running without EADDRINUSE error!"
else
    echo "❌ Server failed to start"
fi
