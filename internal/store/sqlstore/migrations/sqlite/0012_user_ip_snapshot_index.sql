CREATE INDEX user_ip_history_snapshot ON user_ip_history(last_ts DESC, username ASC, ip ASC);
