"use client";
import { useState, useEffect } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { toast } from "react-hot-toast";

interface Badge {
  level: number;
  name: string;
  icon: string;
}

const RewardsManagement = () => {
  const [settings, setSettings] = useState({
    xpThreshold: 500,
    xpIncrement: 500,
    dailyLoginReward: 10,
    contestJoinReward: 50,
    matchWinReward: 100,
    badges: [] as Badge[],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/rewards");
      const data = await res.json();
      if (data && !data.error) {
        setSettings({
            ...settings,
            ...data,
            badges: data.badges || []
        });
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/rewards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        toast.success("Settings saved successfully!");
      } else {
        toast.error("Failed to save settings.");
      }
    } catch (error) {
      toast.error("Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  const addBadge = () => {
    setSettings({
      ...settings,
      badges: [...settings.badges, { level: 1, name: "", icon: "🏅" }]
    });
  };

  const removeBadge = (index: number) => {
    const newBadges = settings.badges.filter((_, i) => i !== index);
    setSettings({ ...settings, badges: newBadges });
  };

  const updateBadge = (index: number, field: keyof Badge, value: string | number) => {
    const newBadges = [...settings.badges];
    newBadges[index] = { ...newBadges[index], [field]: value };
    setSettings({ ...settings, badges: newBadges });
  };

  if (loading) return (
    <DefaultLayout>
        <div className="flex h-screen items-center justify-center">
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-solid border-primary border-t-transparent"></div>
        </div>
    </DefaultLayout>
  );

  return (
    <DefaultLayout>
      <div className="mx-auto max-w-270">
        <Breadcrumb pageName="Rewards Management" />

        <form onSubmit={handleSave} className="grid grid-cols-1 gap-8">
          {/* XP & Coins Section */}
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
                <div className="border-b border-stroke px-7 py-4 dark:border-strokedark">
                    <h3 className="font-medium text-black dark:text-white">XP Level Thresholds</h3>
                </div>
                <div className="p-7">
                    <div className="mb-4">
                        <label className="mb-3 block text-sm font-medium text-black dark:text-white">Base XP for Level 2</label>
                        <input className="w-full rounded border border-stroke bg-gray px-4.5 py-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="number" value={settings.xpThreshold} onChange={(e) => setSettings({ ...settings, xpThreshold: parseInt(e.target.value) })} />
                    </div>
                    <div>
                        <label className="mb-3 block text-sm font-medium text-black dark:text-white">XP Increment per Level</label>
                        <input className="w-full rounded border border-stroke bg-gray px-4.5 py-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="number" value={settings.xpIncrement} onChange={(e) => setSettings({ ...settings, xpIncrement: parseInt(e.target.value) })} />
                    </div>
                </div>
            </div>

            <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
                <div className="border-b border-stroke px-7 py-4 dark:border-strokedark">
                    <h3 className="font-medium text-black dark:text-white">Coin Rewards</h3>
                </div>
                <div className="p-7">
                    <div className="mb-4">
                        <label className="mb-3 block text-sm font-medium text-black dark:text-white">Daily Login</label>
                        <input className="w-full rounded border border-stroke bg-gray px-4.5 py-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="number" value={settings.dailyLoginReward} onChange={(e) => setSettings({ ...settings, dailyLoginReward: parseInt(e.target.value) })} />
                    </div>
                    <div>
                        <label className="mb-3 block text-sm font-medium text-black dark:text-white">Contest Win</label>
                        <input className="w-full rounded border border-stroke bg-gray px-4.5 py-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="number" value={settings.matchWinReward} onChange={(e) => setSettings({ ...settings, matchWinReward: parseInt(e.target.value) })} />
                    </div>
                </div>
            </div>
          </div>

          {/* Badges Section */}
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="flex items-center justify-between border-b border-stroke px-7 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white">Level Badges</h3>
              <button type="button" onClick={addBadge} className="text-sm font-medium text-primary hover:underline">+ Add Badge</button>
            </div>
            <div className="p-7">
              {settings.badges.map((badge, index) => (
                <div key={index} className="mb-4 flex flex-wrap items-end gap-4 rounded-lg border border-stroke p-4 dark:border-strokedark">
                  <div className="flex-1 min-w-[100px]">
                    <label className="mb-2 block text-xs font-medium uppercase">Level</label>
                    <input className="w-full rounded border border-stroke bg-gray py-2 px-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="number" value={badge.level} onChange={(e) => updateBadge(index, 'level', parseInt(e.target.value))} />
                  </div>
                  <div className="flex-[2] min-w-[150px]">
                    <label className="mb-2 block text-xs font-medium uppercase">Badge Name</label>
                    <input className="w-full rounded border border-stroke bg-gray py-2 px-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="text" placeholder="e.g. Bronze Warrior" value={badge.name} onChange={(e) => updateBadge(index, 'name', e.target.value)} />
                  </div>
                  <div className="flex-1 min-w-[80px]">
                    <label className="mb-2 block text-xs font-medium uppercase">Icon</label>
                    <input className="w-full rounded border border-stroke bg-gray py-2 px-3 text-black dark:border-strokedark dark:bg-meta-4 dark:text-white" type="text" placeholder="🏆" value={badge.icon} onChange={(e) => updateBadge(index, 'icon', e.target.value)} />
                  </div>
                  <button type="button" onClick={() => removeBadge(index)} className="pb-2 text-danger hover:text-opacity-80">
                    Remove
                  </button>
                </div>
              ))}
              {settings.badges.length === 0 && (
                <p className="text-center text-sm text-body">No badges defined yet.</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-4.5">
            <button disabled={saving} className="flex justify-center rounded bg-primary px-10 py-3 font-medium text-gray hover:bg-opacity-90 disabled:bg-opacity-50" type="submit">
              {saving ? "Saving..." : "Save All Settings"}
            </button>
          </div>
        </form>
      </div>
    </DefaultLayout>
  );
};

export default RewardsManagement;
