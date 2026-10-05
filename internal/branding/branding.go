// Package branding keeps panel appearance in local control state. Images are
// validated and cached when settings are saved, never read by public requests.
package branding

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"unicode"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
)

const settingKey = "panel.branding"

// Config is the administrator-only appearance configuration.
type Config struct {
	Title    string `json:"title"`
	LogoMode string `json:"logo_mode"`
	LogoPath string `json:"logo_path"`
}

// Public contains only information already visible on the login screen.
type Public struct {
	Title    string `json:"title"`
	LogoMode string `json:"logo_mode"`
	LogoURL  string `json:"logo_url"`
	IconURL  string `json:"icon_url"`
}

// Settings also reports whether the configured image could be loaded.
type Settings struct {
	Config
	LogoStatus string `json:"logo_status"`
	Public     Public `json:"public"`
}

type settingsStore interface {
	GetSetting(string) (string, bool, error)
	SetSetting(string, string) error
}

type snapshot struct {
	Settings
	logo, icon, icon512 []byte
	mime, version       string
}

// Manager publishes immutable snapshots after successful persistence.
type Manager struct {
	st       settingsStore
	basePath string
	mu       sync.Mutex
	current  atomic.Pointer[snapshot]
}

var (
	ErrTitle = errors.New("branding_invalid_title")
	ErrMode  = errors.New("branding_invalid_mode")
	ErrPath  = errors.New("branding_invalid_path")
	ErrRead  = errors.New("branding_logo_unreadable")
	ErrImage = errors.New("branding_invalid_image")
)

// New restores appearance without making a missing image fatal to login.
func New(st settingsStore, basePath string) *Manager {
	m := &Manager{st: st, basePath: basePath}
	cfg := Config{Title: "Telemt Panel", LogoMode: "default"}
	if raw, ok, err := st.GetSetting(settingKey); err == nil && ok {
		var saved Config
		if json.Unmarshal([]byte(raw), &saved) == nil && validate(&saved) == nil {
			cfg = saved
		}
	}
	s, err := m.prepare(cfg)
	if err != nil {
		s = m.empty(cfg)
		s.LogoStatus = "unavailable"
		m.setURLs(s)
	}
	m.current.Store(s)
	return m
}

// Settings returns the administrator-only configuration and safe projection.
func (m *Manager) Settings() Settings { return m.current.Load().Settings }

// Public returns appearance without disclosing filesystem paths or errors.
func (m *Manager) Public() Public { return m.current.Load().Public }

// Save rereads the image even when its path has not changed.
func (m *Manager) Save(cfg Config) (Settings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := validate(&cfg); err != nil {
		return Settings{}, err
	}
	s, err := m.prepare(cfg)
	if err != nil {
		return Settings{}, err
	}
	raw, _ := json.Marshal(cfg)
	if err := m.st.SetSetting(settingKey, string(raw)); err != nil {
		return Settings{}, err
	}
	m.current.Store(s)
	return s.Settings, nil
}

// Asset returns immutable cached image bytes. Callers must not modify them.
func (m *Manager) Asset(iconSize int) (body []byte, contentType, version string) {
	s := m.current.Load()
	if iconSize == 512 {
		return s.icon512, "image/png", s.version + "-512"
	}
	if iconSize == 192 {
		return s.icon, "image/png", s.version + "-192"
	}
	return s.logo, s.mime, s.version
}

func validate(c *Config) error {
	c.Title = strings.TrimSpace(c.Title)
	if !utf8.ValidString(c.Title) || utf8.RuneCountInString(c.Title) < 1 || utf8.RuneCountInString(c.Title) > 80 || strings.ContainsFunc(c.Title, unicode.IsControl) {
		return ErrTitle
	}
	switch c.LogoMode {
	case "default", "hidden":
		c.LogoPath = ""
	case "custom":
		if !filepath.IsAbs(c.LogoPath) || len(c.LogoPath) > 4096 || strings.ContainsRune(c.LogoPath, 0) {
			return ErrPath
		}
	default:
		return ErrMode
	}
	return nil
}

var transparent192 = renderIcon(nil, 192)
var transparent512 = renderIcon(nil, 512)

func (m *Manager) empty(cfg Config) *snapshot {
	// A transparent icon prevents the previous branded favicon reappearing
	// in hidden mode, or when a custom file is unavailable after restart.
	s := &snapshot{Settings: Settings{Config: cfg, LogoStatus: "none", Public: Public{Title: cfg.Title, LogoMode: cfg.LogoMode}}, icon: transparent192, icon512: transparent512}
	return s
}

func (m *Manager) prepare(cfg Config) (*snapshot, error) {
	s := m.empty(cfg)
	if cfg.LogoMode == "custom" {
		body, img, format, err := readImage(cfg.LogoPath)
		if err != nil {
			return nil, err
		}
		s.logo, s.mime = body, "image/"+format
		s.icon, s.icon512, s.LogoStatus = renderIcon(img, 192), renderIcon(img, 512), "ready"
	}
	m.setURLs(s)
	return s, nil
}

func renderIcon(img image.Image, size int) []byte {
	icon := image.NewNRGBA(image.Rect(0, 0, size, size))
	if img != nil {
		bounds := img.Bounds()
		w, h := bounds.Dx(), bounds.Dy()
		if w >= h {
			h = max(1, h*size/w)
			w = size
		} else {
			w = max(1, w*size/h)
			h = size
		}
		scaleIcon(icon, image.Rect((size-w)/2, (size-h)/2, (size-w)/2+w, (size-h)/2+h), img)
	}
	var b bytes.Buffer
	// Encoding a bounded NRGBA image into a bytes.Buffer cannot fail.
	_ = png.Encode(&b, icon)
	return b.Bytes()
}

func (m *Manager) setURLs(s *snapshot) {
	hash := sha256.Sum256(append(append([]byte(s.Config.LogoMode), s.logo...), s.icon...))
	s.version = hex.EncodeToString(hash[:12])
	if len(s.logo) > 0 {
		s.Public.LogoURL = m.basePath + "/api/branding/logo?v=" + s.version
	}
	if s.Config.LogoMode != "default" {
		s.Public.IconURL = m.basePath + "/api/branding/icon?v=" + s.version
	}
}

func readImage(path string) ([]byte, image.Image, string, error) {
	// Nonblocking open also makes a FIFO supplied as a path fail promptly.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, "", ErrRead
	}
	defer f.Close()
	info, err := f.Stat()
	const maxBytes = 5 << 20
	if err != nil || !info.Mode().IsRegular() {
		return nil, nil, "", ErrRead
	}
	if info.Size() > maxBytes {
		return nil, nil, "", ErrImage
	}
	b, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, nil, "", ErrRead
	}
	if len(b) > maxBytes {
		return nil, nil, "", ErrImage
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || (format != "png" && format != "jpeg" && format != "webp") || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 4096 || cfg.Height > 4096 || int64(cfg.Width)*int64(cfg.Height) > 8_000_000 {
		return nil, nil, "", ErrImage
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, nil, "", ErrImage
	}
	return b, img, format, nil
}
