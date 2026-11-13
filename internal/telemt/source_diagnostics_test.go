package telemt

import "testing"

func TestSanitizedDesiredSourceFailureRemainsConfigDiagnostic(t *testing.T) {
	for _, err := range []*APIError{
		{Status: 500, Code: "internal_error", Message: "$: Cannot load the desired configuration source", Details: []FieldIssue{{Path: "$", Code: "source_load_failed", Message: "Cannot load the desired configuration source"}}},
		{Status: 500, Code: "internal_error", Message: "$: Cannot load the desired configuration source"},
		{Status: 500, Code: "internal_error", Message: "Unavailable", Details: []FieldIssue{{Path: "$", Code: "source_load_failed", Message: "Unavailable"}}},
	} {
		got := DiagnoseError(err)
		if got.Code != "telemt_config_read_failed" {
			t.Errorf("sanitized source error classified as %q", got.Code)
		}
		if got.Message != "HTTP 500 · internal_error" {
			t.Errorf("unsafe source diagnostic: %s", got.Message)
		}
	}
}
