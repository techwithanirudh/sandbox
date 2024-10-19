// AIWorker class for handling AI-related operations
export class AIWorker {
  private aiWorkerUrl: string
  private cfAiKey: string
  private databaseWorkerUrl: string
  private workersKey: string

  // Constructor to initialize AIWorker with necessary URLs and keys
  constructor(
    aiWorkerUrl: string,
    cfAiKey: string,
    databaseWorkerUrl: string,
    workersKey: string
  ) {
    this.aiWorkerUrl = aiWorkerUrl
    this.cfAiKey = cfAiKey
    this.databaseWorkerUrl = databaseWorkerUrl
    this.workersKey = workersKey
  }

  // Method to generate code based on user input
  async generateCode(
    userId: string,
    fileName: string,
    code: string,
    line: number,
    instructions: string
  ): Promise<{ response: string; success: boolean }> {
    try {
      // Fetch request to the database worker
      const fetchPromise = fetch(
        `${this.databaseWorkerUrl}/api/sandbox/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `${this.workersKey}`,
          },
          body: JSON.stringify({
            userId: userId,
          }),
        }
      )

      // Fetch request to the AI worker for code generation
      const generateCodePromise = fetch(
        `${this.aiWorkerUrl}/api?fileName=${encodeURIComponent(
          fileName
        )}&code=${encodeURIComponent(code)}&line=${encodeURIComponent(
          line
        )}&instructions=${encodeURIComponent(instructions)}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `${this.cfAiKey}`,
          },
        }
      )

      // Wait for both fetch requests to complete
      const [fetchResponse, generateCodeResponse] = await Promise.all([
        fetchPromise,
        generateCodePromise,
      ])

      // Parse the response from the AI worker
      const json = await generateCodeResponse.json()

      // Return the generated code response
      return { response: json.response, success: true }
    } catch (e: any) {
      // Log and throw an error if code generation fails
      console.error("Error generating code:", e)
      throw new Error(`Error: code generation. ${e.message ?? e}`)
    }
  }
}
