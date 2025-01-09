// /backend/server/src/DockerManager.ts
import Docker, { Container, ContainerCreateOptions } from 'dockerode'
import { once } from 'events'

export class DockerManager {
  private docker: Docker
  private containers: Map<string, Container> = new Map()

  constructor(dockerConfig?: Docker.DockerOptions) {
    this.docker = new Docker(dockerConfig || { socketPath: '/var/run/docker.sock' })
  }

  /**
   * Pull an image if needed (optional).
   */
  public async pullImage(imageName: string) {
    console.log(`[DockerManager] Pulling image: ${imageName}`)
    const stream = await this.docker.pull(imageName)
    await once(stream, 'end')
    console.log(`[DockerManager] Finished pulling image: ${imageName}`)
  }

  /**
   * Create or recreate container. Also auto-starts it by default.
   */
  public async createContainer(
    id: string,
    options: ContainerCreateOptions,
    autoStart = true
  ): Promise<Container> {
    // Remove old container with same ID
    const old = this.containers.get(id)
    if (old) {
      try {
        await old.remove({ force: true })
      } catch {}
      this.containers.delete(id)
    }

    const container = await this.docker.createContainer(options)
    if (autoStart) {
      await container.start()
    }
    this.containers.set(id, container)
    return container
  }

  /**
   * Get container reference if we have it in memory.
   */
  public getContainer(id: string): Container | undefined {
    return this.containers.get(id)
  }

  /**
   * Stop & remove container from Docker and from map
   */
  public async removeContainer(id: string) {
    const container = this.containers.get(id)
    if (!container) return

    try {
      const info = await container.inspect()
      if (info.State.Running) {
        await container.stop()
      }
      await container.remove({ force: true })
      this.containers.delete(id)
    } catch (err) {
      console.error('[DockerManager] Error removing container:', err)
    }
  }
}
