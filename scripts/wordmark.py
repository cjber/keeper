#!/usr/bin/env python3
"""Regenerate assets/ from Liberation Sans outlines: keep is solid, and er is dashed, marked for removal."""

from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = Path("/usr/share/fonts/liberation")
SOLID = TTFont(FONTS / "LiberationSans-BoldItalic.ttf")
DASHED = TTFont(FONTS / "LiberationSans-Italic.ttf")
INK, PAPER = "#17150f", "#f5f2ea"
OUT = Path(__file__).parent.parent / "assets"


def outline(font: TTFont, char: str, x: float, baseline: float, size: float) -> tuple[str, float]:
    glyphs = font.getGlyphSet()
    name = font.getBestCmap()[ord(char)]
    scale = size / font["head"].unitsPerEm
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
    return pen.getCommands(), glyphs[name].width * scale


def svg(width: float, height: float, body: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.2f} {height}" role="img" '
        f'aria-label="keeper"><title>keeper</title>{body}</svg>\n'
    )


def wordmark(ink: str) -> str:
    x, parts = 10.0, []
    for char in "keep":
        path, advance = outline(SOLID, char, x, 77, 74)
        parts.append(f'<path d="{path}" fill="{ink}"/>')
        x += advance
    x += 1
    for char in "er":
        path, advance = outline(DASHED, char, x, 77, 74)
        dash = 'stroke-width="1.5" stroke-dasharray="3.4 2.6" stroke-linecap="round"'
        parts.append(f'<path d="{path}" fill="none" stroke="{ink}" {dash}/>')
        x += advance
    return svg(x + 10, 100, "".join(parts))


def logo() -> str:
    _, advance = outline(SOLID, "k", 0, 390, 400)
    path, _ = outline(SOLID, "k", (512 - advance) / 2, 390, 400)
    return svg(512, 512, f'<rect width="512" height="512" fill="{INK}"/><path d="{path}" fill="{PAPER}"/>')


(OUT / "wordmark.svg").write_text(wordmark(INK))
(OUT / "wordmark-dark.svg").write_text(wordmark(PAPER))
(OUT / "logo.svg").write_text(logo())
