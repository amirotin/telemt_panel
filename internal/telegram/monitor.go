package telegram

import (
	"context"
	"fmt"
	"time"
)

func (b *Bot) monitorLoop(ctx context.Context) {
	defer b.wg.Done()

	ticker := time.NewTicker(monitorInterval)
	defer ticker.Stop()

	var offlineCount int

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			b.runMonitorCycle(&offlineCount)
		}
	}
}

func (b *Bot) runMonitorCycle(offlineCount *int) {
	b.mu.Lock()
	maxIPs := b.cfg.Telegram.DefaultMaxUniqueIps
	b.mu.Unlock()
	if maxIPs <= 0 {
		maxIPs = 5
	}

	users, err := b.apiGetUsers()
	if err != nil {
		*offlineCount++
		if *offlineCount == 3 {
			b.notifyAdmins("🚨 <b>API OFFLINE!</b>")
		}
		return
	}

	if *offlineCount >= 3 {
		b.notifyAdmins("✅ <b>API ONLINE</b>")
	}
	*offlineCount = 0

	now := time.Now().Unix()
	for _, u := range users {
		if len(u.activeIPs) > maxIPs {
			b.notifyAdmins(fmt.Sprintf("⚠️ <b>ПОДОЗРЕНИЕ: %s</b>\nIP: %d", u.name, len(u.activeIPs)))
		}
		for _, ip := range u.activeIPs {
			b.dbUpsertKnownIP(u.name, ip, now)
		}
	}

	b.dbCleanOldData(now-7*86400, now-3*86400)
	b.dbSyncUsers(users)
}
