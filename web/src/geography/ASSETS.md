# Geography assets

The production modules use installed, locked npm packages, never generated
laboratory bundles or a runtime CDN.

- `world-atlas@2.0.2/countries-110m.json`: Natural Earth 1:110m geometry,
  via https://github.com/topojson/world-atlas. Package: ISC; original Natural
  Earth data: public domain.
- `d3-geo@3.1.1` and `topojson-client@3.1.0`: ISC.
- `three@0.185.1`: MIT, loaded only when the globe is selected.
- Globe texture: generated locally at 2048×1024 from the same atlas and
  projection counts. No third-party raster texture is used.

`world-country-codes.json` derives all 249 alpha-2/numeric pairs from
`/usr/share/iso-codes/json/iso_3166-1.json` supplied by Debian's `iso-codes`
package. The upstream source is
https://salsa.debian.org/iso-codes-team/iso-codes (LGPL-2.1-or-later).
Regenerate by sorting `{row['alpha_2']: row['numeric']}` from the JSON
`3166-1` array. Numeric values stay strings, including leading zeroes.
No country-name matching or hand-written demonstration table is used.

All numeric atlas IDs match this mapping. Three atlas features have no ID:
N. Cyprus, Somaliland, Kosovo. They remain unassigned geometry, and IP
countries without a matched contour remain usable in the accessible lists.
Tests verify the complete join and these explicit fallbacks.

Full copyright/license texts ship in `public/geography-licenses.txt`.
Geometry is imported into a content-hashed route chunk. The globe code is a
separate content-hashed chunk. The renderer modules never call an API.
