// drive.js — Folder-mode only (Option B)
// Always query by "'<folderId>' in parents". No driveId/corpora=drive usage.
// Improvements:
//  • Accept credentials via GOOGLE_APPLICATION_CREDENTIALS (path) OR GOOGLE_CREDENTIALS_JSON (path OR inline JSON)
//  • streamFile() auto-exports native Google formats (Docs/Sheets/Slides) to .docx/.xlsx/.pptx

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";

let _authSingleton = null;

function resolveCreds() {
  // Priority: explicit path var → inline JSON var → path from JSON var
  const pathVar = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const jsonVar = process.env.GOOGLE_CREDENTIALS_JSON;

  // If explicit path is provided, use it
  if (pathVar) {
    const abs = path.isAbsolute(pathVar) ? pathVar : path.resolve(process.cwd(), pathVar);
    if (!fs.existsSync(abs)) {
      throw new Error(`Service account JSON not found at ${abs}`);
    }
    return { mode: "keyFile", keyFile: abs };
  }

  if (!jsonVar) {
    throw new Error("Google credentials not configured. Set GOOGLE_APPLICATION_CREDENTIALS (path) or GOOGLE_CREDENTIALS_JSON (path or inline JSON).");
  }

  // If GOOGLE_CREDENTIALS_JSON looks like inline JSON, parse it.
  const looksJson = jsonVar.trim().startsWith("{");
  if (looksJson) {
    try {
      const parsed = JSON.parse(jsonVar);
      return { mode: "fromJSON", credentials: parsed };
    } catch (e) {
      throw new Error("GOOGLE_CREDENTIALS_JSON appears to be JSON but could not be parsed.");
    }
  }

  // Otherwise treat as a path
  const abs = path.isAbsolute(jsonVar) ? jsonVar : path.resolve(process.cwd(), jsonVar);
  if (!fs.existsSync(abs)) {
    throw new Error(`Service account JSON not found at ${abs}`);
  }
  return { mode: "keyFile", keyFile: abs };
}

function getAuth() {
  if (_authSingleton) return _authSingleton;

  const cfg = resolveCreds();
  if (cfg.mode === "fromJSON") {
    const auth = new google.auth.GoogleAuth({
      credentials: cfg.credentials,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    _authSingleton = auth;
    return auth;
  }

  // keyFile mode
  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.keyFile,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  _authSingleton = auth;
  return auth;
}

function getDrive() {
  const auth = getAuth();
  return google.drive({ version: "v3", auth });
}

/** List all items directly under a folder (flat) */
export async function listFlat(folderId) {
  if (!folderId) throw new Error("folderId is required");
  const drive = getDrive();
  let files = [];
  let pageToken;

  do {
    const resp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, parents, webViewLink, createdTime, modifiedTime, size, iconLink, thumbnailLink)",
      pageSize: 1000,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    files = files.concat(resp.data.files || []);
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  return files;
}

/** Search within a folder by (partial) name, optional extension like ".pptx" */
export async function searchByName(folderId, query = "", ext = "") {
  if (!folderId) throw new Error("folderId is required");
  const drive = getDrive();
  let files = [];
  let pageToken;

  const qSafe = (s) => String(s || "").replace(/'/g, "\\'");
  const nameFilter = query ? `name contains '${qSafe(query)}'` : "name != ''";
  const extFilter = ext ? ` and name contains '${qSafe(ext)}'` : "";

  do {
    const resp = await drive.files.list({
      q: `trashed = false and ${nameFilter}${extFilter} and '${folderId}' in parents`,
      fields:
        "nextPageToken, files(id, name, mimeType, parents, webViewLink, createdTime, modifiedTime, size, iconLink, thumbnailLink)",
      pageSize: 200,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    files = files.concat(resp.data.files || []);
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  return files;
}

function safeFilename(name) {
  // Avoid weird header issues; keep it simple
  return encodeURIComponent(name || "download");
}

const EXPORTS = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
  },
};

/** Stream a file’s bytes back through the Express response (auto-export native Google files) */
export async function streamFile(fileId, res) {
  const drive = getDrive();

  // Get metadata
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: true,
  });

  let name = meta.data.name || "download";
  const mimeType = meta.data.mimeType;

  // If native Google type, export to an appropriate format
  if (mimeType && EXPORTS[mimeType]) {
    const { mime, ext } = EXPORTS[mimeType];
    if (!name.toLowerCase().endsWith(ext)) name += ext;

    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(name)}"`);
    res.setHeader("X-File-Name", safeFilename(name));
    res.setHeader("Content-Type", mime);

    const dl = await drive.files.export(
      { fileId, mimeType: mime, supportsAllDrives: true },
      { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
      dl.data.on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
    });
    return;
  }

  // Regular binary file
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(name)}"`);
  res.setHeader("X-File-Name", safeFilename(name));

  const dl = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    dl.data.on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

/** Optional: recursive tree under a folder */
export async function listTree(folderId) {
  if (!folderId) throw new Error("folderId is required");
  const drive = getDrive();

  async function listChildren(id) {
    const node = { id, name: "", mimeType: "", children: [] };

    // fetch current node name
    const meta = await drive.files.get({
      fileId: id,
      fields: "id, name, mimeType",
      supportsAllDrives: true,
    });
    node.name = meta.data.name;
    node.mimeType = meta.data.mimeType;

    // list folder children
    if (node.mimeType === "application/vnd.google-apps.folder") {
      let pageToken;
      do {
        const resp = await drive.files.list({
          q: `'${id}' in parents and trashed = false`,
          fields: "nextPageToken, files(id, name, mimeType)",
          pageSize: 200,
          pageToken,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
        const kids = resp.data.files || [];
        for (const f of kids) node.children.push(await listChildren(f.id));
        pageToken = resp.data.nextPageToken;
      } while (pageToken);
    }

    return node;
  }

  return listChildren(folderId);
}
