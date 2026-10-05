# Docker: тестовый выпуск 1.0

Новый default profile рассчитан на Linux amd64/arm64. Docker выбирает
архитектуру автоматически. Внутри — full-бинарник из одноимённого
опубликованного релиза, SQLite и системные CA-сертификаты. Укажите полный
проверенный тег нового образа через `TELEMT_PANEL_IMAGE`; `latest` не
используется. Публикация образа выполняется отдельным workflow.

Ранее опубликованный `1.0.0-rc.2` — прежний root-образ; этот исходный diff не
перезаписывает его и не добавляет в него license assets. Для нового default
профиля нужен образ, собранный из релиза с этими изменениями.

## Первый запуск

Сохраните [compose.yaml](../compose.yaml) в отдельный каталог. Рядом создайте
`config/` и скопируйте туда [пример](../docker/config.example.toml) как
`config/config.toml`. Конфиг обязателен: готового пароля в образе нет.
В `.env` рядом с compose сохраните выбранный полный тег:

```dotenv
TELEMT_PANEL_IMAGE=ghcr.io/amirotin/telemt_panel:<проверенный-тег-нового-образа>
```

Для команд `docker run` экспортируйте то же значение в shell.

Создайте bcrypt-хеш интерактивно:

```sh
docker run --rm -it "$TELEMT_PANEL_IMAGE" hash-password
```

Вставьте результат в `[auth].password_hash`, укажите адрес и токен API Telemt.
Не публикуйте конфиг; установите права `0600` на файл и `0700` на каталог.
Default-процесс использует UID/GID **65532**. Для нового bind mount назначьте
владельца только созданному каталогу конфигурации:

```sh
sudo chown -R 65532:65532 ./config
sudo chmod 0700 ./config
sudo chmod 0600 ./config/config.toml
```

Новый named volume получает владельца из образа; каталог данных внутри образа
принадлежит 65532:65532. Ошибка доступа к прежним root-owned данным требует
одноразовой миграции ниже; старт контейнера ничего не меняет рекурсивно.

```sh
docker compose pull
docker compose up -d
docker compose logs --tail=100 telemt-panel
```

Пример использует `network_mode: host` **на Linux**, чтобы панель могла
обращаться к Telemt на `127.0.0.1:9091`. Панель первоначально слушает только
`127.0.0.1:8080`: используйте SSH-туннель или nginx/Caddy. Для прямого доступа
настройте адрес и HTTP/HTTPS осознанно; публичный HTTP не шифрует пароль,
сессию и ссылки подключения. Host networking на Docker Desktop требует
отдельной поддержки/настройки; приведённый пример рассчитан на Linux-сервер.

Если Telemt тоже находится в контейнере, можно подключить оба сервиса к общей
Docker-сети, убрать `network_mode: host`, задать API-адрес вида
`http://telemt:9091` и явно опубликовать порты панели. В этом случае слушатель
панели внутри контейнера должен быть `0.0.0.0:8080`, а не loopback. API Telemt
должен быть доступен в этой сети; публиковать его в Интернет не требуется.

## Данные, настройки и HTTPS

- Named volume `panel-data` хранит `panel-state.json`, SQLite, GeoIP и кеш
  сертификатов. Пересоздание контейнера их не удаляет. **Не используйте
  `docker compose down -v`**, если хотите сохранить данные.
- Каталог `config/` монтируется целиком и с записью — это нужно для атомарного
  сохранения настроек доступа через веб. При монтировании одного файла или
  каталога `:ro` веб-изменения конфигурации могут быть недоступны.
- Файловая система образа read-only; рабочие данные находятся в volume,
  конфиг — в bind mount. Процесс работает как UID/GID 65532; Docker socket
  и каталоги служб хоста не монтируются. `no-new-privileges` запрещает
  повышение полномочий через исполняемые файлы.
- Подписка имеет отдельный порт. В режиме bridge опубликуйте его отдельно;
  настраиваемый префикс должен сохраняться reverse proxy.
