import { getStories } from "../fetch";
import { StoriesTable as ClientStoriesTable } from "./client-table";

export async function StoriesTable() {
  const stories = await getStories();
  return <ClientStoriesTable initialStories={stories} />;
}
