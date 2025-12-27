import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { getUserById, getUserPosts, getUserStories } from "@/components/Tables/fetch";
import { notFound } from "next/navigation";
import { UserContentTabs } from "./_components/user-content";
import { UserStatusActions } from "./_components/user-status-actions";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function UserDetailsPage({ params }: Props) {
  const { id } = await params;
  const user = await getUserById(id);

  if (!user) notFound();

  const [posts, stories] = await Promise.all([
    getUserPosts(id),
    getUserStories(id),
  ]);

  const avatarSrc = user.profileImageUrl || user.profilePicture || user.avatarUrl;

  return (
    <>
      <Breadcrumb pageName={`User Details / ${user.fullName || user.username}`} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 text-black dark:text-white">
        <div className="lg:col-span-1">
          <div className="rounded-[10px] bg-white p-6 shadow-1 dark:bg-gray-dark border border-stroke dark:border-dark-3">
            <div className="flex flex-col items-center text-center">
              <div className="h-24 w-24 overflow-hidden rounded-full border-4 border-primary bg-gray-100 flex items-center justify-center">
                {avatarSrc ? (
                  <img
                    src={avatarSrc}
                    alt="Avatar"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-3xl font-bold text-primary">{(user.fullName || "U").charAt(0)}</span>
                )}
              </div>
              <h3 className="mt-4 text-xl font-bold">{user.fullName || "Anonymous"}</h3>
              <p className="text-sm text-gray-500">@{user.username || "n/a"}</p>
            </div>

            <div className="mt-6 space-y-4 border-t border-stroke pt-6 dark:border-dark-3 text-sm">
              <div><p className="text-xs font-semibold uppercase text-gray-400">Email</p><p className="truncate">{user.email || "N/A"}</p></div>
              <div><p className="text-xs font-semibold uppercase text-gray-400">Phone</p><p>{user.phone || "N/A"}</p></div>
              <div><p className="text-xs font-semibold uppercase text-gray-400">Gender</p><p className="capitalize">{user.gender || "N/A"}</p></div>
              <div><p className="text-xs font-semibold uppercase text-gray-400">Joined</p><p>{user.createdAt ? user.createdAt.split('T')[0] : "N/A"}</p></div>
            </div>

            <UserStatusActions userId={id} initialIsBlocked={!!user.isBlocked} />
          </div>
        </div>

        <div className="lg:col-span-2">
          <UserContentTabs initialPosts={posts} initialStories={stories} />
        </div>
      </div>
    </>
  );
}
