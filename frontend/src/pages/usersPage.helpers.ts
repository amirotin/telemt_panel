export interface TlsDomainLink {
  domain: string;
  link: string;
}

export interface UserLinks {
  classic?: string[];
  secure?: string[];
  tls?: string[];
  tls_domains?: TlsDomainLink[];
}

export interface ProxyLinkOption {
  url: string;
  domain: string;
  isDefault: boolean;
}

// One WEB vhost profile from GET /api/telemt/web/profiles (Telemt 3.5.2+).
export interface WebProfile {
  host: string;
  user: string;
  secret_mode: string; // "plain" | "dd"
}

export interface ProxyLinkGroup {
  label: string;
  links: ProxyLinkOption[];
}

function getServer(raw: string): string {
  try {
    return new URL(raw).searchParams.get('server') ?? '';
  } catch {
    return raw.match(/[?&]server=([^&]*)/)?.[1] ?? '';
  }
}

function getSecret(raw: string): string {
  try {
    return new URL(raw).searchParams.get('secret') ?? '';
  } catch {
    return raw.match(/[?&]secret=([^&]*)/)?.[1] ?? '';
  }
}

// extractPlainSecret recovers the user's bare 32-hex secret from existing
// links: classic carries it as-is, secure with a "dd" prefix, fake-TLS with
// "ee" + secret + hex(SNI domain). The tls fallback matters most in the
// field: faketls-only setups have empty classic/secure arrays (#117 follow-up).
// The Users API does not expose the secret directly.
export function extractPlainSecret(links: UserLinks | undefined): string {
  const classic = getSecret(links?.classic?.[0] ?? '');
  if (/^[0-9a-fA-F]{32}$/.test(classic)) return classic;
  const secure = getSecret(links?.secure?.[0] ?? '');
  if (/^dd[0-9a-fA-F]{32}$/i.test(secure)) return secure.slice(2);
  const tls = getSecret(links?.tls?.[0] ?? '');
  const m = /^ee([0-9a-fA-F]{32})/i.exec(tls);
  if (m) return m[1];
  return '';
}

// buildWebProxyLinks assembles tg://webproxy links (Telemt 3.5.2+ WEB mode)
// for this user from the vhost profiles. The API does not return them; the
// scheme has no port (always 443) and no comment parameter.
export function buildWebProxyLinks(
  links: UserLinks | undefined,
  username: string,
  webProfiles: WebProfile[] | undefined,
): ProxyLinkOption[] {
  if (!webProfiles?.length) return [];
  const secret = extractPlainSecret(links);
  if (!secret) return [];
  return webProfiles
    .filter((p) => p.user === username)
    .map((p) => ({
      url: `tg://webproxy?server=${p.host}&secret=${p.secret_mode === 'dd' ? 'dd' : ''}${secret}`,
      domain: p.host,
      isDefault: true,
    }));
}

function appendComment(raw: string, username: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.set('comment', username);
    return u.toString();
  } catch {
    const sep = raw.includes('?') ? '&' : '?';
    return raw + sep + 'comment=' + encodeURIComponent(username);
  }
}

export function buildProxyLinks(
  links: UserLinks | undefined,
  username: string,
  webProfiles?: WebProfile[],
): ProxyLinkGroup[] {
  if (!links) return [];

  const result: ProxyLinkGroup[] = [];
  const makeLink = (rawUrl: string, domain: string, isDefault: boolean): ProxyLinkOption => ({
      url: appendComment(rawUrl, username),
      domain,
      isDefault,
  });
  const addGroup = (label: string, groupLinks: ProxyLinkOption[]) => {
    if (groupLinks.length > 0) result.push({ label, links: groupLinks });
  };

  if (links.tls?.length) {
    const maskByLink = new Map((links.tls_domains ?? []).map((d) => [d.link, d.domain]));
    const tls = links.tls
      .map((url) => makeLink(url, maskByLink.get(url) ?? getServer(url), !maskByLink.has(url)))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    addGroup('TLS', tls);
  }
  addGroup('Secure', (links.secure ?? []).map((url) => makeLink(url, getServer(url), true)));
  addGroup('Classic', (links.classic ?? []).map((url) => makeLink(url, getServer(url), true)));
  addGroup('WEB', buildWebProxyLinks(links, username, webProfiles));

  return result;
}
