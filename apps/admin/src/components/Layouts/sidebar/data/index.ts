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
        icon: Icons.Box,
        items: [],
      },
      {
        title: "Contests",
        url: "/contests",
        icon: Icons.Calendar,
        items: [],
      },
      {
        title: "App Content",
        icon: Icons.Table,
        items: [
          { title: "User Reports", url: "/reports" },
          { title: "Support Tickets", url: "/support" },
        ]
      },
      {
        title: "App Settings",
        icon: Icons.Alphabet,
        items: [
          { title: "Global Config", url: "/app-settings" },
          { title: "Splash Screen", url: "/app-settings/splash" },
          { title: "Onboarding", url: "/app-settings/onboarding" },
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
