package telegram

import (
	"database/sql"
	"fmt"
	"time"
)

func initSchema(db *sql.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS users (proxy_name TEXT PRIMARY KEY, tg_id INTEGER, secret TEXT);
CREATE TABLE IF NOT EXISTS known_ips (proxy_name TEXT, ip TEXT, last_seen INTEGER, UNIQUE(proxy_name, ip));
CREATE TABLE IF NOT EXISTS requests (tg_id INTEGER PRIMARY KEY, tg_username TEXT, desired_name TEXT);
CREATE TABLE IF NOT EXISTS banned_users (tg_id INTEGER PRIMARY KEY, proxy_name TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS reply_map (admin_msg_id INTEGER PRIMARY KEY, client_uid INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS user_lang (tg_id INTEGER PRIMARY KEY, lang TEXT);
`)
	return err
}

func (b *Bot) dbGetLang(tgID int64) (string, error) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return "", nil
	}
	var lang string
	err := db.QueryRow("SELECT lang FROM user_lang WHERE tg_id=?", tgID).Scan(&lang)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return lang, err
}

func (b *Bot) dbSetLang(tgID int64, lang string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("INSERT OR REPLACE INTO user_lang VALUES (?,?)", tgID, lang) //nolint:errcheck
}

func (b *Bot) dbHasLang(tgID int64) bool {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return false
	}
	var dummy int
	return db.QueryRow("SELECT 1 FROM user_lang WHERE tg_id=?", tgID).Scan(&dummy) == nil
}

func (b *Bot) dbGetUser(tgID int64) (proxyName, secret string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return "", ""
	}
	db.QueryRow("SELECT proxy_name, secret FROM users WHERE tg_id=?", tgID).Scan(&proxyName, &secret) //nolint:errcheck
	return proxyName, secret
}

func (b *Bot) dbGetUserByName(name string) (tgID int64, secret string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return 0, ""
	}
	var nullTgID sql.NullInt64
	db.QueryRow("SELECT tg_id, secret FROM users WHERE proxy_name=?", name).Scan(&nullTgID, &secret) //nolint:errcheck
	return nullTgID.Int64, secret
}

func (b *Bot) dbIsBanned(tgID int64) bool {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return false
	}
	var dummy int
	return db.QueryRow("SELECT 1 FROM banned_users WHERE tg_id=?", tgID).Scan(&dummy) == nil
}

func (b *Bot) dbHasRequest(tgID int64) bool {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return false
	}
	var dummy int
	return db.QueryRow("SELECT 1 FROM requests WHERE tg_id=?", tgID).Scan(&dummy) == nil
}

func (b *Bot) dbNameTaken(name string) bool {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return false
	}
	var dummy int
	return db.QueryRow("SELECT 1 FROM users WHERE proxy_name=?", name).Scan(&dummy) == nil
}

func (b *Bot) dbAddRequest(tgID int64, username, desiredName string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("INSERT OR REPLACE INTO requests (tg_id, tg_username, desired_name) VALUES (?,?,?)", tgID, username, desiredName) //nolint:errcheck
}

type requestRow struct {
	tgID        int64
	tgUsername  string
	desiredName string
}

func (b *Bot) dbGetRequests() []requestRow {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return nil
	}
	rows, err := db.Query("SELECT tg_id, tg_username, desired_name FROM requests")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var result []requestRow
	for rows.Next() {
		var r requestRow
		rows.Scan(&r.tgID, &r.tgUsername, &r.desiredName) //nolint:errcheck
		result = append(result, r)
	}
	return result
}

func (b *Bot) dbGetRequest(tgID int64) (desiredName, username string, ok bool) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return "", "", false
	}
	err := db.QueryRow("SELECT desired_name, tg_username FROM requests WHERE tg_id=?", tgID).
		Scan(&desiredName, &username)
	return desiredName, username, err == nil
}

func (b *Bot) dbDeleteRequest(tgID int64) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("DELETE FROM requests WHERE tg_id=?", tgID) //nolint:errcheck
}

func (b *Bot) dbAddUser(name string, tgID int64, secret string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("INSERT OR REPLACE INTO users VALUES (?,?,?)", name, tgID, secret) //nolint:errcheck
}

func (b *Bot) dbApproveRequest(name string, tgID int64, secret string) error {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return fmt.Errorf("db not initialized")
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.Exec("INSERT OR REPLACE INTO users VALUES (?,?,?)", name, tgID, secret); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM requests WHERE tg_id=?", tgID); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *Bot) dbUpdateUserTGID(name string, tgID int64) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("UPDATE users SET tg_id=? WHERE proxy_name=?", tgID, name) //nolint:errcheck
}

func (b *Bot) dbUpdateUserSecret(name string, secret string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("UPDATE users SET secret=? WHERE proxy_name=?", secret, name) //nolint:errcheck
}

func (b *Bot) dbCleanUser(name string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("DELETE FROM users WHERE proxy_name=?", name)     //nolint:errcheck
	db.Exec("DELETE FROM known_ips WHERE proxy_name=?", name) //nolint:errcheck
}

type bannedRow struct {
	tgID      int64
	proxyName string
	reason    string
}

func (b *Bot) dbGetBanned() []bannedRow {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return nil
	}
	rows, err := db.Query("SELECT tg_id, proxy_name, reason FROM banned_users")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var result []bannedRow
	for rows.Next() {
		var r bannedRow
		rows.Scan(&r.tgID, &r.proxyName, &r.reason) //nolint:errcheck
		result = append(result, r)
	}
	return result
}

func (b *Bot) dbBanUser(tgID int64, proxyName, reason string) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("INSERT OR REPLACE INTO banned_users (tg_id, proxy_name, reason) VALUES (?,?,?)", tgID, proxyName, reason) //nolint:errcheck
}

func (b *Bot) dbUnbanUser(tgID int64) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("DELETE FROM banned_users WHERE tg_id=?", tgID) //nolint:errcheck
}

func (b *Bot) dbGetAllUserTGIDs() []int64 {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return nil
	}
	rows, err := db.Query("SELECT tg_id FROM users WHERE tg_id > 0")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var result []int64
	for rows.Next() {
		var id int64
		rows.Scan(&id) //nolint:errcheck
		result = append(result, id)
	}
	return result
}

func (b *Bot) dbSaveReplyMap(adminMsgID int, clientUID int64) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("INSERT OR REPLACE INTO reply_map VALUES (?,?,?)", adminMsgID, clientUID, time.Now().Unix()) //nolint:errcheck
}

func (b *Bot) dbGetReplyTarget(adminMsgID int) int64 {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return 0
	}
	var uid int64
	db.QueryRow("SELECT client_uid FROM reply_map WHERE admin_msg_id=?", adminMsgID).Scan(&uid) //nolint:errcheck
	return uid
}

func (b *Bot) dbUpsertKnownIP(name, ip string, ts int64) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("INSERT OR REPLACE INTO known_ips VALUES (?,?,?)", name, ip, ts) //nolint:errcheck
}

func (b *Bot) dbCleanOldData(ipCutoff, replyCutoff int64) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	db.Exec("DELETE FROM known_ips WHERE last_seen < ?", ipCutoff)     //nolint:errcheck
	db.Exec("DELETE FROM reply_map WHERE created_at < ?", replyCutoff) //nolint:errcheck
}

func (b *Bot) dbSyncUsers(users []apiUser) {
	b.mu.Lock()
	db := b.db
	b.mu.Unlock()
	if db == nil {
		return
	}
	rows, err := db.Query("SELECT proxy_name, secret FROM users")
	if err != nil {
		return
	}
	defer rows.Close()
	existing := make(map[string]string)
	for rows.Next() {
		var name, secret string
		rows.Scan(&name, &secret) //nolint:errcheck
		existing[name] = secret
	}

	for _, u := range users {
		if _, ok := existing[u.name]; !ok {
			db.Exec("INSERT INTO users (proxy_name, secret) VALUES (?,?)", u.name, u.secret) //nolint:errcheck
		} else if existing[u.name] == "" && u.secret != "" {
			db.Exec("UPDATE users SET secret=? WHERE proxy_name=?", u.secret, u.name) //nolint:errcheck
		}
	}
}
