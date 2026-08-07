import { LucideIcon, TrendingUp, TrendingDown } from 'lucide-react';

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  gradient: string;
  change?: number;
  unit?: string;
}

export function StatCard({ icon: Icon, label, value, gradient, change, unit }: StatCardProps) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className={`w-12 h-12 rounded-xl ${gradient} flex items-center justify-center shadow-lg`}>
          <Icon size={22} className="text-white" />
        </div>
        {change !== undefined && (
          <div className={`flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg ${
            change >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'
          }`}>
            {change >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(change)}%
          </div>
        )}
      </div>
      <div>
        <p className="text-2xl font-bold text-foreground">{value ?? '–'}{unit && <span className="text-sm font-medium text-muted-foreground ml-1">{unit}</span>}</p>
        <p className="text-sm text-muted-foreground mt-0.5">{label}</p>
      </div>
    </div>
  );
}
