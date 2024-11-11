import ProfilePage from "@/components/profile"
import ProfileNavbar from "@/components/profile/navbar"
import { Sandbox, User } from "@/lib/types"
import { currentUser } from "@clerk/nextjs"

export default async function Page({
  params: { username: rawUsername },
}: {
  params: { username: string }
}) {
  const username = decodeURIComponent(rawUsername).replace("@", "")
  const currentLoggedInUser = await currentUser()
  console.log(username)
  const [profileRespnse, dbUserResponse] = await Promise.all([
    fetch(
      `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/user?username=${username}`,
      {
        headers: {
          Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
        },
      }
    ),
    fetch(
      `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/user?id=${currentLoggedInUser?.id}`,
      {
        headers: {
          Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
        },
      }
    ),
  ])

  const userProfile = (await profileRespnse.json()) as User
  const dbUserData = (await dbUserResponse.json()) as User
  const publicSandboxes: Sandbox[] = []
  const privateSandboxes: Sandbox[] = []

  userProfile?.sandbox?.forEach((sandbox) => {
    if (sandbox.visibility === "public") {
      publicSandboxes.push(sandbox)
    } else if (sandbox.visibility === "private") {
      privateSandboxes.push(sandbox)
    }
  })
  const hasCurrentUser = Boolean(dbUserData?.id)
  return (
    <div className="">
      <ProfileNavbar userData={dbUserData} />
      <ProfilePage
        publicSandboxes={publicSandboxes}
        privateSandboxes={
          userProfile?.id === dbUserData.id ? privateSandboxes : []
        }
        user={userProfile}
        currentUser={hasCurrentUser ? dbUserData : null}
      />
    </div>
  )
}
