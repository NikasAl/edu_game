#!/usr/bin/env python3
"""
Генерация иконок Android-приложения (и веб-favicon) из растровой картинки.

Использование:
  python3 scripts/gen_icon.py [путь_к_картинке]

По умолчанию источник: resources/icon_source.png (1024x1024, но подойдёт любой
растровый формат, который читает Pillow — картинка центрируется и кадрируется
до квадрата).

Что генерируется (android/app/src/main/res/):
  - mipmap-*/ic_launcher.png        — квадратная иконка со скруглёнными углами (legacy, API < 26);
  - mipmap-*/ic_launcher_round.png  — круглая иконка (legacy);
  - mipmap-*/ic_launcher_foreground.png — слой adaptive-icon (API 26+, full-bleed,
    система сама маскирует и применяет параллакс; ключевой контент должен быть в центре,
    т.к. видны центральные ~67% холста);
  - values/ic_launcher_background.xml — резервный цвет adaptive-фона (средний по углам картинки);
  - src/app/icon.png (512px, скруглённая) — favicon веб-версии (Next.js file-convention).

Плотности: mdpi 1x, hdpi 1.5x, xhdpi 2x, xxhdpi 3x, xxxhdpi 4x.

Зависимости: Pillow (pip install pillow).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

# (папка, множитель) — базовая единица launcher-иконки 48dp
DENSITIES: list[tuple[str, float]] = [
    ("mipmap-mdpi", 1.0),
    ("mipmap-hdpi", 1.5),
    ("mipmap-xhdpi", 2.0),
    ("mipmap-xxhdpi", 3.0),
    ("mipmap-xxxhdpi", 4.0),
]
BASE_LAUNCHER = 48   # dp
BASE_FOREGROUND = 108  # dp (adaptive-холст; видимая зона — центральные 72dp)

LEGACY_RADIUS = 0.16  # радиус скругления legacy-иконки (доля стороны)
WEB_ICON_SIZE = 512
SS = 4  # суперсэмплинг для гладких масок


def load_master(src: Path, size: int) -> Image.Image:
    """Открыть картинку, кадрировать до квадрата по центру, привести к размеру."""
    img = Image.open(src)
    img = ImageOps.exif_transpose(img).convert("RGB")
    w, h = img.size
    if w != h:
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        img = img.crop((left, top, left + side, top + side))
    return img.resize((size, size), Image.LANCZOS)


def rounded_mask(size: int, radius_frac: float) -> Image.Image:
    big = size * SS
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    r = int(big * radius_frac)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=r, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def circle_mask(size: int) -> Image.Image:
    big = size * SS
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, big - 1, big - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def corner_color(img: Image.Image) -> tuple[int, int, int]:
    """Средний цвет четырёх углов — резервный фон adaptive-иконки."""
    w, h = img.size
    k = max(8, w // 24)
    boxes = [(0, 0, k, k), (w - k, 0, w, k), (0, h - k, k, h), (w - k, h - k, w, h)]
    px = [img.crop(b).resize((1, 1), Image.LANCZOS).getpixel((0, 0)) for b in boxes]
    rgb = tuple(sum(c[i] for c in px) // len(px) for i in range(3))  # type: ignore[arg-type]
    return rgb  # type: ignore[return-value]


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="Генерация иконок приложения из растровой картинки")
    ap.add_argument("source", nargs="?", default=str(root / "resources" / "icon_source.png"))
    ap.add_argument("--res", default=str(root / "android" / "app" / "src" / "main" / "res"))
    ap.add_argument("--web", default=str(root / "src" / "app"))
    args = ap.parse_args()

    src = Path(args.source)
    res_dir = Path(args.res)
    web_dir = Path(args.web)
    if not src.exists():
        print(f"Источник не найден: {src}", file=sys.stderr)
        return 1

    master = load_master(src, 1024)
    print(f"Источник: {src} → мастер 1024x1024")

    generated: list[str] = []
    for folder, mult in DENSITIES:
        launcher_px = round(BASE_LAUNCHER * mult)
        fg_px = round(BASE_FOREGROUND * mult)

        # legacy: квадрат со скруглёнными углами
        sq = master.resize((launcher_px, launcher_px), Image.LANCZOS)
        sq.putalpha(rounded_mask(launcher_px, LEGACY_RADIUS))
        save_png(sq, res_dir / folder / "ic_launcher.png")
        generated.append(f"{folder}/ic_launcher.png ({launcher_px}px)")

        # legacy: круг
        rd = master.resize((launcher_px, launcher_px), Image.LANCZOS)
        rd.putalpha(circle_mask(launcher_px))
        save_png(rd, res_dir / folder / "ic_launcher_round.png")
        generated.append(f"{folder}/ic_launcher_round.png ({launcher_px}px)")

        # adaptive-слой: full-bleed без маски (маску применяет лаунчер)
        fg = master.resize((fg_px, fg_px), Image.LANCZOS)
        save_png(fg, res_dir / folder / "ic_launcher_foreground.png")
        generated.append(f"{folder}/ic_launcher_foreground.png ({fg_px}px)")

    # резервный фон adaptive-иконки
    r, g, b = corner_color(master)
    color_xml = res_dir / "values" / "ic_launcher_background.xml"
    color_xml.parent.mkdir(parents=True, exist_ok=True)
    color_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="ic_launcher_background">#{r:02X}{g:02X}{b:02X}</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    generated.append(f"values/ic_launcher_background.xml (#{r:02X}{g:02X}{b:02X})")

    # веб-favicon (Next.js: src/app/icon.png)
    web = master.resize((WEB_ICON_SIZE, WEB_ICON_SIZE), Image.LANCZOS)
    web.putalpha(rounded_mask(WEB_ICON_SIZE, 0.18))
    save_png(web, web_dir / "icon.png")
    generated.append(f"src/app/icon.png ({WEB_ICON_SIZE}px)")

    for line in generated:
        print(f"  ✓ {line}")
    print(f"\nГотово: {len(generated)} файлов. Пересобери APK (npm run apk:debug), чтобы иконка применилась.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
