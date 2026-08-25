package subpage

// uiStrings holds the chosen-language chrome copy for one render — status
// labels, section headings, button text. The manual-setup instructions
// (both languages, always both rendered) live separately in instructions.
type uiStrings struct {
	Title                string
	AccessFor            string
	StatusActive         string
	StatusDisabled       string
	StatusExpired        string
	StatusQuotaExhausted string
	QuotaHeading         string
	QuotaUsedOf          string
	QuotaResetLabel      string
	ExpiryLabel          string
	ConnectHeading       string
	GroupTLS             string
	GroupSecure          string
	GroupClassic         string
	NoLinks              string
	OpenInTelegram       string
	OpenViaTMe           string
	FieldServer          string
	FieldPort            string
	FieldSecret          string
	CopyButton           string
	CopiedButton         string
	ManualParams         string
	ScanHint             string
}

// instructions is one language's collapsed manual-setup walkthrough.
type instructions struct {
	Heading string
	IOS     string
	Android string
	Desktop string
}

var stringsRU = uiStrings{
	Title:                "Доступ к прокси",
	AccessFor:            "Доступ для",
	StatusActive:         "Активен",
	StatusDisabled:       "Отключён",
	StatusExpired:        "Истёк",
	StatusQuotaExhausted: "Квота исчерпана",
	QuotaHeading:         "Остаток квоты",
	QuotaUsedOf:          "из",
	QuotaResetLabel:      "Сброшена",
	ExpiryLabel:          "Действует до",
	ConnectHeading:       "Подключение",
	GroupTLS:             "TLS (маскировка под сайт)",
	GroupSecure:          "Secure",
	GroupClassic:         "Classic",
	NoLinks:              "Ссылки для подключения недоступны.",
	OpenInTelegram:       "Подключить в Telegram",
	OpenViaTMe:           "Открыть через t.me",
	FieldServer:          "Сервер",
	FieldPort:            "Порт",
	FieldSecret:          "Секрет",
	CopyButton:           "Копировать",
	CopiedButton:         "Скопировано",
	ManualParams:         "Ручные параметры",
	ScanHint:             "Отсканируйте камерой Telegram",
}

var stringsEN = uiStrings{
	Title:                "Proxy access",
	AccessFor:            "Access for",
	StatusActive:         "Active",
	StatusDisabled:       "Disabled",
	StatusExpired:        "Expired",
	StatusQuotaExhausted: "Quota exhausted",
	QuotaHeading:         "Quota remaining",
	QuotaUsedOf:          "of",
	QuotaResetLabel:      "Reset",
	ExpiryLabel:          "Valid until",
	ConnectHeading:       "Connect",
	GroupTLS:             "TLS (disguised as a website)",
	GroupSecure:          "Secure",
	GroupClassic:         "Classic",
	NoLinks:              "No connection links are available.",
	OpenInTelegram:       "Connect in Telegram",
	OpenViaTMe:           "Open via t.me",
	FieldServer:          "Server",
	FieldPort:            "Port",
	FieldSecret:          "Secret",
	CopyButton:           "Copy",
	CopiedButton:         "Copied",
	ManualParams:         "Manual parameters",
	ScanHint:             "Scan it with the Telegram camera",
}

var instructionsRU = instructions{
	Heading: "Как добавить прокси вручную",
	IOS: "Настройки → Данные и память → Прокси-сервер → Добавить прокси → MTProto. " +
		"Введите сервер, порт и секрет из полей выше.",
	Android: "Настройки → Данные и память → Настройки прокси → Добавить прокси → MTProto. " +
		"Введите сервер, порт и секрет из полей выше.",
	Desktop: "Настройки → Дополнительно → Настройки сети и прокси → Добавить прокси → MTProto. " +
		"Введите сервер, порт и секрет из полей выше.",
}

var instructionsEN = instructions{
	Heading: "How to add the proxy manually",
	IOS: "Settings → Data and Storage → Proxy → Add Proxy → MTProto. " +
		"Enter the server, port and secret from the fields above.",
	Android: "Settings → Data and Storage → Proxy Settings → Add Proxy → MTProto. " +
		"Enter the server, port and secret from the fields above.",
	Desktop: "Settings → Advanced → Connection Type → Add Proxy → MTProto. " +
		"Enter the server, port and secret from the fields above.",
}
