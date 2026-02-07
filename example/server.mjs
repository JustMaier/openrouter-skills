import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouter, stepCountIs } from '@openrouter/sdk';
import { createSkillsProvider, createSdkTools, processTurn } from '../dist/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ?? 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.MODEL ?? 'anthropic/claude-sonnet-4';

if (!OPENROUTER_API_KEY) {
  console.error('Missing OPENROUTER_API_KEY. Copy .env.example to .env and set your key.');
  process.exit(1);
}

// --- Skills setup ---

const skills = await createSkillsProvider(join(__dirname, 'skills'));
const sdkTools = createSdkTools(skills);
console.log(`Loaded skills: ${skills.skillNames.join(', ')}`);

const client = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

// --- Sessions (in-memory conversation history) ---

const sessions = new Map(); // sessionId -> messages[]

function getSession(id) {
  if (!id || !sessions.has(id)) {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, []);
    return { sessionId, messages: sessions.get(sessionId) };
  }
  return { sessionId: id, messages: sessions.get(id) };
}

// --- MIME types ---

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// --- Static file serving ---

async function serveStatic(req, res) {
  const url = req.url === '/' ? '/index.html' : req.url;
  const publicDir = resolve(join(__dirname, 'public'));
  const filePath = resolve(join(publicDir, url));

  // Prevent path traversal
  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');

    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// --- Chat API endpoint using SDK callModel ---

async function handleChat(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const userMessage = payload.message?.trim();
  const model = payload.model || DEFAULT_MODEL;

  if (!userMessage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No message provided' }));
    return;
  }

  const { sessionId, messages } = getSession(payload.sessionId);
  messages.push({ role: 'user', content: userMessage });

  console.log(`[chat] session=${sessionId.slice(0, 8)} model=${model} messages=${messages.length}`);

  // SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send sessionId so client can use it for subsequent requests
  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  try {
    const result = client.callModel({
      model,
      instructions: 'You are a helpful assistant with access to skills.\n' +
        'When the user asks you to do something covered by a skill, load it first, then use it.',
      input: messages,
      tools: sdkTools,
      stopWhen: stepCountIs(10),
    });

    const { text, history } = await processTurn(result, (event) => {
      if (event.type === 'tool_call') {
        res.write(`data: ${JSON.stringify({ type: 'tool_call', name: event.name, arguments: event.arguments })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'tool_result', name: event.name, result: event.result })}\n\n`);
      }
    });

    res.write(`data: ${JSON.stringify({ type: 'content', content: text })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

    messages.push(...history);
    messages.push({ role: 'assistant', content: text });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }

  res.end();
}

// --- Server ---

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    await handleChat(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ defaultModel: DEFAULT_MODEL, skills: skills.skillNames }));
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Example app running at http://localhost:${PORT}`);
});
