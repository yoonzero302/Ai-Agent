const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 8765);
const BASE_URL = (process.env.ANYTHINGLLM_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.ANYTHINGLLM_API_KEY || "";
const WORKSPACE_SLUG = process.env.ANYTHINGLLM_WORKSPACE_SLUG || "";

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_CHARS = 18 * 1024 * 1024;
const CHAT_TIMEOUT_MS = 180_000;

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

const DOCUMENT_EXTS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
]);

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && request.url === "/") {
    return serveIndex(response);
  }

  if (request.method === "GET" && request.url === "/favicon.ico") {
    response.writeHead(204);
    return response.end();
  }

  if (request.method === "GET" && request.url === "/api/health") {
    return checkAnythingLlm(response);
  }

  if (request.method === "POST" && request.url === "/api/chat") {
    return chat(request, response);
  }

  if (request.method === "GET" && request.url.startsWith("/api/files/")) {
    return proxyGeneratedFile(request, response);
  }

  sendJson(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
});

async function checkAnythingLlm(response) {
  const missing = missingSettings();
  if (missing.length) {
    return sendJson(response, 503, {
      connected: false,
      error: `.env 설정이 필요합니다: ${missing.join(", ")}`,
    });
  }

  try {
    const upstream = await fetchWithTimeout(`${BASE_URL}/api/v1/auth`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, 15_000);

    if (!upstream.ok) {
      return sendJson(response, 503, {
        connected: false,
        error: authError(upstream.status),
      });
    }

    sendJson(response, 200, { connected: true });
  } catch {
    sendJson(response, 503, {
      connected: false,
      error: "AnythingLLM 서버에 연결할 수 없습니다.",
    });
  }
}

async function chat(request, response) {
  const missing = missingSettings();
  if (missing.length) {
    return sendJson(response, 503, {
      error: `.env 설정이 필요합니다: ${missing.join(", ")}`,
    });
  }

  try {
    const body = await readJson(request);
    const attachments = normalizeAttachments(body.attachments);
    let message = typeof body.message === "string" ? body.message.trim() : "";
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim()
        ? body.sessionId.trim().slice(0, 128)
        : "plant-observation";

    if (!message && attachments.length) {
      message = defaultMessageFor(attachments);
    }

    if (!message) {
      return sendJson(response, 400, { error: "질문을 입력해 주세요." });
    }

    const payload = {
      message: prepareChatMessage(message),
      mode: "automatic",
      sessionId,
    };
    if (attachments.length) {
      payload.attachments = attachments;
    }

    const endpoint =
      `${BASE_URL}/api/v1/workspace/${encodeURIComponent(WORKSPACE_SLUG)}/chat`;
    const upstream = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, CHAT_TIMEOUT_MS);

    const raw = await upstream.text();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      // AnythingLLM이 JSON 이외의 응답을 반환한 경우 아래에서 처리합니다.
    }

    if (!upstream.ok) {
      const error =
        upstream.status === 401 || upstream.status === 403
          ? authError(upstream.status)
          : upstream.status === 404
            ? "워크스페이스 slug를 확인해 주세요."
            : `AnythingLLM 요청에 실패했습니다. (HTTP ${upstream.status})`;
      return sendJson(response, 502, { error });
    }

    const files = collectReplyFiles(data);
    let textResponse =
      typeof data.textResponse === "string" ? data.textResponse.trim() : "";

    if (!files.length && wantsGeneratedFile(message)) {
      const generated = makeDownloadableFile(message, textResponse);
      if (generated) {
        files.push(generated);
        textResponse = "요청하신 파일을 만들어 첨부했습니다. 아래에서 다운로드할 수 있습니다.";
      }
    }

    if (!textResponse && files.length) {
      textResponse = "파일을 첨부했습니다.";
    }

    if (!textResponse) {
      return sendJson(response, 502, {
        error: "AnythingLLM 응답에서 답변을 찾지 못했습니다.",
      });
    }

    sendJson(response, 200, { textResponse, files });
  } catch (error) {
    if (error.name === "AbortError") {
      return sendJson(response, 504, {
        error: "AnythingLLM 응답 시간이 초과되었습니다.",
      });
    }
    if (error.name === "PayloadTooLargeError") {
      return sendJson(response, 413, {
        error: "첨부 파일이 너무 큽니다. 파일 개수나 크기를 줄여 주세요.",
      });
    }
    if (error instanceof SyntaxError) {
      return sendJson(response, 400, { error: "잘못된 요청 형식입니다." });
    }
    console.error("채팅 연결 오류:", error.message);
    sendJson(response, 502, {
      error: "AnythingLLM 서버에 연결할 수 없습니다.",
    });
  }
}

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];

  const attachments = [];
  for (const item of raw) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (!item || typeof item !== "object") continue;

    const name = safeFileName(item.name);
    const contentString =
      typeof item.contentString === "string" ? item.contentString : "";
    if (!name || !isBase64DataUrl(contentString)) continue;
    if (contentString.length > MAX_ATTACHMENT_CHARS) continue;

    const ext = path.extname(name).toLowerCase();
    const mime = String(item.mime || "").toLowerCase().trim();

    if (IMAGE_MIMES.has(mime) || mime.startsWith("image/")) {
      attachments.push({
        name,
        mime: mime === "image/jpg" ? "image/jpeg" : mime,
        contentString,
      });
      continue;
    }

    if (DOCUMENT_EXTS.has(ext)) {
      attachments.push({
        name,
        mime: "application/anythingllm-document",
        contentString,
      });
    }
  }
  return attachments;
}

