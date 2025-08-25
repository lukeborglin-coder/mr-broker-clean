#!/bin/bash
echo "🔄 Killing all Node.js processes..."
pkill -9 -f "node" 2>/dev/null || true
pkill -9 -f "npm" 2>/dev/null || true
sleep 3

echo "🔍 Finding available port..."
for port in {3000..3020}; do
    if ! (echo > /dev/tcp/localhost/$port) 2>/dev/null; then
        echo "✅ Found available port: $port"
        sed -i "s/PORT=.*/PORT=$port/" .env
        echo "📝 Updated .env file with PORT=$port"
        break
    fi
done

echo "🚀 Starting server..."
npm start
