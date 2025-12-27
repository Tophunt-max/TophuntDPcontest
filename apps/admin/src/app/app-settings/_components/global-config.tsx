"use client";

import InputGroup from "@/components/FormElements/InputGroup";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";

export function GlobalConfigForm({ settings, setSettings }: any) {
  return (
    <ShowcaseSection title="Global Configuration" className="!p-7">
      <div className="grid grid-cols-1 gap-5.5 sm:grid-cols-2">
        <InputGroup
          label="App Name"
          type="text"
          placeholder="e.g. TopHunt"
          value={settings.appName}
          handleChange={(e) => setSettings({...settings, appName: e.target.value})}
        />
        <InputGroup
          label="App Version"
          type="text"
          placeholder="e.g. 1.0.0"
          value={settings.appVersion}
          handleChange={(e) => setSettings({...settings, appVersion: e.target.value})}
        />
      </div>
      <div className="mt-5.5">
        <InputGroup
          label="Support Email"
          type="email"
          placeholder="support@example.com"
          value={settings.supportEmail}
          handleChange={(e) => setSettings({...settings, supportEmail: e.target.value})}
        />
      </div>
      
      <div className="mt-8 border-t border-stroke pt-6 dark:border-dark-3">
        <div className="flex items-center justify-between p-4 rounded-lg bg-gray-2 dark:bg-dark-2">
          <div>
            <p className="font-medium text-black dark:text-white">Maintenance Mode</p>
            <p className="text-xs text-gray-500">Block app access for users during updates.</p>
          </div>
          <div className="relative inline-block w-12 h-6 transition duration-200 ease-in-out bg-gray-300 rounded-full cursor-pointer">
              <input 
                type="checkbox" 
                checked={settings.maintenanceMode} 
                onChange={(e) => setSettings({...settings, maintenanceMode: e.target.checked})}
                className="sr-only" 
                id="maintenance-toggle"
              />
              <label 
                htmlFor="maintenance-toggle"
                className={`absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full transition-transform duration-200 ease-in-out ${settings.maintenanceMode ? 'translate-x-6 bg-primary' : 'bg-white'}`}
              ></label>
          </div>
        </div>
      </div>
    </ShowcaseSection>
  );
}
