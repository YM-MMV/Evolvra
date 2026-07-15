import {
  Activity,
  Brain,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  CodeXml,
  Compass,
  GraduationCap,
  HeartPulse,
  Landmark,
  MessagesSquare,
  Palette,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  Activity,
  Brain,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  CodeXml,
  Compass,
  GraduationCap,
  HeartPulse,
  Landmark,
  MessagesSquare,
  Palette,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
};

export function DynamicIcon({ name, size = 18, ...props }: { name: string; size?: number; className?: string }) {
  const Icon = icons[name] ?? Compass;
  return <Icon size={size} {...props} />;
}

export const ICON_OPTIONS = Object.keys(icons);
