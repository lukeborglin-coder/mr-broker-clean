#!/bin/bash
# Kill any existing Node.js processes
pkill -9 -f "node server.js" 2>/dev/null || true
sleep 2

# Find available port starting from 3000
for port in {3000..3010}; do
    if ! netstat -tlnp 2>/dev/null | grep -q ":$port "; then
        echo "Using available port: $port"
        sed -i "s/PORT=.*/PORT=$port/" .env
        break
    fi
done

# Start the server
npm start
