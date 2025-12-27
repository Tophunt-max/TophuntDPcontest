import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { UsersTable } from "@/components/Tables/users-table";

import { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "User Management",
};

const TablesPage = () => {
  return (
    <>
      <Breadcrumb pageName="User Management" />

      <div className="space-y-10">
        <Suspense fallback={<div>Loading Users...</div>}>
          <UsersTable />
        </Suspense>
      </div>
    </>
  );
};

export default TablesPage;
