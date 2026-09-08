// Literal pre-edit business copy. Keep independent from the live dictionaries and resolver.
export const COUNTER_DESCRIPTION_EXPECTATIONS = {
  "counters.core.uptime_seconds": {
    "ru": "Сколько времени процесс прокси работает без перезапуска.",
    "en": "How long the proxy process has been running."
  },
  "counters.core.connections_total": {
    "ru": "Сколько клиентских подключений принято с момента запуска.",
    "en": "Client connections accepted since startup."
  },
  "counters.core.connections_bad_total": {
    "ru": "Сколько подключений оказались некорректными или не прошли проверку.",
    "en": "Connections that turned out invalid or failed validation."
  },
  "counters.core.connections_bad_by_class": {
    "ru": "Некорректные подключения в разрезе причин.",
    "en": "Invalid connections grouped by class."
  },
  "counters.core.handshake_failures_by_class": {
    "ru": "Неудачные рукопожатия в разрезе причин.",
    "en": "Handshake failures grouped by class."
  },
  "counters.core.handshake_failures_by_stage": {
    "ru": "Неудачные рукопожатия в разрезе этапов конечного автомата.",
    "en": "Handshake failures grouped by state-machine stage."
  },
  "counters.core.handshake_timeouts_total": {
    "ru": "Сколько рукопожатий не уложились в отведённое время.",
    "en": "Handshake timeouts."
  },
  "counters.core.accept_permit_timeout_total": {
    "ru": "Сколько раз слушатель не дождался разрешения принять подключение.",
    "en": "Listener admission permit acquisition timeouts."
  },
  "counters.core.configured_users": {
    "ru": "Сколько пользователей настроено у прокси.",
    "en": "Configured user count."
  },
  "counters.core.telemetry_core_enabled": {
    "ru": "Собирает ли прокси базовую телеметрию ядра.",
    "en": "Whether core telemetry is collected."
  },
  "counters.core.telemetry_user_enabled": {
    "ru": "Собирает ли прокси телеметрию в разрезе пользователей.",
    "en": "Whether per-user telemetry is collected."
  },
  "counters.core.telemetry_me_level": {
    "ru": "Насколько подробно собирается телеметрия middle proxy: off, normal или verbose.",
    "en": "Middle-proxy telemetry level: off, normal or verbose."
  },
  "counters.core.conntrack_control_enabled": {
    "ru": "Разрешено ли прокси управлять таблицей conntrack.",
    "en": "Whether conntrack control is enabled by policy."
  },
  "counters.core.conntrack_control_available": {
    "ru": "Доступен ли механизм управления conntrack прямо сейчас.",
    "en": "Whether the conntrack control backend is currently available."
  },
  "counters.core.conntrack_pressure_active": {
    "ru": "Действует ли сейчас режим давления на таблицу conntrack.",
    "en": "Whether conntrack pressure is currently active."
  },
  "counters.core.conntrack_event_queue_depth": {
    "ru": "Сколько событий закрытия ждут обработки в очереди conntrack.",
    "en": "Current depth of the conntrack close-event queue."
  },
  "counters.core.conntrack_rule_apply_ok": {
    "ru": "Успешно ли применилось последнее правило conntrack.",
    "en": "Whether the last conntrack rule application succeeded."
  },
  "counters.core.conntrack_delete_attempt_total": {
    "ru": "Сколько попыток удалить запись conntrack было сделано.",
    "en": "Conntrack delete attempts."
  },
  "counters.core.conntrack_delete_success_total": {
    "ru": "Сколько записей conntrack удалено успешно.",
    "en": "Successful conntrack deletes."
  },
  "counters.core.conntrack_delete_not_found_total": {
    "ru": "Сколько удалений conntrack не нашли записи.",
    "en": "Conntrack deletes that found nothing."
  },
  "counters.core.conntrack_delete_error_total": {
    "ru": "Сколько удалений conntrack завершились ошибкой.",
    "en": "Conntrack deletes that failed."
  },
  "counters.core.conntrack_close_event_drop_total": {
    "ru": "Сколько событий закрытия conntrack отброшено.",
    "en": "Dropped conntrack close events."
  },
  "counters.upstream.connect_attempt_total": {
    "ru": "Сколько попыток подключиться через апстрим было сделано.",
    "en": "Upstream connect attempts."
  },
  "counters.upstream.connect_success_total": {
    "ru": "Сколько подключений через апстрим удались.",
    "en": "Successful upstream connects."
  },
  "counters.upstream.connect_fail_total": {
    "ru": "Сколько подключений через апстрим не удались.",
    "en": "Failed upstream connects."
  },
  "counters.upstream.connect_failfast_hard_error_total": {
    "ru": "Сколько подключений прервано сразу из-за неустранимой ошибки.",
    "en": "Connects aborted immediately on a hard error."
  },
  "counters.upstream.connect_attempts_bucket_1": {
    "ru": "Подключения, удавшиеся с первой попытки.",
    "en": "Connects resolved in one attempt."
  },
  "counters.upstream.connect_attempts_bucket_2": {
    "ru": "Подключения, потребовавшие двух попыток.",
    "en": "Connects resolved in two attempts."
  },
  "counters.upstream.connect_attempts_bucket_3_4": {
    "ru": "Подключения, потребовавшие трёх-четырёх попыток.",
    "en": "Connects resolved in three or four attempts."
  },
  "counters.upstream.connect_attempts_bucket_gt_4": {
    "ru": "Подключения, потребовавшие более четырёх попыток.",
    "en": "Connects that needed more than four attempts."
  },
  "counters.upstream.connect_duration_success_bucket_le_100ms": {
    "ru": "Удачные подключения быстрее 100 мс.",
    "en": "Successful connects within 100 ms."
  },
  "counters.upstream.connect_duration_success_bucket_101_500ms": {
    "ru": "Удачные подключения за 101–500 мс.",
    "en": "Successful connects taking 101–500 ms."
  },
  "counters.upstream.connect_duration_success_bucket_501_1000ms": {
    "ru": "Удачные подключения за 501–1000 мс.",
    "en": "Successful connects taking 501–1000 ms."
  },
  "counters.upstream.connect_duration_success_bucket_gt_1000ms": {
    "ru": "Удачные подключения дольше 1000 мс.",
    "en": "Successful connects taking over 1000 ms."
  },
  "counters.upstream.connect_duration_fail_bucket_le_100ms": {
    "ru": "Неудачные подключения, отпавшие быстрее 100 мс.",
    "en": "Failed connects that gave up within 100 ms."
  },
  "counters.upstream.connect_duration_fail_bucket_101_500ms": {
    "ru": "Неудачные подключения, отпавшие за 101–500 мс.",
    "en": "Failed connects that gave up in 101–500 ms."
  },
  "counters.upstream.connect_duration_fail_bucket_501_1000ms": {
    "ru": "Неудачные подключения, отпавшие за 501–1000 мс.",
    "en": "Failed connects that gave up in 501–1000 ms."
  },
  "counters.upstream.connect_duration_fail_bucket_gt_1000ms": {
    "ru": "Неудачные подключения, отпавшие позже 1000 мс.",
    "en": "Failed connects that gave up after 1000 ms."
  },
  "counters.middle_proxy.keepalive_sent_total": {
    "ru": "Сколько keepalive-пакетов отправлено в middle proxy.",
    "en": "Keepalive packets sent to the middle proxy."
  },
  "counters.middle_proxy.keepalive_failed_total": {
    "ru": "Сколько keepalive-пакетов не удалось отправить.",
    "en": "Keepalive packets that failed to send."
  },
  "counters.middle_proxy.keepalive_pong_total": {
    "ru": "Сколько ответов на keepalive получено.",
    "en": "Keepalive pong responses received."
  },
  "counters.middle_proxy.keepalive_timeout_total": {
    "ru": "Сколько keepalive остались без ответа в срок.",
    "en": "Keepalive timeout events."
  },
  "counters.middle_proxy.rpc_proxy_req_signal_sent_total": {
    "ru": "Сколько сигналов активности RPC-прокси отправлено.",
    "en": "RPC proxy activity signals sent."
  },
  "counters.middle_proxy.rpc_proxy_req_signal_failed_total": {
    "ru": "Сколько сигналов активности RPC-прокси не удалось отправить.",
    "en": "RPC proxy activity signals that failed to send."
  },
  "counters.middle_proxy.rpc_proxy_req_signal_skipped_no_meta_total": {
    "ru": "Сколько сигналов пропущено из-за отсутствия метаданных.",
    "en": "Signals skipped because metadata was missing."
  },
  "counters.middle_proxy.rpc_proxy_req_signal_response_total": {
    "ru": "Сколько ответов на сигналы RPC-прокси получено.",
    "en": "RPC proxy signal responses received."
  },
  "counters.middle_proxy.rpc_proxy_req_signal_close_sent_total": {
    "ru": "Сколько сигналов закрытия RPC-прокси отправлено.",
    "en": "RPC proxy close signals sent."
  },
  "counters.middle_proxy.reconnect_attempt_total": {
    "ru": "Сколько попыток переподключения к middle proxy сделано.",
    "en": "Reconnect attempts to the middle proxy."
  },
  "counters.middle_proxy.reconnect_success_total": {
    "ru": "Сколько переподключений к middle proxy удались.",
    "en": "Successful middle-proxy reconnects."
  },
  "counters.middle_proxy.handshake_reject_total": {
    "ru": "Сколько рукопожатий с middle proxy отклонено.",
    "en": "Middle-proxy handshakes rejected."
  },
  "counters.middle_proxy.handshake_error_codes": {
    "ru": "Отклонённые рукопожатия в разрезе кодов ошибок.",
    "en": "Rejected handshakes grouped by error code."
  },
  "counters.middle_proxy.reader_eof_total": {
    "ru": "Сколько раз читатель middle proxy получил конец потока.",
    "en": "Reader EOF events on the middle-proxy link."
  },
  "counters.middle_proxy.idle_close_by_peer_total": {
    "ru": "Сколько раз удалённая сторона закрыла соединение по простою.",
    "en": "Idle closes initiated by the peer."
  },
  "counters.middle_proxy.route_drop_no_conn_total": {
    "ru": "Пакеты, отброшенные из-за отсутствия привязанного соединения.",
    "en": "Route drops caused by a missing bound connection."
  },
  "counters.middle_proxy.route_drop_channel_closed_total": {
    "ru": "Пакеты, отброшенные из-за закрытого канала назначения.",
    "en": "Route drops caused by a closed destination channel."
  },
  "counters.middle_proxy.route_drop_queue_full_total": {
    "ru": "Пакеты, отброшенные переполнением очереди, всего.",
    "en": "Route drops caused by a full queue, in total."
  },
  "counters.middle_proxy.route_drop_queue_full_base_total": {
    "ru": "Пакеты, отброшенные переполнением обычной очереди.",
    "en": "Route drops in the base-priority queue."
  },
  "counters.middle_proxy.route_drop_queue_full_high_total": {
    "ru": "Пакеты, отброшенные переполнением приоритетной очереди.",
    "en": "Route drops in the high-priority queue."
  },
  "counters.middle_proxy.d2c_batches_total": {
    "ru": "Сколько пачек кадров отправлено от дата-центра к клиенту.",
    "en": "Batch flushes on the DC-to-client path."
  },
  "counters.middle_proxy.d2c_batch_frames_total": {
    "ru": "Сколько кадров вошло в эти пачки.",
    "en": "Frames included in those batches."
  },
  "counters.middle_proxy.d2c_batch_bytes_total": {
    "ru": "Сколько байтов полезной нагрузки вошло в эти пачки.",
    "en": "Payload bytes included in those batches."
  },
  "counters.middle_proxy.d2c_flush_reason_queue_drain_total": {
    "ru": "Пачки, отправленные потому, что очередь опустела.",
    "en": "Flushes caused by the queue draining."
  },
  "counters.middle_proxy.d2c_flush_reason_batch_frames_total": {
    "ru": "Пачки, отправленные по достижении предела кадров.",
    "en": "Flushes caused by the frame-count batch limit."
  },
  "counters.middle_proxy.d2c_flush_reason_batch_bytes_total": {
    "ru": "Пачки, отправленные по достижении предела байтов.",
    "en": "Flushes caused by the byte-count batch limit."
  },
  "counters.middle_proxy.d2c_flush_reason_max_delay_total": {
    "ru": "Пачки, отправленные по исчерпании допустимой задержки.",
    "en": "Flushes caused by the max-delay budget."
  },
  "counters.middle_proxy.d2c_flush_reason_ack_immediate_total": {
    "ru": "Пачки, отправленные из-за политики немедленного подтверждения.",
    "en": "Flushes caused by the immediate-ACK policy."
  },
  "counters.middle_proxy.d2c_flush_reason_close_total": {
    "ru": "Пачки, отправленные при закрытии соединения.",
    "en": "Flushes caused by the close path."
  },
  "counters.middle_proxy.d2c_data_frames_total": {
    "ru": "Кадры с данными, отправленные клиенту.",
    "en": "Data frames sent to the client."
  },
  "counters.middle_proxy.d2c_ack_frames_total": {
    "ru": "Кадры подтверждения, отправленные клиенту.",
    "en": "ACK frames sent to the client."
  },
  "counters.middle_proxy.d2c_payload_bytes_total": {
    "ru": "Байты полезной нагрузки, отправленные клиенту.",
    "en": "Payload bytes sent to the client."
  },
  "counters.middle_proxy.d2c_write_mode_coalesced_total": {
    "ru": "Записи клиенту, объединённые в одну операцию.",
    "en": "Client writes that were coalesced."
  },
  "counters.middle_proxy.d2c_write_mode_split_total": {
    "ru": "Записи клиенту, разбитые на несколько операций.",
    "en": "Client writes that were split."
  },
  "counters.middle_proxy.d2c_quota_reject_pre_write_total": {
    "ru": "Отказы по квоте до записи клиенту.",
    "en": "Quota rejections before writing to the client."
  },
  "counters.middle_proxy.d2c_quota_reject_post_write_total": {
    "ru": "Отказы по квоте после записи клиенту.",
    "en": "Quota rejections after writing to the client."
  },
  "counters.middle_proxy.d2c_frame_buf_shrink_total": {
    "ru": "Сколько раз буфер кадров клиента ужимался.",
    "en": "Client frame-buffer shrink operations."
  },
  "counters.middle_proxy.d2c_frame_buf_shrink_bytes_total": {
    "ru": "Сколько байтов освободило ужатие буфера кадров.",
    "en": "Bytes released by frame-buffer shrink operations."
  },
  "counters.middle_proxy.socks_kdf_strict_reject_total": {
    "ru": "Отказы SOCKS по строгой политике ключевого материала.",
    "en": "SOCKS rejections under the strict KDF policy."
  },
  "counters.middle_proxy.socks_kdf_compat_fallback_total": {
    "ru": "Переходы SOCKS на совместимую политику ключевого материала.",
    "en": "SOCKS fallbacks to the compatible KDF policy."
  },
  "counters.middle_proxy.endpoint_quarantine_total": {
    "ru": "Сколько раз адрес middle proxy отправлялся в карантин.",
    "en": "Endpoint quarantine activations."
  },
  "counters.middle_proxy.kdf_drift_total": {
    "ru": "Сколько раз обнаружено расхождение ключевого материала.",
    "en": "KDF drift detections."
  },
  "counters.middle_proxy.kdf_port_only_drift_total": {
    "ru": "Сколько раз расхождение ключевого материала касалось только порта.",
    "en": "KDF drift detections that only involved the port."
  },
  "counters.middle_proxy.hardswap_pending_reuse_total": {
    "ru": "Сколько раз ожидающее поколение было переиспользовано.",
    "en": "Pending hard-swap generations that were reused."
  },
  "counters.middle_proxy.hardswap_pending_ttl_expired_total": {
    "ru": "Сколько ожидающих поколений просрочили свой срок.",
    "en": "Pending hard-swap generations that expired."
  },
  "counters.middle_proxy.single_endpoint_outage_enter_total": {
    "ru": "Сколько раз включался аварийный режим для дата-центра с одним адресом.",
    "en": "Entries into single-endpoint outage mode."
  },
  "counters.middle_proxy.single_endpoint_outage_exit_total": {
    "ru": "Сколько раз аварийный режим выключался.",
    "en": "Exits from single-endpoint outage mode."
  },
  "counters.middle_proxy.single_endpoint_outage_reconnect_attempt_total": {
    "ru": "Попытки переподключения в аварийном режиме.",
    "en": "Reconnect attempts made in outage mode."
  },
  "counters.middle_proxy.single_endpoint_outage_reconnect_success_total": {
    "ru": "Удачные переподключения в аварийном режиме.",
    "en": "Reconnects that succeeded in outage mode."
  },
  "counters.middle_proxy.single_endpoint_quarantine_bypass_total": {
    "ru": "Сколько раз карантин адреса обходился в аварийном режиме.",
    "en": "Quarantine bypasses during outage mode."
  },
  "counters.middle_proxy.single_endpoint_shadow_rotate_total": {
    "ru": "Сколько ротаций теневых писателей выполнено.",
    "en": "Shadow writer rotations performed."
  },
  "counters.middle_proxy.single_endpoint_shadow_rotate_skipped_quarantine_total": {
    "ru": "Сколько ротаций пропущено из-за карантина адреса.",
    "en": "Shadow rotations skipped because of quarantine."
  },
  "counters.middle_proxy.floor_mode_switch_total": {
    "ru": "Сколько раз режим пола писателей переключался.",
    "en": "Writer floor mode switches."
  },
  "counters.middle_proxy.floor_mode_switch_static_to_adaptive_total": {
    "ru": "Переключения пола писателей со статического на адаптивный.",
    "en": "Floor switches from static to adaptive."
  },
  "counters.middle_proxy.floor_mode_switch_adaptive_to_static_total": {
    "ru": "Переключения пола писателей с адаптивного на статический.",
    "en": "Floor switches from adaptive to static."
  },
  "counters.pool.pool_swap_total": {
    "ru": "Сколько раз пул писателей менял поколение.",
    "en": "Writer-pool generation swaps."
  },
  "counters.pool.pool_drain_active": {
    "ru": "Сколько поколений пула выводится прямо сейчас.",
    "en": "Pool generations currently draining."
  },
  "counters.pool.pool_force_close_total": {
    "ru": "Сколько писателей закрыто принудительно по тайм-ауту вывода.",
    "en": "Writers force-closed on the drain timeout."
  },
  "counters.pool.pool_stale_pick_total": {
    "ru": "Сколько раз клиент был привязан к устаревшему писателю.",
    "en": "Stale writer picks made for a client binding."
  },
  "counters.pool.writer_removed_total": {
    "ru": "Сколько писателей удалено из пула.",
    "en": "Writers removed from the pool."
  },
  "counters.pool.writer_removed_unexpected_total": {
    "ru": "Сколько писателей удалено из пула незапланированно.",
    "en": "Writers removed unexpectedly."
  },
  "counters.pool.refill_triggered_total": {
    "ru": "Сколько раз запускалось дозаполнение пула.",
    "en": "Refill operations triggered."
  },
  "counters.pool.refill_skipped_inflight_total": {
    "ru": "Сколько дозаполнений пропущено, потому что предыдущее ещё шло.",
    "en": "Refills skipped because one was already in flight."
  },
  "counters.pool.refill_failed_total": {
    "ru": "Сколько дозаполнений завершились неудачей.",
    "en": "Refill operations that failed."
  },
  "counters.pool.writer_restored_same_endpoint_total": {
    "ru": "Сколько писателей восстановлено на том же адресе.",
    "en": "Writers restored on the same endpoint."
  },
  "counters.pool.writer_restored_fallback_total": {
    "ru": "Сколько писателей восстановлено на запасном адресе.",
    "en": "Writers restored on a fallback endpoint."
  },
  "counters.desync.secure_padding_invalid_total": {
    "ru": "Сколько кадров пришли с некорректным защитным заполнением.",
    "en": "Frames that arrived with invalid secure padding."
  },
  "counters.desync.desync_total": {
    "ru": "Сколько раз обнаружено рассогласование потока кадров.",
    "en": "Frame desync events detected."
  },
  "counters.desync.desync_full_logged_total": {
    "ru": "Сколько рассогласований записано в журнал полностью.",
    "en": "Desync events logged in full."
  },
  "counters.desync.desync_suppressed_total": {
    "ru": "Сколько записей о рассогласовании подавлено.",
    "en": "Desync log entries suppressed."
  },
  "counters.desync.desync_frames_bucket_0": {
    "ru": "Рассогласования, затронувшие ноль кадров.",
    "en": "Desync events covering zero frames."
  },
  "counters.desync.desync_frames_bucket_1_2": {
    "ru": "Рассогласования, затронувшие один-два кадра.",
    "en": "Desync events covering one or two frames."
  },
  "counters.desync.desync_frames_bucket_3_10": {
    "ru": "Рассогласования, затронувшие от трёх до десяти кадров.",
    "en": "Desync events covering three to ten frames."
  },
  "counters.desync.desync_frames_bucket_gt_10": {
    "ru": "Рассогласования, затронувшие более десяти кадров.",
    "en": "Desync events covering more than ten frames."
  },
  "counters.class": {
    "ru": "Причина, по которой подключение или рукопожатие не состоялось.",
    "en": "The reason a connection or handshake did not succeed."
  },
  "counters.class_total": {
    "ru": "Сколько раз встретилась эта причина с момента запуска.",
    "en": "How many times this reason has occurred since startup."
  },
  "counters.stage": {
    "ru": "Этап конечного автомата рукопожатия, на котором произошёл сбой.",
    "en": "The handshake state-machine stage where the failure happened."
  },
  "counters.stage_total": {
    "ru": "Сколько сбоев рукопожатия пришлось на этот этап.",
    "en": "How many handshake failures happened at this stage."
  },
  "counters.error_code": {
    "ru": "Код ошибки, с которым middle proxy отклонил рукопожатие.",
    "en": "Error code the middle proxy rejected the handshake with."
  },
  "counters.error_code_total": {
    "ru": "Сколько отклонений пришлось на этот код ошибки.",
    "en": "How many rejections carried this error code."
  }
} as const;
