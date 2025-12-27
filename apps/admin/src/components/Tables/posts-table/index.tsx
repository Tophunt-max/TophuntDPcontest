import { getPosts } from "../fetch";
import { PostsTable as ClientPostsTable } from "./client-table";

export async function PostsTable() {
  const posts = await getPosts();
  return <ClientPostsTable initialPosts={posts} />;
}
