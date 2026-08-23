import { buildProxyLinks } from './usersPage.helpers';

const username = 'alice';

function assertDeepEqual(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

const tlsLinks = buildProxyLinks(
  {
    tls: [
      'tg://proxy?server=edge.example&port=443&secret=tls-default',
      'tg://proxy?server=edge.example&port=443&secret=tls-mask',
    ],
    tls_domains: [
      {
        domain: 'cdn.example',
        link: 'tg://proxy?server=edge.example&port=443&secret=tls-mask',
      },
    ],
  },
  username,
);

assertDeepEqual(
  tlsLinks.map((group) => ({
    label: group.label,
    links: group.links.map((link) => ({
      domain: link.domain,
      isDefault: link.isDefault,
      url: link.url,
    })),
  })),
  [
    {
      label: 'TLS',
      links: [
        {
          domain: 'edge.example',
          isDefault: true,
          url: 'tg://proxy?server=edge.example&port=443&secret=tls-default&comment=alice',
        },
        {
          domain: 'cdn.example',
          isDefault: false,
          url: 'tg://proxy?server=edge.example&port=443&secret=tls-mask&comment=alice',
        },
      ],
    },
  ],
);

assertDeepEqual(
  buildProxyLinks(
    {
      secure: ['tg://proxy?server=secure.example&port=443&secret=secure-secret'],
    },
    username,
  ).map((group) => [group.label, group.links.map((link) => [link.domain, link.isDefault])]),
  [['Secure', [['secure.example', true]]]],
);

assertDeepEqual(
  buildProxyLinks(
    {
      classic: ['tg://proxy?server=classic.example&port=443&secret=classic-secret'],
    },
    username,
  ).map((group) => [group.label, group.links.map((link) => [link.domain, link.isDefault])]),
  [['Classic', [['classic.example', true]]]],
);

assertDeepEqual(
  buildProxyLinks(
    {
      tls: ['tg://proxy?server=edge.example&port=443&secret=tls-default'],
      secure: ['tg://proxy?server=secure.example&port=443&secret=secure-secret'],
    },
    username,
  ).map((group) => ({
    label: group.label,
    links: group.links.map((link) => link.domain),
  })),
  [
    { label: 'TLS', links: ['edge.example'] },
    { label: 'Secure', links: ['secure.example'] },
  ],
);

// --- WEB proxy links (Telemt 3.5.2+) ---

const secret = '0123456789abcdef0123456789abcdef';
const webProfiles = [
  { host: 'proxy.example.com', user: 'alice', secret_mode: 'dd' },
  { host: 'second.example.net', user: 'alice', secret_mode: 'plain' },
  { host: 'proxy.example.com', user: 'bob', secret_mode: 'plain' },
];

// Secret recovered from the classic link; only alice's profiles used;
// dd prefix applied per profile; no comment parameter appended.
const webGroups = buildProxyLinks(
  { classic: [`tg://proxy?server=host.example&port=443&secret=${secret}`] },
  'alice',
  webProfiles,
);
assertDeepEqual(
  webGroups.map((g) => ({ label: g.label, urls: g.links.map((l) => l.url) })),
  [
    {
      label: 'Classic',
      urls: [`tg://proxy?server=host.example&port=443&secret=${secret}&comment=alice`],
    },
    {
      label: 'WEB',
      urls: [
        `tg://webproxy?server=proxy.example.com&secret=dd${secret}`,
        `tg://webproxy?server=second.example.net&secret=${secret}`,
      ],
    },
  ],
);

// Secret recoverable from the dd-prefixed secure link too.
const webFromSecure = buildProxyLinks(
  { secure: [`tg://proxy?server=host.example&port=443&secret=dd${secret}`] },
  'alice',
  [webProfiles[0]],
);
const webGroup = webFromSecure.find((g) => g.label === 'WEB');
assertDeepEqual(webGroup?.links.map((l) => l.url), [
  `tg://webproxy?server=proxy.example.com&secret=dd${secret}`,
]);

// No profiles for this user → no WEB group; unknown secret → no WEB group.
assertDeepEqual(
  buildProxyLinks({ classic: [`tg://proxy?server=h&port=443&secret=${secret}`] }, 'carol', webProfiles)
    .some((g) => g.label === 'WEB'),
  false,
);
assertDeepEqual(
  buildProxyLinks({ tls: ['tg://proxy?server=h&port=443&secret=eeff'] }, 'alice', webProfiles)
    .some((g) => g.label === 'WEB'),
  false,
);

console.log('usersPage.helpers tests passed');
