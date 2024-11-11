"use client"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MAX_FREE_GENERATION } from "@/lib/constant"
import { User } from "@/lib/types"
import { useClerk } from "@clerk/nextjs"
import {
  LayoutDashboard,
  LogOut,
  Sparkles,
  User as UserIcon,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import Avatar from "./avatar"

export default function UserButton({ userData }: { userData: User }) {
  if (!userData) return null

  const { signOut } = useClerk()
  const router = useRouter()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Avatar name={userData.name} avatarUrl={userData.avatarUrl} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48" align="end">
        <div className="py-1.5 px-2 w-full">
          <div className="font-medium">{userData.name}</div>
          <div className="text-sm w-full overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
            {userData.email}
          </div>
        </div>

        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Sparkles className="size-4 mr-2 text-indigo-500" />
          <div className="w-full flex flex-col items-start text-sm">
            <span className="text-sm">{`AI Usage: ${userData.generations}/${MAX_FREE_GENERATION}`}</span>
            <div className="rounded-full w-full mt-1 h-1.5 overflow-hidden bg-secondary border border-muted-foreground">
              <div
                className="h-full bg-indigo-500 rounded-full"
                style={{
                  width: `${(userData.generations * 100) / 1000}%`,
                }}
              />
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" asChild>
          <Link href={"/dashboard"}>
            <LayoutDashboard className="mr-2 size-4" />
            <span>Dashboard</span>
            <DropdownMenuSeparator />
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" asChild>
          <Link href={`/@${userData.username}`}>
            <UserIcon className="mr-2 size-4" />
            <span>Profile</span>
            <DropdownMenuSeparator />
          </Link>
        </DropdownMenuItem>
        {/* <DropdownMenuItem className="cursor-pointer">
          <Pencil className="mr-2 size-4" />
          <span>Edit Profile</span>
        </DropdownMenuItem> */}
        <DropdownMenuItem
          onClick={() => signOut(() => router.push("/"))}
          className="!text-destructive cursor-pointer"
        >
          <LogOut className="mr-2 size-4" />
          <span>Log Out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
