import * as Icons from "../icons";

export const NAV_DATA = [
  {
    label: "MAIN MENU",
    items: [
      {
        title: "User Management",
        url: "/tables",
        icon: Icons.User,
        items: [],
      },
      {
        title: "Rewards Management",
        url: "/rewards",
        icon: Icons.FourCircle,
        items: [],
      },
      {
        title: "Contests",
        icon: Icons.Calendar,
        items: [
          { title: "Manage Contests", url: "/contests" },
          { title: "Vote Monitoring", url: "/contests/monitoring" },
          { title: "Prize Claims", url: "/contests/prizes" },
        ],
      },
      {
        title: "App Content",
        icon: Icons.Table,
        items: [
          { title: "Push Notifications", url: "/notifications" },
          { title: "User Reports", url: "/reports" },
          { title: "Support Tickets", url: "/support" },
        ]
      },
      {
        title: "App Settings",
        icon: Icons.Alphabet,
        items: [
          { title: "Global Config", url: "/app-settings" },
          { title: "Banner Settings", url: "/app-settings/banners" },
          { title: "Reward Settings", url: "/app-settings/rewards" },
          { title: "Legal Content", url: "/app-settings/legal" },
          { title: "App Design", url: "/app-settings/design" },
          { title: "Authentication", url: "/app-settings/auth" },
          { title: "Android Settings", url: "/app-settings/android" },
          { title: "iOS Settings", url: "/app-settings/ios" },
        ],
      },
      {
        title: "Admin Profile",
        url: "/profile",
        icon: Icons.User,
        items: [],
      },
    ],
  },
];