function collectReplyFiles(data) {
  const files = [];
  const seen = new Set();
  const outputs = [];
  if (Array.isArray(data.outputs)) outputs.push(...data.outputs);
  if (data.output) outputs.push(data.output);

  for (const item of outputs) {
    const file = fileFromOutput(item);
    if (!file || seen.has(file.url)) continue;
    seen.add(file.url);
    files.push(file);
  }

  const text = typeof data.textResponse === "string" ? data.textResponse : "";
  for (const file of filesFromText(text)) {
    if (seen.has(file.url)) continue;
    seen.add(file.url);
    files.push(file);
  }
  return files.slice(0, MAX_ATTACHMENTS);
}

function fileFromOutput(item) {
  if (!item) return null;
  if (typeof item === "string") {
    return fileFromStorage(item, item);
  }

  const payload =
    item.payload && typeof item.payload === "object"
      ? { ...item, ...item.payload }
      : item;

  const storageName = safeStorageName(
    payload.storageFilename || storageNameFromUrl(payload.url),
  );
  if (storageName) {
    const displayName = safeFileName(
      payload.filename || payload.name || storageName,
    );
    const kind =
      item.type === "imageGenerationCard" || isImageName(displayName) || isImageName(storageName)
        ? "image"
        : "document";
    return {
      name: displayName,
      kind,
      mime: mimeFromName(displayName || storageName),
      size: Number(payload.fileSize) || 0,
      url: `/api/files/${encodeURIComponent(storageName)}?name=${encodeURIComponent(displayName)}`,
    };
  }

  const dataUrl = [payload.contentString, payload.image].find(
    (value) => typeof value === "string" && isBase64DataUrl(value),
  );
  if (!dataUrl) return null;
  const name = safeFileName(payload.filename || payload.name || "attachment");
  return {
    name,
    kind: isImageName(name) || String(payload.mime || "").startsWith("image/") || dataUrl.startsWith("data:image/")
      ? "image"
      : "document",
    mime: payload.mime || mimeFromDataUrl(dataUrl) || mimeFromName(name),
    size: Number(payload.fileSize) || 0,
    url: dataUrl,
  };
}

function filesFromText(text) {
  const files = [];
  const imageMarkdown = /!\[[^\]]*\]\((data:image\/[a-z0-9.+-]+;base64,[^)]+)\)/gi;
  let match;
  let index = 1;
  while ((match = imageMarkdown.exec(text))) {
    files.push({
      name: `image-${index}.png`,
      kind: "image",
      mime: mimeFromDataUrl(match[1]),
      size: 0,
      url: match[1],
    });
    index += 1;
  }

  const generated = /generated-files\/([A-Za-z0-9._-]+)/gi;
  while ((match = generated.exec(text))) {
    const storageName = safeStorageName(match[1]);
    if (!storageName) continue;
    const name = safeFileName(storageName);
    files.push({
      name,
      kind: isImageName(name) ? "image" : "document",
      mime: mimeFromName(name),
      size: 0,
      url: `/api/files/${encodeURIComponent(storageName)}?name=${encodeURIComponent(name)}`,
    });
  }
  return files;
}

