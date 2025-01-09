// /backend/server/src/utils.ts

export class LockManager {
  private locks: { [key: string]: Promise<any> } = {}

  async acquireLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (!this.locks[key]) {
      this.locks[key] = (async () => {
        try {
          return await task()
        } finally {
          delete this.locks[key]
        }
      })()
    }
    return this.locks[key]
  }
}
