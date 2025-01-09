// /backend/server/src/TerminalManager.ts
import { Container } from 'dockerode'
import { Terminal } from './Terminal'

export class TerminalManager {
  private container: Container
  private terminals: Record<string, Terminal> = {}

  constructor(container: Container) {
    this.container = container
  }

  async createTerminal(
    id: string,
    onData: (data: string) => void,
    cols = 80,
    rows = 24
  ) {
    if (this.terminals[id]) {
      console.log(`[TerminalManager] Terminal ${id} already exists`)
      return
    }
    const term = new Terminal(this.container)
    await term.init({ cols, rows, onData })
    this.terminals[id] = term
  }

  async sendTerminalData(id: string, data: string) {
    if (!this.terminals[id]) return
    this.terminals[id].write(data)
  }

  async resizeTerminal(id: string, size: { cols: number; rows: number }) {
    if (!this.terminals[id]) return
    await this.terminals[id].resize(size.cols, size.rows)
  }

  async closeTerminal(id: string) {
    if (!this.terminals[id]) return
    await this.terminals[id].close()
    delete this.terminals[id]
  }

  async closeAllTerminals() {
    for (const id of Object.keys(this.terminals)) {
      await this.closeTerminal(id)
    }
  }
}