function fileFromStorage(storageName, displayName) {
  const stored = safeStorageName(storageName);
  if (!stored) return null;
  const name = safeFileName(displayName || stored);
  return {
    name,
    kind: isImageName(name) || isImageName(stored) ? "image" : "document",
    mime: mimeFromName(name || stored),
    size: 0,
    url: `/api/files/${encodeURIComponent(stored)}?name=${encodeURIComponent(name)}`,
  };
}

async function proxyGeneratedFile(request, response) {
  const missing = missingSettings();
  if (missing.length) {
    return sendJson(response, 503, {
      error: `.env 설정이 필요합니다: ${missing.join(", ")}`,
    });
  }

  let parsed;
  try {
    parsed = new URL(request.url, "http://127.0.0.1");
  } catch {
    return sendJson(response, 400, { error: "잘못된 요청입니다." });
  }

  const storageName = safeStorageName(
    decodeURIComponent(parsed.pathname.slice("/api/files/".length)),
  );
  if (!storageName) {
    return sendJson(response, 400, { error: "잘못된 파일 이름입니다." });
  }

  const displayName = safeFileName(parsed.searchParams.get("name") || storageName);
  const endpoint =
    `${BASE_URL}/api/v1/document/generated-files/${encodeURIComponent(storageName)}`;

  try {
    const upstream = await fetchWithTimeout(endpoint, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, 60_000);

    if (!upstream.ok) {
      return sendJson(response, upstream.status === 404 ? 404 : 502, {
        error: "AnythingLLM에서 파일을 받지 못했습니다.",
      });
    }

    const mime =
      upstream.headers.get("content-type") || mimeFromName(displayName);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const encoded = encodeURIComponent(displayName).replace(/['()]/g, escape);
    response.writeHead(200, {
      "Content-Type": mime.split(";")[0].trim(),
      "Content-Disposition": `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
    });
    response.end(buffer);
  } catch (error) {
    if (error.name === "AbortError") {
      return sendJson(response, 504, { error: "파일 다운로드 시간이 초과되었습니다." });
    }
    console.error("파일 전달 오류:", error.message);
    sendJson(response, 502, { error: "AnythingLLM에서 파일을 받지 못했습니다." });
  }
}

function safeStorageName(value) {
  const base = path.basename(String(value || "")).replace(/[\u0000-\u001f]/g, "");
  if (!base || base.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(base)) {
    return "";
  }
  return base;
}

function storageNameFromUrl(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/generated-files\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function isImageName(name) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(
    path.extname(String(name || "")).toLowerCase(),
  );
}

function mimeFromName(name) {
  switch (path.extname(String(name || "")).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".csv": return "text/csv";
    case ".doc": return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".ppt": return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xls": return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default: return "application/octet-stream";
  }
}

function mimeFromDataUrl(value) {
  const match = String(value || "").match(/^data:([^;]+);base64,/i);
  return match ? match[1] : "image/png";
}

function prepareChatMessage(message) {
  if (!wantsGeneratedFile(message)) return message;
  return [
    "아래 요청에 맞는 문서 본문만 작성하세요.",
    "파일 도구, 승인, 첨부 불가, 환경 제한 이야기는 하지 마세요.",
    "거절하지 말고, 제목부터 끝까지 바로 쓸 수 있는 완성된 글을 마크다운으로 적으세요.",
    "",
    `요청: ${message}`,
  ].join("\n");
}

function wantsGeneratedFile(message) {
  const text = String(message || "");
  const mentionsFile =
    /워드|엑셀|파워포인트|피피티|\bpptx?\b|\bdocx\b|\bxlsx\b|\bpdf\b|한글\s*파일|문서\s*파일|\.docx|\.xlsx|\.pptx|\.pdf|이미지\s*파일|그림\s*파일/i.test(
      text,
    );
  const asksToCreate =
    /만들|생성|작성|첨부|보내|내려\s*받|다운로드|저장|줄래|줘|주세요|파일로/.test(text);
  return mentionsFile && asksToCreate;
}

function makeDownloadableFile(message, text) {
  const body = documentBodyFromReply(text);
  if (!body) return null;
  const kind = requestedDocumentKind(message);
  const name = requestedFileName(message, kind.ext);
  const buffer = kind.ext === "csv"
    ? Buffer.concat([Buffer.from("\uFEFF", "utf8"), Buffer.from(body, "utf8")])
    : kind.ext === "txt"
      ? Buffer.from(body, "utf8")
      : buildDocx(body, name.replace(/\.docx$/i, ""));
  const dataUrl = `data:${kind.mime};base64,${buffer.toString("base64")}`;
  return {
    name,
    kind: "document",
    mime: kind.mime,
    size: buffer.length,
    url: dataUrl,
  };
}

function requestedDocumentKind(message) {
  const text = String(message || "");
  if (/엑셀|\bxlsx\b|\.xlsx|\.csv/i.test(text)) {
    return {
      ext: "csv",
      mime: "text/csv;charset=utf-8",
    };
  }
  if (/텍스트|\.txt\b|메모장/i.test(text) && !/워드|docx|문서/i.test(text)) {
    return { ext: "txt", mime: "text/plain;charset=utf-8" };
  }
  return {
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

function requestedFileName(message, ext) {
  const quoted = String(message || "").match(/[“"']([^“"']{1,80})[”"']/);
  let base = quoted ? quoted[1] : "문서";
  base = base.replace(/[\\/:*?"<>|]/g, " ").trim() || "문서";
  if (/\.(docx|csv|txt|pdf|pptx|xlsx)$/i.test(base)) {
    return safeFileName(base.replace(/\.[^.]+$/, `.${ext}`)) || `문서.${ext}`;
  }
  return safeFileName(`${base}.${ext}`) || `문서.${ext}`;
}

function documentBodyFromReply(text) {
  let body = String(text || "")
    .replace(/\[설정 안내\][\s\S]*$/g, "")
    .replace(/죄송합니다[^\n]*\n?/g, "")
    .replace(/현재 환경에서는[^\n]*\n?/g, "")
    .replace(/파일 생성 기능이[^\n]*\n?/g, "")
    .replace(/전달할 수 없습니다[^\n]*\n?/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^[-*]\s+/gm, "• ")
    .trim();
  return body;
}

function buildDocx(text, title) {
  const paragraphs = String(text)
    .split(/\n/)
    .map((line) => {
      const xml = escapeXml(line || " ");
      return `<w:p><w:r><w:t xml:space="preserve">${xml}</w:t></w:r></w:p>`;
    })
    .join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels, "utf8") },
  ]);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFile = Buffer.concat([local, nameBuf, data]);
    chunks.push(localFile);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += localFile.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDir, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function defaultMessageFor(attachments) {
  const hasImage = attachments.some((item) => item.mime.startsWith("image/"));
  const hasDocument = attachments.some(
    (item) => item.mime === "application/anythingllm-document",
  );
  if (hasImage && hasDocument) {
    return "첨부한 사진과 문서를 보고 식물 관찰을 도와주세요.";
  }
  if (hasImage) {
    return "이 식물 사진을 관찰하고 특징을 설명해 주세요.";
  }
  return "첨부한 문서를 읽고 식물 관찰을 도와주세요.";
}

function safeFileName(value) {
  const base = path.basename(String(value || "")).replace(/[\u0000-\u001f]/g, "");
  if (!base || base === "." || base === "..") return "";
  return base.slice(0, 180);
}

function isBase64DataUrl(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return false;
  const marker = ";base64,";
  const comma = value.indexOf(marker);
  if (comma < 5) return false;
  if (!/^data:[a-z0-9.+\-\/]+$/i.test(value.slice(0, comma))) return false;
  return value.length > comma + marker.length;
}

function missingSettings() {
  const missing = [];
  if (!BASE_URL) missing.push("ANYTHINGLLM_URL");
  if (!API_KEY) missing.push("ANYTHINGLLM_API_KEY");
  if (!WORKSPACE_SLUG) missing.push("ANYTHINGLLM_WORKSPACE_SLUG");
  return missing;
}

function authError(status) {
  return `Developer API 키가 올바르지 않습니다. (HTTP ${status})`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        const error = new Error("요청이 너무 큽니다.");
        error.name = "PayloadTooLargeError";
        fail(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        settled = true;
        resolve(JSON.parse(raw || "{}"));
      } catch {
        fail(new SyntaxError("잘못된 JSON"));
      }
    });
    request.on("error", fail);
  });
}

function serveIndex(response) {
  fs.readFile(path.join(ROOT, "index.html"), (error, content) => {
    if (error) {
      return sendJson(response, 500, { error: "index.html을 읽을 수 없습니다." });
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(content);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`포트 ${PORT}가 이미 사용 중입니다. 기존 서버를 종료해 주세요.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`식물 관찰 학습: http://127.0.0.1:${PORT}`);
});
