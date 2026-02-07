# OpenRouter Tool Calling

OpenRouter provides three ways to use tool calling, each at a different level of abstraction.

---

## 1. Chat Completions API (OpenAI-Compatible)

**Endpoint:** `POST /api/v1/chat/completions`

This is the OpenAI-compatible format. Most existing code and tutorials target this endpoint.

### Tool Definition

```typescript
// Same format for both Chat Completions and Responses APIs
const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City and state, e.g. San Francisco, CA' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
      },
      required: ['location']
    }
  }
};
```

### Request

```typescript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'anthropic/claude-3.5-sonnet',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the weather in NYC?' }
    ],
    tools: [weatherTool],
    tool_choice: 'auto',
    max_tokens: 2048
  })
});
```

### Response (tool call)

```json
{
  "id": "gen-xxxxxxxxxxxxxx",
  "choices": [{
    "finish_reason": "tool_calls",
    "native_finish_reason": "tool_use",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"location\": \"New York, NY\"}"
        }
      }]
    }
  }],
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 15,
    "total_tokens": 65
  },
  "model": "anthropic/claude-3.5-sonnet"
}
```

Key differences from raw OpenAI:
- `native_finish_reason` -- the provider's actual finish reason (e.g. `tool_use` for Anthropic, `stop` for OpenAI)
- `finish_reason` -- normalized by OpenRouter to a standard set: `stop`, `tool_calls`, `length`, `content_filter`, `error`
- Token counts use a normalized tokenizer (GPT-4o). Native counts available via `/api/v1/generation`.

### Returning Tool Results

```typescript
messages.push(assistantMessage); // the message containing tool_calls
messages.push({
  role: 'tool',
  tool_call_id: 'call_abc123',
  content: JSON.stringify({ temperature: 72, unit: 'fahrenheit' })
});
// Call the API again with the updated messages array
```

---

## 2. Responses API (OpenRouter-Native)

**Endpoint:** `POST /api/v1/responses`

This is OpenRouter's own format. It differs from Chat Completions in several ways that make it more informative for production use.

### Request

```json
{
  "model": "openai/o4-mini",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "What is the weather in San Francisco?" }]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get the current weather in a location",
      "parameters": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "City and state" }
        },
        "required": ["location"]
      }
    }
  ],
  "tool_choice": "auto",
  "max_output_tokens": 9000
}
```

Note the differences from Chat Completions:
- `input` instead of `messages` -- content uses `{ type: "input_text", text }` objects
- Tool definitions are flatter: `name` and `parameters` sit at the top level (no nested `function` wrapper)
- `max_output_tokens` instead of `max_tokens`

### Response (tool call)

```json
{
  "id": "resp_1234567890",
  "object": "response",
  "created_at": 1234567890,
  "completed_at": 1234567895,
  "model": "openai/o4-mini",
  "status": "completed",
  "output": [
    {
      "type": "function_call",
      "id": "fc_abc123",
      "call_id": "call_xyz789",
      "name": "get_weather",
      "arguments": "{\"location\":\"San Francisco, CA\"}"
    }
  ],
  "output_text": "",
  "usage": {
    "input_tokens": 45,
    "output_tokens": 25,
    "total_tokens": 70
  },
  "temperature": 1.0,
  "top_p": 1.0,
  "presence_penalty": 0.0,
  "frequency_penalty": 0.0,
  "parallel_tool_calls": true,
  "max_tool_calls": null,
  "tools": [...],
  "tool_choice": { ... },
  "instructions": { ... },
  "metadata": { ... }
}
```

### Why the Responses API is better for production

| Feature | Chat Completions | Responses API |
|---------|-----------------|---------------|
| Token usage | `prompt_tokens`, `completion_tokens` (normalized) | `input_tokens`, `output_tokens` (native) |
| Status tracking | None | `status`, `created_at`, `completed_at` |
| Tool call output | Nested in `choices[].message.tool_calls` | Flat in `output[]` with `type: "function_call"` |
| Text output | `choices[].message.content` | `output_text` convenience field + `output[]` with `type: "message"` |
| Config echo | None | Echoes back `temperature`, `top_p`, `tools`, `tool_choice`, etc. |
| Parallel tools | Implicit | Explicit `parallel_tool_calls` field |
| Conversation chain | Manual message array | `previous_response_id` for linking |
| Cache info | Not exposed | `prompt_cache_key` |
| Safety | Not exposed | `safety_identifier` |

### Response (text output)

When the model responds with text instead of a tool call:

