"""Уменьшенные копии спрайтов настроений для Worker: assets/sprites/*.jpg (1024 px, оригиналы) -> public/sprites/*.jpg (160 px).
Запуск: python scripts/make-sprites.py (нужен Pillow). Оригиналы не трогаем."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src, dst = root / "assets" / "sprites", root / "public" / "sprites"
dst.mkdir(parents=True, exist_ok=True)
for f in sorted(src.glob("*.jpg")):
    im = Image.open(f).convert("RGB").resize((160, 160), Image.LANCZOS)
    im.save(dst / f.name, "JPEG", quality=86, optimize=True)
    print(f.name, (dst / f.name).stat().st_size, "bytes")
