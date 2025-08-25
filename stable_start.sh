#!/bin/bash
echo "🚀 STABLE SERVER STARTUP - Fixing exit code -15 issue"

# Function to handle cleanup
cleanup() {
    echo "🛑 Received termination signal, shutting down gracefully..."
    if [ ! -z "$SERVER_PID" ]; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    exit 0
}

# Set up signal handlers
trap cleanup TERM INT

# Set environment variables
export PORT=3001
export NODE_ENV=production

# Start server in background and capture PID
echo "🎯 Starting Mr. Broker server on port 3001..."
node server.js &
SERVER_PID=$!

echo "✅ Server started with PID: $SERVER_PID"
echo "🌐 Server URL: http://localhost:3001"
echo "🔑 Admin: cognitive_internal / coggpt25"
echo "🔑 Client: genentech_user / demo123"

# Wait for server process and handle signals
wait $SERVER_PID
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Server exited normally"
else
    echo "⚠️  Server exited with code: $EXIT_CODE"
fi
