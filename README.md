# mr-broker (Node middleware)

This small server exposes two endpoints:

- `POST /upsert-chunks` — ingest text chunks into Pinecone (namespaced per client)
- `POST /search` — query Pinecone and ask OpenAI to draft a grounded answer with citations

## Quick start

1) Install Node 18+
2) Copy `.env.sample` to `.env` and fill in your keys:
   - OPENAI_API_KEY
   - PINECONE_API_KEY
   - PINECONE_INDEX_HOST (looks like https://YOURINDEX-xxxx.svc.YOURREGION.pinecone.io)
   - AUTH_TOKEN (any long random string)
   - PORT=3000
3) `npm install`
4) `node server.js`

You can expose it publicly with ngrok: `ngrok http 3000`

## Deploy to Render (optional)

- Connect this folder to Render as a Blueprint using `render.yaml`
- Set the 3 required env vars (OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST)
- Render will generate AUTH_TOKEN and run on PORT 10000 by default

## Endpoints

### POST /upsert-chunks
Body:
```json
{
  "clientId": "genentech",
  "fileName": "Report Q2 2025.pptx",
  "fileUrl": "https://sharepoint/...",
  "study": "ATU Q2 2025",
  "date": "2025-06-01",
  "chunks": [
    { "idSuffix": "0", "text": "first 1000 characters..." },
    { "idSuffix": "1", "text": "next 1000 characters..." }
  ]
}
```

Headers:
- `x-auth-token: YOUR_AUTH_TOKEN`

### POST /search
Body:
```json
{
  "clientId": "genentech",
  "userQuery": "What has satisfaction for Product X looked like over the past few years?",
  "topK": 6
}
```

Headers:
- `x-auth-token: YOUR_AUTH_TOKEN`
