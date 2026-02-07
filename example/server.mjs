import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillsProvider } from '../dist/index.js';

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
console.log(`Loaded skills: ${skills.skillNames.join(', ')}`);

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
  const filePath = join(__dirname, 'public', url);

  // Prevent path traversal
  if (!filePath.startsWith(join(__dirname, 'public'))) {
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

// --- OpenRouter Chat Completions agentic loop ---

async function agentLoop(messages, onChunk, model) {
  const systemPrompt = [
    'You are a helpful assistant with access to skills.',
    'When the user asks you to do something covered by a skill, load it first, then use it.',
    '',
    skills.systemPrompt,
  ].join('\n');

  const conversation = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: conversation,
        tools: skills.chatCompletionsTools,
        tool_choice: 'auto',
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      onChunk({ type: 'error', error: `OpenRouter ${response.status}: ${body}` });
      return;
    }

    // Parse SSE stream
    const { text, toolCalls } = await parseStream(response.body, onChunk);

    // If we got text and no tool calls, we're done
    if (toolCalls.length === 0) {
      onChunk({ type: 'done' });
      return;
    }

    // Add assistant message with tool calls to conversation
    conversation.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call
    for (const tc of toolCalls) {
      onChunk({ type: 'tool_call', name: tc.name, arguments: tc.arguments });

      let args;
      try {
        args = JSON.parse(tc.arguments);
      } catch {
        args = {};
      }

      const result = await skills.handleToolCall(tc.name, args);
      const content = typeof result === 'string' ? result : JSON.stringify(result);

      onChunk({ type: 'tool_result', name: tc.name, result: content });

      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content,
      });
    }
  }

  onChunk({ type: 'error', error: 'Max tool rounds exceeded' });
}

// --- SSE stream parser ---

async function parseStream(body, onChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const toolCallMap = new Map(); // index -> { id, name, arguments }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        text += delta.content;
        onChunk({ type: 'content', content: delta.content });
      }

      // Tool calls (streamed incrementally)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, { id: tc.id || '', name: '', arguments: '' });
          }
          const entry = toolCallMap.get(idx);
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }
  }

  return { text, toolCalls: [...toolCallMap.values()] };
}

// --- Chat API endpoint ---

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

  const messages = payload.messages ?? [];
  const model = payload.model || DEFAULT_MODEL;

  if (messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No messages provided' }));
    return;
  }

  console.log(`[chat] model=${model} messages=${messages.length}`);

  // SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  await agentLoop(messages, (chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }, model);

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
