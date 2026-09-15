from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import re
import subprocess
import tempfile
from pathlib import Path

ASSET_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.wav', '.mp3', '.ogg', '.m4a', '.json'}


def data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return f'data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}'


def inline_css(root: Path, css_path: Path) -> str:
    css = css_path.read_text()
    def repl(match: re.Match[str]) -> str:
        raw = match.group(1).strip().strip('"\'')
        if raw.startswith(('data:', 'http:', 'https:', '#')):
            return match.group(0)
        target = (css_path.parent / raw.split('?', 1)[0]).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            return match.group(0)
        return f'url("{data_uri(target)}")' if target.is_file() else match.group(0)
    return re.sub(r'url\(([^)]+)\)', repl, css)


def build(root_value: str | Path, output_value: str | Path | None = None) -> str:
    root = Path(root_value).resolve()
    output = Path(output_value).resolve() if output_value else root / 'ИГРАТЬ.html'
    html = (root / 'index.html').read_text()

    def css_repl(match: re.Match[str]) -> str:
        href = match.group(1).split('?', 1)[0]
        path = root / href.lstrip('/')
        return f'<style>\n{inline_css(root, path)}\n</style>' if path.is_file() else ''

    html = re.sub(
        r'<link\b(?=[^>]*\brel=["\']stylesheet["\'])(?=[^>]*\bhref=["\']([^"\']+)["\'])[^>]*>',
        css_repl,
        html,
        flags=re.I,
    )

    # Remove optional live-site helpers before taking replacement offsets.
    html = re.sub(r'<script\b[^>]*\bsrc=["\'](?:/pulse/script\.js|/player-name\.js)[^"\']*["\'][^>]*>\s*</script>', '', html, flags=re.I)
    module = re.search(r'<script\b[^>]*\btype=["\']module["\'][^>]*\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script>', html, re.I)
    if not module:
        raise RuntimeError('module entry script not found')
    entry = root / module.group(1).split('?', 1)[0].lstrip('/')
    with tempfile.TemporaryDirectory() as td:
        bundle = Path(td) / 'bundle.js'
        subprocess.run([
            'npx', '--no-install', 'esbuild', str(entry), '--bundle', '--format=iife',
            '--platform=browser', '--charset=utf8', '--log-level=error', f'--outfile={bundle}',
        ], cwd=root, check=True)
        js = bundle.read_text()

    resources: dict[str, str] = {}
    for path in sorted(root.rglob('*')):
        rel_parts = path.relative_to(root).parts
        excluded = {'.git', '.claude', 'docs', 'tests', 'tools', 'node_modules'}
        if path.is_file() and path.suffix.lower() in ASSET_SUFFIXES and not excluded.intersection(rel_parts):
            key = path.relative_to(root).as_posix()
            resources[key] = data_uri(path)

    adapter = r'''<script>
window.__OFFLINE_RESOURCES__=RESOURCE_MAP;
(()=>{const R=window.__OFFLINE_RESOURCES__, key=v=>String(v||'').split('#')[0].split('?')[0].replace(/^file:\/\/[^/]*\//,'').replace(/^\.\//,'').replace(/^\//,'');
const map=v=>R[key(v)]||v;
const nativeFetch=window.fetch&&window.fetch.bind(window); if(nativeFetch) window.fetch=(input,init)=>nativeFetch(typeof input==='string'?map(input):input,init);
const {HTMLImageElement,HTMLMediaElement}=window;
for(const C of [HTMLImageElement,HTMLMediaElement]){if(!C)continue;const d=Object.getOwnPropertyDescriptor(C.prototype,'src');if(d&&d.set)Object.defineProperty(C.prototype,'src',{get:d.get,set(v){d.set.call(this,map(v))},configurable:true,enumerable:d.enumerable});}
})();
</script>'''.replace('RESOURCE_MAP', json.dumps(resources, ensure_ascii=False, separators=(',', ':')))
    replacement = adapter + '\n<script>\n' + js + '\n</script>'
    html = html[:module.start()] + replacement + html[module.end():]

    # Local icon files also become data URIs.
    def icon_repl(match: re.Match[str]) -> str:
        rel = match.group(2).split('?', 1)[0].lstrip('/')
        return match.group(1) + resources.get(rel, match.group(2)) + match.group(3)
    html = re.sub(r'(<link\b[^>]*\bhref=["\'])([^"\']+)(["\'][^>]*>)', icon_repl, html, flags=re.I)
    html = re.sub(r'<link\b(?=[^>]*\brel=["\']manifest["\'])[^>]*>', '', html, flags=re.I)
    output.write_text(html)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(digest)
    return digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--output')
    args = parser.parse_args()
    build(args.root, args.output)
