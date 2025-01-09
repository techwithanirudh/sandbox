// import { Room } from "@/components/editor/live/room"
import Loading from "@/components/editor/loading"
import Navbar from "@/components/editor/navbar"
import { TerminalProvider } from "@/context/TerminalContext"
import { Sandbox, User, UsersToSandboxes } from "@/lib/types"
import { currentUser } from "@clerk/nextjs"
import dynamic from "next/dynamic"
import { notFound, redirect } from "next/navigation"

export const revalidate = 0

const getUserData = async (id: string) => {
  const userRes = await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/user?id=${id}`,
    {
      headers: {
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
    }
  )
  const userData: User = await userRes.json()
  return userData
}

const getSandboxData = async (id: string) => {
  const sandboxRes = await fetch(
    `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/sandbox?id=${id}`,
    {
      headers: {
        Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
      },
    }
  )
  const sandboxData: Sandbox = await sandboxRes.json()
  return sandboxData
}

const getSharedUsers = async (usersToSandboxes: UsersToSandboxes[]) => {
  if (!usersToSandboxes) {
    return []
  }

  const shared = await Promise.all(
    usersToSandboxes.map(async (user) => {
      const userRes = await fetch(
        `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/user?id=${user.userId}`,
        {
          headers: {
            Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
          },
        }
      )
      const userData: User = await userRes.json()
      return {
        id: userData.id,
        name: userData.name,
        avatarUrl: userData.avatarUrl,
      }
    })
  )

  return shared
}

const CodeEditor = dynamic(() => import("@/components/editor"), {
  ssr: false,
  loading: () => <Loading />,
})

export default async function CodePage({ params }: { params: { id: string } }) {
  const user = await currentUser()
  const sandboxId = params.id

  if (!user) {
    redirect("/")
  }

  const userData = await getUserData(user.id)
  const sandboxData = await getSandboxData(sandboxId)
  const shared = await getSharedUsers(sandboxData.usersToSandboxes)

  const isOwner = sandboxData.userId === user.id
  const isSharedUser = shared.some((uts) => uts.id === user.id)

  if (!isOwner && !isSharedUser) {
    return notFound()
  }

  if (isSharedUser && sandboxData.visibility === "private") {
    return notFound()
  }

  return (
    <TerminalProvider>
      {/* <Room id={sandboxId}> */}
      <div className="overflow-hidden overscroll-none w-screen h-screen grid [grid-template-rows:3.5rem_auto] bg-background">
        <Navbar
          userData={userData}
          sandboxData={sandboxData}
          shared={shared as { id: string; name: string; avatarUrl: string }[]}
        />
        <CodeEditor userData={userData} sandboxData={sandboxData} />
      </div>
      {/* </Room> */}
    </TerminalProvider>
  )
}
