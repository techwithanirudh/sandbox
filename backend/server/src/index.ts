// /backend/server/src/index.ts
import cors from 'cors'
import dotenv from 'dotenv'
import express, { Express } from 'express'
import fs from 'fs'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import { ConnectionManager } from './ConnectionManager'
import { DokkuClient } from './DokkuClient'
import { Sandbox } from './Sandbox'
import { SecureGitClient } from './SecureGitClient'
import { socketAuth } from './socketAuth'
import { TFile, TFolder } from './types'

// Error handling
export const handleErrors = (message: string, error: any, socket: Socket) => {
  console.error(message, error)
  socket.emit("error", `${message} ${error.message ?? error}`)
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", promise, reason)
})

// Set up
dotenv.config()
const app: Express = express()
const port = process.env.PORT || 4000
app.use(cors())
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

// Connection manager
const connections = new ConnectionManager()
const sandboxes: Record<string, Sandbox> = {}

// Optional: Dokku & Git
const dokkuClient = (process.env.DOKKU_HOST && process.env.DOKKU_KEY && process.env.DOKKU_USERNAME)
  ? new DokkuClient({
      host: process.env.DOKKU_HOST,
      username: process.env.DOKKU_USERNAME,
      privateKey: fs.readFileSync(process.env.DOKKU_KEY),
    })
  : null

dokkuClient?.connect().catch(err => {
  console.error('[index] Failed to connect Dokku client:', err)
})

const gitClient = (process.env.DOKKU_HOST && process.env.DOKKU_KEY)
  ? new SecureGitClient(`dokku@${process.env.DOKKU_HOST}`, process.env.DOKKU_KEY)
  : null

// Socket auth
io.use(socketAuth)

// On connection
io.on("connection", async (socket) => {
  try {
    const data = socket.data as {
      userId: string
      sandboxId: string
      isOwner: boolean
      type: string
    }

    console.log(`[index] User ${data.userId} connected to sandbox ${data.sandboxId} as owner? ${data.isOwner}`)

    connections.addConnectionForSandbox(socket, data.sandboxId, data.isOwner)

    if (!data.isOwner && !connections.ownerIsConnected(data.sandboxId)) {
      console.log(`[index] Non-owner tried to connect, but owner not present. Disabling access.`)
      socket.emit("disableAccess", "Sandbox owner not connected.")
      return
    }

    // Create or reuse sandbox
    let sandbox = sandboxes[data.sandboxId]
    if (!sandbox) {
      sandbox = new Sandbox(data.sandboxId, data.type, {
        dokkuClient,
        gitClient
      })
      sandboxes[data.sandboxId] = sandbox
      console.log(`[index] Created new Sandbox for ${data.sandboxId}`)
    }

    // Callback to notify all sockets about file changes
    const sendFileNotifications = (files: (TFolder | TFile)[]) => {
      connections.connectionsForSandbox(data.sandboxId).forEach((connSocket: Socket) => {
        connSocket.emit('loaded', files)
      })
    }

    // Initialize
    await sandbox.initialize(sendFileNotifications)
    socket.emit('loaded', sandbox.fileManager?.files)
    socket.emit('ready')

    // Register event handlers
    const handlers = sandbox.handlers({ userId: data.userId, isOwner: data.isOwner, socket })
    Object.entries(handlers).forEach(([event, fn]) => {
      socket.on(event, async (options: any, callback?: (resp: any) => void) => {
        try {
          const result = await fn(options)
          callback?.(result)
        } catch (e: any) {
          handleErrors(`Error in event "${event}": `, e, socket)
        }
      })
    })

    // On disconnect
    socket.on("disconnect", async () => {
      console.log(`[index] User ${data.userId} disconnected from ${data.sandboxId}`)
      connections.removeConnectionForSandbox(socket, data.sandboxId, data.isOwner)

      // If the owner is gone, close the sandbox
      if (data.isOwner && !connections.ownerIsConnected(data.sandboxId)) {
        console.log(`[index] Owner disconnected from sandbox ${data.sandboxId}. Cleaning up.`)
        await sandbox.disconnect()
        delete sandboxes[data.sandboxId]
        socket.broadcast.emit("disableAccess", "Owner disconnected.")
      }
    })
  } catch (err: any) {
    handleErrors("[index] Error connecting:", err, socket)
  }
})

httpServer.listen(port, () => {
  console.log(`[index] Server running on port ${port}`)
})
