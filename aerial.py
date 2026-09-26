"""위성사진 바탕 — 브이월드 타일을 대상지 좌표계로 재투영해 한 장으로.

타일을 브라우저에서 그대로 깔면 안 된다. 타일은 웹 메르카토르(EPSG:3857)이고
우리 도판은 국가 TM(EPSG:5186 등)이라, 겹치면 도형과 사진이 서서히 어긋난다.
그래서 서버가 필요한 타일을 받아 이어 붙이고, **도판과 같은 격자로 다시 뿌려**
장면 범위에 딱 맞는 PNG 한 장을 만든다.

한 번 만든 것은 대상지 폴더에 캐시한다. 타일 요청이 반복되지 않게.
"""

from __future__ import annotations

import io
import hashlib
import math
import os
import tempfile
import time
from collections.abc import Callable

import numpy as np
from PIL import Image

from common import ENV_PATH, Site, network_session, site_frame
from vworld import load_key

TILE = 256
R = 6378137.0
ORIGIN = 20037508.342789244          # 웹 메르카토르 한쪽 끝
MAX_Z = 19                            # 브이월드 항공사진 최대
LAYERS = {"satellite": ("Satellite", "jpeg"), "base": ("Base", "png")}
try:
    CACHE_MAX_AGE_DAYS = max(0.0, float(os.environ.get("VWORLD_AERIAL_CACHE_DAYS", "30")))
except ValueError:
    CACHE_MAX_AGE_DAYS = 30.0


def _fresh(path: str) -> bool:
    if not os.path.isfile(path):
        return False
    if CACHE_MAX_AGE_DAYS <= 0:
        return False
    return time.time() - os.path.getmtime(path) < CACHE_MAX_AGE_DAYS * 86400


def _save_png_atomic(image: Image.Image, path: str) -> None:
    fd, temporary = tempfile.mkstemp(prefix=os.path.basename(path) + ".",
                                     suffix=".tmp", dir=os.path.dirname(path))
    os.close(fd)
    try:
        image.save(temporary, format="PNG")
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def _to3857(lon, lat):
    x = R * np.radians(lon)
    y = R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return x, y


def _pick_zoom(ground_res: float, lat: float) -> int:
    """도판 1픽셀이 담을 지상 거리에 맞는 타일 확대 단계."""
    # 메르카토르는 위도가 높을수록 늘어난다. 그만큼 보정해야 실제 해상도가 맞는다.
    merc_res = ground_res / max(0.1, math.cos(math.radians(lat)))
    z = math.log2(2 * ORIGIN / (TILE * merc_res))
    return max(0, min(MAX_Z, int(math.ceil(z))))


def _fetch_mosaic(key: str, domain: str, layer: str, z: int,
                  x0: int, x1: int, y0: int, y1: int,
                  on_progress: Callable[[float, str], None] | None = None) -> Image.Image:
    name, ext = LAYERS[layer]
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    if cols * rows > 400:
        raise ValueError(f"타일이 너무 많습니다 ({cols}×{rows}). 반경을 줄이세요.")
    out = Image.new("RGB", (cols * TILE, rows * TILE), (238, 238, 234))
    sess = network_session()
    sess.headers["Referer"] = domain        # 브이월드 키는 신청한 도메인에 묶여 있다
    got = 0
    done = 0
    total = cols * rows
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            url = f"https://api.vworld.kr/req/wmts/1.0.0/{key}/{name}/{z}/{ty}/{tx}.{ext}"
            try:
                r = sess.get(url, timeout=20)
                is_image = r.content[:2] in (b"\xff\xd8", b"\x89P")
                if r.status_code != 200 or not is_image:
                    # 키·도메인이 틀리면 모든 타일이 똑같이 실패한다. 첫 장부터
                    # 거부된 것이 확실한데 수십 장을 끝까지 기다릴 이유가 없다.
                    if not got:
                        reason = f"HTTP {r.status_code}" if r.status_code != 200 \
                            else "이미지가 아닌 응답"
                        raise RuntimeError(
                            f"첫 VWorld 타일을 받지 못했습니다 ({reason}). "
                            "VWORLD_KEY·VWORLD_DOMAIN을 확인하세요."
                        )
                    continue
                out.paste(Image.open(io.BytesIO(r.content)).convert("RGB"),
                          ((tx - x0) * TILE, (ty - y0) * TILE))
                got += 1
            except RuntimeError:
                raise
            except Exception:
                if not got:
                    raise RuntimeError(
                        "첫 VWorld 타일 요청에 실패했습니다. 네트워크 연결과 "
                        "VWORLD_KEY·VWORLD_DOMAIN을 확인하세요."
                    )
                continue
            done += 1
            if on_progress:
                on_progress(done / total * 100,
                            f"VWorld 타일 다운로드 {done}/{total}")
    if not got:
        raise RuntimeError("타일을 한 장도 받지 못했습니다. "
                           ".env 의 VWORLD_KEY·VWORLD_DOMAIN 을 확인하세요.")
    return out


