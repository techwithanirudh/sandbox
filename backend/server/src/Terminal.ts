// /backend/server/src/Terminal.ts
import Docker, { Container, Exec } from 'dockerode'
import { Duplex } from 'stream'

export class Terminal {
  private container: Container
  private execId: string | null = null
  private stream: Duplex | null = null
  private onDataCallback?: (chunk: string) => void

  constructor(container: Container) {
    this.container = container
  }

  async init({ cols = 80, rows = 24, onData }: {
    cols?: number
    rows?: number
    onData: (data: string) => void
  }) {
    this.onDataCallback = onData
    const exec = await this.container.exec({
      Cmd: ['/bin/bash'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true
    })
    this.execId = exec.id

    const stream = await exec.start({ hijack: true, stdin: true })
    this.stream = stream as Duplex

    this.stream.on('data', (chunk: Buffer) => {
      onData(chunk.toString('utf-8'))
    })
    this.stream.on('error', (err) => {
      console.error('[Terminal] stream error:', err)
    })

    // Attempt resize
    await this.resize(cols, rows)

    // Some initial commands
    this.write(`cd /workspace/data\r`)
    this.write(`clear\r`)
  }

  write(data: string) {
    if (!this.stream) return
    this.stream.write(data)
  }

  async resize(cols: number, rows: number) {
    if (!this.execId) return
    try {
    //   const exec = this.container.exec({ Id: this.execId })
    //   await exec.resize({ w: cols, h: rows })
    } catch (err) {
      console.error('[Terminal] Resize error:', err)
    }
  }

  async close() {
    if (this.stream) {
      this.write('exit\r')
      this.stream.end()
    }
    this.stream = null
    this.execId = null
  }
}
