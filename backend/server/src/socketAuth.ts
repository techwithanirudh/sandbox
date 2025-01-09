// /backend/server/src/socketAuth.ts
import { Socket } from 'socket.io'
import { z } from 'zod'
import { Sandbox as DBSandbox, User } from './types'

export const socketAuth = async (socket: Socket, next: Function) => {
  const handshakeSchema = z.object({
    userId: z.string(),
    sandboxId: z.string(),
    EIO: z.string(),
    transport: z.string(),
  })

  const q = socket.handshake.query
  const parseQuery = handshakeSchema.safeParse(q)

  if (!parseQuery.success) {
    next(new Error('Invalid request.'))
    return
  }

  const { sandboxId, userId } = parseQuery.data

  // Fetch user data
  const dbUserRes = await fetch(`${process.env.DATABASE_WORKER_URL}/api/user?id=${userId}`, {
    headers: { Authorization: `${process.env.WORKERS_KEY}` }
  })
  const dbUser = (await dbUserRes.json()) as User

  // Fetch sandbox data
  const dbSandboxRes = await fetch(`${process.env.DATABASE_WORKER_URL}/api/sandbox?id=${sandboxId}`, {
    headers: { Authorization: `${process.env.WORKERS_KEY}` }
  })
  const dbSandbox = (await dbSandboxRes.json()) as DBSandbox

  if (!dbUser) {
    next(new Error('DB error.'))
    return
  }

  // Check ownership or shared access
  const ownSandbox = dbUser.sandbox.find(s => s.id === sandboxId)
  const shared = dbUser.usersToSandboxes.find(uts => uts.sandboxId === sandboxId)

  if (!ownSandbox && !shared) {
    next(new Error('Invalid credentials.'))
    return
  }

  socket.data = {
    userId,
    sandboxId,
    isOwner: Boolean(ownSandbox),
    type: dbSandbox.type
  }
  next()
}
