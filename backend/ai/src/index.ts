import { Anthropic } from "@anthropic-ai/sdk";

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

    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const instructions = url.searchParams.get("instructions");
    const context = url.searchParams.get("context");

    if (!instructions) {
      return new Response("Missing instructions parameter", { status: 400 });
    }

    const prompt = `You are an intelligent programming assistant. Please respond to the following request:

${instructions}

${context ? `Context:\n${context}\n` : ''}

If your response includes code, please format it using triple backticks (\`\`\`) with the appropriate language identifier. For example:

\`\`\`python
print("Hello, World!")
\`\`\`

Provide a clear and concise explanation along with any code snippets.`;

    try { 
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: "claude-3-opus-20240229",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const assistantResponse = response.content[0].type === 'text' ? response.content[0].text : '';

      // When sending the response, include CORS headers
      return new Response(JSON.stringify({ "response": assistantResponse }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (error) {
      console.error("Error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
