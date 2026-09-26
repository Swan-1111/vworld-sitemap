"""On-demand VWorld collection used only by the 3D diagram.

The normal site analysis remains immutable. Expanded parcel/building data is
stored below ``out/<site>/_3d_context/<radius>m`` and can be reused by any
smaller requested radius.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone

from pyproj import Transformer

from common import ENV_PATH, Site, load_config, resolve_crs
from vworld import VWorld, load_key


MAX_RADIUS = 900
LAYERS = (
    ("LP_PA_CBND_BUBUN", "필지"),
    ("LT_C_SPBD", "건물"),
)
_LOCK = threading.Lock()


def root(name: str) -> str:
    return os.path.join(Site(name).dir, "_3d_context")


def cache_dir(name: str, radius: float) -> str:
    return os.path.join(root(name), f"{int(math.ceil(radius))}m")


def _manifest_path(path: str) -> str:
    return os.path.join(path, "_manifest.json")


def _read_manifest(path: str) -> dict | None:
    try:
        with open(_manifest_path(path), encoding="utf-8") as f:
            data = json.load(f)
        if all(os.path.exists(os.path.join(path, f"{data_id}.geojson"))
               for data_id, _ in LAYERS):
            return data
    except (OSError, ValueError, TypeError):
        pass
    return None


def cached_radii(name: str) -> list[int]:
    base = root(name)
    if not os.path.isdir(base):
        return []
    found = []
    for entry in os.scandir(base):
        if not entry.is_dir() or not entry.name.endswith("m"):
            continue
        manifest = _read_manifest(entry.path)
        if manifest:
            try:
                found.append(int(manifest.get("radius") or entry.name[:-1]))
            except (TypeError, ValueError):
                pass
    return sorted(set(found))


def find_covering(name: str, radius: float) -> tuple[int, str] | None:
    for cached in cached_radii(name):
        if cached >= radius:
            return cached, cache_dir(name, cached)
    return None


def base_radius(name: str) -> int:
    from scene import _full_radius
    return int(round(_full_radius(name)))


def _base_frame(site: Site) -> tuple[str, float, float]:
    manifest = site.read_manifest()
    if not manifest:
        raise FileNotFoundError(f"'{site.name}' 수집 결과가 없습니다.")
    target_crs, _ = resolve_crs(load_config(), manifest)
    project = Transformer.from_crs("EPSG:4326", target_crs, always_xy=True)
    min_lon, min_lat, max_lon, max_lat = manifest["bbox_4326"]
    corners = [
        project.transform(min_lon, min_lat),
        project.transform(max_lon, min_lat),
        project.transform(max_lon, max_lat),
        project.transform(min_lon, max_lat),
    ]
    ox = round((min(p[0] for p in corners) + max(p[0] for p in corners)) / 2, 3)
    oy = round((min(p[1] for p in corners) + max(p[1] for p in corners)) / 2, 3)
    return target_crs, ox, oy


def bbox_for_radius(name: str, radius: float) -> list[float]:
    site = Site(name)
    target_crs, ox, oy = _base_frame(site)
    unproject = Transformer.from_crs(target_crs, "EPSG:4326", always_xy=True)
    corners = [unproject.transform(ox + dx, oy + dy)
               for dx in (-radius, radius) for dy in (-radius, radius)]
    return [min(p[0] for p in corners), min(p[1] for p in corners),
            max(p[0] for p in corners), max(p[1] for p in corners)]


def collect(name: str, radius: float, keys: dict[str, str] | None = None,
            on_progress=None) -> tuple[int, str]:
    """Collect an expanded square and return ``(cached_radius, directory)``."""
    site = Site(name)
    if not site.exists():
        raise FileNotFoundError(f"'{site.name}' 수집 결과가 없습니다.")
    radius = int(math.ceil(radius))
    if radius <= base_radius(name):
        raise ValueError("기존 수집 범위 안쪽은 추가 수집이 필요하지 않습니다.")
    if radius > MAX_RADIUS:
        raise ValueError(f"3D 컨텍스트는 최대 {MAX_RADIUS}m까지 수집할 수 있습니다.")

    covering = find_covering(name, radius)
    if covering:
        if on_progress:
            on_progress(100, "이미 수집된 3D 컨텍스트를 사용합니다.")
        return covering

    supplied = keys or {}
    if supplied.get("VWORLD_KEY"):
        key = supplied["VWORLD_KEY"]
        domain = supplied.get("VWORLD_DOMAIN") or "http://localhost"
    else:
        key, domain = load_key(ENV_PATH)

    target = cache_dir(name, radius)
    temp = f"{target}.building-{uuid.uuid4().hex[:8]}"
    bbox = bbox_for_radius(name, radius)
    api = VWorld(key, domain)
    counts: dict[str, int] = {}

    with _LOCK:
        covering = find_covering(name, radius)
        if covering:
            return covering
        os.makedirs(temp, exist_ok=False)
        try:
            for index, (data_id, label) in enumerate(LAYERS):
                start = index * 45
                span = 45
                if on_progress:
                    on_progress(start, f"{label} 수집 준비")

                def layer_progress(done, total, count, *, _label=label,
                                   _start=start, _span=span):
                    pct = _start + _span * (done / max(1, total))
                    if on_progress:
                        on_progress(pct, f"{_label} 수집 · {done}/{total}칸 · {count:,}건")

                features = api.get_feature_tiled(data_id, bbox, on_progress=layer_progress)
                counts[data_id] = len(features)
                collection = {"type": "FeatureCollection", "features": features}
                with open(os.path.join(temp, f"{data_id}.geojson"), "w", encoding="utf-8") as f:
                    json.dump(collection, f, ensure_ascii=False)

            manifest = {
                "kind": "3d_context",
                "site": site.name,
                "radius": radius,
                "bbox_4326": bbox,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "layers": counts,
            }
            with open(_manifest_path(temp), "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
            os.makedirs(root(name), exist_ok=True)
            os.replace(temp, target)
        except Exception:
            shutil.rmtree(temp, ignore_errors=True)
            raise

    if on_progress:
        on_progress(92, "3D 장면 캐시를 만드는 중")
    return radius, target
