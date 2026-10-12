# Third-party notices

CC-Doc-Review itself is released under the MIT License (see `LICENSE`). The review page bundles the following third-party libraries, unmodified, in `server/web/static/vendor/`, and inlines some icon paths in `server/web/static/overlay.js` and `src/bandview.js`. Each remains under its own license. Copyright lines below follow each project's official LICENSE file.

| Library | Version | License | Copyright |
|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 15.0.12 | MIT (also contains John Gruber's Markdown notice, BSD-3-Clause style) | Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey; Copyright (c) 2004, John Gruber |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.4 | Apache-2.0 OR MPL-2.0 (this project uses it under Apache-2.0) | Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53 |
| [highlight.js](https://github.com/highlightjs/highlight.js) (including the `github` and `github-dark` styles) | 11.11.1 | BSD-3-Clause | Copyright (c) 2006, Ivan Sagalaev (the file header also reads "(c) 2006-2024 Josh Goebel and other contributors") |
| [mermaid](https://github.com/mermaid-js/mermaid) | 11.4.1 | MIT | Copyright (c) 2014 - 2022 Knut Sveidqvist |
| [Lucide](https://lucide.dev) icons (SVG paths inlined in `overlay.js` and `bandview.js`) | n/a | ISC | Copyright (c) 2026 Lucide Icons and Contributors; some icons derive from Feather, Copyright (c) 2013-present Cole Bemis (MIT) |

Official license files:

- marked: https://github.com/markedjs/marked/blob/v15.0.12/LICENSE.md
- DOMPurify: https://github.com/cure53/DOMPurify/blob/3.2.4/LICENSE
- highlight.js: https://github.com/highlightjs/highlight.js/blob/11.11.1/LICENSE
- mermaid: https://github.com/mermaid-js/mermaid/blob/mermaid%4011.4.1/LICENSE
- Lucide: https://github.com/lucide-icons/lucide/blob/main/LICENSE

## Notes

- **mermaid** is distributed as a single bundled file that includes its own dependencies. The "Bundled license information" block at the end of `mermaid.min.js` carries notices only for DOMPurify 3.2.1 (Apache-2.0 OR MPL-2.0), js-yaml 4.1.0 (MIT), lodash-es (MIT) and cytoscape (including the notices of the components it embeds). The other bundled dependencies (d3, dagre and others) are used under their own licenses; refer to each project for its terms.
- **highlight.js** styles `github` and `github-dark` are distributed with highlight.js under the same BSD-3-Clause license.
- **DOMPurify** is dual-licensed under the Apache License 2.0 or the Mozilla Public License 2.0; this project uses it under the Apache License 2.0. The full text is at https://www.apache.org/licenses/LICENSE-2.0 and in DOMPurify's LICENSE file linked above. We found no NOTICE file in the DOMPurify 3.2.4 package, so there is no NOTICE text to reproduce. The Mozilla Public License 2.0 alternative is at https://www.mozilla.org/MPL/2.0/.
- **Lucide**: some icons derive from the Feather project (Copyright (c) 2013-present Cole Bemis, MIT License, full text below under MIT).

# License texts

## MIT License

Applies to marked, mermaid and the Feather-derived part of Lucide. Copyright holders are listed in the table above.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## BSD 3-Clause License (highlight.js)

```
Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Markdown license (John Gruber, contained in marked's LICENSE.md)

```
Copyright (c) 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
```

## ISC License (Lucide)

```
Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Apache License 2.0 and MPL 2.0 (DOMPurify)

DOMPurify may be used under either license. This project uses it under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0. The text is not reproduced here; DOMPurify's own LICENSE file (linked above) contains both licenses in full.
