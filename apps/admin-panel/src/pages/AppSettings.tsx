import { SettingsEditor } from "@/components/SettingsEditor";
import { api } from "@/lib/api";

export default function AppSettings() {
  return (
    <SettingsEditor
      title="App Settings"
      subtitle="Global app configuration (feature flags, banners, links, versions)"
      queryKey="app-settings"
      load={api.appSettings}
      save={api.saveAppSettings}
    />
  );
}
