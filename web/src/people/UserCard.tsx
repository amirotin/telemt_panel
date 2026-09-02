import { useRef, useState, type CSSProperties } from "react";
import { useLongPress, useMove, usePress } from "@react-aria/interactions";
import { mergeProps } from "@react-aria/utils";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useStrings, type Dict } from "../i18n";
import { Avatar } from "../ui/Avatar";
import { quotaRatio } from "../ui/quota.helpers";
import { formatDurationApprox } from "./expiry";
import { computeUserStatus, getUserQuota, isOnline } from "./users.helpers";
import { personAvatarTone } from "./personMeta.helpers";
import type { UsersTopicQuotaEntry, UsersTopicUser } from "../realtime/topics";

export interface UserCardProps {
  user: UsersTopicUser;
  quotaEntry: UsersTopicQuotaEntry | undefined;
  now: number;
  selected?: boolean;
  gesturesEnabled?: boolean;
  swipeOpen?: boolean;
  onOpen: () => void;
  onAccess: () => void;
  onActions: () => void;
  onSwipeOpen?: () => void;
  onSwipeClose?: () => void;
}

const SWIPE_ACTIONS_WIDTH_PX = 142;
const SWIPE_OPEN_THRESHOLD_PX = 54;

// UserCard is one fixed-density row used by the virtualized list. Desktop
// exposes four comparable columns; phone portrait rearranges the same facts
// into a two-row card without adding secondary metrics that Telemt does not
// provide. Swipe-left and long press accelerate the visible actions button.
export function UserCard({
  user,
  quotaEntry,
  now,
  selected,
  gesturesEnabled = true,
  swipeOpen = false,
  onOpen,
  onAccess,
  onActions,
  onSwipeOpen = () => {},
  onSwipeClose = () => {},
}: UserCardProps) {
  const s = useStrings();
  const quota = getUserQuota(user, quotaEntry);
  const status = computeUserStatus(user, quota, now);
  const online = isOnline(user);
  const moved = useRef(false);
  const longPressed = useRef(false);
  const dragOffset = useRef(swipeOpen ? -SWIPE_ACTIONS_WIDTH_PX : 0);
  const dragTotal = useRef({ x: 0, y: 0 });
  const dragAxis = useRef<"pending" | "horizontal" | "vertical">("pending");
  const [visibleDragOffset, setVisibleDragOffset] = useState<number | null>(null);

  function updateDragOffset(value: number) {
    dragOffset.current = Math.max(-SWIPE_ACTIONS_WIDTH_PX, Math.min(0, value));
    setVisibleDragOffset(dragOffset.current);
  }

  function closeSwipe() {
    dragOffset.current = 0;
    setVisibleDragOffset(null);
    onSwipeClose();
  }

  const { moveProps } = useMove({
    onMoveStart: () => {
      moved.current = false;
      longPressed.current = false;
      dragTotal.current = { x: 0, y: 0 };
      dragAxis.current = "pending";
      dragOffset.current = swipeOpen ? -SWIPE_ACTIONS_WIDTH_PX : 0;
    },
    onMove: ({ deltaX, deltaY }) => {
      if (!gesturesEnabled) return;
      dragTotal.current.x += deltaX;
      dragTotal.current.y += deltaY;
      const { x, y } = dragTotal.current;
      if (dragAxis.current === "pending" && Math.max(Math.abs(x), Math.abs(y)) > 7) {
        dragAxis.current = Math.abs(x) > Math.abs(y) ? "horizontal" : "vertical";
      }
      if (dragAxis.current !== "horizontal") return;
      moved.current = true;
      updateDragOffset((swipeOpen ? -SWIPE_ACTIONS_WIDTH_PX : 0) + x);
    },
    onMoveEnd: () => {
      if (!gesturesEnabled || longPressed.current) return;
      if (dragAxis.current === "horizontal" && dragOffset.current < -SWIPE_OPEN_THRESHOLD_PX) onSwipeOpen();
      else onSwipeClose();
      setVisibleDragOffset(null);
    },
  });
  const { longPressProps } = useLongPress({
    isDisabled: !gesturesEnabled,
    threshold: 500,
    accessibilityDescription: `${s.people.gestureHintTitle} ${s.people.gestureHintBody}`,
    onLongPressStart: () => {
      longPressed.current = false;
    },
    onLongPress: () => {
      longPressed.current = true;
      moved.current = false;
      closeSwipe();
      onActions();
    },
  });
  const { pressProps, isPressed } = usePress({
    onPressStart: (event) => {
      // A browser may synthesize a virtual click after touch long-press.
      // Preserve the winning long-press flag for that follow-up event, but
      // clear stale gesture state for a genuinely new pointer interaction.
      if (event.pointerType === "virtual") return;
      moved.current = false;
      longPressed.current = false;
    },
    onPress: () => {
      if (moved.current || longPressed.current) return;
      if (swipeOpen) {
        closeSwipe();
        return;
      }
      onOpen();
    },
  });
  const interactionProps = mergeProps(
    gesturesEnabled ? moveProps : {},
    gesturesEnabled ? longPressProps : {},
    pressProps,
  );

  const statusText = status === "active"
    ? online ? s.people.online : s.people.offline
    : s.people.status[status];
  const quotaPercent = quota.limitBytes === null
    ? null
    : Math.round(quotaRatio(quota.usedBytes, quota.limitBytes) * 100);
  const access = accessSummary(user, status, now, s);
  const activity = user.current_connections > 0
    ? `${user.current_connections} ${s.people.connectionsLower}`
    : s.people.noConnections;
  const ipCopy = online
    ? `${user.active_unique_ips} ${s.people.activeIpsShort}`
    : s.people.offline;

  return (
    <div className={cn("people-user-shell", selected && "is-selected", swipeOpen && "is-swiped", visibleDragOffset !== null && "is-dragging")}>
      <div className="people-swipe-actions" aria-hidden={!swipeOpen}>
        <button type="button" tabIndex={swipeOpen ? 0 : -1} onClick={() => { closeSwipe(); onAccess(); }}><span>↗</span>{s.people.inspector.tabs.access}</button>
        <button type="button" tabIndex={swipeOpen ? 0 : -1} onClick={() => { closeSwipe(); onActions(); }}><span>•••</span>{s.people.actions.menu}</button>
      </div>
      <div
        {...interactionProps}
        role="button"
        tabIndex={0}
        data-testid={`user-card-${user.username}`}
        aria-current={selected ? "true" : undefined}
        className={cn("people-user-row", isPressed && "is-pressed", visibleDragOffset !== null && "is-dragging")}
        style={visibleDragOffset === null ? undefined : { "--people-swipe-offset": `${visibleDragOffset}px` } as CSSProperties}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!gesturesEnabled) return;
          closeSwipe();
          onActions();
        }}
      >
        <span className="people-row-identity">
          <Avatar
            name={user.username}
            size="sm"
            tone={personAvatarTone(user, status)}
            online={online}
            ringOn={selected ? "surface" : "bg"}
            className="people-square-avatar"
          />
          <span className="min-w-0">
            <strong className={cn(status === "disabled" && "text-text-faint")}>{user.username}</strong>
            <small className={cn(status !== "active" && "text-warn")}>{statusText}</small>
          </span>
        </span>

        <span className="people-row-cell people-row-activity">
          <strong>{activity}</strong>
          <small>{ipCopy}</small>
        </span>

        <span className={cn("people-row-cell people-row-traffic", status === "quota_exhausted" && "is-warn")}>
          <strong>{formatBytes(user.total_octets, s)}</strong>
          <small>{quotaPercent === null ? s.people.allTime : `${quotaPercent}% ${s.people.quotaShort}`}</small>
        </span>

        <span className={cn("people-row-cell people-row-access", status !== "active" && "is-warn")}>
          <strong>{access.primary}</strong>
          <small>{access.secondary}</small>
        </span>
      </div>

    </div>
  );
}

function accessSummary(
  user: UsersTopicUser,
  status: ReturnType<typeof computeUserStatus>,
  now: number,
  s: Dict,
): { primary: string; secondary: string } {
  if (status !== "active") {
    return { primary: s.people.status[status], secondary: user.enabled ? s.people.runtimeState : "" };
  }
  const target = user.expiration_rfc3339 ? Date.parse(user.expiration_rfc3339) : NaN;
  if (Number.isNaN(target)) return { primary: s.people.detail.noExpiry, secondary: s.people.accessEnabled };
  return {
    primary: formatDurationApprox(Math.max(0, target - now), s),
    secondary: s.people.accessEnabled,
  };
}
