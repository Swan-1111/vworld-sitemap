"""사이트 분석 시스템 공통 설정·경로.

대상지 하나당 out/<사이트명>/ 폴더 하나. 주소만 바꾸면 어느 지역이든 같은 방식으로 돈다.
"""

from __future__ import annotations

import json
import os
import re
import sys
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
OUT_ROOT = os.path.join(HERE, "out")
ENV_PATH = os.path.join(HERE, ".env")

# Codex 같은 격리 실행 환경은 외부 접속을 막을 때 프록시를 127.0.0.1:9로 둔다.
# 그 상태로 로컬 사이트 서버를 띄우면 하위 수집 프로세스까지 값을 물려받아, 사용자의
# 정상 인터넷이 있어도 모든 요청이 죽은 포트로 향한다. 일반 회사 프록시는 건드리지 않고
# 이 명백한 차단용 루프백 값만 무시한다.
PROXY_ENV_NAMES = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
)


def _blocked_loopback_proxy(value: str | None) -> bool:
    if not value:
        return False
    try:
        parsed = urlsplit(value if "://" in value else "http://" + value)
        return parsed.hostname in ("127.0.0.1", "localhost", "::1") and parsed.port == 9
    except ValueError:
        return False


def clean_network_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """현재 환경을 복사하되 차단용 127.0.0.1:9 프록시만 걷어낸다."""
    env = dict(os.environ)
    for name in PROXY_ENV_NAMES:
        if _blocked_loopback_proxy(env.get(name)):
            env.pop(name, None)
    if extra:
        env.update(extra)
    return env


def network_session():
    """죽은 루프백 프록시를 상속하지 않는 requests 세션."""
    import requests

    session = requests.Session()
    if any(_blocked_loopback_proxy(os.environ.get(name)) for name in PROXY_ENV_NAMES):
        session.trust_env = False
        # 일부 값만 차단용이고 나머지는 사용자가 지정한 정상 프록시일 수도 있다.
        # trust_env를 끈 뒤 정상 값만 세션에 다시 옮겨 그런 환경도 보존한다.
        cleaned = clean_network_env()
        for scheme, names in {
            "http": ("http_proxy", "HTTP_PROXY"),
            "https": ("https_proxy", "HTTPS_PROXY"),
            "all": ("all_proxy", "ALL_PROXY"),
            "no_proxy": ("no_proxy", "NO_PROXY"),
        }.items():
            value = next((cleaned.get(name) for name in names if cleaned.get(name)), None)
            if value:
                session.proxies[scheme] = value
    return session


