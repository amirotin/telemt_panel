package subpage

import (
	_ "embed"
	"html/template"
)

//go:embed templates/page.html.tmpl
var pageTemplateSource string

// pageTemplate is parsed once at init; the source is a fixed embedded
// asset, so a parse failure here is a build-time bug, not a runtime one.
var pageTemplate = template.Must(template.New("page").Parse(pageTemplateSource))
