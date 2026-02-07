#!/usr/bin/env node

/**
 * Runs a multi-turn conversation against the dev server and prints
 * a summary table showing load_skill/use_skill calls and remember flags.
 *
 * Usage:
 *   node example/test-conversation.mjs [base-url]
 *
 * Default base URL: http://localhost:3000
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';

const TURNS = [
  'What is the weather in Tokyo?',
  'What about in Paris?',
  'List the Discord channels',
  'Send a message saying Hello from the agent to the random channel',
  'Now send Build complete to the dev channel',
];

async function sendMessage(message, sessionId) {
  const body = { message };
  if (sessionId) body.sessionId = sessionId;

  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const text = await res.text();
  const events = [];

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch {}
  }

  return events;
}

function parseToolCalls(events) {
  let sessionId = null;
  const loads = [];
  const uses = [];
  let content = '';

  for (const e of events) {
    if (e.type === 'session') sessionId = e.sessionId;
    if (e.type === 'content') content = e.content;
    if (e.type === 'tool_call') {
      let args;
      try { args = JSON.parse(e.arguments); } catch { args = {}; }

      if (e.name === 'load_skill') {
        loads.push(args.skill ?? '?');
      } else if (e.name === 'use_skill') {
        uses.push({
          skill: args.skill ?? '?',
          script: args.script ?? '?',
          args: args.args ?? [],
          remember: args.remember,
        });
      }
    }
  }

  return { sessionId, loads, uses, content };
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '\u2026';
}

async function main() {
  console.log(`\nTesting against ${BASE}\n`);

  let sessionId = null;
  const rows = [];

  for (let i = 0; i < TURNS.length; i++) {
    const msg = TURNS[i];
    process.stdout.write(`  Turn ${i + 1}/${TURNS.length}: ${truncate(msg, 50)}...`);

    const events = await sendMessage(msg, sessionId);
    const { sessionId: sid, loads, uses, content } = parseToolCalls(events);
    if (sid) sessionId = sid;

    rows.push({
      turn: i + 1,
      message: msg,
      loads,
      uses,
      content,
    });

    process.stdout.write(' done\n');
  }

  // Print table
  console.log('\n' + '='.repeat(110));
  console.log(
    pad('Turn', 5) +
    pad('Request', 30) +
    pad('load_skill', 14) +
    pad('use_skill', 32) +
    pad('remember', 10) +
    'Response'
  );
  console.log('-'.repeat(110));

  for (const r of rows) {
    const loadStr = r.loads.length ? r.loads.join(', ') : '--';
    const useEntries = r.uses.length ? r.uses : [null];

    for (let j = 0; j < useEntries.length; j++) {
      const u = useEntries[j];
      const useStr = u ? `${u.script} ${u.args.join(' ')}` : '--';
      const remStr = u ? String(u.remember ?? 'omitted') : '--';

      // Only show turn/request/response on first line
      if (j === 0) {
        console.log(
          pad(String(r.turn), 5) +
          pad(truncate(r.message, 28), 30) +
          pad(loadStr, 14) +
          pad(truncate(useStr, 30), 32) +
          pad(remStr, 10) +
          truncate(r.content, 40)
        );
      } else {
        console.log(
          pad('', 5) +
          pad('', 30) +
          pad('', 14) +
          pad(truncate(useStr, 30), 32) +
          pad(remStr, 10)
        );
      }
    }
  }

  console.log('='.repeat(110));

  // Summary stats
  const totalLoads = rows.reduce((n, r) => n + r.loads.length, 0);
  const totalUses = rows.reduce((n, r) => n + r.uses.length, 0);
  const rememberedUses = rows.reduce((n, r) => n + r.uses.filter(u => u.remember === true).length, 0);
  const forgottenUses = rows.reduce((n, r) => n + r.uses.filter(u => u.remember !== true).length, 0);

  console.log(`\nStats: ${totalLoads} load_skill | ${totalUses} use_skill (${rememberedUses} remembered, ${forgottenUses} forgotten)`);
  console.log(`Session: ${sessionId}\n`);
}

function pad(str, len) {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
