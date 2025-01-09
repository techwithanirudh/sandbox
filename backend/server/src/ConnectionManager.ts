// /backend/server/src/ConnectionManager.ts
import { Socket } from "socket.io"

class Counter {
  private count: number = 0
  increment() {
    this.count++
  }
  decrement() {
    this.count = Math.max(0, this.count - 1)
  }
  getValue() {
    return this.count
  }
}

export class ConnectionManager {
  private ownerConnections: Record<string, Counter> = {}
  private sockets: Record<string, Set<Socket>> = {}

  ownerIsConnected(sandboxId: string): boolean {
    return this.ownerConnections[sandboxId]?.getValue() > 0
  }

  addConnectionForSandbox(socket: Socket, sandboxId: string, isOwner: boolean) {
    this.sockets[sandboxId] ??= new Set()
    this.sockets[sandboxId].add(socket)
    if (isOwner) {
      this.ownerConnections[sandboxId] ??= new Counter()
      this.ownerConnections[sandboxId].increment()
    }
  }

  removeConnectionForSandbox(
    socket: Socket,
    sandboxId: string,
    isOwner: boolean,
  ) {
    this.sockets[sandboxId]?.delete(socket)
    if (isOwner) {
      this.ownerConnections[sandboxId]?.decrement()
    }
  }

  connectionsForSandbox(sandboxId: string): Set<Socket> {
    return this.sockets[sandboxId] ?? new Set()
  }
}
