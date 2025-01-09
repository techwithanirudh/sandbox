// /backend/server/src/DokkuClient.ts
import { SSHConfig, SSHSocketClient } from "./SSHSocketClient"

export interface DokkuResponse {
  ok: boolean
  output: string
}

export class DokkuClient extends SSHSocketClient {
  constructor(config: SSHConfig) {
    // talk to Dokku daemon socket, if relevant
    super(config, "/var/run/dokku-daemon/dokku-daemon.sock")
  }

  async sendCommand(command: string): Promise<DokkuResponse> {
    try {
      const response = await this.sendData(command)
      if (typeof response !== "string") {
        throw new Error("Dokku response not a string")
      }
      return JSON.parse(response)
    } catch (error: any) {
      throw new Error(`Failed to send command: ${error.message}`)
    }
  }

  async listApps(): Promise<string[]> {
    const response = await this.sendCommand("--quiet apps:list")
    return response.output.split("\n")
  }

  async getAppCreatedAt(appName: string): Promise<number> {
    const response = await this.sendCommand(
      `apps:report --app-created-at ${appName}`,
    )
    const createdAt = parseInt(response.output.trim(), 10)
    if (isNaN(createdAt)) {
      throw new Error(
        `Failed to retrieve creation timestamp for app ${appName}`,
      )
    }
    return createdAt
  }

  async appExists(appName: string): Promise<boolean> {
    const response = await this.sendCommand(`apps:exists ${appName}`)
    return response.output.includes("App") === false
  }
}