def build(name: str, radius: float = 250.0, size: int = 1400,
          layer: str = "satellite", gray: bool = False,
          keys: dict[str, str] | None = None,
          on_progress: Callable[[float, str], None] | None = None,
          refresh: bool = False) -> str:
    """장면 범위(±radius m)에 딱 맞는 바탕 이미지를 만들어 경로를 준다.

    keys 를 주면 그 인증키로 타일을 받는다 (화면에서 각자 넣은 키).
    """
    site = Site(name)
    report = on_progress or (lambda _progress, _message: None)
    report(2, "위성사진 준비 중")
    manifest = site.read_manifest()
    if not manifest:
        raise FileNotFoundError(f"'{name}' 수집 결과가 없습니다.")

    # 같은 이름으로 다른 위치를 재분석해도 예전 사진을 재사용하지 않는다.
    # 반경뿐 아니라 실제 재투영 좌표계·원점까지 캐시 식별자에 포함한다.
    frame = site_frame(site)
    frame_key = hashlib.sha256(
        f"{frame.crs}|{frame.ox:.6f}|{frame.oy:.6f}".encode("utf-8")
    ).hexdigest()[:16]
    radius_key = f"{float(radius):.3f}".rstrip("0").rstrip(".")
    cache = os.path.join(site.dir, f"바탕_{layer}_{radius_key}m_{size}px_{frame_key}.png")
    if not refresh and _fresh(cache) and not gray:
        report(100, "저장된 위성사진 불러오기 완료")
        return cache
    gray_cache = cache.replace(".png", "_흑백.png")
    gray_is_current = (_fresh(gray_cache) and
                       (not os.path.exists(cache)
                        or os.path.getmtime(gray_cache) >= os.path.getmtime(cache)))
    if not refresh and gray and gray_is_current:
        report(100, "저장된 흑백 위성사진 불러오기 완료")
        return gray_cache
    if not refresh and gray and _fresh(cache):
        # 흑백·레벨 조절은 같은 컬러 원본에서 파생된다. 컬러 캐시가 있는데도
        # 타일 서버를 다시 호출하면 느릴 뿐 아니라 일시적인 인증 오류에도 취약하다.
        with Image.open(cache) as cached:
            _save_png_atomic(cached.convert("L").convert("RGB"), gray_cache)
        report(100, "흑백 위성사진 만들기 완료")
        return gray_cache

    # 좌표 기준은 common 이 정한다 — 도면·장면·지형과 같은 원점이어야 사진이 맞는다
    report(5, "위성사진 범위와 해상도 계산 중")
    ox, oy = frame.ox, frame.oy

    # 도판 격자 — scene 과 같은 정사각형 ±radius, 위쪽이 북쪽
    gx = np.linspace(ox - radius, ox + radius, size)
    gy = np.linspace(oy + radius, oy - radius, size)
    GX, GY = np.meshgrid(gx, gy)
    lon, lat = frame.to_wgs(GX, GY)

    lat0 = float(np.nanmean(lat))
    z = _pick_zoom(2 * radius / size, lat0)

    mx, my = _to3857(lon, lat)
    res = 2 * ORIGIN / (TILE * 2 ** z)              # 메르카토르 m/px
    px = (mx + ORIGIN) / res
    py = (ORIGIN - my) / res

    x0, x1 = int(np.floor(px.min() / TILE)), int(np.floor(px.max() / TILE))
    y0, y1 = int(np.floor(py.min() / TILE)), int(np.floor(py.max() / TILE))

    if keys and keys.get("VWORLD_KEY"):
        key = keys["VWORLD_KEY"]
        domain = keys.get("VWORLD_DOMAIN") or "http://localhost"
    else:
        key, domain = load_key(ENV_PATH)
    report(8, "VWorld 타일 요청 준비 중")
    mosaic = _fetch_mosaic(
        key, domain, layer, z, x0, x1, y0, y1,
        on_progress=lambda progress, message: report(8 + progress * 0.72, message),
    )
    report(84, "도면 좌표에 맞추는 중")
    arr = np.asarray(mosaic)

    # 도판 격자 각 점이 모자이크의 어느 픽셀인지 (최근접)
    ix = np.clip((px - x0 * TILE).astype(np.int32), 0, arr.shape[1] - 1)
    iy = np.clip((py - y0 * TILE).astype(np.int32), 0, arr.shape[0] - 1)
    out = Image.fromarray(arr[iy, ix])

    report(96, "위성사진 저장 중")
    _save_png_atomic(out, cache)
    if gray:
        _save_png_atomic(out.convert("L").convert("RGB"), gray_cache)
        report(100, "흑백 위성사진 만들기 완료")
        return gray_cache
    report(100, "위성사진 다운로드 완료")
    return cache
