const variants: Record<string, string> = {
  default: 'bg-secondary text-secondary-foreground',
  primary: 'bg-violet-100 text-violet-700',
  success: 'bg-green-100 text-green-700',
  warning: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
  info: 'bg-blue-100 text-blue-700',
  host: 'bg-purple-100 text-purple-700',
  admin: 'bg-rose-100 text-rose-700',
  user: 'bg-slate-100 text-slate-600',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  paid: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
  ringing: 'bg-blue-100 text-blue-700',
  ended: 'bg-slate-100 text-slate-600',
  missed: 'bg-red-100 text-red-700',
  cancelled: 'bg-amber-100 text-amber-700',
  audio: 'bg-violet-100 text-violet-700',
  video: 'bg-cyan-100 text-cyan-700',
  reviewed: 'bg-blue-100 text-blue-700',
  dismissed: 'bg-slate-100 text-slate-600',
  banned: 'bg-red-100 text-red-700',
  actioned: 'bg-orange-100 text-orange-700',
};

export function Badge({ variant = 'default', children }: { variant?: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${variants[variant] || variants.default}`}>
      {children}
    </span>
  );
}
