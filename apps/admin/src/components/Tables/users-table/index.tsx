import { getUsers } from "../fetch";
import { UsersTable as ClientUsersTable } from "./client-table";

export async function UsersTable() {
  const users = await getUsers();

  return <ClientUsersTable initialUsers={users} />;
}