- Default слушает высокий порт 8080; низкие порты и TLS обслуживает внешний
  nginx/Caddy. Для готовых сертификатов можно монтировать каталог с
  ключом/fullchain, доступный UID 65532, и слушать HTTPS на высоком порту.
  Вариант ACME с host networking и TCP/80 требует явно выбранного override
  `user: "0:0"`; это даёт процессу root-полномочия внутри контейнера.
  Сохраняйте `read_only`, `no-new-privileges` и отсутствие host-control mounts.
- После сохранения настроек, требующих restart: `docker compose restart telemt-panel`.
  Контейнер не получает доступ к Docker daemon для перезапуска самого себя.

## Обновление контейнера

Перед первым переходом с root-образа остановите сервис и сохраните конфиг и
**конкретный** volume данных. Пример для обычного rootful Docker на Linux
без user namespace remapping (имя volume выясните через `docker volume ls`):

```sh
docker compose stop telemt-panel
mkdir -m 0700 backup-before-nonroot
sudo cp -a ./config backup-before-nonroot/config
PANEL_DATA_VOLUME=myproject_panel-data
docker run --rm --user 0:0 --entrypoint /bin/sh \
  --mount "type=volume,src=$PANEL_DATA_VOLUME,dst=/data,readonly" \
  --mount "type=bind,src=$PWD/backup-before-nonroot,dst=/backup" \
  "$TELEMT_PANEL_IMAGE" \
  -c 'tar -czpf /backup/panel-data.tar.gz -C /data .'
sudo chown -R 65532:65532 ./config
docker run --rm --user 0:0 --entrypoint /bin/sh \
  --mount "type=volume,src=$PANEL_DATA_VOLUME,dst=/data" \
  "$TELEMT_PANEL_IMAGE" \
  -c 'chown -R 65532:65532 /data'
```

Проверьте backup до запуска нового тега. Команды меняют владельца только
выбранного config/data, не произвольных каталогов хоста. Для rootless Docker
или user namespace remapping выполните назначение владельца через root helper
в том же namespace Docker, а не используйте host UID 65532 напрямую.

Для rollback остановите контейнер, верните прежний image tag и `user: "0:0"`,
восстановите `config/` из `backup-before-nonroot/config`. Восстановите данные
в тот же остановленный volume из `panel-data.tar.gz` через root helper;
архив сохраняет прежние владельцев и права. Не смешивайте восстановленную
конфигурацию с другой версией схемы данных. Backup не удаляйте до успешной
проверки входа, настроек и SQLite после пересоздания.

Меняйте полный тег `TELEMT_PANEL_IMAGE` в `.env` и shell, затем:

```sh
docker compose pull
docker compose up -d
```

Обновление/перезапуск Telemt на уровне ОС и замена бинарника панели из веба
в этом образе не предусмотрены: используйте управление контейнерами на хосте.
Редактирование пользователей и настроек Telemt через его API продолжает работать.
Логи процесса панели смотрите через `docker compose logs`.

Для перехода с контейнера 0.6.2 сохраните старый конфиг и данные, добавьте
постоянный volume и следуйте [описанию перехода](UPGRADING.md). Само обновление
образа не конвертирует TOML. В rc.1 нельзя дописывать `[store]` к старой схеме:
сначала нужен `config export` в текущий формат. Для команд при остановленном
сервисе можно использовать `docker compose run --rm telemt-panel config ...`.

## Публикация образа

Workflow `Container prerelease` запускается вручную с тегом опубликованного
prerelease. Он проверяет SHA256 и ELF бинарников, собирает amd64/arm64,
проверяет старт, вход, SQLite и сохранение сессии после пересоздания контейнера,
затем публикует платформенные теги и общий manifest. Существующий версионный
тег не перезаписывается; `latest` не изменяется. Образ не содержит локальных
конфигов, исходников панели, Node.js, Go toolchain или Docker CLI.
