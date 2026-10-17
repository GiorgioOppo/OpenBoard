# Vendored utf8proc

OpenBoard includes unmodified upstream **utf8proc v2.12.0**, supporting Unicode
18.0.0, from commit `79cdd5ab40c79afa559f689ffc13b76812dee1ac`.

- Upstream: https://github.com/JuliaStrings/utf8proc
- Release: https://github.com/JuliaStrings/utf8proc/releases/tag/v2.12.0
- `SOURCE.json` records the exact immutable source URLs, byte lengths and SHA-256
  checksums. `check-vendor.py` verifies all four upstream files without network
  access. No upstream source files have been modified.
- Code is MIT-licensed; generated data also carries the Unicode data license.
  Preserve the complete upstream `LICENSE.md` with redistributions.

`src/utf8proc_vendor.c` compiles the library into the application, using the
upstream generated data directly. No system library, download or data generation
is needed to build or run OpenBoard. Compile only the wrapper: `utf8proc_data.c`
is included by the upstream implementation and must not be compiled separately.

OpenBoard search uses full default case-folding and canonical NFC composition.
Compatibility normalization, accent stripping, default-ignorable stripping,
transliteration and stemming are disabled. Snippets return original stored UTF-8
rather than normalized search text. Updating this dependency requires changing
its immutable commit and file checksums, reviewing license/version changes and
running Unicode search and sanitizer checks.
