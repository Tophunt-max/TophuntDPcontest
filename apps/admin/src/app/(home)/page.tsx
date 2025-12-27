import { PaymentsOverview } from "@/components/Charts/payments-overview";
import { UsedDevices } from "@/components/Charts/used-devices";
import { createTimeFrameExtractor } from "@/utils/timeframe-extractor";
import { Suspense } from "react";
import { ChatsCard } from "./_components/chats-card";
import { OverviewCardsGroup } from "./_components/overview-cards";
import { OverviewCardsSkeleton } from "./_components/overview-cards/skeleton";
import { getUserGrowthData, getDeviceStats } from "./fetch";
import { DonutChart } from "@/components/Charts/used-devices/chart";

type PropsType = {
  searchParams: Promise<{
    selected_time_frame?: string;
  }>;
};

export default async function Home({ searchParams }: PropsType) {
  const { selected_time_frame } = await searchParams;
  const extractTimeFrame = createTimeFrameExtractor(selected_time_frame);
  
  const [growthData, deviceStats] = await Promise.all([
    getUserGrowthData(),
    getDeviceStats()
  ]);

  return (
    <>
      <Suspense fallback={<OverviewCardsSkeleton />}>
        <OverviewCardsGroup />
      </Suspense>

      <div className="mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6 2xl:mt-9 2xl:gap-7.5">
        
        {/* User Growth Chart */}
        <div className="col-span-12 rounded-[10px] bg-white p-7.5 shadow-1 dark:bg-gray-dark border border-stroke dark:border-dark-3">
            <h2 className="text-xl font-bold text-black dark:text-white mb-4">User Growth (Last 7 Months)</h2>
            <div className="h-[250px] flex items-end gap-2 px-4">
                {growthData.data.map((count, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-2 group">
                        <div 
                            className="w-full bg-primary rounded-t-md transition-all group-hover:bg-opacity-80 relative"
                            style={{ height: `${Math.max((count / (Math.max(...growthData.data) || 1)) * 200, 5)}px` }}
                        >
                            <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                                {count} users
                            </span>
                        </div>
                        <span className="text-[10px] text-gray-500 uppercase">{growthData.categories[i]}</span>
                    </div>
                ))}
            </div>
        </div>

        {/* Used Devices Real Data */}
        <div className="col-span-12 xl:col-span-6 rounded-[10px] bg-white p-7.5 shadow-1 dark:bg-gray-dark border border-stroke dark:border-dark-3">
            <h2 className="text-xl font-bold text-black dark:text-white mb-9">Used Devices</h2>
            <div className="grid place-items-center">
                <DonutChart data={deviceStats} />
            </div>
            <div className="mt-8 flex justify-center gap-6 text-sm">
                <div className="flex items-center gap-2"><div className="size-3 rounded-full bg-[#5750F1]"></div><span>Web</span></div>
                <div className="flex items-center gap-2"><div className="size-3 rounded-full bg-[#5475E5]"></div><span>Mobile</span></div>
                <div className="flex items-center gap-2"><div className="size-3 rounded-full bg-[#8099EC]"></div><span>Other</span></div>
            </div>
        </div>

        <Suspense fallback={null}>
          <div className="col-span-12 xl:col-span-6">
            <ChatsCard />
          </div>
        </Suspense>
      </div>
    </>
  );
}