```json
{
  "id": "resp_1234567890",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "id": "msg_abc123",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "The weather in San Francisco is 18C and sunny.",
          "annotations": []
        }
      ]
    }
  ],
  "output_text": "The weather in San Francisco is 18C and sunny.",
  "usage": { "input_tokens": 12, "output_tokens": 45, "total_tokens": 57 }
}
```

---

## 3. OpenRouter JS SDK (`@openrouter/sdk`)

The SDK wraps the Responses API with TypeScript-first ergonomics. It handles the agentic loop, Zod schema validation, and tool execution automatically.

### Setup

```typescript
import { OpenRouter, tool } from '@openrouter/sdk';
import { z } from 'zod';

const openrouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});
```

### Defining Tools

The `tool()` helper takes Zod schemas and an `execute` function:

```typescript
const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name, e.g. "San Francisco, CA"'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ location, units }) => {
    const data = await fetchWeather(location);
    return {
      temperature: units === 'celsius' ? data.temp_c : data.temp_f,
      conditions: data.condition,
    };
  },
});
```

Set `execute: false` to intercept tool calls manually instead of auto-executing.

### Calling Models with Tools

```typescript
const result = openrouter.callModel({
  model: 'openai/gpt-5-nano',
  input: 'What is the weather in Paris?',
  instructions: 'You are a helpful weather assistant.',
  tools: [weatherTool],
  maxToolRounds: 5,        // auto-execute up to 5 rounds (default)
  temperature: 0.7,
  maxOutputTokens: 2048,
});
```

### Getting Results

```typescript
// Wait for all tool execution to finish, get final text
const text = await result.getText();

// Get the full response object (includes usage)
const response = await result.getResponse();
console.log(response.usage);
// { inputTokens: 50, outputTokens: 35, cachedTokens: 0 }

// Get raw tool calls (set maxToolRounds: 0 to skip auto-execution)
const toolCalls = await result.getToolCalls();
for (const call of toolCalls) {
  console.log(call.name, call.id, call.arguments);
}

// Stream tool calls as they arrive
for await (const toolCall of result.getToolCallsStream()) {
  console.log(`Tool: ${toolCall.name}`, toolCall.arguments);
}
```

### Lower-Level: `chat.send()`

For direct Chat Completions access through the SDK:

```typescript
const response = await openrouter.chat.send({
  model: 'anthropic/claude-3.5-sonnet',
  messages: [
    { role: 'user', content: 'What is the weather in London?' }
  ],
  tools: tools,
  stream: false,
});

// Returns the Chat Completions format
const toolCalls = response.choices[0].message.toolCalls;
```

---

## The Agentic Loop

Regardless of which API you use, the pattern is the same:

```typescript
const maxRounds = 10;

for (let round = 0; round < maxRounds; round++) {
  const response = await callLLM(messages);
  const assistantMsg = response.choices[0].message;
  messages.push(assistantMsg);

  if (assistantMsg.tool_calls) {
    for (const call of assistantMsg.tool_calls) {
      const result = await executeLocally(call.function.name, call.function.arguments);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  } else {
    break;
  }
}
```

The SDK's `callModel` with `maxToolRounds` handles this loop automatically. For the Responses API, tool results in `output[]` use `type: "function_call_output"` with a `call_id` reference.

## Streaming (Chat Completions)

Tool call arguments arrive as partial SSE chunks and must be concatenated:

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"loc"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\":\"NYC\"}"}}]}}]}
data: {"choices":[{"finish_reason":"tool_calls"}]}
```

Reconstruct full arguments by concatenating chunks with the same `index`.

---

## Which API to Use

| Use Case | Recommended |
|----------|-------------|
| Drop-in replacement for OpenAI code | Chat Completions |
| New project, want richer metadata | Responses API |
| TypeScript project, want auto-execution | SDK `callModel` |
| Need manual control with SDK niceties | SDK `chat.send()` |

For this library, the **Responses API** or **SDK** are the better foundation -- they provide token usage, status tracking, and parallel tool call configuration that the Chat Completions format lacks.

---

## Reference Implementation

The project at `C:\Dev\Repos\ai\mini-experiments\tool-calling` uses the Chat Completions API with a custom agent framework:

- **Agent factory**: `createAgent(options)` returns a reusable agent function
- **Tool interface**: `{ definition, execute }` -- JSON schema + async handler
- **Tool registry**: Central map of tool name to implementation
- **Stream parser**: Reconstructs tool calls from SSE chunks via `eventsource-parser`
- **Multi-round execution**: Loops up to `maxToolRounds` (default 10)
- **Callbacks**: `onContent`, `onToolCall`, `onError`, `onComplete`
