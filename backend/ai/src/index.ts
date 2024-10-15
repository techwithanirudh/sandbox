import { Anthropic } from "@anthropic-ai/sdk";
import { MessageParam } from "@anthropic-ai/sdk/src/resources/messages.js";

export interface Env {
  ANTHROPIC_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const body = await request.json() as { messages: unknown; context: unknown };
    const messages = body.messages;
    const context = body.context;

    if (!Array.isArray(messages)) {
      return new Response("Invalid messages format", { status: 400 });
    }

    const systemMessage = `You are an intelligent programming assistant. Please respond to the following request concisely. If your response includes code, please format it using triple backticks (\`\`\`) with the appropriate language identifier. For example:

\`\`\`python
print("Hello, World!")
\`\`\`

Provide a clear and concise explanation along with any code snippets. Keep your response brief and to the point.

${context ? `Context:\n${context}\n` : ''}`;

    const anthropicMessages = messages.map(msg => ({
      role: msg.role === 'human' ? 'user' : 'assistant',
      content: msg.content
    })) as MessageParam[];

    try { 
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

      const stream = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20240620",
        max_tokens: 1024,
        system: systemMessage,
        messages: anthropicMessages,
        stream: true,
      });

      const encoder = new TextEncoder();

      const streamResponse = new ReadableStream({
        async start(controller) {
          for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              const bytes = encoder.encode(chunk.delta.text);
              controller.enqueue(bytes);
            }
          }
          controller.close();
        },
      });

      return new Response(streamResponse, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch (error) {
      console.error("Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
