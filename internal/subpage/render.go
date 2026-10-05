package subpage

import (
	"io"
	"strconv"
	"strings"
)

var pageHTMLEscaper = strings.NewReplacer("\x00", "\uFFFD", "\"", "&#34;", "&", "&amp;", "'", "&#39;", "+", "&#43;", "<", "&lt;", ">", "&gt;")

func renderPageData(w io.Writer, data pageData) error {
	b := pageWriter{w: w}
	b.writeString("<!doctype html>\n<html lang=\"")
	b.writeString(pageHTMLEscaper.Replace(data.Lang))
	b.writeString("\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<meta name=\"theme-color\" content=\"#0e1319\" media=\"(prefers-color-scheme: dark)\">\n<meta name=\"theme-color\" content=\"#e9edf2\" media=\"(prefers-color-scheme: light)\">\n<title>")
	b.writeString(pageHTMLEscaper.Replace(data.S.Title))
	b.writeString(" — ")
	b.writeString(pageHTMLEscaper.Replace(data.Username))
	b.writeString("</title>\n<style>\n   \n  :root {\n    color-scheme: dark;\n    --bg: #0e1319;\n    --sur: #171e26;\n    --sur2: #1c242e;\n    --line: #1f2731;\n    --txt: #eef3f8;\n    --sec: #8fa0b0;\n    --mut: #7a8998;\n    --acc: #4a9bdd;\n    --acc-solid: #2b71ae;\n    --ok: #5ec97e;\n    --warn: #e0a63f;\n    --err: #e0655a;\n    --brand-a: #2e5c8a;\n    --brand-b: #4a9bdd;\n  }\n  @media (prefers-color-scheme: light) {\n    :root {\n      color-scheme: light;\n      --bg: #e9edf2;\n      --sur: #ffffff;\n      --sur2: #e7ecf1;\n      --line: #dbe2ea;\n      --txt: #17222c;\n      --sec: #54616f;\n      --mut: #626d79;\n      --acc: #1e6cb0;\n      --acc-solid: #1e6cb0;\n      --ok: #177a45;\n      --warn: #8a5c0a;\n      --err: #b53a2e;\n      --brand-a: #244c76;\n      --brand-b: #3880be;\n    }\n  }\n\n  * { box-sizing: border-box; }\n  body {\n    margin: 0;\n    background: var(--bg);\n    color: var(--txt);\n    font-family: ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif;\n    font-variant-numeric: tabular-nums;\n    -webkit-font-smoothing: antialiased;\n    line-height: 1.5;\n  }\n  main {\n    max-width: 430px;\n    margin: 0 auto;\n    padding: 28px 20px 40px;\n    display: flex;\n    flex-direction: column;\n    gap: 14px;\n  }\n  :focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }\n\n   \n  header { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 6px 0 2px; }\n  .avatar {\n    display: inline-flex; align-items: center; justify-content: center;\n    width: 58px; height: 58px; border-radius: 50%;\n    background: linear-gradient(135deg, var(--brand-a), var(--brand-b));\n    color: #fff; font-size: 19px; font-weight: 700;\n  }\n  h1 {\n    margin: 2px 0 0; font-size: 20px; font-weight: 800; letter-spacing: -0.02em;\n    text-align: center; word-break: break-all;\n  }\n  .sr-only {\n    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;\n    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;\n  }\n  .status {\n    display: inline-flex; align-items: center; gap: 6px;\n    padding: 5px 12px; border-radius: 99px; font-size: 12px; font-weight: 600;\n  }\n  .status::before { content: \"\"; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }\n  .status-active { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }\n  .status-quota_exhausted { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }\n  .status-disabled,\n  .status-expired { color: var(--err); background: color-mix(in srgb, var(--err) 14%, transparent); }\n\n   \n  .card { background: var(--sur); border-radius: 16px; padding: 16px; }\n  .card + .card { margin-top: 0; }\n  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 12px; color: var(--sec); }\n  .row .v { color: var(--txt); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n  .quota { margin: 0; }\n  .expiry { margin: 12px 0 0; padding-top: 12px; border-top: 1px solid var(--line); }\n  .bar { height: 8px; background: var(--line); border-radius: 99px; margin-top: 8px; overflow: hidden; }\n  .bar-fill { height: 100%; background: var(--acc); border-radius: 99px; }\n  .bar-fill.warn { background: var(--warn); }\n  .bar-fill.full { background: var(--err); }\n  .reset { margin: 10px 0 0; }\n\n   \n  .caption {\n    margin: 8px 0 -4px; font-size: 11.5px; font-weight: 600;\n    text-transform: uppercase; letter-spacing: 0.06em; color: var(--mut);\n  }\n  h2, h3 { margin: 0; }\n\n   \n  .connect { display: flex; flex-direction: column; gap: 14px; }\n  .variant { display: flex; flex-direction: column; gap: 10px; }\n  .domain {\n    margin: 0; align-self: flex-start;\n    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n    font-size: 11.5px; color: var(--acc);\n    background: color-mix(in srgb, var(--acc) 12%, transparent);\n    padding: 4px 10px; border-radius: 99px; word-break: break-all;\n  }\n  .btn-primary {\n    display: flex; align-items: center; justify-content: center; gap: 10px;\n    width: 100%; min-height: 54px; padding: 0 16px;\n    background: var(--acc-solid); color: #fff; text-decoration: none;\n    border-radius: 14px; font-size: 15px; font-weight: 700;\n  }\n  .btn-primary svg { flex: none; }\n  .btn-secondary {\n    display: flex; align-items: center; justify-content: center;\n    width: 100%; min-height: 44px;\n    background: color-mix(in srgb, var(--acc) 10%, transparent);\n    color: var(--acc); text-decoration: none;\n    border-radius: 12px; font-size: 13px; font-weight: 600;\n  }\n  .qr-card { display: flex; flex-direction: column; align-items: center; gap: 10px; }\n  .qr { display: block; width: 180px; height: 180px; border-radius: 12px; background: #fff; padding: 8px; }\n  .qr-hint { font-size: 11.5px; color: var(--sec); text-align: center; }\n  .empty { margin: 0; font-size: 13px; color: var(--sec); }\n\n   \n  details.manual { background: var(--sur); border-radius: 16px; overflow: hidden; }\n  details.manual > summary {\n    display: flex; align-items: center; min-height: 52px; padding: 0 16px;\n    font-size: 13.5px; font-weight: 600; color: var(--txt); cursor: pointer;\n    list-style: none;\n  }\n  details.manual > summary::-webkit-details-marker { display: none; }\n  details.manual > summary::after {\n    content: \"\"; margin-left: auto; width: 8px; height: 8px;\n    border-right: 2px solid var(--mut); border-bottom: 2px solid var(--mut);\n    transform: rotate(45deg) translate(-2px, -2px);\n    transition: transform 0.15s;\n  }\n  details.manual[open] > summary::after { transform: rotate(-135deg) translate(-2px, -2px); }\n  .fields {\n    margin: 0; padding: 6px 16px 14px; border-top: 1px solid var(--line);\n    display: grid; grid-template-columns: 64px 1fr; column-gap: 10px; align-items: center;\n  }\n  .fields dt { font-size: 11px; color: var(--sec); }\n  .fields dd {\n    margin: 0; display: flex; align-items: center; gap: 10px; min-height: 44px;\n  }\n  .fields code {\n    flex: 1; min-width: 0;\n    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n    font-size: 12.5px; color: var(--txt); word-break: break-all;\n  }\n  button.copy {\n    flex: none; background: var(--sur2); border: none; border-radius: 8px;\n    color: var(--acc); font-size: 11px; font-weight: 600; font-family: inherit;\n    min-height: 32px; padding: 0 12px; cursor: pointer;\n  }\n  button.copy:hover { background: var(--line); }\n\n   \n  details.instructions { background: var(--sur); border-radius: 16px; overflow: hidden; }\n  details.instructions > summary {\n    display: flex; align-items: center; min-height: 52px; padding: 0 16px;\n    font-size: 13px; font-weight: 600; color: var(--sec); cursor: pointer;\n    list-style: none;\n  }\n  details.instructions > summary::-webkit-details-marker { display: none; }\n  details.instructions p {\n    margin: 0; padding: 10px 16px; font-size: 12px; line-height: 1.6; color: var(--sec);\n    border-top: 1px solid var(--line);\n  }\n  details.instructions strong { color: var(--txt); }\n</style>\n</head>\n<body>\n<main>\n  <header>\n    <span class=\"avatar\" aria-hidden=\"true\">")
	b.writeString(pageHTMLEscaper.Replace(data.Initial))
	b.writeString("</span>\n    <h1>")
	b.writeString(pageHTMLEscaper.Replace(data.S.AccessFor))
	b.writeString(" ")
	b.writeString(pageHTMLEscaper.Replace(data.Username))
	b.writeString("</h1>\n    <span class=\"status status-")
	b.writeString(pageHTMLEscaper.Replace(data.Status.Key))
	b.writeString("\">")
	b.writeString(pageHTMLEscaper.Replace(data.Status.Label))
	b.writeString("</span>\n  </header>\n\n  ")
	if data.Quota != nil || data.Expiry != nil {
		b.writeString("\n  <div class=\"card\">\n    ")
		if data.Quota != nil {
			b.writeString("\n    <section class=\"quota\">\n      <div class=\"row\"><span>")
			b.writeString(pageHTMLEscaper.Replace(data.S.QuotaHeading))
			b.writeString("</span><span class=\"v\">")
			b.writeString(pageHTMLEscaper.Replace(data.Quota.UsedHuman))
			b.writeString(" ")
			b.writeString(pageHTMLEscaper.Replace(data.S.QuotaUsedOf))
			b.writeString(" ")
			b.writeString(pageHTMLEscaper.Replace(data.Quota.TotalHuman))
			b.writeString("</span></div>\n      <div class=\"bar\"><div class=\"bar-fill")
			if data.Quota.Percent >= 100 {
				b.writeString(" full")
			} else if data.Quota.Percent >= 80 {
				b.writeString(" warn")
			}
			b.writeString("\" style=\"width:")
			b.writeString(strconv.Itoa(data.Quota.Percent))
			b.writeString("%\"></div></div>\n      ")
			if data.Quota.ResetHuman != "" {
				b.writeString("<div class=\"row reset\"><span>")
				b.writeString(pageHTMLEscaper.Replace(data.S.QuotaResetLabel))
				b.writeString(":</span><span class=\"v\">")
				b.writeString(pageHTMLEscaper.Replace(data.Quota.ResetHuman))
				b.writeString("</span></div>")
			}
			b.writeString("\n    </section>\n    ")
		}
		b.writeString("\n    ")
		if data.Expiry != nil {
			b.writeString("\n    <section class=\"expiry\">\n      <div class=\"row\"><span>")
			b.writeString(pageHTMLEscaper.Replace(data.S.ExpiryLabel))
			b.writeString("</span><span class=\"v\">")
			b.writeString(pageHTMLEscaper.Replace(data.Expiry.Formatted))
			b.writeString("</span></div>\n    </section>\n    ")
		}
		b.writeString("\n  </div>\n  ")
	}
	b.writeString("\n\n  <section class=\"connect\">\n    <h2 class=\"sr-only\">")
	b.writeString(pageHTMLEscaper.Replace(data.S.ConnectHeading))
	b.writeString("</h2>\n    ")
	if len(data.Groups) == 0 {
		b.writeString("\n    <p class=\"empty\">")
		b.writeString(pageHTMLEscaper.Replace(data.S.NoLinks))
		b.writeString("</p>\n    ")
	}
	b.writeString("\n    ")
	for _, group := range data.Groups {
		b.writeString("\n    <h3 class=\"caption\">")
		b.writeString(pageHTMLEscaper.Replace(group.Title))
		b.writeString("</h3>\n    ")
		for _, variant := range group.Variants {
			b.writeString("\n    <div class=\"variant\">\n      ")
			if variant.Domain != "" {
				b.writeString("<p class=\"domain\">")
				b.writeString(pageHTMLEscaper.Replace(variant.Domain))
				b.writeString("</p>")
			}
			b.writeString("\n      <a class=\"btn-primary\" href=\"")
			b.writeString(pageHTMLEscaper.Replace(normalizePageURL(variant.TgURL)))
			b.writeString("\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M21.9 4.6 18.9 19c-.2 1-.8 1.2-1.6.8l-4.6-3.4-2.2 2.1c-.2.3-.5.5-.9.5l.3-4.6L18.3 7c.4-.3-.1-.5-.6-.2L7.4 13.3 3 11.9c-1-.3-1-1 .2-1.4l17.3-6.7c.8-.3 1.5.2 1.4.8z\"></path></svg>")
			b.writeString(pageHTMLEscaper.Replace(data.S.OpenInTelegram))
			b.writeString("</a>\n      ")
			if variant.TMeURL != "" {
				b.writeString("<a class=\"btn-secondary\" href=\"")
				b.writeString(pageHTMLEscaper.Replace(normalizePageURL(variant.TMeURL)))
				b.writeString("\">")
				b.writeString(pageHTMLEscaper.Replace(data.S.OpenViaTMe))
				b.writeString("</a>")
			}
			b.writeString("\n      ")
			if variant.Web {
				b.writeString("<p class=\"empty\">")
				b.writeString(pageHTMLEscaper.Replace(data.S.WEBHint))
				b.writeString("</p>")
			}
			b.writeString("\n      <div class=\"card qr-card\">\n        <img class=\"qr\" src=\"")
			b.writeString(pageHTMLEscaper.Replace(normalizePageURL(variant.QRDataURI)))
			b.writeString("\" alt=\"QR\" width=\"256\" height=\"256\">\n        <span class=\"qr-hint\">")
			b.writeString(pageHTMLEscaper.Replace(data.S.ScanHint))
			b.writeString("</span>\n      </div>\n      <details class=\"manual\">\n        <summary>")
			b.writeString(pageHTMLEscaper.Replace(data.S.ManualParams))
			b.writeString("</summary>\n        <dl class=\"fields\">\n          <dt>")
			b.writeString(pageHTMLEscaper.Replace(data.S.FieldServer))
			b.writeString("</dt>\n          <dd><code>")
			b.writeString(pageHTMLEscaper.Replace(variant.Server))
			b.writeString("</code><button type=\"button\" class=\"copy\" data-copy data-copied=\"")
			b.writeString(pageHTMLEscaper.Replace(data.S.CopiedButton))
			b.writeString("\">")
			b.writeString(pageHTMLEscaper.Replace(data.S.CopyButton))
			b.writeString("</button></dd>\n          ")
			if variant.Port != "" {
				b.writeString("<dt>")
				b.writeString(pageHTMLEscaper.Replace(data.S.FieldPort))
				b.writeString("</dt>\n          <dd><code>")
				b.writeString(pageHTMLEscaper.Replace(variant.Port))
				b.writeString("</code><button type=\"button\" class=\"copy\" data-copy data-copied=\"")
				b.writeString(pageHTMLEscaper.Replace(data.S.CopiedButton))
				b.writeString("\">")
				b.writeString(pageHTMLEscaper.Replace(data.S.CopyButton))
				b.writeString("</button></dd>\n          ")
			}
			b.writeString("\n          <dt>")
			b.writeString(pageHTMLEscaper.Replace(data.S.FieldSecret))
			b.writeString("</dt>\n          <dd><code>")
			b.writeString(pageHTMLEscaper.Replace(variant.Secret))
			b.writeString("</code><button type=\"button\" class=\"copy\" data-copy data-copied=\"")
			b.writeString(pageHTMLEscaper.Replace(data.S.CopiedButton))
			b.writeString("\">")
			b.writeString(pageHTMLEscaper.Replace(data.S.CopyButton))
			b.writeString("</button></dd>\n        </dl>\n        <p role=\"status\" data-copy-feedback data-manual=\"")
			b.writeString(pageHTMLEscaper.Replace(data.S.CopyManually))
			b.writeString("\"></p>\n      </details>\n    </div>\n    ")
		}
		b.writeString("\n    ")
	}
	b.writeString("\n  </section>\n\n  <details class=\"instructions\"")
	if data.Lang == "ru" {
		b.writeString(" open")
	}
	b.writeString(">\n    <summary>")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsRU.Heading))
	b.writeString("</summary>\n    <p><strong>iOS:</strong> ")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsRU.IOS))
	b.writeString("</p>\n    <p><strong>Android:</strong> ")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsRU.Android))
	b.writeString("</p>\n    <p><strong>Desktop:</strong> ")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsRU.Desktop))
	b.writeString("</p>\n  </details>\n  <details class=\"instructions\"")
	if data.Lang == "en" {
		b.writeString(" open")
	}
	b.writeString(">\n    <summary>")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsEN.Heading))
	b.writeString("</summary>\n    <p><strong>iOS:</strong> ")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsEN.IOS))
	b.writeString("</p>\n    <p><strong>Android:</strong> ")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsEN.Android))
	b.writeString("</p>\n    <p><strong>Desktop:</strong> ")
	b.writeString(pageHTMLEscaper.Replace(data.InstructionsEN.Desktop))
	b.writeString("</p>\n  </details>\n</main>\n<script>\ndocument.addEventListener('click', async function (e) {\n  var btn = e.target.closest('[data-copy]');\n  if (!btn) return;\n  var code = btn.previousElementSibling;\n  if (!code) return;\n  var feedback = btn.closest('details').querySelector('[data-copy-feedback]');\n  var copied = false;\n  try {\n    await navigator.clipboard.writeText(code.textContent);\n    copied = true;\n  } catch (_) {\n    \n    var selection = window.getSelection();\n    if (selection) {\n      var range = document.createRange();\n      range.selectNodeContents(code);\n      selection.removeAllRanges();\n      selection.addRange(range);\n      try { copied = document.execCommand('copy'); } catch (_) {}\n    }\n  }\n  feedback.textContent = copied ? '' : feedback.getAttribute('data-manual');\n  if (copied) {\n    var prev = btn.textContent;\n    btn.textContent = btn.getAttribute('data-copied') || prev;\n    setTimeout(function () { btn.textContent = prev; }, 1200);\n  }\n});\n</script>\n</body>\n</html>\n")
	return b.err
}

// The trusted-URL normalization rule follows Go html/template/url.go.
func normalizePageURL(s string) string {
	var b strings.Builder
	const digits = "0123456789abcdef"
	for i := 0; i < len(s); i++ {
		c := s[i]
		safe := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$&*+,/:;=?@[]-._~", c) >= 0
		if c == '%' && i+2 < len(s) && isURLHex(s[i+1]) && isURLHex(s[i+2]) {
			safe = true
		}
		if safe {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(digits[c>>4])
			b.WriteByte(digits[c&15])
		}
	}
	return b.String()
}
func isURLHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// The HTTP handler already buffers the complete page before committing status.
// Reuse that writer instead of retaining another full response in the renderer.
type pageWriter struct {
	w   io.Writer
	err error
}

func (b *pageWriter) writeString(s string) {
	if b.err != nil {
		return
	}
	n, err := io.WriteString(b.w, s)
	if err == nil && n != len(s) {
		err = io.ErrShortWrite
	}
	b.err = err
}
