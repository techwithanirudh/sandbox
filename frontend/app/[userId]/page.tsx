import Logo from "@/assets/logo.svg"
import ProfilePage from "@/components/profile"
import { ThemeSwitcher } from "@/components/ui/theme-switcher"
import UserButton from "@/components/ui/userButton"
import { Sandbox, User } from "@/lib/types"
import { currentUser } from "@clerk/nextjs"
import Image from "next/image"
import Link from "next/link"

export default async function Page({
  params: { userId },
}: {
  params: { userId: string }
}) {
  const [userRes, user] = await Promise.all([
    fetch(
      `${process.env.NEXT_PUBLIC_DATABASE_WORKER_URL}/api/user?id=${userId}`,
      {
        headers: {
          Authorization: `${process.env.NEXT_PUBLIC_WORKERS_KEY}`,
        },
      }
    ),
    currentUser(),
  ])

  const userData = (await userRes.json()) as User
  const publicSandboxes: Sandbox[] = []
  const privateSandboxes: Sandbox[] = []

  userData.sandbox.forEach((sandbox) => {
    if (sandbox.visibility === "public") {
      publicSandboxes.push(sandbox)
    } else if (sandbox.visibility === "private") {
      privateSandboxes.push(sandbox)
    }
  })

  return (
    <div className="">
      <div className=" py-3 px-4 w-full flex items-center justify-between border-b border-border">
        <div className="flex items-center space-x-4">
          <Link
            href="/"
            className="ring-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none rounded-sm"
          >
            <Image src={Logo} alt="Logo" width={36} height={36} />
          </Link>
          <div className="text-sm font-medium flex items-center">Sandbox</div>
        </div>
        <div className="flex items-center space-x-4">
          <ThemeSwitcher />
          {Boolean(userData) ? <UserButton userData={userData!} /> : null}
        </div>
      </div>
      <ProfilePage
        {...{
          publicSandboxes,
          privateSandboxes: user?.id === userId ? privateSandboxes : [],
          user: userData,
          currentUser: user
            ? {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
              }
            : null,
        }}
      />
    </div>
  )
}
