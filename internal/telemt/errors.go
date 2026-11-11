package telemt

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// ErrorDiagnostic describes a failed operation without exposing response bodies or URLs.
type ErrorDiagnostic struct {
	Code    string
	Message string
}

// DiagnoseError distinguishes upstream rejections, bad responses and connection failures.
func DiagnoseError(err error) ErrorDiagnostic {
	diagnostic := ErrorDiagnostic{Code: errorCode(err), Message: "Telemt request failed"}
	if errors.Is(err, ErrResponseTooLarge) {
		limit := maxResponseBytes
		var sizeErr *responseTooLargeError
		if errors.As(err, &sizeErr) {
			limit = sizeErr.limit
		}
		diagnostic.Message = fmt.Sprintf("Telemt response exceeds %d MiB limit", limit/1024/1024)
		return diagnostic
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status >= 100 && apiErr.Status <= 599 {
		diagnostic.Message = fmt.Sprintf("HTTP %d", apiErr.Status)
		if validDiagnosticCode(apiErr.Code) {
			diagnostic.Message += " · " + apiErr.Code
		}
		if apiErr.RequestID != 0 {
			diagnostic.Message += " · #" + strconv.FormatUint(apiErr.RequestID, 10)
		}
	}
	return diagnostic
}

func errorCode(err error) string {
	if errors.Is(err, ErrInvalidResponse) {
		return "telemt_invalid_response"
	}
	if errors.Is(err, ErrResponseTooLarge) {
		return "telemt_response_too_large"
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		if apiErr.Status == http.StatusUnauthorized {
			return "telemt_auth_failed"
		}
		if apiErr.Status == http.StatusGatewayTimeout {
			return "telemt_timeout"
		}
		if apiErr.Status >= 400 && apiErr.Status < 500 {
			switch apiErr.Code {
			case "read_only", "forbidden", "not_found", "rate_limited", "capability_absent":
				return apiErr.Code
			}
		}
		if apiErr.Status >= 500 {
			// Newer Telemt sanitizes source failures and reports their category
			// through field diagnostics; the underlying OS failure is unknown.
			for _, issue := range apiErr.Details {
				if issue.Code == "source_load_failed" {
					return "telemt_config_read_failed"
				}
			}
			message := strings.ToLower(apiErr.Message)
			if strings.Contains(message, "cannot load the desired configuration source") {
				return "telemt_config_read_failed"
			}
			write := strings.HasPrefix(message, "failed to write config:")
			read := strings.HasPrefix(message, "failed to read config") ||
				strings.HasPrefix(message, "failed to load config:") ||
				strings.HasPrefix(message, "failed to verify config graph:")
			if write || read {
				switch {
				case strings.Contains(message, "permission denied"), strings.Contains(message, "operation not permitted"):
					return "telemt_config_permission_denied"
				case strings.Contains(message, "read-only file system"):
					return "telemt_config_read_only"
				case strings.Contains(message, "no space left on device"), strings.Contains(message, "disk quota exceeded"):
					return "telemt_config_storage_full"
				case write:
					return "telemt_config_write_failed"
				default:
					return "telemt_config_read_failed"
				}
			}
		}
		return "telemt_api_error"
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return "telemt_timeout"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "telemt_dns_failed"
	}
	var authorityErr x509.UnknownAuthorityError
	var certificateErr x509.CertificateInvalidError
	var hostnameErr x509.HostnameError
	if errors.As(err, &authorityErr) || errors.As(err, &certificateErr) || errors.As(err, &hostnameErr) {
		return "telemt_tls_failed"
	}
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &syntaxErr) || errors.As(err, &typeErr) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "telemt_invalid_response"
	}
	return "telemt_unreachable"
}

func validDiagnosticCode(code string) bool {
	if len(code) == 0 || len(code) > 64 || code[0] < 'a' || code[0] > 'z' {
		return false
	}
	for _, char := range code {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}
	return true
}
