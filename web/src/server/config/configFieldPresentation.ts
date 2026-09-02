import type { ComponentType, SVGProps } from "react";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import {
  IconActivity,
  IconClock,
  IconDevice,
  IconGlobe,
  IconLink,
  IconMore,
  IconPulse,
  IconShield,
  IconSwap,
} from "../../ui/icons";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const CONFIG_GROUP_ICONS: Record<string, Icon> = {
  routing: IconSwap,
  me: IconActivity,
  upstreams: IconLink,
  tls: IconShield,
  listeners: IconDevice,
  web: IconGlobe,
  timeouts: IconClock,
  observability: IconPulse,
  links: IconPulse,
  diagnostics: IconMore,
};

export function configFieldLabel(
  field: TelemtConfigField,
  labels: Record<string, string>,
): string {
  const normalized = field.path.replaceAll("[]", "");
  if (labels[normalized]) return labels[normalized];
  const leaf = normalized.split(".").at(-1) ?? normalized;
  const label = leaf.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function configFieldDescription(
  field: TelemtConfigField,
  copy: { restart: string; conditional: string; reload: string },
): string {
  const consequence = field.apply.includes("restart")
    ? copy.restart
    : field.apply.includes("conditional")
      ? copy.conditional
      : copy.reload;
  return `${field.data_type} · default: ${field.default_value} · ${consequence}`;
}
