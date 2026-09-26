"""사이트 분석 웹 뷰어 — 로컬 실행.

    python web.py          →  http://127.0.0.1:8000

주소를 넣으면 그 대상지를 분석하고, 지도에서 필지를 클릭해 골라 DXF로 내려받습니다.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from functools import lru_cache
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, FiniteFloat, field_validator

from common import (
    ENV_PATH,
    OUT_ROOT,
    Site,
    clean_network_env,
    last_site,
    list_sites,
    network_session,
)
from vworld import VWorld, VWorldError, load_key

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "web", "index.html")

app = FastAPI(title="사이트 분석")
JOBS: dict[str, dict] = {}
JOB_LOCK = threading.RLock()


def _env_int(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


MAX_ACTIVE_JOBS = _env_int("VWORLD_MAX_ACTIVE_JOBS", 3, 1)
JOB_TTL_SECONDS = _env_int("VWORLD_JOB_TTL_SECONDS", 86400, 300)
MAX_DEM_UPLOAD = 8 * 1024 * 1024 * 1024


def _cleanup_jobs_locked(now: float | None = None) -> None:
    now = time.time() if now is None else now
    expired = [job_id for job_id, job in JOBS.items()
               if job.get("status") != "running"
               and now - float(job.get("finished_at") or job.get("created_at") or now)
               > JOB_TTL_SECONDS]
    for job_id in expired:
        JOBS.pop(job_id, None)


def _create_job(payload: dict, requested_id: str | None = None) -> tuple[str, dict]:
    with JOB_LOCK:
        now = time.time()
        _cleanup_jobs_locked(now)
        active = sum(job.get("status") == "running" for job in JOBS.values())
        if active >= MAX_ACTIVE_JOBS:
            raise HTTPException(429, f"동시에 실행할 수 있는 작업은 {MAX_ACTIVE_JOBS}개입니다. 진행 중인 작업이 끝난 뒤 다시 시도하세요.")
        job_id = requested_id or uuid.uuid4().hex[:8]
        while not requested_id and job_id in JOBS:
            job_id = uuid.uuid4().hex[:8]
        if requested_id and job_id in JOBS and JOBS[job_id].get("status") == "running":
            raise HTTPException(409, "같은 진행률 작업 번호가 이미 사용 중입니다.")
        job = {**payload, "created_at": now}
        JOBS[job_id] = job
        return job_id, job


def _finish_job(job: dict) -> None:
    job["finished_at"] = time.time()


# ------------------------------------------------------------------ 접근 잠금
#
# 로컬(127.0.0.1)에서만 쓸 때는 잠금이 없다 — 열자마자 그대로 쓴다.
# 터널 등으로 밖에 열 때만 ACCESS_PASSWORD 를 주면 암호를 묻는다.
# 분석은 하루 1,000건 한도를 태우고 삭제는 되돌릴 수 없어서, 열어둘 수 없다.

ACCESS_PASSWORD = os.environ.get("ACCESS_PASSWORD", "").strip()


@app.middleware("http")
async def guard(request: Request, call_next):
    if not ACCESS_PASSWORD:
        return await call_next(request)
    sent = request.headers.get("authorization", "")
    ok = False
    if sent.lower().startswith("basic "):
        try:
            raw = base64.b64decode(sent.split(" ", 1)[1]).decode("utf-8", "replace")
            ok = secrets.compare_digest(raw.split(":", 1)[-1], ACCESS_PASSWORD)
        except (binascii.Error, ValueError, IndexError):
            ok = False
    if ok:
        return await call_next(request)
    return Response(status_code=401, content="암호가 필요합니다.",
                    headers={"WWW-Authenticate": 'Basic realm="site-analysis"'})


# ------------------------------------------------------------------ 인증키
#
# 각자 자기 키로 쓴다. 화면에서 넣은 키가 요청 머리에 실려 오면 그걸 쓰고,
# 없으면 서버의 .env 를 쓴다. 서버는 남의 키를 저장하지 않는다 — 그 요청에만 쓴다.

def keys_of(request: Request) -> dict[str, str]:
    """요청에 실려 온 인증키를 환경변수 모양으로."""
    got = {}
    for header, name in (("x-vworld-key", "VWORLD_KEY"),
                         ("x-vworld-domain", "VWORLD_DOMAIN"),
                         ("x-data-key", "DATA_GO_KR_KEY")):
        v = (request.headers.get(header) or "").strip()
        if v:
            got[name] = v
    return got


def _env_value(name: str) -> str:
    """환경변수를 우선하고, 없으면 로컬 .env의 단일 값을 읽는다."""
    value = (os.environ.get(name) or "").strip()
    if value or not os.path.exists(ENV_PATH):
        return value
    with open(ENV_PATH, encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, raw = line.partition("=")
            if key.strip() == name:
                return raw.strip().strip('"').strip("'")
    return ""


def gemini_key_of(request: Request) -> str:
    """배포 환경에서는 서버 키를, 필요한 경우 요청별 개인 키를 사용한다."""
    return (request.headers.get("x-gemini-key") or "").strip() or _env_value("GEMINI_API_KEY")


def server_has_keys() -> dict[str, bool]:
    """서버에 키가 있는지. 화면이 「키를 넣으세요」를 띄울지 정하는 데 쓴다."""
    import ledger as ledger_mod
    out = {}
    try:
        load_key(ENV_PATH)
        out["vworld"] = True
    except Exception:
        out["vworld"] = False
    try:
        ledger_mod.load_key(ENV_PATH)
        out["ledger"] = True
    except Exception:
        out["ledger"] = False
    out["gemini"] = bool(_env_value("GEMINI_API_KEY"))
    return out


def vworld_of(request: Request) -> VWorld:
    """요청 브라우저의 키를 우선하고, 없으면 서버 .env 키를 쓴다."""
    mine = keys_of(request)
    key = mine.get("VWORLD_KEY")
    domain = mine.get("VWORLD_DOMAIN") or "http://localhost"
    if not key:
        key, domain = load_key(ENV_PATH)
    return VWorld(key, domain)


# --------------------------------------------------------------------- 작업

def save_boundary(site_name: str, ring: list[list[float]]) -> str:
    """지도에서 찍은 경계를 GeoJSON 으로. QGIS·다른 도구에서도 그대로 열린다."""
    site = Site(site_name)
    os.makedirs(site.dir, exist_ok=True)
    closed = list(ring) + ([ring[0]] if ring[0] != ring[-1] else [])
    fc = {"type": "FeatureCollection",
          "features": [{"type": "Feature", "properties": {"name": "구역 경계"},
                        "geometry": {"type": "Polygon", "coordinates": [closed]}}]}
    with open(site.boundary, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)
    return site.boundary


def run_pipeline(job_id: str, address: str, radius: float, name: str | None,
                 no_ledger: bool, bbox: list[float] | None = None,
                 terrain: bool = True, boundary: list[list[float]] | None = None,
                 keys: dict[str, str] | None = None) -> None:
    job = JOBS[job_id]
    # 화면에서 넣은 키를 하위 프로세스에 넘긴다. 환경변수가 .env 를 이긴다.
    env = clean_network_env(keys)
    collected_site = None

    def step(title: str, argv: list[str], required: bool = True,
             span: tuple[float, float] = (0.0, 100.0)) -> bool:
        """한 단계를 돌린다.

        required=False 면 실패해도 파이프라인을 세우지 않는다. 대장·지형처럼
        외부 서비스에 기대는 단계가 죽었다고 이미 받은 공간정보까지 버릴 이유는 없다.

        span 은 전체 진행률에서 이 단계가 차지하는 구간이다. 하위 스크립트가
        `@@P n` 으로 자기 안에서의 진행도를 알려 주면 그 구간에 맞춰 환산한다.
        """
        nonlocal collected_site
        base, end = span
        job["phase"] = title
        job["progress"] = base
        job["log"].append(f"── {title}")
        proc = subprocess.Popen(
            [sys.executable, "-u", *argv], cwd=HERE, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            if argv[0] == "fetch_site.py" and line.startswith("@@SITE "):
                collected_site = Site(json.loads(line[7:])).name
                continue
            if line.startswith("@@P "):          # 진행도 신호는 로그에 남기지 않는다
                try:
                    job["progress"] = base + (end - base) * float(line[4:]) / 100
                except ValueError:
                    pass
                continue
            job["log"].append(line)
            del job["log"][:-400]
        proc.wait()
        job["progress"] = end
        if proc.returncode != 0:
            if required:
                job["status"] = "error"
                job["log"].append(f"!! {title} 실패")
                return False
            job["log"].append(f"!! {title} 실패 — 건너뛰고 이어갑니다")
        return True

    try:
        if bbox:
            argv = ["fetch_site.py", "--bbox", *[str(v) for v in bbox]]
        else:
            argv = ["fetch_site.py", address, "--radius", str(radius)]
        if name:
            argv += ["--name", name]
        if not step("① 공간정보 수집", argv, span=(0, 55)):
            return

        # 폴더명은 slugify를 거치므로 입력한 이름과 다를 수 있다.
        # 그대로 돌려주면 화면이 없는 대상지를 열려다 실패한다.
        # 최근 대상지는 모든 작업이 공유하는 CLI 편의 기능이다. 동시에 수집하면
        # 다른 작업이 쓴 이름일 수 있으므로, 이 자식 프로세스의 결과만 이어받는다.
        site_name = collected_site
        if not site_name:
            raise RuntimeError("공간정보 수집 결과에 대상지 이름이 없습니다.")
        job["site"] = site_name

        # 점으로 그린 경계는 수집 범위와 별개다. 도판에 남기려고 폴더에 적어 둔다.
        if boundary and len(boundary) >= 3:
            save_boundary(site_name, boundary)
            job["log"].append(f"── 구역 경계 {len(boundary)}점 저장")

        argv = ["build_db.py", "--name", site_name]
        if no_ledger:
            argv.append("--no-ledger")
        # 대장은 공공데이터포털 사정을 탄다. 실패해도 도면·지형은 만들어 준다.
        step("② 건축물대장 조인", argv, required=False, span=(55, 78))

        if not step("③ 도면 생성", ["to_dxf.py", "--name", site_name, "--preview"],
                    span=(78, 90)):
            return

        # 설치된 전국 NGII DEM을 우선하고, 서울은 기존 등고선 자료로 내려간다. 해당
        # 도엽이 아직 없어도 앞의 공간정보 결과는 살린다.
        if terrain:
            job["phase"] = "④ 지형 (등고선·표고점)"
            job["progress"] = 90
            job["log"].append("── ④ 지형 (등고선·표고점)")
            proc = subprocess.Popen(
                [sys.executable, "-u", "terrain.py", "--name", site_name],
                cwd=HERE, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
            )
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    job["log"].append(line)
                    del job["log"][:-400]
            proc.wait()
            if proc.returncode != 0:
                job["log"].append("!! 지형을 가져오지 못했습니다 (나머지 결과는 정상입니다)")

        job["status"] = "done"
        job["phase"] = "완료"
        job["progress"] = 100
        job["log"].append("── 완료")
    except Exception as e:  # 스레드에서 죽으면 상태가 영영 running으로 남는다
        job["status"] = "error"
        job["log"].append(f"!! {e}")
    finally:
        if job.get("status") != "running":
            _finish_job(job)


Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
LonLat = tuple[Longitude, Latitude]


def validate_boundary(ring):
    if not ring:
        return ring
    from shapely.geometry import Polygon
    if len(set(ring)) < 3:
        raise ValueError("경계는 서로 다른 점이 세 개 이상 필요합니다.")
    polygon = Polygon(ring)
    if not polygon.is_valid or polygon.area <= 0:
        raise ValueError("경계가 교차하거나 면적이 없습니다. 외곽선을 다시 그려 주세요.")
    return ring


class AnalyzeRequest(BaseModel):
    address: str = ""
    radius: float = Field(default=350, gt=0, le=2500, allow_inf_nan=False)
    name: str | None = None
    no_ledger: bool = False
    terrain: bool = True              # 전국 NGII DEM 또는 서울시 등고선·표고점
    bbox: list[FiniteFloat] | None = Field(default=None, min_length=4, max_length=4)
    boundary: list[LonLat] | None = None
    _boundary_valid = field_validator("boundary")(validate_boundary)


class SelectRequest(BaseModel):
    pnus: list[str] = Field(default_factory=list)
    only_selected: bool = False
    margin: float = 30.0


class ContextExpandRequest(BaseModel):
    radius: float
    grid: int = 56


class NanoRenderRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=6000)
    image: str = Field(min_length=32, max_length=24_000_000)


MAX_NANO_SOURCE_BYTES = 12 * 1024 * 1024


def _gemini_output_image(payload: dict) -> tuple[str, str] | None:
    """Interactions REST 응답의 마지막 이미지 블록을 찾는다."""
    for step in reversed(payload.get("steps") or []):
        if not isinstance(step, dict) or step.get("type") != "model_output":
            continue
        for content in reversed(step.get("content") or []):
            if not isinstance(content, dict) or content.get("type") != "image":
                continue
            data = content.get("data")
            if data:
                return str(data), str(content.get("mime_type") or "image/png")
    return None


def run_context_expand(job_id: str, name: str, radius: float, grid: int,
                       keys: dict[str, str] | None = None) -> None:
    """Collect and prebuild an expanded 3D-only context in the background."""
    job = JOBS[job_id]
    try:
        import context3d
        import scene as scene_mod

        def report(progress: float, message: str) -> None:
            job["progress"] = max(0.0, min(99.0, float(progress)))
            job["phase"] = message
            if not job["log"] or job["log"][-1] != message:
                job["log"].append(message)
                del job["log"][:-200]

        cached_radius, path = context3d.collect(
            name, radius, keys=keys, on_progress=report
        )
        job["phase"] = "3D 장면 구성 중"
        job["progress"] = 94.0
        scene_mod.build_context_cached(name, radius, grid, path)
        job.update(status="done", phase="완료", progress=100.0,
                   radius=radius, cached_radius=cached_radius)
        job["log"].append("3D 컨텍스트 추가 수집 완료")
    except Exception as exc:
        job["status"] = "error"
        job["phase"] = "오류"
        job["log"].append(f"!! {exc}")
    finally:
        _finish_job(job)


def run_road_analysis(job_id: str, name: str,
                      keys: dict[str, str] | None = None) -> None:
    """Backfill only NGII centerline attributes for an existing site."""
    job = JOBS[job_id]
    try:
        import road_data

        def report(done: int, total: int, count: int) -> None:
            pct = 5 + 90 * done / max(total, 1)
            message = f"도로중심선 수집 · {done}/{total}칸 · {count:,}건"
            job["progress"] = max(float(job.get("progress", 0)), min(95.0, pct))
            job["phase"] = message
            if not job["log"] or job["log"][-1] != message:
                job["log"].append(message)
                del job["log"][:-200]

        api = None
        request_key = (keys or {}).get("VWORLD_KEY")
        if request_key:
            api = VWorld(request_key, (keys or {}).get("VWORLD_DOMAIN") or "http://localhost")
        try:
            result = road_data.materialize_analysis(
                Site(name), api=api, on_progress=report,
            )
        except Exception:
            # 브라우저에 저장된 개인 키가 만료됐으면 서버 키로 한 번 복구한다.
            if not request_key:
                raise
            key, domain = load_key(ENV_PATH)
            job["log"].append("개인 VWorld 키 실패 · 서버 키로 다시 시도")
            result = road_data.materialize_analysis(
                Site(name), api=VWorld(key, domain), on_progress=report,
            )
            job["key_source"] = "server-fallback"

        job.update(status="done", phase="도로망 분석 준비 완료", progress=100.0,
                   count=result.get("count", 0), dataset_id=result.get("dataset_id"))
        job["log"].append(f"도로중심선 {result.get('count', 0):,}건 준비 완료")
    except Exception as exc:
        job["status"] = "error"
        job["phase"] = "도로망 분석 자료를 받지 못했습니다"
        job["log"].append(f"!! {exc}")
    finally:
        _finish_job(job)


# ------------------------------------------------------------------ 엔드포인트

# 화면 파일은 고치면서 쓰는 것이라 캐시를 남기지 않는다.
# 브라우저가 옛 js 를 붙들고 있으면 "고쳤는데 안 바뀐다"가 된다.
NO_CACHE = {"Cache-Control": "no-store, must-revalidate"}


@app.get("/", response_class=HTMLResponse)
def index():
    with open(INDEX, encoding="utf-8") as f:
        return HTMLResponse(f.read(), headers=NO_CACHE)


# ------------------------------------------------------------------ 프리셋
#
# 「지금까지 잡아 놓은 것」을 통째로 다섯 칸에 담아 둔다.
# 브라우저가 아니라 서버에 둔다 — 엣지가 저장소를 막아도 남고,
# 터널로 폰에서 들어와도 같은 프리셋이 보인다.

PRESET_SLOTS = 5
# kind 로 갈래를 나눈다. site = 사이트 분석(어느 대상지를 어떻게 잡았나),
# plan2d = 2D 도판(그 자료를 어떻게 그리나). 서로 섞이면 안 된다.
PRESET_KINDS = {
    "site": "_presets.json",
    "plan2d": "_presets_plan2d.json",
    "diagram3d": "_presets_diagram3d.json",
    "diagram3d_view": "_presets_diagram3d_view.json",
}
_PRESET_LOCK = threading.Lock()


def _preset_path(kind: str) -> str:
    if kind not in PRESET_KINDS:
        raise HTTPException(400, f"프리셋 갈래는 {', '.join(PRESET_KINDS)} 입니다.")
    return os.path.join(OUT_ROOT, PRESET_KINDS[kind])


class Preset(BaseModel):
    label: str = ""
    state: dict = Field(default_factory=dict)


def _now() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _read_presets(kind: str) -> dict:
    try:
        with open(_preset_path(kind), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_presets(kind: str, saved: dict) -> None:
    os.makedirs(OUT_ROOT, exist_ok=True)
    path = _preset_path(kind)
    temporary = path + f".{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as f:
            json.dump(saved, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


@app.get("/api/presets")
def presets_list(kind: str = "site"):
    saved = _read_presets(kind)
    return JSONResponse({
        "slots": [
            {"n": n, **(saved.get(str(n)) or {"label": "", "state": None})}
            for n in range(1, PRESET_SLOTS + 1)
        ]
    })


@app.put("/api/presets/{n}")
def preset_save(n: int, body: Preset, kind: str = "site"):
    if not 1 <= n <= PRESET_SLOTS:
        raise HTTPException(400, f"프리셋은 1~{PRESET_SLOTS} 번입니다.")
    with _PRESET_LOCK:
        saved = _read_presets(kind)
        saved[str(n)] = {"label": body.label[:60], "state": body.state,
                         "saved_at": _now()}
        _write_presets(kind, saved)
    return JSONResponse({"ok": True, "n": n})


@app.delete("/api/presets/{n}")
def preset_clear(n: int, kind: str = "site"):
    with _PRESET_LOCK:
        saved = _read_presets(kind)
        saved.pop(str(n), None)
        _write_presets(kind, saved)
    return JSONResponse({"ok": True})


@app.get("/favicon.ico")
def favicon():
    """빈 응답. 없으면 콘솔에 404 가 찍혀, 진짜 오류를 찾을 때 눈을 어지럽힌다."""
    return Response(status_code=204)


@app.get("/api/district/{code}")
def district_boundary(code: str):
    """법정동 경계. 동까지만 고르면 그 동 전체를 대상으로 잡는 데 쓴다.

    브라우저에서 직접 부르면 다른 출처라 막히므로 서버가 받아 넘긴다.
    """
    if not code.isdigit() or not (5 <= len(code) <= 10):
        raise HTTPException(400, "법정동코드가 아닙니다.")
    from shapely.geometry import shape

    try:
        r = network_session().get(
            f"https://map.vworld.kr/data/geojson/district/{code}.geojson", timeout=30)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        raise HTTPException(502, f"경계를 받지 못했습니다: {e}")

    geom = shape(data["features"][0]["geometry"] if data.get("features") else data["geometry"])
    if geom.is_empty:
        raise HTTPException(404, "경계가 비어 있습니다.")
    # MultiPolygon 이면 가장 큰 조각을 쓴다 (섬처럼 떨어진 부속지는 뺀다)
    poly = max(geom.geoms, key=lambda g: g.area) if geom.geom_type == "MultiPolygon" else geom
    ring = [[round(x, 7), round(y, 7)] for x, y in poly.exterior.coords]
    minx, miny, maxx, maxy = geom.bounds
    return {"code": code, "bbox": [minx, miny, maxx, maxy], "ring": ring,
            "parts": len(getattr(geom, "geoms", [geom]))}


@app.get("/api/admin")
def admin_list():
    """주소 드롭다운용 서울 구·법정동 목록. admin_list.py 로 만들어 둔 파일."""
    path = os.path.join(HERE, "web", "seoul_admin.json")
    if not os.path.exists(path):
        return {"sido": "서울특별시", "gu": {},
                "note": "목록이 없습니다. `python admin_list.py` 를 한 번 실행하세요."}
    with open(path, encoding="utf-8") as f:
        return JSONResponse(json.load(f))


# 화면이 쓰는 스크립트. 파일을 늘릴 때마다 엔드포인트를 새로 적지 않도록
# 허용 목록으로 한 번에 받는다. 목록에 없는 이름은 주지 않는다 —
# 이름을 그대로 경로에 붙이면 폴더 밖 파일까지 읽히기 때문이다.
SCRIPTS = {
    "requests.js": "requests.js",
    "draw.js": "draw.js",
    "presets.js": "presets.js",
    "diagram.js": "diagram.js",
    "plan2d.js": "plan2d.js",
    "render3d.bundle.js": "render3d.bundle.js",
    "rhino3d.bundle.js": "rhino3d.bundle.js",
    "rhino3dm.js": "rhino3dm.js",
    "draco_decoder.js": "draco_decoder.js",
    "draco_wasm_wrapper.js": "draco_wasm_wrapper.js",
    "basis_transcoder.js": "basis_transcoder.js",
    # 이미 열려 있던 탭은 예전 주소를 기억할 수 있다. 그 탭도 새 번들을 받게 한다.
    "render3d.js": "render3d.bundle.js",
}


@app.get("/rhino3dm.wasm")
def rhino3dm_wasm():
    """Rhino 3DM 내보내기에 쓰는 공식 OpenNURBS WebAssembly 모듈."""
    return FileResponse(os.path.join(HERE,"web","rhino3dm.wasm"),
                        media_type="application/wasm",headers=NO_CACHE)


@app.get("/draco_decoder.wasm")
def draco_decoder_wasm():
    """VWorld b3dm 내부의 Draco 압축 메시를 푸는 공식 Three.js 모듈."""
    return FileResponse(os.path.join(HERE,"web","draco_decoder.wasm"),
                        media_type="application/wasm",headers=NO_CACHE)


@app.get("/basis_transcoder.wasm")
def basis_transcoder_wasm():
    """VWorld KTX2 외벽·지붕 텍스처를 푸는 공식 Three.js Basis 모듈."""
    return FileResponse(os.path.join(HERE,"web","basis_transcoder.wasm"),
                        media_type="application/wasm",headers=NO_CACHE)


@app.get("/{name}.js")
def script_js(name: str):
    name = name + ".js"
    if name not in SCRIPTS:
        raise HTTPException(404, "그런 스크립트는 없습니다.")
    return FileResponse(os.path.join(HERE, "web", SCRIPTS[name]),
                        media_type="text/javascript", headers=NO_CACHE)


@app.get("/api/bootstrap")
def bootstrap(request: Request):
    """배경지도 타일은 브라우저가 직접 부르므로 브이월드 키를 내려 준다.
    화면에서 넣은 키가 있으면 그걸 쓰고, 없으면 서버 것을 쓴다."""
    mine = keys_of(request)
    key = mine.get("VWORLD_KEY", "")
    if not key:
        try:
            key, _ = load_key(ENV_PATH)
        except Exception:
            key = ""
    return {"vworld_key": key, "sites": list_sites(), "last": last_site(),
            "server_keys": server_has_keys(), "locked": bool(ACCESS_PASSWORD),
            "version": version_info()}


@app.post("/api/render/nano-banana")
def nano_banana_render(req: NanoRenderRequest, request: Request):
    """현재 3D 뷰를 Nano Banana 2로 사진화한다. 입력과 결과는 서버에 저장하지 않는다."""
    key = gemini_key_of(request)
    if not key:
        raise HTTPException(503, "GEMINI_API_KEY가 없습니다. tools/vworld/.env에 Google Gemini API 키를 넣어 주세요.")

    match = re.fullmatch(r"data:(image/(?:png|jpeg));base64,([A-Za-z0-9+/=\r\n]+)", req.image)
    if not match:
        raise HTTPException(400, "렌더 입력 이미지는 PNG 또는 JPEG data URL이어야 합니다.")
    mime_type, image_data = match.group(1), re.sub(r"\s+", "", match.group(2))
    try:
        decoded = base64.b64decode(image_data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, "렌더 입력 이미지의 base64가 올바르지 않습니다.") from exc
    if len(decoded) > MAX_NANO_SOURCE_BYTES:
        raise HTTPException(413, "렌더 입력 이미지는 12MB 이하여야 합니다.")

    model = _env_value("GEMINI_IMAGE_MODEL") or "gemini-3.1-flash-image"
    body = {
        "model": model,
        "input": [
            {"type": "text", "text": req.prompt.strip()},
            {"type": "image", "mime_type": mime_type, "data": image_data},
        ],
        "response_format": {"type": "image", "image_size": "2K"},
        "store": False,
    }
    session = network_session()
    try:
        response = session.post(
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            json=body,
            timeout=240,
        )
        result = response.json()
    except Exception as exc:
        raise HTTPException(502, "Google 이미지 렌더 API에 연결하지 못했습니다.") from exc
    if not response.ok:
        message = ((result.get("error") or {}).get("message") if isinstance(result, dict) else "")
        status_code = response.status_code if response.status_code < 500 else 502
        raise HTTPException(status_code, "Google 이미지 렌더 실패" + (f": {message}" if message else ""))
    found = _gemini_output_image(result)
    if not found:
        status = result.get("status") if isinstance(result, dict) else ""
        raise HTTPException(502, f"Google 응답에 이미지가 없습니다{f' ({status})' if status else ''}.")
    output_data, output_mime = found
    return {"image": f"data:{output_mime};base64,{output_data}",
            "mime_type": output_mime, "model": model}


@app.get("/api/vworld/webgl-config")
def vworld_webgl_config(request: Request):
    """VWorld의 document.write 기반 초기화 파일을 안전한 지연 로더 정보로 바꾼다.

    공식 ``webglMapInit.js.do``는 페이지가 처음 파싱될 때 동기 ``<script>``로 넣는
    사용법만 가정한다. 버튼을 누른 뒤 그대로 실행하면 document.write가 이미 열린
    앱 문서를 덮거나 Chrome이 삽입을 무시한다. 서버에서 키 유효성을 확인하고 3D에
    필요한 두 엔진 URL만 추려, 브라우저가 순서대로 append할 수 있게 돌려준다.
    """
    api = vworld_of(request)
    session = network_session()
    try:
        response = session.get(
            "https://map.vworld.kr/js/webglMapInit.js.do",
            params={"version": "3.0", "apiKey": api.key},
            timeout=30,
        )
        response.raise_for_status()
        source = response.text
    except Exception as exc:
        raise HTTPException(502, "VWorld WebGL 초기화 정보를 받지 못했습니다.") from exc
    finally:
        session.close()

    def value(name: str, default: str = "") -> str:
        match = re.search(rf"var\s+{re.escape(name)}\s*=\s*['\"]([^'\"]*)", source)
        return match.group(1) if match else default

    valid = value("vworldIsValid", "false").lower() == "true"
    error = value("vworldErrMsg", "")
    if not valid:
        raise HTTPException(403, error or "이 인증키는 VWorld 3D 지도 API를 사용할 수 없습니다.")

    paths = re.findall(r'vworldUrl\s*\+\s*["\']([^"\']+\.js(?:\?[^"\']*)?)', source)
    scripts = []
    for path in paths:
        path = path.rstrip("\\")
        if not ("WSViewerStartup.js" in path or "VWViewerStartup" in path):
            continue
        url = "https://map.vworld.kr" + path
        if url not in scripts:
            scripts.append(url)
    if len(scripts) < 2:
        # 공식 파일의 공백/따옴표 모양이 바뀌어도 알려진 3.0 엔진으로 복구한다.
        scripts = [
            "https://map.vworld.kr/js/ws3dmap/WS3DRelease3/WSViewerStartup.js",
            "https://map.vworld.kr/js/ws3dmap/WS3DRelease3/VWViewerStartup.v30.min.js?ver=2024061902",
        ]
    scripts.append("/api/vworld/webgl-ol3.js")
    return {
        "valid": True,
        "scripts": scripts,
        "vector_key": value("vworldVectorKey", ""),
        "api_version": "3.0",
    }


@lru_cache(maxsize=1)
def _safe_vworld_ol3_loader() -> str:
    """ol3 결합 스크립트의 document.write를 의존성 URL 수집으로 바꾼다."""
    session = network_session()
    try:
        response = session.get(
            "https://map.vworld.kr/js/ws3dmap/WS3DRelease3/vw.ol3WebGL.v30.js",
            params={"ver": "2024061902"}, timeout=30,
        )
        response.raise_for_status()
        source = response.text
    finally:
        session.close()
    output = ["window.__VWORLD_OL3_DEPS__ = [];"]
    replaced = 0
    jquery_replaced = 0
    for line in source.splitlines():
        if "document.write" not in line:
            # 이 앱은 ``$``를 querySelector 단축 함수로 이미 선언한다. VWorld의
            # CommonFunc는 같은 전역 이름을 jQuery라고 가정하므로 그대로 두면
            # ``$(...).addClass is not a function``으로 지도 시작이 멈춘다. VWorld
            # 결합 모듈 안의 호출만 명시적인 jQuery 전역으로 고정한다.
            safe_line, count = re.subn(r"(?<![\w$.])\$\(", "window.jQuery(", line)
            jquery_replaced += count
            output.append(safe_line)
            continue
        source_at = line.find("src=\\\'\"")
        start = line.find("+", source_at) + 1 if source_at >= 0 else -1
        end = line.rfind("+ \"\\\'></script>\");")
        if start <= 0 or end <= start:
            # 공식 파일 모양이 달라졌을 때 document.write를 실행하는 것보다는 명확히
            # 실패하는 편이 안전하다. 이미 열린 앱 문서를 절대 덮지 않는다.
            output.append("/* unsupported VWorld document.write omitted: " +
                          line.replace("*/", "") + " */")
            continue
        expression = line[start:end].strip()
        output.append(f"window.__VWORLD_OL3_DEPS__.push(String({expression}));")
        replaced += 1
    if replaced < 8:
        raise RuntimeError("VWorld ol3 의존성 로더 형식이 변경되었습니다.")
    if jquery_replaced < 10:
        raise RuntimeError("VWorld ol3 jQuery 결합 형식이 변경되었습니다.")
    return "\n".join(output)


@app.get("/api/vworld/webgl-ol3.js")
def vworld_webgl_ol3_loader():
    """페이지를 지우지 않는 VWorld ol3 결합 로더."""
    try:
        source = _safe_vworld_ol3_loader()
    except Exception as exc:
        raise HTTPException(502, "VWorld WebGL 결합 모듈을 준비하지 못했습니다.") from exc
    return Response(content=source, media_type="text/javascript", headers=NO_CACHE)


@app.get("/api/terrain/status")
def terrain_data_status():
    """현재 설치된 전국 NGII DEM 도엽과 버전."""
    try:
        from terrain_data import status
        return status()
    except (ImportError, OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(500, str(exc)) from exc


@app.post("/api/terrain/import")
async def import_terrain_data(request: Request, filename: str = ""):
    """브라우저가 보낸 NGII DEM ZIP/IMG/GeoTIFF를 스트리밍 설치한다.

    multipart 파서가 파일 전체를 메모리에 올리지 않도록 본문 자체를 파일로 받는다.
    현재 서버는 localhost 전용이고, 외부 공개 시에는 기존 ACCESS_PASSWORD 또는 관리자
    인증으로 이 엔드포인트를 반드시 잠가야 한다.
    """
    safe_name = os.path.basename(filename or "NGII_DEM.zip").strip()
    suffix = os.path.splitext(safe_name)[1].lower()
    if suffix not in (".zip", ".img", ".tif", ".tiff"):
        raise HTTPException(400, "NGII DEM ZIP, IMG, TIF, TIFF 파일만 설치할 수 있습니다.")

    from terrain_data import CACHE_ROOT, import_source
    inbox = os.path.join(CACHE_ROOT, "inbox")
    os.makedirs(inbox, exist_ok=True)
    upload = os.path.join(inbox, f"upload-{uuid.uuid4().hex}{suffix}")
    total = 0
    try:
        with open(upload, "wb") as f:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_DEM_UPLOAD:
                    raise HTTPException(413, "DEM 설치 파일은 8GB까지 받을 수 있습니다.")
                f.write(chunk)
        result = await asyncio.to_thread(import_source, upload, safe_name)
    except HTTPException:
        raise
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        try:
            os.remove(upload)
        except OSError:
            pass
    _PREVIEW_CACHE.clear()
    return {"ok": True, "bytes": total, "version": result.get("version"),
            "added": result.get("added", 0), "tiles": len(result.get("files") or []),
            "bbox_4326": result.get("bbox_4326") or []}


def _find_repo() -> str:
    """저장소 최상위를 git 에게 물어본다.

    이 폴더가 저장소 뿌리인 경우(도구만 분리해 배포한 저장소)와
    하위 폴더인 경우(전체 작업 저장소) 둘 다 그대로 동작해야 한다.
    """
    try:
        r = subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return os.path.abspath(r.stdout.strip())
    except Exception:
        pass
    return HERE


REPO = _find_repo()


def _git(*args, timeout=20):
    # git 이 자격증명을 물으면 창이 뜬 채로 멈춰 선다. 그 사이 브라우저는
    # 응답을 못 받아 「Failed to fetch」만 보게 된다. 아예 못 묻게 막고,
    # 못 하면 빨리 실패하게 한다 — 실패는 화면에 이유를 적어 줄 수 있다.
    env = {**os.environ,
           "GIT_TERMINAL_PROMPT": "0",       # 터미널에서 묻지 않기
           "GCM_INTERACTIVE": "never",       # 윈도우 자격증명 관리자 창 띄우지 않기
           "GIT_ASKPASS": "echo",
           "GIT_CONFIG_PARAMETERS": "'credential.interactive=never'"}
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout, env=env)


def version_info() -> dict:
    """지금 돌고 있는 버전. 베타라서 어느 시점 코드인지 알 수 있어야 한다."""
    if not os.path.isdir(os.path.join(REPO, ".git")):
        return {"commit": None,
                "note": "git 저장소가 아닙니다 — 자동 업데이트를 받으려면 복사 대신 clone 하세요"}
    try:
        return {
            "commit": _git("rev-parse", "--short", "HEAD").stdout.strip(),
            "date": _git("log", "-1", "--format=%cs").stdout.strip(),
            "subject": _git("log", "-1", "--format=%s").stdout.strip(),
            "branch": _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip(),
            "note": None,
        }
    except Exception as e:
        return {"commit": None, "note": f"버전 확인 실패: {e}"}


@app.get("/api/update/check")
def update_check():
    """원격에 새 버전이 있는지 확인. 네트워크를 타므로 눌렀을 때만 호출한다."""
    if not os.path.isdir(os.path.join(REPO, ".git")):
        return {"available": False, "reason": "git 저장소가 아닙니다"}
    try:
        # 30초를 넘기면 포기한다. 더 기다려 봐야 브라우저 쪽이 먼저 끊긴다.
        f = _git("fetch", "--quiet", timeout=30)
        if f.returncode != 0:
            why = (f.stderr or f.stdout or "").strip().splitlines()
            return {"available": False,
                    "reason": "깃허브에 닿지 못했습니다 — " +
                              (why[-1][:160] if why else "이유를 알 수 없습니다")}
        behind = int((_git("rev-list", "--count", "HEAD..@{u}").stdout or "0").strip() or 0)
        log = _git("log", "--oneline", "HEAD..@{u}").stdout
        return {"available": behind > 0, "behind": behind,
                "changes": [l for l in log.splitlines() if l.strip()][:20]}
    except subprocess.TimeoutExpired:
        return {"available": False,
                "reason": "깃허브 응답이 없어 30초 만에 그만두었습니다. 잠시 뒤 다시 눌러 보세요."}
    except Exception as e:
        return {"available": False, "reason": f"확인 실패: {e}"}


@app.post("/api/update/apply")
def update_apply():
    """새 버전을 받는다. 되돌릴 수 없는 병합은 하지 않고 fast-forward만 허용한다."""
    if not os.path.isdir(os.path.join(REPO, ".git")):
        raise HTTPException(400, "git 저장소가 아닙니다.")
    before = _git("rev-parse", "--short", "HEAD").stdout.strip()
    r = _git("pull", "--ff-only", timeout=120)
    if r.returncode != 0:
        raise HTTPException(500,
            "업데이트 실패 — 이 PC에서 파일을 고쳤을 수 있습니다.\n"
            "폴더에서 update.bat 을 실행해 안내를 보세요.\n\n" + (r.stderr or r.stdout))
    after = _git("rev-parse", "--short", "HEAD").stdout.strip()
    # requirements.txt 가 바뀌었으면 패키지도 다시 맞춰야 한다
    changed = _git("diff", "--name-only", f"{before}..{after}").stdout
    need_pip = "requirements.txt" in changed
    return {"ok": True, "before": before, "after": after,
            "restart_required": before != after, "pip_required": need_pip,
            "message": ("받았습니다. 창을 닫고 다시 실행하세요."
                        + (" 패키지도 바뀌었으니 update.bat 으로 다시 여세요." if need_pip else ""))
                       if before != after else "이미 최신입니다."}


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest, request: Request):
    if req.name:
        try:
            Site(req.name)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    if req.bbox:
        if len(req.bbox) != 4:
            raise HTTPException(400, "영역은 [minLon, minLat, maxLon, maxLat] 네 값이어야 합니다.")
        minx, miny, maxx, maxy = req.bbox
        if not (-180 <= minx <= 180 and -180 <= maxx <= 180
                and -90 <= miny <= 90 and -90 <= maxy <= 90):
            raise HTTPException(400, "경도·위도의 허용 범위를 벗어났습니다.")
        if maxx <= minx or maxy <= miny:
            raise HTTPException(400, "영역이 잘못되었습니다.")
        # 너무 넓으면 수집이 수십 분씩 걸리고 API 호출도 폭증한다
        if (maxx - minx) > 0.05 or (maxy - miny) > 0.05:
            raise HTTPException(400, "영역이 너무 넓습니다. 한 변 5km 이내로 잡아주세요.")
    elif not req.address.strip():
        raise HTTPException(400, "주소를 입력하거나 지도에서 영역을 지정하세요.")

    job_id, _ = _create_job({"status": "running", "log": [], "site": None,
                             "progress": 0.0, "phase": "준비"})
    threading.Thread(
        target=run_pipeline,
        args=(job_id, req.address.strip(), req.radius, req.name, req.no_ledger,
              req.bbox, req.terrain, req.boundary, keys_of(request)),
        daemon=True,
    ).start()
    return {"job_id": job_id}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    with JOB_LOCK:
        _cleanup_jobs_locked()
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "작업을 찾을 수 없습니다.")
        return {**job, "log": list(job.get("log") or [])}


def _site_or_404(name: str) -> Site:
    try:
        site = Site(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not site.exists():
        raise HTTPException(404, f"'{name}' 대상지가 없습니다.")
    return site


def _ledger_map(site: Site) -> dict[str, dict]:
    if not os.path.exists(site.db):
        return {}
    con = sqlite3.connect(site.db)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("SELECT * FROM parcel_full").fetchall()
    except sqlite3.Error:
        return {}
    finally:
        con.close()
    return {r["pnu"]: {k: r[k] for k in r.keys()} for r in rows}


@app.get("/api/site/{name}")
def site_info(name: str):
    site = _site_or_404(name)
    manifest = site.read_manifest()
    bbox = manifest["bbox_4326"]
    # 같은 이름으로 다시 분석해도 원본·경계가 달라지면 다이어그램 캐시가 바뀌었다는
    # 것을 브라우저가 바로 알 수 있어야 한다.
    try:
        import scene as scene_mod
        scene_fingerprint = scene_mod.fingerprint(site)
    except Exception:
        scene_fingerprint = ""
    return {
        "name": site.name,
        "bbox": bbox,
        "center": [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2],
        "resolved_by": manifest.get("resolved_by", {}),
        "layers": manifest.get("layers", []),
        "has_db": os.path.exists(site.db),
        "has_dxf": os.path.exists(site.dxf),
        "has_terrain": os.path.exists(site.dxf_terrain),
        "has_spot": os.path.exists(site.csv_spot),
        "scene_fingerprint": scene_fingerprint,
    }


class TerrainRequest(BaseModel):
    refresh: bool = False


@app.post("/api/site/{name}/terrain")
def make_terrain(name: str, req: TerrainRequest, request: Request):
    """이미 분석해 둔 대상지에 지형만 뒤늦게 붙인다."""
    site = _site_or_404(name)
    argv = [sys.executable, "-u", "terrain.py", "--name", site.name]
    if req.refresh:
        argv.append("--refresh")
    proc = subprocess.run(argv, cwd=HERE, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=900,
                          env=clean_network_env(keys_of(request)))
    if proc.returncode != 0:
        raise HTTPException(500, (proc.stdout or "") + (proc.stderr or ""))
    try:
        import scene as scene_mod
        scene_fingerprint = scene_mod.fingerprint(site)
    except Exception:
        scene_fingerprint = ""
    _PREVIEW_CACHE.pop(site.name, None)
    return {"ok": True, "log": proc.stdout.splitlines()[-12:],
            "has_terrain": os.path.exists(site.dxf_terrain),
            "has_spot": os.path.exists(site.csv_spot),
            "scene_fingerprint": scene_fingerprint}


@app.get("/api/site/{name}/parcels")
def parcels(name: str):
    """지적도 GeoJSON에 대장 속성을 붙여서 내보낸다."""
    site = _site_or_404(name)
    path = site.geojson("LP_PA_CBND_BUBUN")
    if not os.path.exists(path):
        raise HTTPException(404, "지적도 데이터가 없습니다.")
    with open(path, encoding="utf-8") as f:
        fc = json.load(f)

    info = _ledger_map(site)
    keep = ("jimok", "zone", "district", "건물동수", "대장건수", "main_purps", "strct", "roof",
            "use_apr_year", "grnd_flr_cnt", "tot_area", "bc_rat", "vl_rat",
            "필지면적_m2", "필지면적_평")
    for feat in fc["features"]:
        props = feat.setdefault("properties", {})
        row = info.get(str(props.get("pnu") or ""))
        if row:
            props.update({k: row.get(k) for k in keep})
    return JSONResponse(fc)


@app.get("/api/site/{name}/scene")
def scene_data(name: str, radius: float = 0.0, grid: int = 56):
    """다이어그램 탭이 쓰는 3차원 장면. DXF와 같은 좌표계·같은 원점의 미터 좌표.

    grid 는 지형 격자 한 변의 칸 수. 크면 삼각형이 잘아지고 응답도 커진다.
    """
    site = _site_or_404(name)
    import context3d
    import scene as scene_mod
    full_radius = scene_mod._full_radius(name)
    # radius 0 은 「수집 범위 전체」라는 뜻이다. 여기서 하한을 씌우면 그 뜻이 죽는다.
    if radius and radius > 0:
        radius = max(50.0, min(radius, context3d.MAX_RADIUS))
    else:
        radius = 0.0
    grid = max(16, min(grid, 120))
    try:
        if radius > full_radius:
            covering = context3d.find_covering(name, radius)
            if not covering:
                raise HTTPException(409, "이 반경은 3D 컨텍스트 추가 수집이 필요합니다.")
            _, path = covering
            data = scene_mod.build_context_cached(name, radius, grid, path)
        else:
            data = scene_mod.build_cached(name, radius, grid)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    data = {k: v for k, v in data.items() if k != "pad"}   # 가장자리 보간용, 화면은 안 쓴다
    manifest = site.read_manifest()
    resolved_by = manifest.get("resolved_by") or {}
    bbox = manifest.get("bbox_4326", [])
    # site.name은 사용자가 붙인 프로젝트명일 수 있으므로 주소와 섞지 않는다.
    # 수집 manifest에는 정규화된 주소가 resolved_by 아래에 저장된다.
    data["site_label"] = manifest.get("site") or name
    data["address"] = (manifest.get("address") or resolved_by.get("address")
                       or resolved_by.get("query") or "")
    if len(bbox) == 4:
        data["center"] = [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2]
    data["full_radius"] = full_radius
    data["context_cached_radii"] = context3d.cached_radii(name)
    data["max_context_radius"] = context3d.MAX_RADIUS
    return JSONResponse(data)


@app.post("/api/site/{name}/road-analysis")
def ensure_road_analysis(name: str, request: Request):
    """Fill missing road-analysis attributes without rebuilding the saved site preset."""
    site = _site_or_404(name)
    path = site.geojson("ROAD_CENTERLINE")
    try:
        with open(path, encoding="utf-8") as f:
            count = len((json.load(f) or {}).get("features") or [])
    except (OSError, ValueError):
        count = 0
    if count:
        return {"cached": True, "count": count, "dataset_id": "lt_l_n3a0020000"}

    with JOB_LOCK:
        for existing_id, existing in list(JOBS.items()):
            if (existing.get("kind") == "road-analysis" and existing.get("site") == site.name
                    and existing.get("status") == "running"):
                return {"cached": False, "job_id": existing_id, "reused_job": True}

    job_id, _ = _create_job({
        "kind": "road-analysis", "status": "running", "log": [],
        "site": site.name, "progress": 0.0, "phase": "도로망 분석 자료 준비",
    })
    threading.Thread(
        target=run_road_analysis,
        args=(job_id, site.name, keys_of(request)),
        daemon=True,
    ).start()
    return {"cached": False, "job_id": job_id}


@app.get("/api/precision-roads")
def precision_road_catalog():
    """화면에 노출할 정밀도로 레이어의 고정 화이트리스트."""
    import precision_roads
    return {"layers": precision_roads.layer_catalog()}


@app.get("/api/site/{name}/precision-road/{layer_id}")
def precision_road_layer(name: str, layer_id: str, request: Request,
                         refresh: bool = False):
    """정밀도로 요소를 켠 순간에만 WFS로 받고 대상지 좌표로 변환한다."""
    site = _site_or_404(name)
    import precision_roads
    try:
        return precision_roads.collect(site, layer_id, vworld_of(request), refresh=refresh)
    except VWorldError as exc:
        raise HTTPException(502, str(exc)) from exc
    except (ValueError, OSError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        # requests 오류에는 키가 든 URL이 포함될 수 있으므로 상세 문자열을 그대로
        # 브라우저에 보내지 않는다. VWorld 클라이언트의 오류는 이미 정제되어 있다.
        raise HTTPException(502, "정밀도로 WFS를 불러오지 못했습니다.") from exc


@app.get("/api/roads/status")
def road_catalog_status(site: str = ""):
    """대상지 도로면 출처, 공식 최신판, 로컬 current/보존판을 함께 보여 준다."""
    import road_data
    target = _site_or_404(site) if site else None
    return road_data.catalog_status(target, refresh=False)


@app.post("/api/roads/catalog/refresh")
def refresh_road_catalog(site: str = ""):
    """ZIP을 바꾸지 않고 공식 자료실의 버전 목록만 새로 확인한다."""
    import road_data
    target = _site_or_404(site) if site else None
    try:
        return road_data.catalog_status(target, refresh=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/site/{name}/scene-context")
def expand_scene_context(name: str, req: ContextExpandRequest, request: Request):
    """Start explicit collection when the requested 3D radius exceeds PROJECT SITE."""
    _site_or_404(name)
    import context3d

    base = context3d.base_radius(name)
    radius = int(round(req.radius))
    grid = max(16, min(req.grid, 120))
    if radius <= base:
        return {"cached": True, "radius": radius, "base_radius": base}
    if radius > context3d.MAX_RADIUS:
        raise HTTPException(400, f"3D 컨텍스트는 최대 {context3d.MAX_RADIUS}m까지 가능합니다.")
    covering = context3d.find_covering(name, radius)
    if covering:
        return {"cached": True, "radius": radius, "cached_radius": covering[0]}
    with JOB_LOCK:
        for existing_id, existing in list(JOBS.items()):
            if (existing.get("kind") == "context3d" and existing.get("site") == Site(name).name
                    and existing.get("requested_radius") == radius
                    and existing.get("status") == "running"):
                return {"cached": False, "job_id": existing_id, "reused_job": True}

    job_id, _ = _create_job({
        "kind": "context3d", "status": "running", "log": [],
        "site": Site(name).name, "requested_radius": radius,
        "progress": 0.0, "phase": "추가 수집 준비",
    })
    threading.Thread(
        target=run_context_expand,
        args=(job_id, name, radius, grid, keys_of(request)),
        daemon=True,
    ).start()
    return {"cached": False, "job_id": job_id}


@app.get("/api/site/{name}/aerial")
def aerial(request: Request, name: str, radius: float = 250.0, size: int = 1400,
           layer: str = "satellite", gray: bool = False, job_id: str = "",
           refresh: bool = False):
    """2D 도판에 깔 바탕 사진. 장면과 같은 좌표계·같은 범위로 재투영해 준다."""
    _site_or_404(name)
    # 잘린 반경을 화면에 알려 줘야 한다. 화면은 사진이 ±radius 를 덮는다고 믿고
    # 그 자리에 붙이는데, 여기서 몰래 줄이면 모델과 사진이 어긋난다.
    radius = max(50.0, min(radius, 2500.0))
    size = max(256, min(size, 2400))
    if layer not in ("satellite", "base"):
        raise HTTPException(400, "layer 는 satellite 또는 base 입니다.")
    if job_id:
        if (len(job_id) > 48
                or not all(c.isalnum() or c in "-_" for c in job_id)):
            raise HTTPException(400, "잘못된 진행률 작업 번호입니다.")
    _, job = _create_job({
        "kind": "aerial", "status": "running", "log": [],
        "site": Site(name).name, "progress": 0.0, "phase": "위성사진 준비 중",
    }, requested_id=job_id or None)

    def report(progress: float, message: str) -> None:
        # 잘못된 개인 키에서 서버 키로 재시도할 때 숫자가 뒤로 가지 않게 한다.
        job["progress"] = max(float(job.get("progress", 0)),
                              min(99.0, max(0.0, float(progress))))
        job["phase"] = message

    def mark_error(message: str) -> None:
        job.update(status="error", phase="위성사진 오류")
        job["log"] = [message]
        _finish_job(job)

    request_keys = keys_of(request)
    key_source = "request" if request_keys.get("VWORLD_KEY") else "server"
    try:
        import aerial as aerial_mod
        path = aerial_mod.build(name, radius, size, layer, gray,
                                keys=request_keys, on_progress=report, refresh=refresh)
    except (FileNotFoundError, ValueError) as e:
        mark_error(str(e))
        raise HTTPException(400, str(e))
    except Exception as first_error:
        # 브라우저 localStorage에 만료되거나 다른 도메인용인 키가 남아 있으면
        # 그 키가 서버의 정상 .env 키보다 우선된다. 새 반경 사진에서만 갑자기
        # 실패하는 이유다. 개인 키가 실패했을 때 서버 키로 한 번 더 받아 준다.
        if not request_keys.get("VWORLD_KEY"):
            mark_error(str(first_error))
            raise HTTPException(
                502, f"바탕 사진을 만들지 못했습니다: {first_error}"
            )
        report(job["progress"],
               "브라우저 키 오류 · 서버 키로 다시 받는 중")
        try:
            path = aerial_mod.build(name, radius, size, layer, gray, keys={},
                                    on_progress=report, refresh=refresh)
            key_source = "server-fallback"
        except (FileNotFoundError, ValueError) as e:
            mark_error(str(e))
            raise HTTPException(400, str(e))
        except Exception as server_error:
            message = ("브라우저 키와 서버 키가 모두 실패했습니다. "
                       f"서버 키 오류: {server_error}")
            mark_error(message)
            raise HTTPException(
                502,
                f"바탕 사진을 만들지 못했습니다: {message}",
            )
    job.update(status="done", phase="위성사진 준비 완료", progress=100.0)
    _finish_job(job)
    # 실제로 쓴 반경을 함께 준다. 화면은 이 값으로 사진을 붙여야 어긋나지 않는다.
    return FileResponse(path, media_type="image/png",
                        headers={"X-Aerial-Radius": str(radius),
                                 "X-VWorld-Key-Source": key_source})


@app.get("/api/site/{name}/buildings")
def buildings(name: str):
    site = _site_or_404(name)
    path = site.geojson("LT_C_SPBD")
    if not os.path.exists(path):
        return JSONResponse({"type": "FeatureCollection", "features": []})
    with open(path, encoding="utf-8") as f:
        return JSONResponse(json.load(f))


# 내보내기 미리보기가 쓰는 가벼운 선 뭉치. 원자료를 그대로 주면 수 MB 라
# 창이 뜨는 데만 한참 걸린다. 380px 짜리 그림에 필요한 만큼만 남긴다.
_PREVIEW_CACHE: dict[str, tuple[str, dict]] = {}

# 미리보기에서 쓰는 이름 ← 브이월드 데이터ID
_PREVIEW_LAYERS = {
    "road": "LT_L_SPRD",
    "zone": "LT_C_UQ111",
    "district": "LT_C_UPISUQ161",
    "planroad": "LT_C_UPISUQ151",
}

# 이보다 촘촘한 점은 미리보기에서 같은 픽셀에 찍힌다. 도(degree) 단위 — 약 2m.
_PREVIEW_TOL = 2e-5


def _thin(coords, tol: float = _PREVIEW_TOL):
    """앞 점에서 tol 도 이상 떨어진 점만 남긴다. 끝점은 지킨다."""
    out = []
    for x, y in coords:
        if not out or abs(x - out[-1][0]) > tol or abs(y - out[-1][1]) > tol:
            out.append([round(x, 6), round(y, 6)])
    if len(coords) > 1 and out[-1] != [round(coords[-1][0], 6), round(coords[-1][1], 6)]:
        out.append([round(coords[-1][0], 6), round(coords[-1][1], 6)])
    return out if len(out) > 1 else []


def _lines_of(geom) -> list:
    """어떤 GeoJSON 도형이든 그릴 선들로 편다. 폴리곤은 테두리(구멍 포함)로."""
    t, c = geom.get("type"), geom.get("coordinates")
    if not c:
        return []
    if t == "LineString":
        return [c]
    if t == "MultiLineString":
        return list(c)
    if t == "Polygon":
        return list(c)
    if t == "MultiPolygon":
        return [ring for poly in c for ring in poly]
    if t == "GeometryCollection":
        return [ln for g in geom.get("geometries", []) for ln in _lines_of(g)]
    return []


def _contours_lonlat(name: str) -> list:
    """등고선을 위경도로. 장면 캐시가 이미 있을 때만 — 없으면 만들지 않고 건너뛴다.

    지형은 만드는 데 수십 초가 걸린다. 미리보기 하나 띄우자고 그걸 기다리게 할 수 없다.
    """
    site = Site(name)
    try:
        import glob as _glob

        from pyproj import Transformer

        import scene as scene_mod
    except ImportError:
        return []
    if not _glob.glob(os.path.join(site.dir, "_scene_*.json")):
        return []
    try:
        data = scene_mod.build_cached(name, 0.0, 56)
    except Exception:
        return []
    ox, oy = data.get("origin") or (0, 0)
    fwd = Transformer.from_crs(data["crs"], "EPSG:4326", always_xy=True).transform
    out = []
    for c in data.get("contours") or []:
        pts = [fwd(ox + p[0], oy + p[1]) for p in c.get("pts") or []]
        thinned = _thin(pts)
        if thinned:
            out.append(thinned)
    return out


@app.get("/api/site/{name}/preview")
def preview_layers(name: str):
    """내보내기 창의 미리보기가 쓰는 레이어들 — 지적도·건물 말고 나머지."""
    site = _site_or_404(name)
    # manifest뿐 아니라 지형·경계·레이어 원본까지 같은 지문으로 묶는다.
    # 지형만 다시 만들었을 때도 예전 등고선 미리보기가 남아 있으면 안 된다.
    try:
        import scene as scene_mod
        stamp = scene_mod.fingerprint(site)
    except (ImportError, OSError, ValueError):
        stamp = str(os.stat(site.manifest).st_mtime_ns)
    hit = _PREVIEW_CACHE.get(site.name)
    if hit is not None and hit[0] == stamp:
        return JSONResponse(hit[1])

    out: dict[str, list] = {}
    for key, data_id in _PREVIEW_LAYERS.items():
        path = site.geojson(data_id)
        if not os.path.exists(path):
            out[key] = []
            continue
        try:
            with open(path, encoding="utf-8") as f:
                fc = json.load(f)
        except (ValueError, OSError):
            out[key] = []
            continue
        lines = []
        for feat in fc.get("features", []):
            for ln in _lines_of(feat.get("geometry") or {}):
                thinned = _thin(ln)
                if thinned:
                    lines.append(thinned)
        out[key] = lines
    out["terrain"] = _contours_lonlat(name)

    _PREVIEW_CACHE[site.name] = (stamp, out)
    return JSONResponse(out)


@app.post("/api/site/{name}/dxf")
def make_dxf(name: str, req: SelectRequest):
    """선택한 필지를 V-SITE 레이어로 넣어 DXF를 다시 만든다.

    only_selected 면 고른 필지와 그 위의 건물만 담은 별도 파일을 만든다.
    """
    site = _site_or_404(name)
    if req.only_selected and not req.pnus:
        raise HTTPException(400, "선택한 필지가 없습니다.")

    argv = [sys.executable, "-u", "to_dxf.py", "--name", site.name, "--preview"]
    if req.pnus:
        argv += ["--select", *req.pnus]
    if req.only_selected:
        argv += ["--only-selected", "--margin", str(req.margin)]

    proc = subprocess.run(argv, cwd=HERE, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise HTTPException(500, (proc.stdout or "") + (proc.stderr or ""))
    return {"ok": True, "kind": "selected" if req.only_selected else "full",
            "log": proc.stdout.splitlines()[-14:]}



class BoundaryRequest(BaseModel):
    ring: list[LonLat] = Field(default_factory=list)
    _ring_valid = field_validator("ring")(validate_boundary)


@app.post("/api/site/{name}/boundary")
def set_boundary(name: str, req: BoundaryRequest):
    """PROJECT SITE 경계를 정하고 도면을 다시 만든다.

    수집을 다시 하지 않는다. 이미 받아 둔 자료를 새 경계로 자르기만 하면 된다.
    """
    site = _site_or_404(name)
    if req.ring and len(req.ring) >= 3:
        save_boundary(site.name, req.ring)
        note = f"경계 {len(req.ring)}점 적용"
    else:
        if os.path.exists(site.boundary):
            os.remove(site.boundary)
        note = "경계 해제 — CONTEXT 수집범위 전체로 자릅니다"

    proc = subprocess.run([sys.executable, "-u", "to_dxf.py", "--name", site.name, "--preview"],
                          cwd=HERE, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise HTTPException(500, (proc.stdout or "") + (proc.stderr or ""))
    _PREVIEW_CACHE.pop(site.name, None)
    return {"ok": True, "note": note, "log": proc.stdout.splitlines()[-12:]}


@app.get("/api/site/{name}/boundary")
def get_boundary(name: str):
    """저장된 PROJECT SITE 경계. 화면에 다시 그려 준다."""
    site = _site_or_404(name)
    if not os.path.exists(site.boundary):
        return {"ring": []}
    with open(site.boundary, encoding="utf-8") as f:
        fc = json.load(f)
    try:
        ring = fc["features"][0]["geometry"]["coordinates"][0]
    except (KeyError, IndexError, TypeError):
        return {"ring": []}
    return {"ring": ring}



class ExportRequest(BaseModel):
    scope: Literal["context", "project", "design", "area"] = "context"
    pnus: list[str] = Field(default_factory=list)
    ring: list[LonLat] = Field(default_factory=list)
    layers: list[Literal["parcel", "bldg", "road", "zone", "district", "planroad"]] = Field(default_factory=list)
    _ring_valid = field_validator("ring")(validate_boundary)


@app.post("/api/site/{name}/export")
def export_dxf(name: str, req: ExportRequest):
    """무엇을 내보낼지 정해 DXF 를 만든다.

    context — CONTEXT 수집범위로 크롭
    project — 확정한 PROJECT SITE 경계로 자름 (저장된 구역경계)
    design  — 고른 필지와 그 위의 건물만
    area    — 이번에 그린 범위로만 자름
    """
    site = _site_or_404(name)
    if req.scope == "project" and not os.path.exists(site.boundary):
        raise HTTPException(400, "PROJECT SITE 경계를 먼저 확정해 주세요.")
    token = uuid.uuid4().hex
    export_dir = os.path.join(site.dir, "_exports")
    os.makedirs(export_dir, exist_ok=True)
    output = os.path.join(export_dir, token + ".dxf")
    argv = [sys.executable, "-u", "to_dxf.py", "--name", site.name, "--out", output]
    tmp = None

    if req.scope == "context":
        # 수집범위 「전체」지 「자르지 않음」이 아니다. 예전에는 --no-crop 이라
        # 용도지역·지구단위계획의 동 전체 도형이 범위 밖으로 한참 뻗어 나갔다.
        argv.append("--crop-context")
    elif req.scope == "design":
        if not req.pnus:
            raise HTTPException(400, "DESIGN AREA 로 고른 필지가 없습니다.")
        argv += ["--select", *req.pnus, "--only-selected", "--margin", "0"]
    elif req.scope == "area":
        if len(req.ring) < 3:
            raise HTTPException(400, "내보낼 범위를 그려 주세요.")
        ring = list(req.ring)
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        tmp = os.path.join(export_dir, token + ".geojson")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {},
                 "geometry": {"type": "Polygon", "coordinates": [ring]}}]}, f)
        argv += ["--clip-geojson", tmp]
    # project 는 저장된 경계를 그대로 쓰므로 옵션이 없다

    if req.pnus and req.scope != "design":
        argv += ["--select", *req.pnus]
    if req.layers:
        argv += ["--layers", *req.layers]

    try:
        proc = subprocess.run(argv, cwd=HERE, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            raise HTTPException(500, (proc.stdout or "") + (proc.stderr or ""))
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
    return {"ok": True, "kind": "selected" if req.scope == "design" else "full",
            "download_kind": "export_" + token,
            "log": proc.stdout.splitlines()[-14:]}


@app.delete("/api/site/{name}")
def delete_site(name: str):
    """대상지 폴더를 통째로 지운다."""
    site = _site_or_404(name)
    # out/ 밖을 지우는 일이 없도록 경로를 한 번 더 확인한다
    target = os.path.abspath(site.dir)
    if not target.startswith(os.path.abspath(OUT_ROOT) + os.sep):
        raise HTTPException(400, "삭제할 수 없는 경로입니다.")
    shutil.rmtree(target)
    _PREVIEW_CACHE.pop(site.name, None)
    if last_site() == site.name:
        try:
            os.remove(os.path.join(OUT_ROOT, "_last_site.txt"))
        except OSError:
            pass
    return {"ok": True, "deleted": site.name, "sites": list_sites()}


@app.get("/api/site/{name}/download/{kind}")
def download(name: str, kind: str):
    site = _site_or_404(name)
    if re.fullmatch(r"export_[0-9a-f]{32}", kind):
        target = os.path.join(site.dir, "_exports", kind[7:] + ".dxf")
        if not os.path.isfile(target):
            raise HTTPException(404, "내보낸 파일이 없습니다.")
        return FileResponse(target, filename=f"{site.name}_내보내기.dxf")
    target = {
        "dxf": site.dxf, "db": site.db, "ref": site.ref,
        "dxf_selected": site.dxf_selected,
        "dxf_terrain": site.dxf_terrain, "csv_spot": site.csv_spot,
    }.get(kind)
    if not target or not os.path.exists(target):
        raise HTTPException(404, "파일이 없습니다.")
    return FileResponse(target, filename=os.path.basename(target))


def port_in_use(port: int) -> bool:
    import socket

    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    import threading
    import webbrowser

    import uvicorn

    # 배치파일에서 실행될 때 한글이 깨지지 않도록 콘솔 출력을 UTF-8로 고정한다
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass

    port = int(os.environ.get("PORT", 8000))
    url = f"http://127.0.0.1:{port}"

    # 이미 떠 있으면 서버를 또 띄우지 않고 브라우저만 연다 (더블클릭 두 번 눌러도 안전)
    if port_in_use(port):
        print(f"\n  이미 실행 중입니다  →  {url}")
        print("  브라우저를 엽니다.\n")
        webbrowser.open(url)
        return

    os.makedirs(OUT_ROOT, exist_ok=True)
    if not os.path.exists(ENV_PATH):
        print("\n  [알림] .env 파일이 없습니다.")
        print("  .env.example 을 .env 로 복사한 뒤 인증키를 채워야 데이터를 받을 수 있습니다.")
    else:
        try:
            load_key(ENV_PATH)
        except Exception as e:
            print(f"\n  [경고] {e}")

    print(f"\n  사이트 분석 뷰어  →  {url}")
    print("  브라우저가 자동으로 열립니다. 종료하려면 이 창에서 Ctrl+C 를 누르세요.\n")
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    except KeyboardInterrupt:
        pass
    print("\n  종료했습니다.")


if __name__ == "__main__":
    main()
