import { useStrings } from "../i18n";
import { IconChevronRight } from "../ui/icons";

/** Shared label for every overview card's drill-down action. */
export function WidgetActionLabel() {
  const s = useStrings();
  return (
    <>
      {s.pulse.diagLink}
      <IconChevronRight className="h-3.5 w-3.5" />
    </>
  );
}
