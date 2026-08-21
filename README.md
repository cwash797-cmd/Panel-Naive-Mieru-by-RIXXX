[🇷🇺 Русский](README.md) | [🇬🇧 English](README.en.md)

---

<div align="center">

# 🛡 Panel Naive + Mieru (+Hysteria2) by RIXXX

**v1.11.1** — Веб-панель управления NaiveProxy + Mieru + Hysteria2 для Ubuntu/Debian VPS

[![Telegram](https://img.shields.io/badge/Telegram-@russian__paradice__vpn-2CA5E0?logo=telegram&logoColor=white)](https://t.me/russian_paradice_vpn)
[![GitHub](https://img.shields.io/badge/GitHub-cwash797--cmd-181717?logo=github)](https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX)
[![License](https://img.shields.io/badge/License-MIT-bronze?color=c08552)](LICENSE)

> 💬 **Поддержка и обновления:** [t.me/russian_paradice_vpn](https://t.me/russian_paradice_vpn)  
> ☕ **Поддержать проект:** [app.lava.top/2107724612](https://app.lava.top/2107724612?tabId=donate)

</div>

---

## ✨ Возможности

| Sprint | Функционал |
|--------|-----------|
| 1 | Авто-установщик: определение архитектуры (только amd64), caddy-forwardproxy-naive, Mieru .deb, systemd, NTP, UFW, config.json |
| 2 | CRUD пользователей: SQLite, атомарная перестройка Caddyfile / Mieru-конфига, cron удаления просроченных |
| 3 | Настройки сервера: смена портов, паттерны трафика, MTU, авто-обновление UFW |
| 4 | Клиентские конфиги: Naive-ссылка, Mieru sing-box JSON, универсальный конфиг, QR-коды |
| 5 | Мониторинг: WebSocket метрики в реальном времени, трафик, квоты, история снимков |
| 6 | `update.sh`: `--dry-run`, `--force`, `--expose`, `--ssh-only`, `--status`, `--repair`, `--help` |
| 7 | **Каскад / Relay** (v1.2.6): `client → Entry (RU) → Exit (EU) → internet` — Naive `upstream` + Mieru вариант B (mieru-client + redsocks + iptables), управляется из UI |
| 8 | **Hysteria2 «из коробки»** (v1.8.x): третий протокол общего пула — устанавливается автоматически рядом с Naive + Mieru (`install_hysteria.sh`, `auth: userpass`, systemd, per-user трафик, каскад). Включается чекбоксом в общем пуле пользователя. |
| 9 | **Одна «умная» Sub-ссылка** (v1.8.7–1.8.8): единая ссылка `/sub/:token` с авто-определением клиента по User-Agent. **Shadowrocket** получает base64-список URI (Naive → нативная HTTPS-схема, Mieru `mierus://`, Hy2 `hysteria2://`), **Karing** — sing-box JSON. Передаёт срок действия и трафик через заголовок `Subscription-Userinfo`. ✅ **Проверено на Karing и Shadowrocket.** |

---

## 🖥 Поддерживаемые ОС

| Дистрибутив | Версии |
|-------------|--------|
| Ubuntu | 20.04, 22.04, 24.04 |
| Debian | 11, 12 |

**Архитектуры:** `x86_64` (amd64) — **только** *(caddy-forwardproxy-naive поддерживает только amd64)*  
> ⚠️ ARM64 и ARMv7 **не поддерживаются** в v1.2.3 — установщик завершится с понятной ошибкой.

---

## 🚀 Быстрый старт

```bash
# 1. Клонировать репозиторий
git clone https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX.git
cd Panel-Naive-Mieru-by-RIXXX

# 2. Запустить установщик от root
sudo bash install.sh
```

Мастер установки запросит:
- Язык (Русский / English) — **первый вопрос**
- Домен / имя хоста
- Email для TLS (Caddy управляет сертификатами автоматически через TLS-ALPN-01)
- Порт NaiveProxy (по умолчанию: `443`)
- Диапазон портов Mieru (по умолчанию: `2012-2022`)
- URL фейкового сайта (по умолчанию: `https://www.example.com`)
- Probe secret (по умолчанию: авто-генерация)
- Данные администратора панели
- Настройка UFW (опционально)
- Режим доступа к панели (SSH-only / публичный)

---

## 🔒 Доступ к панели

### SSH-only (по умолчанию, наиболее безопасно)
```bash
# С вашей локальной машины:
ssh -L 3000:127.0.0.1:3000 root@<ip-сервера>
# Затем откройте: http://localhost:3000/
```

### Внешний доступ (домен + TLS + basic auth + webBasePath)

Панель **всегда** слушает только `127.0.0.1:3000`. Внешний доступ открывается
исключительно через отдельный поддомен с TLS — голого HTTP-порта (8080) больше нет.

```bash
sudo bash update.sh --expose panel.example.com
# Панель доступна по: https://panel.example.com/<webBasePath>/
#   • <webBasePath> — случайные 16 hex (можно сменить в UI или --web-base-path)
#   • корень panel.example.com/ и любые пути вне webBasePath → статическая заглушка
#   • доступ защищён basic auth (логин/пароль) поверх логина в панель
#   • basic-auth пароль (если сгенерирован) показывается ОДИН раз в конце
```

Вернуть в локальный режим:
```bash
sudo bash update.sh --ssh-only
# Панель снова только через SSH-туннель; panel-блок удалён, порт закрыт.
```

> ⚠️ Старые установки на `:8080` при обновлении автоматически переводятся в
> безопасный SSH-only режим (порт 8080 закрывается), доступ при этом не теряется.

---

## 📁 Важные пути

| Путь | Назначение |
|------|-----------|
| `/etc/rixxx-panel/config.json` | Конфигурация панели |
| `/etc/rixxx-panel/version` | Установленная версия |
| `/etc/rixxx-panel/backups/` | Резервные копии (хранится последние 10) |
| `/etc/caddy-naive/Caddyfile` | Конфиг Caddy forwardproxy-naive (basicauth, probe_resistance) |
| `/etc/caddy-naive/probe_secret` | Секрет защиты от зондирования |
| `/var/www/fake-site/` | Фейковый сайт (показывается неопознанным клиентам) |
| `/var/log/caddy-naive/access.log` | Лог доступа caddy-naive |
| `/var/log/rixxx-panel-install.log` | Лог установки |
| `/var/lib/rixxx-panel/mita-state.json` | JSON-файл Mieru (применяется через `mita apply config`) |
| `/var/lib/rixxx-panel/db.sqlite` | SQLite база данных пользователей |
| `/opt/panel-naive-mieru/` | Файлы приложения панели |
| `/usr/local/bin/caddy-naive` | Бинарный файл caddy-forwardproxy-naive |

> ⚠️ **Важно:** `/etc/mita/` — внутреннее хранилище Mieru в формате protobuf, **не редактируется вручную**.  
> Панель использует `/var/lib/rixxx-panel/mita-state.json` и применяет его командой `mita apply config <file>`.

> 🔐 **Предупреждение безопасности (Bug 45):** Панель хранит **открытые (plaintext) пароли** пользователей  
> в SQLite (`/var/lib/rixxx-panel/db.sqlite`). Это необходимо, потому что `caddy-forwardproxy-naive`  
> хэширует пароли самостоятельно при запуске и требует оригинальный текст. **Ограничьте доступ  
> к файлу БД:** он уже защищён правами `600 root:root`, но вы должны убедиться, что VPS не  
> скомпрометирован. Не используйте пароли VPN повторно на других сервисах.

---

## 🔧 Ключевые команды

```bash
# Управление сервисами
systemctl status caddy-naive mita
systemctl restart caddy-naive
systemctl restart mita

# Панель (PM2)
pm2 logs panel-naive-mieru
pm2 restart panel-naive-mieru
pm2 status

# Mieru
mita status
mita describe users
mita describe config
mita apply config /var/lib/rixxx-panel/mita-state.json
mita reload

# Caddy
caddy-naive validate --config /etc/caddy-naive/Caddyfile --adapter caddyfile
caddy-naive reload  --config /etc/caddy-naive/Caddyfile --adapter caddyfile

# Управление панелью
bash update.sh --status    # Проверка состояния
bash update.sh --repair    # Исправление сломанной установки
sudo bash uninstall.sh     # Полное удаление
```

---

## 📱 Клиентские приложения

### NaiveProxy
Формат ссылки: `naive+https://username:password@domain:443`

| Клиент | Платформа |
|--------|-----------|
| [ShadowRocket](https://apps.apple.com/app/shadowrocket/id932747118) | iOS |
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [NekoBox](https://github.com/MatsuriDayo/NekoBoxForAndroid) | Android |
| [naiveproxy](https://github.com/klzgrad/naiveproxy/releases) | CLI |

### Mieru (sing-box)
Скачайте **Mieru JSON** или **Универсальный конфиг** со страницы пользователей.

| Клиент | Платформа |
|--------|-----------|
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [Sing-box](https://apps.apple.com/app/sing-box/id6451272673) | iOS |
| [Sing-box](https://github.com/SagerNet/sing-box/releases) | Android / Windows / Linux / macOS |

### Hysteria2
Устанавливается **из коробки** вместе с Naive + Mieru и работает как третий протокол общего пула. Формат ссылки: `hysteria2://username:password@domain:443?sni=domain&insecure=0#username`.

| Клиент | Платформа |
|--------|-----------|
| [ShadowRocket](https://apps.apple.com/app/shadowrocket/id932747118) | iOS |
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [Hysteria](https://github.com/apernet/hysteria/releases) | CLI |

> ℹ️ Сервер использует `auth: userpass`, поэтому паролем на проводе является связка `username:password`. Для sing-box-клиентов (Karing) панель автоматически подставляет её в поле `password` — отдельного поля username у sing-box нет.

### 🔗 Sub-ссылка (одна «умная» подписка) — v1.8.7–1.8.8
Нажмите **«Sub-ссылка»** на карточке пользователя, чтобы скопировать единую ссылку вида
`https://sub.<домен>/sub/<token>`. Она **сама определяет клиент** по User-Agent и отдаёт нужный формат:

| Клиент | Формат | Протоколы |
|--------|--------|-----------|
| **Shadowrocket** | base64-список URI | Naive (нативная HTTPS-схема), Mieru (`mierus://`), Hysteria2 (`hysteria2://`) |
| **Karing** | sing-box JSON | Naive, Mieru, Hysteria2 (как JSON-outbound с `urltest`) |

- Ссылка передаёт клиенту **срок действия и трафик** через заголовок `Subscription-Userinfo`.
- Ручное переопределение формата: `?client=shadowrocket` / `?client=karing` или `?format=singbox`.
- Отдельный поддомен `sub.<домен>` настраивается в разделе настроек — Caddy сам выпускает TLS-сертификат.
- ✅ **Проверено на реальных устройствах в Karing и Shadowrocket** — все три протокола подключаются.

### Универсальный конфиг (urltest авто-выбор)
Содержит все включённые протоколы (NaiveProxy + Mieru + Hysteria2) с `urltest` — автоматически выбирает более быстрое соединение.

---

## 🏗 Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                         VPS                               │
│                                                          │
│  ┌──────────┐  порт 443     ┌──────────────────────┐    │
│  │  Клиент  │ ──HTTPS──────▶│    caddy-naive       │    │
│  │ (Naive)  │               │  (NaiveProxy HTTPS   │    │
│  └──────────┘               │   forward proxy)     │    │
│                             └──────────────────────┘    │
│                                                          │
│  ┌──────────┐  порты        ┌──────────────────────┐    │
│  │  Клиент  │  2012-2022    │        mita          │    │
│  │ (Mieru)  │ ──TCP/UDP────▶│    (Mieru proxy)     │    │
│  └──────────┘               └──────────────────────┘    │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │           Панель управления (Node.js + PM2)         │  │
│  │   127.0.0.1:3000  │  REST API  │  WebSocket  │  UI  │  │
│  │              SQLite DB (/var/lib/rixxx-panel/)      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─────────────────────┐   ┌────────────────────────┐   │
│  │  /etc/caddy-naive/  │   │ /var/lib/rixxx-panel/  │   │
│  │     Caddyfile       │   │   mita-state.json      │   │
│  └─────────────────────┘   └────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

---

## 🌐 Каскад / Relay (v1.2.6)

Настройте двухузловую цепочку прямо из панели (**Settings → Каскад**):

```
┌──────────┐   ┌────────────────────────────┐   ┌──────────────┐   ┌──────────┐
│  Клиент  │──▶│ Entry (RU)                 │──▶│ Exit (EU)    │──▶│ Интернет │
│          │   │ caddy-naive  → upstream    │   │ caddy-naive  │   │          │
│  Naive   │   │ mita (plain)               │   │ mita         │   │          │
│  + Mieru │   │ mieru-client→redsocks→ipt. │   │              │   │          │
└──────────┘   └────────────────────────────┘   └──────────────┘   └──────────┘
```

Провайдер RU видит только Entry-ноду; весь исходящий трафик уходит через Exit (EU).

### Что происходит под капотом

- **NaiveProxy** — в `Caddyfile` Entry-ноды добавляется директива `upstream https://user:pass@exit-host:443` внутри блока `forward_proxy`. Трафик клиента заворачивается на Exit-ноду перед выходом в интернет.
- **Mieru — вариант B (redsocks + iptables + mieru-client)**. Exit-нода — это полноценный сервер Mieru (`mita`), а не «сырой» SOCKS5, поэтому вместо native-egress используется прозрачный relay:
  1. `mieru-client` поднимает локальный SOCKS5 на `127.0.0.1:1080`, подключаясь к Exit-mita по протоколу Mieru (весь диапазон портов).
  2. `redsocks` (`127.0.0.1:12345`) превращает SOCKS5 в прозрачный редирект.
  3. `iptables` (цепочка `REDSOCKS`, owner-match по uid пользователя `mita`) заворачивает исходящий TCP-трафик Entry-mita в redsocks. RETURN-правило для IP Exit-ноды защищает от петли.
  4. `watchdog` (cron) перезапускает `mieru-client` после 3 подряд неудачных проверок.

  Entry-`mita` остаётся обычным сервером — в `mita-state.json` ничего не дописывается. Всю цепочку настраивает и сносит скрипт `panel/scripts/cascade_mieru.sh` (`setup` / `teardown` / `status`), который панель вызывает из API. `mieru-client` и `redsocks` ставятся **лениво** при первом включении каскада.

### Пред­условия

Установите **тот же скрипт** на обе ноды (RU = Entry, EU = Exit). На Exit-ноде просто заведите пользователей Mieru. Каскад настраивается **только на Entry-панели** — post-factum, второй сервер можно добавить позже.

### UI-управление

1. Откройте **Settings → Каскад**.
2. Включите галочку **«Включить каскад»**.
3. Заполните нужные «ноги» (можно одну из двух):
   - **Naive upstream URL** — `https://user:password@exit.example.com:443` (оставьте пустым, чтобы не каскадировать Naive).
   - **Mieru exit host / IP** — адрес Exit-ноды (домен или IP).
   - **Mieru exit port (start/end)** — диапазон портов Mieru на Exit-ноде (по умолчанию `2012–2022`).
   - **Mieru exit username / password** — учётные данные пользователя Mieru на Exit-ноде (поле пароля можно оставить пустым, чтобы не менять сохранённый).
4. Нажмите **Применить каскад**. Панель перепишет `Caddyfile` (Naive) и запустит/остановит relay через `cascade_mieru.sh` (Mieru). Первая установка может занять до минуты (ленивая установка пакетов).
5. Кнопка **«Проверить статус»** показывает состояние `mieru.service` / `redsocks`, наличие iptables-цепочки и текущий egress-IP.

> 💡 Каскад можно включать/выключать без удаления настроек — снимите галочку и нажмите «Применить»: relay будет аккуратно демонтирован (`teardown`), а пароль Exit-ноды сохранится для повторного включения.

> 🔒 Пароль Exit-ноды никогда не возвращается в браузер (`/api/config` отдаёт только флаг «задан/нет»).

---

## 🔄 Обновление одной командой

На сервере **не нужен** ни git, ни заранее скачанный `update.sh` — команда сама
скачивает свежий установщик обновления из `main` и запускает его. БД с ключами
(`/var/lib/rixxx-panel/db.sqlite`) и конфиг (`/etc/rixxx-panel/config.json`) при
обновлении **не трогаются**, плюс автоматически снимается бэкап (включая БД).

```bash
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

Начиная с v1.3.0 установщик кладёт `update.sh` и `VERSION` прямо в
`/opt/panel-naive-mieru`, поэтому в дальнейшем можно обновляться и так:

```bash
sudo bash /opt/panel-naive-mieru/update.sh -y
```

> **Как работает версия.** Источник истины — файл `VERSION` в корне репозитория.
> При релизе достаточно поднять номер в `VERSION` и запушить в `main`. `update.sh`
> сам сравнивает установленную версию с версией в `main` и обновляется, если
> `main` новее. Принудительно (без сверки версий): добавьте `--force`.

## 🔄 Справочник update.sh

```bash
# Обновиться одной командой (на проде, без git):
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y

bash update.sh                    # Интерактивное обновление
bash update.sh --dry-run          # Предпросмотр изменений (без записи)
bash update.sh --force -y         # Принудительное обновление, без сверки версий
bash update.sh --status           # Полный отчёт о состоянии
bash update.sh --repair           # Восстановление сломанных конфигов
bash update.sh --expose <домен>   # Публичный режим панели
bash update.sh --ssh-only         # Вернуться в SSH-only режим
bash update.sh --help             # Справка
```

---

## 🗑 Удаление

```bash
# Полное удаление (включая конфиги и базу данных)
sudo bash uninstall.sh
```

---

## 🛡 Безопасность

- Панель работает на `127.0.0.1:3000` — не доступна из интернета по умолчанию
- Пароль администратора хранится в bcrypt-хэше в `config.json` (chmod 600)
- SQLite БД в `/var/lib/rixxx-panel/` (только root)
- **Probe resistance**: неопознанные клиенты видят фейковый сайт вместо ошибки прокси
- **Без certbot**: Caddy управляет TLS автоматически через TLS-ALPN-01 (порт 80 не нужен)
- Временные конфиг-файлы удаляются через `shred -u`
- Rate limiting на login (20 запросов / 15 мин)
- Куки сессии `httpOnly`

---

## 🔧 Решение проблем

### Топ-5 распространённых проблем

**1. Ошибка синхронизации времени (Mieru не подключается)**
```bash
timedatectl status
timedatectl set-ntp true
# Mieru требует точность ±30 секунд между клиентом и сервером
```

**2. Конфликт портов**
```bash
ss -tlnup | grep -E '443|2012'
# Проверьте, не занят ли порт другим процессом
```

**3. mita не запускается**
```bash
journalctl -u mita -n 50
mita status
# Проверьте /var/lib/rixxx-panel/mita-state.json на валидность JSON
mita apply config /var/lib/rixxx-panel/mita-state.json
```

**4. Проблемы с TLS-сертификатом Caddy**
```bash
journalctl -u caddy-naive -n 50
caddy-naive validate --config /etc/caddy-naive/Caddyfile --adapter caddyfile
# Убедитесь, что домен указывает на IP сервера и порт 443 открыт
```

**5. Клиент не подключается**
```bash
# Чеклист:
# 1. Пинг домена с клиентского устройства
# 2. Время синхронизировано на обоих устройствах?
# 3. Порты открыты в UFW?
ufw status
# 4. Скачайте новый конфиг после любого изменения портов
# 5. Используйте правильный клиент (ShadowRocket / Karing / Sing-box)
```

---

## 📸 Скриншоты

> Скриншоты UI доступны в папке `docs/screenshots/` репозитория.

---

## 📋 Стек технологий

- **Установщик:** Bash (Ubuntu 20.04–24.04, Debian 11–12)
- **Панель:** Node.js 20 LTS + Express + better-sqlite3 + WebSocket
- **Процесс-менеджер:** PM2
- **NaiveProxy:** caddy-naive (Caddy + forward_proxy plugin)
- **Mieru:** mita (управляется через `mita apply config`)
- **Файрвол:** UFW
- **База данных:** SQLite (WAL mode)

---

## 📝 Кредиты

- **Автор:** RIXXX
- **Telegram:** [@russian_paradice_vpn](https://t.me/russian_paradice_vpn)
- **Донат:** [app.lava.top/2107724612](https://app.lava.top/2107724612?tabId=donate)
- **NaiveProxy:** [klzgrad/naiveproxy](https://github.com/klzgrad/naiveproxy)
- **Mieru:** [enfein/mieru](https://github.com/enfein/mieru)
- **Caddy:** [caddyserver.com](https://caddyserver.com)
- **Karing:** [KaringX/karing](https://github.com/KaringX/karing)
