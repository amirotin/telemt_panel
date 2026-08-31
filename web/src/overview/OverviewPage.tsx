import { useStrings } from "../i18n";
import { HealthHero } from "../pulse/widgets/HealthHero";
import { StatRow } from "../pulse/widgets/StatRow";
import { Problems } from "../pulse/widgets/Problems";
import { DcWidget } from "../pulse/widgets/DcWidget";
import { MePoolWidget } from "../pulse/widgets/MePoolWidget";
import { UpstreamsWidget } from "../pulse/widgets/UpstreamsWidget";
import { OnlineNow } from "../pulse/widgets/OnlineNow";
import { RecentEventsWidget } from "../pulse/widgets/RecentEventsWidget";
import { QuotasWidget } from "../pulse/widgets/QuotasWidget";

const CONTENT_MAX = "mx-auto w-full max-w-[1440px]";

// Overview is deliberately fixed. An operator console benefits from stable
// positions and muscle memory; a linear user-defined list could not preserve
// the pairs and proportions of this twelve-column layout, and allowed critical
// operational sections to be hidden altogether.
export function OverviewPage() {
  const s = useStrings();
  return (
    <div className={`${CONTENT_MAX} flex flex-col gap-4 lg:gap-5`}>
      <h1 className="text-page-title font-bold text-text">{s.overview.title}</h1>

      <HealthHero />
      <StatRow />

      {/* The operator workspace has one primary scan column and a dedicated
          event rail. Below xl the rail rejoins the content so tablet and
          phone widths never squeeze operational cards into empty slivers. */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-12 xl:gap-5">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-9 xl:gap-5">
          <Problems />
          <DcWidget />

          <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:gap-5 [&>*]:h-full">
            <MePoolWidget />
            <UpstreamsWidget />
          </div>

          <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-1 xl:gap-5 [&>*]:h-full">
            <OnlineNow />
            <div className="xl:hidden">
              <RecentEventsWidget />
            </div>
          </div>

          {/* QuotasWidget removes itself in the normal state. */}
          <QuotasWidget />
        </div>

        <aside
          aria-label={s.pulse.widgets.recent_events}
          className="hidden min-w-0 xl:col-span-3 xl:block"
          data-testid="overview-event-rail"
        >
          <div className="sticky top-5">
            <RecentEventsWidget rail />
          </div>
        </aside>
      </div>
    </div>
  );
}