def load_config(path: str | None = None) -> dict:
    with open(path or CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


# 국가 표준 TM 좌표계(GRS80). 대상지 경도에 맞는 원점을 써야 도면 왜곡이 없다.
TM_BELTS = [
    (126.0, "EPSG:5185", "서부원점 125°E"),
    (128.0, "EPSG:5186", "중부원점 127°E"),
    (130.0, "EPSG:5187", "동부원점 129°E"),
    (999.0, "EPSG:5188", "동해원점 131°E"),
]


def pick_crs(lon: float) -> tuple[str, str]:
    for limit, epsg, label in TM_BELTS:
        if lon < limit:
            return epsg, label
    return "EPSG:5186", "중부원점 127°E"


def resolve_crs(cfg: dict, manifest: dict) -> tuple[str, str]:
    """config가 auto면 수집범위 중심 경도로 좌표계를 고른다."""
    setting = cfg.get("target_crs", "auto")
    bbox = manifest["bbox_4326"]
    lon = (bbox[0] + bbox[2]) / 2
    if str(setting).lower() != "auto":
        return setting, "config 지정"
    return pick_crs(lon)


class Frame:
    """대상지 하나의 좌표 기준. 도면·장면·사진·지형이 **반드시 같은 것**을 써야 한다.

    같은 계산을 네 파일에 각각 적어 두었더니 조금씩 갈라졌고, 그 결과가
    「모델과 위성사진이 안 맞는」 증상으로 나왔다. 한 군데서만 정한다.

      crs        목표 좌표계 (EPSG:518x)
      to_target  위경도 → 목표 좌표계
      to_wgs     목표 좌표계 → 위경도
      box        수집범위를 목표 좌표계로 옮긴 사각형 (minx, miny, maxx, maxy)
      ox, oy     도면 원점. 실좌표 = 도면좌표 + (ox, oy)
      radius     원점에서 수집범위 모서리까지 (정사각형의 반변)
    """

    __slots__ = ("crs", "crs_label", "to_target", "to_wgs", "box", "ox", "oy", "radius")

    def __init__(self, cfg: dict, manifest: dict, origin: str | None = None):
        from pyproj import Transformer

        self.crs, self.crs_label = resolve_crs(cfg, manifest)
        self.to_target = Transformer.from_crs("EPSG:4326", self.crs, always_xy=True).transform
        self.to_wgs = Transformer.from_crs(self.crs, "EPSG:4326", always_xy=True).transform

        minx, miny, maxx, maxy = manifest["bbox_4326"]
        pts = [self.to_target(minx, miny), self.to_target(maxx, miny),
               self.to_target(maxx, maxy), self.to_target(minx, maxy)]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        self.box = (min(xs), min(ys), max(xs), max(ys))

        mode = origin or cfg.get("origin", "center")
        if mode == "center":
            self.ox = round((self.box[0] + self.box[2]) / 2, 3)
            self.oy = round((self.box[1] + self.box[3]) / 2, 3)
        else:
            self.ox = self.oy = 0.0
        self.radius = max(self.box[2] - self.box[0], self.box[3] - self.box[1]) / 2

    def shift(self, x, y, z=None):
        """실좌표 → 도면좌표. shapely 의 transform 에 그대로 넘길 수 있다."""
        return (x - self.ox, y - self.oy)


def site_frame(site, cfg: dict | None = None, origin: str | None = None) -> Frame:
    """대상지의 좌표 기준을 만든다. manifest 가 없으면 알려 준다."""
    manifest = site.read_manifest()
    if not manifest:
        raise FileNotFoundError(f"'{site.name}' 수집 결과가 없습니다.")
    return Frame(cfg or load_config(), manifest, origin)


def slugify(text: str) -> str:
    """주소를 폴더명으로 쓸 수 있게 다듬는다. 한글은 그대로 둔다."""
    text = re.sub(r"[\\/:*?\"<>|]", "", str(text or "")).strip()
    text = re.sub(r"\s+", "-", text)
    # Windows는 끝의 점·공백을 무시하고, ``.``/``..``은 경로 자체를 뜻한다.
    # 이름으로 받은 값이 out/ 바깥을 가리키거나 예약 장치명이 되지 않게 한다.
    text = text[:60].rstrip(" .")
    if not text or text in {".", ".."}:
        return "site"
    reserved = {"CON", "PRN", "AUX", "NUL",
                *(f"COM{i}" for i in range(1, 10)),
                *(f"LPT{i}" for i in range(1, 10))}
    if text.split(".", 1)[0].upper() in reserved:
        text += "-site"
    return text


class Site:
    """대상지 하나의 작업 폴더."""

    def __init__(self, name: str):
        raw = str(name or "").strip()
        if raw and not raw.strip(" ."):
            raise ValueError("대상지 이름은 점(.)만으로 만들 수 없습니다.")
        self.name = slugify(name)
        root = os.path.abspath(OUT_ROOT)
        target = os.path.abspath(os.path.join(root, self.name))
        try:
            inside = os.path.commonpath((root, target)) == root
        except ValueError:
            inside = False
        if not inside or target == root:
            raise ValueError("대상지 이름이 올바른 작업 폴더를 만들지 못합니다.")
        self.dir = target
        self.geojson_dir = os.path.join(self.dir, "geojson")

    def ensure(self):
        os.makedirs(self.geojson_dir, exist_ok=True)
        return self

    @property
    def manifest(self) -> str:
        return os.path.join(self.geojson_dir, "_manifest.json")

    @property
    def db(self) -> str:
        return os.path.join(self.dir, "site.sqlite")

    @property
    def dxf(self) -> str:
        return os.path.join(self.dir, f"{self.name}_사이트맵.dxf")

    @property
    def dxf_selected(self) -> str:
        return os.path.join(self.dir, f"{self.name}_선택부지.dxf")

    @property
    def dxf_terrain(self) -> str:
        return os.path.join(self.dir, f"{self.name}_지형.dxf")

    @property
    def csv_spot(self) -> str:
        return os.path.join(self.dir, "표고점.csv")

    @property
    def ref(self) -> str:
        return os.path.join(self.dir, "좌표기준.txt")

    @property
    def boundary(self) -> str:
        """지도에서 점으로 찍어 그린 구역 경계."""
        return os.path.join(self.dir, "구역경계.geojson")

    @property
    def preview(self) -> str:
        return os.path.join(self.dir, "미리보기.png")

    def geojson(self, data_id: str) -> str:
        return os.path.join(self.geojson_dir, f"{data_id}.geojson")

    def read_manifest(self) -> dict | None:
        if not os.path.exists(self.manifest):
            return None
        with open(self.manifest, encoding="utf-8") as f:
            return json.load(f)

    def exists(self) -> bool:
        return os.path.exists(self.manifest)


_LAST = os.path.join(OUT_ROOT, "_last_site.txt")


def remember_site(name: str) -> None:
    """방금 작업한 대상지를 기록해 다음 단계가 --name 없이도 이어받게 한다."""
    os.makedirs(OUT_ROOT, exist_ok=True)
    with open(_LAST, "w", encoding="utf-8") as f:
        f.write(name)


def last_site() -> str | None:
    if not os.path.exists(_LAST):
        return None
    with open(_LAST, encoding="utf-8") as f:
        name = f.read().strip()
    return name if name and os.path.isdir(os.path.join(OUT_ROOT, name)) else None


def list_sites() -> list[str]:
    if not os.path.isdir(OUT_ROOT):
        return []
    return sorted(
        d for d in os.listdir(OUT_ROOT)
        if os.path.exists(os.path.join(OUT_ROOT, d, "geojson", "_manifest.json"))
    )


def resolve_site(name: str | None, address: str | None = None) -> Site:
    """--name 없으면 주소에서, 그것도 없으면 가장 최근 사이트를 쓴다."""
    if name:
        return Site(name)
    if address:
        return Site(address)
    recent = last_site()
    if recent:
        return Site(recent)
    sites = list_sites()
    if len(sites) == 1:
        return Site(sites[0])
    if not sites:
        raise SystemExit("작업된 대상지가 없습니다. 먼저 `python site.py \"주소\"` 를 실행하세요.")
    raise SystemExit(
        "대상지가 여러 개입니다. --name 으로 지정하세요:\n  " + "\n  ".join(sites)
    )

# ------------------------------------------------------------------ 진행도
#
# 웹 화면이 진행률 바를 그리려면 각 단계가 "지금 몇 %인지" 알려 줘야 한다.
# 터미널에서 직접 돌릴 때는 방해가 되므로, 파이프로 연결됐을 때만 신호를 낸다.
# web.py 가 이 줄을 걷어내고 숫자만 읽는다.

_PIPED = not sys.stdout.isatty()


def progress(pct: float) -> None:
    """이 단계 안에서의 진행도 0~100."""
    if _PIPED:
        print(f"@@P {max(0.0, min(100.0, pct)):.1f}", flush=True)
