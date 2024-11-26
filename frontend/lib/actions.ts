"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

export async function createSandbox(body: {
  type: string
  name: string
  userId: string
  visibility: string
}) {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
      body: JSON.stringify(body),
    }
  )

  return await res.text()
}

export async function updateSandbox(body: {
  id: string
  name?: string
  visibility?: "public" | "private"
}) {
  await fetch(`${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
    },
    body: JSON.stringify(body),
  })

  revalidatePath("/dashboard")
}

export async function deleteSandbox(id: string) {
  await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox?id=${id}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
    }
  )

  revalidatePath("/dashboard")
}

export async function shareSandbox(sandboxId: string, email: string) {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox/share`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
      body: JSON.stringify({ sandboxId, email }),
    }
  )
  const text = await res.text()

  if (res.status !== 200) {
    return { success: false, message: text }
  }

  revalidatePath(`/code/${sandboxId}`)
  return { success: true, message: "Shared successfully." }
}

export async function unshareSandbox(sandboxId: string, userId: string) {
  await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox/share`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
      body: JSON.stringify({ sandboxId, userId }),
    }
  )

  revalidatePath(`/code/${sandboxId}`)
}

export async function toggleLike(sandboxId: string, userId: string) {
  await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox/like`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
      body: JSON.stringify({ sandboxId, userId }),
    }
  )
  revalidatePath(`/[username]`, "page")
  revalidatePath(`/dashboard`, "page")
}

const UpdateErrorSchema = z.object({
  error: z
    .union([
      z.string(),
      z.array(
        z.object({
          path: z.array(z.string()),
          message: z.string(),
        })
      ),
    ])
    .optional(),
})

export async function updateUser(prevState: any, formData: FormData) {
  const data = Object.fromEntries(formData)

  const schema = z.object({
    id: z.string(),
    username: z.string(),
    oldUsername: z.string(),
    name: z.string(),
  })
  console.log(data)

  try {
    const validatedData = schema.parse(data)

    const changedUsername = validatedData.username !== validatedData.oldUsername
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/user`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
        },
        body: JSON.stringify({
          id: validatedData.id,
          username: data.username ?? undefined,
          name: data.name ?? undefined,
        }),
      }
    )

    const responseData = await res.json()

    // Validate the response using our error schema
    const parseResult = UpdateErrorSchema.safeParse(responseData)

    if (!parseResult.success) {
      return { error: "Unexpected error occurred" }
    }

    if (parseResult.data.error) {
      return parseResult.data
    }

    if (changedUsername) {
      const newRoute = `/@${validatedData.username}`
      return { message: "Successfully updated", newRoute }
    }
    revalidatePath(`/[username]`, "page")
    return { message: "Successfully updated" }
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.log(error)
      return {
        error: error.errors?.[0].message,
      }
    }

    return { error: "An unexpected error occurred" }
  }
}
